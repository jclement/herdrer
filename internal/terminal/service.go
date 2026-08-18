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
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
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

	mu     sync.Mutex
	cache  []Agent
	at     time.Time
	keeper *os.File
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
		cmd := exec.CommandContext(ctx, s.herdrBin, herdrArgs(session)...)
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

// herdrArgs builds the argv that launches or attaches a Herdr session.
//
// Plain `herdr` launches the default session or attaches to it if one is
// already running; `--session <name>` does the same for a named one. There is
// deliberately no "attach" subcommand in the argv: `herdr attach` is not a
// valid command — it exits immediately with "unknown command: attach", which
// in a browser terminal looks like the terminal itself is broken.
func herdrArgs(session string) []string {
	if session == "" {
		return nil
	}
	return []string{"--session", session}
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

// EnsureServer makes sure a Herdr server is running, starting one if it is not.
//
// Herdr's server is started by its first client, not by a daemon flag. On a
// laptop that is invisible — you run `herdr` and there it is. On a headless box
// nobody runs anything, so until a human opens the browser terminal there is no
// server, the socket does not exist, and the agent board is empty with no
// explanation for why.
//
// So herdrer starts one at boot. The keeper is a real PTY running a real
// client, because Herdr is a TUI and will not start without one; it is simply
// never attached to a browser. Agents launched inside it outlive every browser
// session and every herdrer restart, which is the entire point of a remote box.
func (s *Service) EnsureServer(ctx context.Context) error {
	if s.herdrBin == "" {
		return nil
	}
	if s.ServerRunning(ctx) {
		slog.Info("herdr server already running")
		return nil
	}

	slog.Info("no herdr server running, starting one")
	cmd := exec.CommandContext(context.WithoutCancel(ctx), s.herdrBin)
	cmd.Env = s.env()
	cmd.Dir = homeDir()

	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 120, Rows: 40})
	if err != nil {
		return fmt.Errorf("start herdr: %w", err)
	}

	// The keeper's output goes nowhere, but it must be drained: a PTY whose
	// buffer fills blocks the writer, which would wedge the very server this
	// is here to keep alive.
	go func() {
		buf := make([]byte, 8192)
		for {
			if _, err := f.Read(buf); err != nil {
				return
			}
		}
	}()

	s.mu.Lock()
	s.keeper = f
	s.mu.Unlock()

	// Wait for the socket rather than assuming: a caller that reports "started"
	// while the board is still empty is worse than one that reports a failure.
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if s.ServerRunning(ctx) {
			slog.Info("herdr server started")
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("herdr did not come up within 20s")
}

// ServerRunning reports whether Herdr's control socket is answering.
func (s *Service) ServerRunning(ctx context.Context) bool {
	if s.herdrBin == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.herdrBin, "status", "server")
	cmd.Env = s.env()
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "running") && !strings.Contains(string(out), "not running")
}

// StopKeeper closes the keeper PTY. The Herdr server itself is deliberately
// left running: it owns the user's agents, and herdrer restarting for a deploy
// must not kill them.
func (s *Service) StopKeeper() {
	s.mu.Lock()
	f := s.keeper
	s.keeper = nil
	s.mu.Unlock()
	if f != nil {
		_ = f.Close()
	}
}

// --- the full session tree -------------------------------------------------------

// Workspace, Tab and Pane mirror Herdr's session structure. They exist so the
// browser can render a real view of the box — which workspace, which tab, which
// pane, and what each one is doing — rather than a flat list of agent names
// that loses where anything lives.
type Workspace struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Number      int    `json:"number"`
	Focused     bool   `json:"focused"`
	AgentStatus string `json:"agent_status"`
	TabCount    int    `json:"tab_count"`
	PaneCount   int    `json:"pane_count"`
	Tabs        []Tab  `json:"tabs"`
}

// Tab is one tab within a workspace.
type Tab struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	Label       string `json:"label"`
	Number      int    `json:"number"`
	Focused     bool   `json:"focused"`
	AgentStatus string `json:"agent_status"`
	Panes       []Pane `json:"panes"`
}

