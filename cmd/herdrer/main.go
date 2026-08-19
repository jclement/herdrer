// Command herdrer serves the review inbox and terminal for one developer box.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"

	"github.com/jclement/herdrer/internal/agentskill"
	"github.com/jclement/herdrer/internal/api"
	"github.com/jclement/herdrer/internal/auth"
	"github.com/jclement/herdrer/internal/config"
	"github.com/jclement/herdrer/internal/notify"
	"github.com/jclement/herdrer/internal/paste"
	"github.com/jclement/herdrer/internal/review"
	"github.com/jclement/herdrer/internal/store"
	"github.com/jclement/herdrer/internal/tasks"
	"github.com/jclement/herdrer/internal/terminal"
)

// version is stamped at build time with -ldflags.
var version = "dev"

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))

	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}

	var err error
	switch cmd {
	case "serve":
		err = cmdServe(os.Args[2:])
	case "enroll":
		err = cmdEnroll(os.Args[2:])
	case "token":
		err = cmdToken(os.Args[2:])
	case "task":
		err = cmdTask(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println("herdrer", version)
	case "help", "--help", "-h":
		usage()
	default:
		usage()
		err = fmt.Errorf("unknown command %q", cmd)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Print(`herdrer — a review inbox and a terminal for one developer box.

Usage:
  herdrer serve                    Run the server (default)
  herdrer enroll [flags]           Mint a one-time passkey registration code
  herdrer token create [flags]     Mint an agent API token
  herdrer token list               Show agent tokens and their state
  herdrer token revoke <id>        Revoke an agent token immediately
  herdrer task add [flags] [title] Queue a task for the dispatcher (or pipe stdin)
  herdrer version

Registration requires a code minted on this machine. There is no open signup,
no password, and no recovery backdoor: a passkey is the only way in.

Configuration is read from the environment; see .env.sample for every key.
`)
}

// --- serve ------------------------------------------------------------------------

func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.SuppressAuth {
		slog.Warn("SUPPRESS_AUTH IS SET — every authentication check is disabled. " +
			"This is only legal on loopback and must never reach a deployed box.")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		return err
	}
	defer st.Close()

	authSvc, err := auth.New(cfg, st)
	if err != nil {
		return err
	}
	notifySvc, err := notify.New(st, cfg.VAPIDPath, cfg.Origin,
		cfg.VAPIDPublic, cfg.VAPIDPrivate, cfg.VAPIDSubject, cfg.NtfyURL)
	if err != nil {
		return err
	}

	bus := api.NewBus()
	reviewSvc := review.New(st, notifySvc, bus, cfg.MaxOpenItems, cfg.DefaultExpiryHours, cfg.MaxExpiryHours)
	reviewSvc.StartSweeper(ctx)

	termSvc := terminal.New(cfg.TerminalEnabled, cfg.HerdrConfigDir)
	ptys := terminal.NewManager(ctx, termSvc, 4)
	defer ptys.CloseAll()

	// Hit the ground running: a headless box has no Herdr server until someone
	// starts a client, so herdrer starts one itself rather than showing an
	// empty agent board and leaving the human to guess why. Failure is logged,
	// not fatal — the review inbox is useful without a shell, and refusing to
	// boot over this would take out the one tool you use to fix the box.
	if cfg.TerminalEnabled {
		go func() {
			if err := termSvc.EnsureServer(ctx); err != nil {
				slog.Warn("could not start a herdr server", "err", err)
			}
		}()
		defer termSvc.StopKeeper()
	}

	pastes, err := paste.New(cfg.StateDir)
	if err != nil {
		return err
	}
	stopReaper := make(chan struct{})
	pastes.StartReaper(stopReaper)
	defer close(stopReaper)

	assets, err := review.NewAssetStore(cfg.StateDir)
	if err != nil {
		return err
	}

	// The coordinator: deterministic Go owns the queue, the claims and the
	// reap; Claude Code appears only as per-task workers it starts under
	// Herdr. Gated on the terminal switch because starting an agent and
	// prompting it is a shell.
	tasksSvc := tasks.New(st, termSvc, reviewSvc, bus, notifySvc, tasks.Options{
		RepoRoot: cfg.RepoRoot, WorkerCap: cfg.WorkerCap,
		AcceptTimeout: cfg.AcceptTimeout, NudgeAfter: cfg.NudgeAfter,
		GiveUpAfter: cfg.GiveUpAfter, TailMaxBytes: cfg.TailMaxBytes,
		MaxAttempts: cfg.MaxAttempts, Origin: cfg.Origin,
	})
	reviewSvc.SetResolvedHook(tasksSvc.OnReviewResolved)
	tasksSvc.Run(ctx)

	srv := api.NewServer(cfg, st, authSvc, reviewSvc, termSvc, ptys, notifySvc, bus,
		pastes, assets, tasksSvc, version)

	// Teach the agents on this box about herdrer, and give them a credential.
	//
	// Both on every start, because a hand-installed skill drifts the moment the
	// API changes and a credential nobody provisions is a step that never
	// happens. Neither is fatal: herdrer's job is to be reachable, and failing
	// to write a dotfile is not a reason to refuse to boot.
	if home, err := os.UserHomeDir(); err == nil {
		if err := agentskill.Install(home, agentskill.Render(cfg.Origin)); err != nil {
			slog.Warn("could not install the agent skill", "err", err)
		}
		if err := agentskill.EnsureCredential(ctx, st, authSvc, home, cfg.Origin); err != nil {
			slog.Warn("could not provision an agent credential", "err", err)
		}
	}

	n, err := st.CountUsers(ctx)
	if err != nil {
		return err
	}
	if n == 0 {
		slog.Warn("no passkey is registered on this box yet — " +
			"run `herdrer enroll` here to mint a registration code")
	}

	httpSrv := &http.Server{
		Addr:    cfg.Addr,
		Handler: srv,
		// A terminal socket and a 300s long-poll both outlive any sane read
		// timeout, so the write side is left open and only the header read is
		// bounded. Slowloris is the reverse proxy's problem, not ours.
		ReadHeaderTimeout: 20 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("herdrer listening",
			"addr", cfg.Addr, "origin", cfg.Origin, "rp_id", cfg.RPID(),
			"tls", cfg.TLSMode, "terminal", cfg.TerminalEnabled,
			"herdr", termSvc.HasHerdr(), "version", version)
		switch cfg.TLSMode {
		case config.TLSFile:
			errCh <- httpSrv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
		default:
			// autocert is intentionally not wired: binding 443 would require
			// CAP_NET_BIND_SERVICE on the process that forks shells. TLS
			// terminates in a reverse proxy running as a different user.
			errCh <- httpSrv.ListenAndServe()
		}
	}()

	select {
	case <-ctx.Done():
		slog.Info("shutting down")
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}

	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return httpSrv.Shutdown(shutCtx)
}

