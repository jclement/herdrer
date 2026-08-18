// Command herdrer serves the review inbox and terminal for one developer box.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"

	"github.com/jclement/herdrer/internal/api"
	"github.com/jclement/herdrer/internal/auth"
	"github.com/jclement/herdrer/internal/config"
	"github.com/jclement/herdrer/internal/notify"
	"github.com/jclement/herdrer/internal/review"
	"github.com/jclement/herdrer/internal/store"
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

	srv := api.NewServer(cfg, st, authSvc, reviewSvc, termSvc, ptys, notifySvc, bus, version)

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
	if len(args) == 0 || args[0] != "create" {
		return fmt.Errorf("usage: herdrer token create --name <name> [--scopes review:write,review:read]")
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