// Pane is one terminal. Agent is non-nil when something agent-shaped runs here.
type Pane struct {
	ID          string `json:"id"`
	TabID       string `json:"tab_id"`
	WorkspaceID string `json:"workspace_id"`
	Title       string `json:"title"`
	CWD         string `json:"cwd"`
	Focused     bool   `json:"focused"`
	AgentStatus string `json:"agent_status"`
	Agent       *Agent `json:"agent,omitempty"`
}

// State is the whole session tree, plus what herdrer knows about its own
// relationship to Herdr.
type State struct {
	Running            bool        `json:"running"`
	Version            string      `json:"version"`
	Protocol           int         `json:"protocol"`
	FocusedPaneID      string      `json:"focused_pane_id"`
	FocusedTabID       string      `json:"focused_tab_id"`
	FocusedWorkspaceID string      `json:"focused_workspace_id"`
	Workspaces         []Workspace `json:"workspaces"`
	Agents             []Agent     `json:"agents"`
	Blocked            int         `json:"blocked"`
}

type rawSnapshot struct {
	Result struct {
		Snapshot struct {
			Version            string `json:"version"`
			Protocol           int    `json:"protocol"`
			FocusedPaneID      string `json:"focused_pane_id"`
			FocusedTabID       string `json:"focused_tab_id"`
			FocusedWorkspaceID string `json:"focused_workspace_id"`
			Agents             []struct {
				Agent       string `json:"agent"`
				AgentStatus string `json:"agent_status"`
				Name        string `json:"name"`
				PaneID      string `json:"pane_id"`
				WorkspaceID string `json:"workspace_id"`
				Title       string `json:"terminal_title_stripped"`
				CWD         string `json:"cwd"`
				Focused     bool   `json:"focused"`
			} `json:"agents"`
			Workspaces []struct {
				ID          string `json:"workspace_id"`
				Label       string `json:"label"`
				Number      int    `json:"number"`
				Focused     bool   `json:"focused"`
				AgentStatus string `json:"agent_status"`
				TabCount    int    `json:"tab_count"`
				PaneCount   int    `json:"pane_count"`
			} `json:"workspaces"`
			Tabs []struct {
				ID          string `json:"tab_id"`
				WorkspaceID string `json:"workspace_id"`
				Label       string `json:"label"`
				Number      int    `json:"number"`
				Focused     bool   `json:"focused"`
				AgentStatus string `json:"agent_status"`
			} `json:"tabs"`
			Panes []struct {
				ID          string `json:"pane_id"`
				TabID       string `json:"tab_id"`
				WorkspaceID string `json:"workspace_id"`
				Title       string `json:"terminal_title_stripped"`
				CWD         string `json:"cwd"`
				Focused     bool   `json:"focused"`
				AgentStatus string `json:"agent_status"`
			} `json:"panes"`
		} `json:"snapshot"`
	} `json:"result"`
}

