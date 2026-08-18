// Package agentskill keeps the coding agents on this box taught about herdrer.
//
// The skill text is compiled into the binary and served at /onboard/skill.md,
// so writing it to disk from the same binary means the instructions an agent
// reads can never describe a different version of the API than the one
// answering its requests. A hand-installed copy drifts the first time the
// endpoint changes, and drifts silently.
package agentskill

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// Managed-block markers for files herdrer shares with a human.
const (
	beginMarker = "<!-- BEGIN herdrer (managed — edits inside are overwritten) -->"
	endMarker   = "<!-- END herdrer -->"
)

// Install writes the skill everywhere the agents on this box will look.
//
// It is called on every start, so the skill tracks the running binary. Failures
// are reported but never fatal: herdrer's job is to be reachable, and being
// unable to write a dotfile is not a reason to refuse to boot.
func Install(home, skill string) error {
	var errs []string
	if err := installClaude(home, skill); err != nil {
		errs = append(errs, err.Error())
	}
	if err := installCodex(home, skill); err != nil {
		errs = append(errs, err.Error())
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

// installClaude writes ~/.claude/skills/herdrer/SKILL.md.
//
// The directory is named for herdrer, so the file is wholly ours and is
// replaced outright rather than merged.
func installClaude(home, skill string) error {
	dir := filepath.Join(home, ".claude", "skills", "herdrer")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("claude skill dir: %w", err)
	}
	return writeIfChanged(filepath.Join(dir, "SKILL.md"), skill, 0o644)
}

// installCodex maintains a marked block inside ~/.codex/AGENTS.md.
//
// Unlike the Claude skill, this file belongs to the human and may hold their
// own instructions, so herdrer owns only the region between its markers and
// leaves everything else untouched. Clobbering a user's global agent
// instructions to install our own would be a genuinely hostile thing for a tool
// to do on startup.
func installCodex(home, skill string) error {
	dir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("codex dir: %w", err)
	}
	path := filepath.Join(dir, "AGENTS.md")

	block := beginMarker + "\n\n" + skill + "\n" + endMarker

	existing, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read %s: %w", path, err)
	}

	var out string
	switch {
	case len(existing) == 0:
		out = block + "\n"
	case strings.Contains(string(existing), beginMarker) && strings.Contains(string(existing), endMarker):
		start := strings.Index(string(existing), beginMarker)
		end := strings.Index(string(existing), endMarker) + len(endMarker)
		out = string(existing[:start]) + block + string(existing[end:])
	default:
		// A file exists with no managed block: append rather than replace.
		out = strings.TrimRight(string(existing), "\n") + "\n\n" + block + "\n"
	}
	return writeIfChanged(path, out, 0o644)
}

// writeIfChanged avoids rewriting a file whose content already matches, so a
// restart does not churn mtimes that a file watcher might be reacting to.
func writeIfChanged(path, content string, mode os.FileMode) error {
	if cur, err := os.ReadFile(path); err == nil && string(cur) == content {
		return nil
	}
	// Write to a temp file in the same directory and rename, so a reader never
	// sees a half-written skill.
	tmp, err := os.CreateTemp(filepath.Dir(path), ".herdrer-skill-*")
	if err != nil {
		return fmt.Errorf("temp file: %w", err)
	}
	defer os.Remove(tmp.Name())

	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), mode); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("install %s: %w", path, err)
	}
	slog.Info("agent skill installed", "path", path)
	return nil
}