// --- enroll -----------------------------------------------------------------------

func cmdEnroll(args []string) error {
	fs := flag.NewFlagSet("enroll", flag.ExitOnError)
	label := fs.String("label", "", "what this code is for, e.g. \"iPhone\"")
	ttl := fs.Duration("ttl", 0, "how long the code stays valid (default 15m)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx := context.Background()
	st, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		return err
	}
	defer st.Close()

	d := *ttl
	if d <= 0 {
		d = cfg.EnrollTTL
	}
	code := auth.NewEnrollmentCode()
	e, err := st.CreateEnrollment(ctx, uuid.NewString(), store.HashToken(code), *label, d)
	if err != nil {
		return err
	}
	st.Audit(ctx, store.AuditEntry{Actor: "system", Kind: "auth.enrollment_created",
		Subject: e.ID, Detail: map[string]any{"label": *label, "via": "cli"}})

	fmt.Printf(`
  Passkey registration code

      %s

  Valid for %s, single use.

  Open %s on the device you want to register,
  choose "Register a passkey", and enter the code.

`, code, d.Round(time.Second), cfg.Origin)
	return nil
}

// --- token ------------------------------------------------------------------------

func cmdToken(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: herdrer token <create|list|revoke>")
	}
	switch args[0] {
	case "list":
		return cmdTokenList(args[1:])
	case "revoke":
		return cmdTokenRevoke(args[1:])
	case "create":
	default:
		return fmt.Errorf("unknown token subcommand %q; want create, list or revoke", args[0])
	}
	fs := flag.NewFlagSet("token create", flag.ExitOnError)
	name := fs.String("name", "", "what this token is for")
	scopes := fs.String("scopes", auth.ScopeReviewWrite+","+auth.ScopeReviewRead, "comma-separated scopes")
	handle := fs.String("user", "", "user handle to attach the token to (default: the only user)")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if *name == "" {
		return fmt.Errorf("--name is required")
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx := context.Background()
	st, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		return err
	}
	defer st.Close()

	users, err := st.ListUsers(ctx)
	if err != nil {
		return err
	}
	if len(users) == 0 {
		return fmt.Errorf("no users registered yet — run `herdrer enroll` first")
	}
	target := users[0]
	if *handle != "" {
		target, err = st.GetUserByHandle(ctx, *handle)
		if err != nil {
			return fmt.Errorf("no user with handle %q", *handle)
		}
	} else if len(users) > 1 {
		return fmt.Errorf("more than one user exists; pass --user <handle>")
	}

	authSvc, err := auth.New(cfg, st)
	if err != nil {
		return err
	}
	t, secret, err := authSvc.MintToken(ctx, target.ID, *name,
		strings.Split(strings.ReplaceAll(*scopes, " ", ""), ","), 0)
	if err != nil {
		return err
	}
	st.Audit(ctx, store.AuditEntry{Actor: "system", Kind: "token.created",
		Subject: t.ID, Detail: map[string]any{"name": t.Name, "via": "cli"}})

	fmt.Printf(`
  Agent token %q for %s
  Scopes: %s

      %s

  This is the only time it is shown. Store it now.

`, t.Name, target.Handle, strings.Join(t.Scopes, " "), secret)
	return nil
}

