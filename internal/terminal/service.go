// Package terminal is the shell lane: the agent status board, and a PTY
// bridged to a browser.
//
// Everything in this package is shell-equivalent. Nothing here is reachable
// without a passkey session — the routes live in the human tree, the upgrade
// requires a single-use ticket minted by an authenticated same-origin request,
// and no agent token can obtain one.
package terminal

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Agent is one row on the status board.
type Agent struct {
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Status    string `json:"status"`
	Workspace string `json:"workspace"`
	PaneID    string `json:"pane_id"`
	Title     string `json:"title"`
	CWD       string `json:"cwd"`
	Focused   bool   `json:"focused"`
}

// Blocked reports whether this agent is waiting on a human.
func (a Agent) Blocked() bool { return a.Status == "blocked" }

// Service talks to Herdr and owns the PTYs.
type Service struct {
	enabled   bool
	configDir string
	herdrBin  string

	mu    sync.Mutex
	cache []Agent
	at    time.Time
}

// New builds the service. A missing herdr binary is not an error: the box may
// not have one yet, and the terminal still works as a plain login shell.
func New(enabled bool, configDir string) *Service {
	s := &Service{enabled: enabled, configDir: configDir}
	if p, err := exec.LookPath("herdr"); err == nil {
		s.herdrBin = p
	}
	return s
}

// Enabled reports whether the shell lane is switched on at all. A deployment
// may run review-only, in which case no PTY is ever spawned.
func (s *Service) Enabled() bool { return s.enabled }

// HasHerdr reports whether a herdr binary was found.
func (s *Service) HasHerdr() bool { return s.herdrBin != "" }

// Agents returns the status board, cached briefly so a phone polling it does
// not fork a subprocess per second.
//
// This shells out to `herdr api snapshot` rather than speaking the unix socket
// protocol directly. The socket is the better long-term answer — it carries
// structural subscriptions that replay current state on subscribe, so one
// connection is bootstrap plus delta — but the CLI is a stable, documented
// surface and a subprocess costs about 30ms, which a status board can afford.
// Moving to the socket is an implementation change behind this method.
func (s *Service) Agents(ctx context.Context) ([]Agent, error) {
	if s.herdrBin == "" {
		return nil, nil
	}
	s.mu.Lock()
	if time.Since(s.at) < 2*time.Second {
		out := append([]Agent(nil), s.cache...)
		s.mu.Unlock()
		return out, nil
	}
	s.mu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, s.herdrBin, "api", "snapshot")
	cmd.Env = s.env()
	raw, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("herdr api snapshot: %w", err)
	}

	var envelope struct {
		Result struct {
			Snapshot struct {
				Agents []struct {
					Agent       string `json:"agent"`
					AgentStatus string `json:"agent_status"`
					Name        string `json:"name"`
					PaneID      string `json:"pane_id"`
					WorkspaceID string `json:"workspace_id"`
					Title       string `json:"terminal_title_stripped"`
					CWD         string `json:"cwd"`
					Focused     bool   `json:"focused"`
				} `json:"agents"`
			} `json:"snapshot"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("parse herdr snapshot: %w", err)
	}

	agents := make([]Agent, 0, len(envelope.Result.Snapshot.Agents))
	for _, a := range envelope.Result.Snapshot.Agents {
		name := a.Name
		if name == "" {
			// An unnamed pane still needs a stable handle for the URL space.
			// The pane id is session-scoped and moves with pane.move, so it is
			// a fallback, not the identity.
			name = a.PaneID
		}
		agents = append(agents, Agent{
			Name: name, Kind: a.Agent, Status: a.AgentStatus, Workspace: a.WorkspaceID,
			PaneID: a.PaneID, Title: a.Title, CWD: a.CWD, Focused: a.Focused,
		})
	}

	s.mu.Lock()
	s.cache, s.at = agents, time.Now()
	s.mu.Unlock()
	return agents, nil
}

// CountBlocked returns how many agents are waiting on a human.
func (s *Service) CountBlocked(ctx context.Context) int {
	agents, err := s.Agents(ctx)
	if err != nil {
		return 0
	}
	n := 0
	for _, a := range agents {
		if a.Blocked() {
			n++
		}
	}
	return n
}

// command builds what a new PTY runs.
//
// With herdr present the PTY attaches to a session, which is the product. With
// it absent the PTY is a plain login shell, so a freshly provisioned box is
// still reachable from a phone — which is exactly when you most need it, since
// installing herdr is one of the things you would want to do from there.
func (s *Service) command(ctx context.Context, session string) *exec.Cmd {
	if s.herdrBin != "" {
		args := []string{"attach"}
		if session != "" {
			args = append(args, "--session", session)
		}
		cmd := exec.CommandContext(ctx, s.herdrBin, args...)
		cmd.Env = s.env()
		cmd.Dir = homeDir()
		return cmd
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}
	cmd := exec.CommandContext(ctx, shell, "-l")
	cmd.Env = s.env()
	cmd.Dir = homeDir()
	return cmd
}

func (s *Service) env() []string {
	env := append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		// Mark the descendant so a shell prompt, and any agent running in it,
		// can tell it is being watched through a browser.
		"HERDRER=1",
	)
	if s.configDir != "" {
		env = append(env, "HERDR_CONFIG_DIR="+s.configDir)
	}
	return env
}

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	if u, err := user.Current(); err == nil {
		return u.HomeDir
	}
	return "/"
}

// SocketPath reports where herdr's control socket should live, for diagnostics.
func (s *Service) SocketPath(session string) string {
	base := s.configDir
	if base == "" {
		base = filepath.Join(homeDir(), ".config", "herdr")
	}
	if session != "" {
		return filepath.Join(base, "sessions", session, "herdr.sock")
	}
	return filepath.Join(base, "herdr.sock")
}

// Sessions lists the named herdr sessions present on the box.
func (s *Service) Sessions() []string {
	base := s.configDir
	if base == "" {
		base = filepath.Join(homeDir(), ".config", "herdr")
	}
	entries, err := os.ReadDir(filepath.Join(base, "sessions"))
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			out = append(out, e.Name())
		}
	}
	return out
}