// Snapshot returns the full session tree.
//
// A missing or stopped Herdr is reported as `running: false` with an empty
// tree, never as an error: "no server yet" is an ordinary state on a box that
// just booted, and a 500 there makes the UI look broken when it is merely
// early.
func (s *Service) Snapshot(ctx context.Context) (*State, error) {
	st := &State{Workspaces: []Workspace{}, Agents: []Agent{}}
	if s.herdrBin == "" {
		return st, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.herdrBin, "api", "snapshot")
	cmd.Env = s.env()
	out, err := cmd.Output()
	if err != nil {
		return st, nil
	}

	var raw rawSnapshot
	if err := json.Unmarshal(out, &raw); err != nil {
		return st, fmt.Errorf("parse herdr snapshot: %w", err)
	}
	snap := raw.Result.Snapshot

	st.Running = true
	st.Version = snap.Version
	st.Protocol = snap.Protocol
	st.FocusedPaneID = snap.FocusedPaneID
	st.FocusedTabID = snap.FocusedTabID
	st.FocusedWorkspaceID = snap.FocusedWorkspaceID

	// Index agents by pane so a pane can carry the agent running inside it.
	byPane := map[string]Agent{}
	for _, a := range snap.Agents {
		name := a.Name
		if name == "" {
			name = a.PaneID
		}
		ag := Agent{
			Name: name, Kind: a.Agent, Status: a.AgentStatus, Workspace: a.WorkspaceID,
			PaneID: a.PaneID, Title: a.Title, CWD: a.CWD, Focused: a.Focused,
		}
		byPane[a.PaneID] = ag
		st.Agents = append(st.Agents, ag)
		if ag.Blocked() {
			st.Blocked++
		}
	}

	panesByTab := map[string][]Pane{}
	for _, p := range snap.Panes {
		pane := Pane{
			ID: p.ID, TabID: p.TabID, WorkspaceID: p.WorkspaceID, Title: p.Title,
			CWD: p.CWD, Focused: p.Focused, AgentStatus: p.AgentStatus,
		}
		if ag, ok := byPane[p.ID]; ok {
			a := ag
			pane.Agent = &a
		}
		panesByTab[p.TabID] = append(panesByTab[p.TabID], pane)
	}

	tabsByWorkspace := map[string][]Tab{}
	for _, t := range snap.Tabs {
		tab := Tab{
			ID: t.ID, WorkspaceID: t.WorkspaceID, Label: t.Label, Number: t.Number,
			Focused: t.Focused, AgentStatus: t.AgentStatus, Panes: panesByTab[t.ID],
		}
		if tab.Panes == nil {
			tab.Panes = []Pane{}
		}
		tabsByWorkspace[t.WorkspaceID] = append(tabsByWorkspace[t.WorkspaceID], tab)
	}

	for _, ws := range snap.Workspaces {
		w := Workspace{
			ID: ws.ID, Label: ws.Label, Number: ws.Number, Focused: ws.Focused,
			AgentStatus: ws.AgentStatus, TabCount: ws.TabCount, PaneCount: ws.PaneCount,
			Tabs: tabsByWorkspace[ws.ID],
		}
		if w.Tabs == nil {
			w.Tabs = []Tab{}
		}
		st.Workspaces = append(st.Workspaces, w)
	}
	return st, nil
}

// FocusTarget names one thing to bring to the foreground. Exactly one field
// may be set.
type FocusTarget struct {
	Agent       string `json:"agent,omitempty"`
	TabID       string `json:"tab_id,omitempty"`
	WorkspaceID string `json:"workspace_id,omitempty"`
}

// ErrNoFocusTarget means the caller named nothing, or more than one thing.
var ErrNoFocusTarget = errors.New("name exactly one of agent, tab_id or workspace_id")

// idPattern is what a Herdr identifier may contain.
//
// These values become argv for a subprocess. They arrive from a browser, so
// they are attacker-influenced even though the caller holds a session, and the
// allowlist is what keeps this from being a way to run something else. Herdr's
// own ids look like `w1`, `w1:t2`, `w1:p3`; agent names are user-chosen but
// Herdr constrains them to sane identifiers.
//
// The leading character is restricted separately, and that is not fussiness: a
// dash is legal *inside* an identifier but a leading one turns the argument
// into a flag. `herdr agent focus --help` prints help and exits zero, so a
// value like that would be silently accepted as a successful focus. Anything
// that starts with a dash is rejected outright.
var idPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$`)

// Focus brings a workspace, tab or agent to the foreground in the running
// Herdr session.
//
// This is what turns the agents board from a map into a remote control: the
// browser terminal renders whatever Herdr has focused, so focusing an agent
// here is how you steer the single attached view from a phone.
func (s *Service) Focus(ctx context.Context, t FocusTarget) error {
	if s.herdrBin == "" {
		return errors.New("herdr is not installed on this box")
	}

	var args []string
	n := 0
	if t.Agent != "" {
		n++
		args = []string{"agent", "focus", t.Agent}
	}
	if t.TabID != "" {
		n++
		args = []string{"tab", "focus", t.TabID}
	}
	if t.WorkspaceID != "" {
		n++
		args = []string{"workspace", "focus", t.WorkspaceID}
	}
	if n != 1 {
		return ErrNoFocusTarget
	}

	// Validate the value, not just the shape: it is about to be argv.
	if !idPattern.MatchString(args[len(args)-1]) {
		return fmt.Errorf("%w: %q is not a valid identifier", ErrNoFocusTarget, args[len(args)-1])
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.herdrBin, args...)
	cmd.Env = s.env()
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("herdr %s: %s", strings.Join(args, " "), strings.TrimSpace(string(out)))
	}

	// The board is about to be wrong by one focus change; drop the cache so the
	// next read reflects what just happened.
	s.mu.Lock()
	s.at = time.Time{}
	s.mu.Unlock()
	return nil
}