// cmdTokenList shows every agent token, including revoked ones, because the
// audit question is usually "what existed" rather than "what works now".
func cmdTokenList(args []string) error {
	fs := flag.NewFlagSet("token list", flag.ExitOnError)
	if err := fs.Parse(args); err != nil {
		return err
	}
	ctx := context.Background()
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()

	users, err := st.ListUsers(ctx)
	if err != nil {
		return err
	}
	if len(users) == 0 {
		return fmt.Errorf("no users registered yet")
	}

	fmt.Printf("\n  %-38s %-16s %-12s %-20s %s\n", "ID", "NAME", "PREFIX", "LAST USED", "STATE")
	for _, u := range users {
		toks, err := st.ListAPITokens(ctx, u.ID)
		if err != nil {
			return err
		}
		for _, t := range toks {
			state := "active"
			if t.RevokedAt != nil {
				state = "revoked"
			} else if t.ExpiresAt != nil && time.Now().After(*t.ExpiresAt) {
				state = "expired"
			}
			used := "never"
			if t.LastUsedAt != nil {
				used = t.LastUsedAt.Format("2006-01-02 15:04")
			}
			fmt.Printf("  %-38s %-16s %-12s %-20s %s\n", t.ID, t.Name, t.TokenPrefix, used, state)
		}
	}
	fmt.Println()
	return nil
}

// cmdTokenRevoke kills a token immediately. The row survives for the audit
// trail; only its ability to authenticate is removed.
func cmdTokenRevoke(args []string) error {
	fs := flag.NewFlagSet("token revoke", flag.ExitOnError)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: herdrer token revoke <id>   (see: herdrer token list)")
	}
	id := fs.Arg(0)

	ctx := context.Background()
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()

	users, err := st.ListUsers(ctx)
	if err != nil {
		return err
	}
	for _, u := range users {
		if err := st.RevokeAPIToken(ctx, u.ID, id); err == nil {
			st.Audit(ctx, store.AuditEntry{Actor: "system", Kind: "token.revoked",
				Subject: id, Detail: map[string]any{"via": "cli"}})
			fmt.Printf("revoked %s\n", id)
			return nil
		}
	}
	return fmt.Errorf("no such token: %s", id)
}

// --- task -------------------------------------------------------------------------

// cmdTask files a task from the shell, on the box, straight into the database.
// This exists for one reason a browser cannot match: piping a failing
// command's output into the body. Everything else about tasks — triage,
// cancel, retry, watching — is deliberately web-only.
func cmdTask(args []string) error {
	if len(args) == 0 || args[0] != "add" {
		return fmt.Errorf("usage: herdrer task add [--repo <r>] [--ready] [title, or stdin]")
	}
	fs := flag.NewFlagSet("task add", flag.ExitOnError)
	repo := fs.String("repo", "", "repo the task is bound to, relative to HERDRER_REPO_ROOT")
	ready := fs.Bool("ready", false, "file straight to ready (triaged, dispatchable)")
	kind := fs.String("kind", "change", "change | investigate | chore")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}

	body := strings.Join(fs.Args(), " ")
	if fi, err := os.Stdin.Stat(); err == nil && fi.Mode()&os.ModeCharDevice == 0 {
		piped, err := io.ReadAll(io.LimitReader(os.Stdin, 64*1024))
		if err != nil {
			return err
		}
		if body == "" {
			body = string(piped)
		} else {
			body = body + "\n\n```\n" + strings.TrimRight(string(piped), "\n") + "\n```\n"
		}
	}
	body = strings.TrimSpace(body)
	if body == "" {
		return fmt.Errorf("nothing to file: pass a title, pipe a body, or both")
	}

	ctx := context.Background()
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	users, err := st.ListUsers(ctx)
	if err != nil {
		return err
	}
	if len(users) == 0 {
		return fmt.Errorf("no users registered yet — run `herdrer enroll` first")
	}

	title := body
	if i := strings.IndexByte(title, '\n'); i > 0 {
		title = title[:i]
	}
	if len(title) > 120 {
		title = title[:120]
	}
	status := "inbox"
	if *ready {
		status = "ready"
	}
	now := time.Now()
	t := &store.Task{
		ID:     "tk_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16],
		UserID: users[0].ID, Title: strings.TrimSpace(title), BodyMD: body,
		Kind: *kind, Repo: strings.Trim(*repo, "/"), Status: status,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := st.CreateTask(ctx, t, "cli"); err != nil {
		return err
	}
	st.Audit(ctx, store.AuditEntry{Actor: "system", Kind: "task.created",
		Subject: t.ID, Detail: map[string]any{"via": "cli", "status": status}})
	fmt.Printf("filed %s (%s) — %s\n", t.ID, status, t.Title)
	if !*ready {
		fmt.Println("it sits in the inbox until you mark it ready in the browser (or pass --ready)")
	}
	return nil
}

// openStore is the shared setup for CLI verbs that touch the database.
func openStore(ctx context.Context) (*store.Store, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	return store.Open(ctx, cfg.DBPath)
}
