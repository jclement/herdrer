package terminal

// The dispatch verbs: everything the task dispatcher needs Herdr to do.
//
// These live in this package on purpose. internal/terminal's contract is
// "everything here is shell-equivalent", and every verb below is exactly that —
// worktree.open forks processes, agent.start launches Claude Code, and
// agent.prompt types into it. HERDRER_TERMINAL_ENABLED=false must therefore
// disable task dispatch along with the PTYs, and putting the verbs here makes
// that one switch rather than two.
//
// Transport is the herdr CLI (`herdr worktree create`, `herdr agent …`), the
// same one-shot-per-invocation surface the snapshot already uses. The socket's
// held-open subscription client is a latency optimisation for later, behind
// these method signatures.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

// Worktree is what Herdr reports after opening or creating one.
type Worktree struct {
	Path        string // the checkout on disk — the durable half
	WorkspaceID string
	PaneID      string // the root pane, at a shell prompt — where the agent starts
}

// ErrTerminalDisabled means the shell lane is off, which turns dispatch off.
var ErrTerminalDisabled = errors.New("the terminal lane is disabled on this box")

// branchPattern is what a git branch name may look like when it is about to
// become argv. Deliberately tighter than git's own rules: no leading dash (it
// would parse as a flag), no "..", no whitespace, no colon.
var branchPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}$`)

// ValidBranch reports whether a branch name is safe to hand to the herdr CLI.
func ValidBranch(name string) bool {
	return branchPattern.MatchString(name) && !strings.Contains(name, "..")
}

// ValidAgentName reports whether an agent name is safe as a CLI argument.
func ValidAgentName(name string) bool { return idPattern.MatchString(name) }

// run executes one herdr CLI invocation and returns its stdout.
func (s *Service) run(ctx context.Context, args ...string) ([]byte, error) {
	if !s.enabled {
		return nil, ErrTerminalDisabled
	}
	if s.herdrBin == "" {
		return nil, errors.New("herdr is not installed on this box")
	}
	cmd := exec.CommandContext(ctx, s.herdrBin, args...)
	cmd.Env = s.env()
	out, err := cmd.Output()
	if err != nil {
		detail := ""
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			detail = strings.TrimSpace(string(ee.Stderr))
		}
		if detail == "" {
			detail = err.Error()
		}
		return nil, fmt.Errorf("herdr %s: %s", args[0], detail)
	}
	return out, nil
}

// worktreeResult is the JSON the worktree verbs print. Fields are probed
// defensively: the schema names workspace/worktree/root_pane/tab, and only the
// three below are load-bearing here.
type worktreeResult struct {
	Result struct {
		Worktree struct {
			Path string `json:"path"`
		} `json:"worktree"`
		Workspace struct {
			WorkspaceID string `json:"workspace_id"`
		} `json:"workspace"`
		RootPane struct {
			PaneID string `json:"pane_id"`
		} `json:"root_pane"`
	} `json:"result"`
}

func parseWorktree(raw []byte) (*Worktree, error) {
	var r worktreeResult
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("parse herdr worktree result: %w", err)
	}
	wt := &Worktree{
		Path:        r.Result.Worktree.Path,
		WorkspaceID: r.Result.Workspace.WorkspaceID,
		PaneID:      r.Result.RootPane.PaneID,
	}
	if wt.PaneID == "" {
		return nil, errors.New("herdr did not report a root pane for the worktree")
	}
	return wt, nil
}

// CreateWorktree makes a fresh git worktree workspace off a repo checkout and
// returns its root pane, without stealing focus from whatever the human is
// looking at.
//
// repoPath has been validated against HERDRER_REPO_ROOT by the caller; branch
// is validated again here because this is the last stop before argv.
func (s *Service) CreateWorktree(ctx context.Context, repoPath, branch string) (*Worktree, error) {
	if !ValidBranch(branch) {
		return nil, fmt.Errorf("branch %q is not a name this will pass to a subprocess", branch)
	}
	out, err := s.run(ctx, "worktree", "create",
		"--cwd", repoPath, "--branch", branch, "--no-focus")
	if err != nil {
		return nil, err
	}
	return parseWorktree(out)
}

// OpenWorktree reopens an existing worktree checkout (a retry after a Herdr
// restart lands here, so the work already on the branch survives).
func (s *Service) OpenWorktree(ctx context.Context, path string) (*Worktree, error) {
	out, err := s.run(ctx, "worktree", "open", "--path", path, "--no-focus")
	if err != nil {
		return nil, err
	}
	return parseWorktree(out)
}

// StartAgent launches Claude Code in an existing pane and names it. The name
// is the durable handle everything else keys on — pane ids do not survive
// pane.move, agent names do.
func (s *Service) StartAgent(ctx context.Context, name, paneID string) error {
	if !ValidAgentName(name) || !idPattern.MatchString(paneID) {
		return fmt.Errorf("refusing to pass %q / %q to a subprocess", name, paneID)
	}
	_, err := s.run(ctx, "agent", "start", name, "--kind", "claude", "--pane", paneID)
	return err
}

// Prompt submits text to a named agent.
//
// THE INVARIANT, stated where it is enforced: the text herdrer sends through
// this call is equivalent to typing into a shell that can do anything the dev
// user can. Callers must pass only herdrer-authored constant templates whose
// sole variables are server-minted identifiers — never a task title, body, or
// any other byte a human or agent typed. internal/tasks/prompts.go is the one
// place those templates live, and its test is what holds this line.
func (s *Service) Prompt(ctx context.Context, agentName, text string) error {
	if !ValidAgentName(agentName) {
		return fmt.Errorf("refusing to prompt %q", agentName)
	}
	_, err := s.run(ctx, "agent", "prompt", agentName, text)
	return err
}

// ReadTail captures an agent's recent terminal output: the 2am safety net.
// Plain text, no ANSI — this is evidence for a human to read on a phone.
func (s *Service) ReadTail(ctx context.Context, agentName string, lines int) (string, error) {
	if !ValidAgentName(agentName) {
		return "", fmt.Errorf("refusing to read %q", agentName)
	}
	if lines <= 0 {
		lines = 200
	}
	// `--format text` prints the screen as plain text, no envelope. Verified
	// against herdr 0.8.0 rather than assumed.
	out, err := s.run(ctx, "agent", "read", agentName,
		"--source", "recent", "--lines", fmt.Sprint(lines), "--format", "text")
	if err != nil {
		return "", err
	}
	return string(out), nil
}
