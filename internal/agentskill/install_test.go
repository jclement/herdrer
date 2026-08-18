package agentskill

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleSkill = "---\nname: herdrer\n---\n\nAsk the human.\n"

func TestInstallWritesClaudeSkill(t *testing.T) {
	home := t.TempDir()
	if err := Install(home, sampleSkill); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(home, ".claude", "skills", "herdrer", "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != sampleSkill {
		t.Errorf("skill content = %q", got)
	}
}

// TestInstallPreservesExistingCodexInstructions is the one that matters.
//
// ~/.codex/AGENTS.md belongs to the human and may hold their own global
// instructions. Clobbering it on startup to install ours would be a hostile
// thing for a tool to do, so herdrer owns only the region between its markers.
func TestInstallPreservesExistingCodexInstructions(t *testing.T) {
	home := t.TempDir()
	codex := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codex, 0o755); err != nil {
		t.Fatal(err)
	}
	theirs := "# My rules\n\nAlways run the tests.\n"
	path := filepath.Join(codex, "AGENTS.md")
	if err := os.WriteFile(path, []byte(theirs), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := Install(home, sampleSkill); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if !strings.Contains(string(got), "Always run the tests.") {
		t.Fatal("herdrer destroyed the user's own codex instructions")
	}
	if !strings.Contains(string(got), "Ask the human.") {
		t.Error("the skill was not appended")
	}
}

// TestInstallIsIdempotentAndReplacesItsOwnBlock proves repeated starts neither
// duplicate the block nor leave a stale version behind.
func TestInstallIsIdempotentAndReplacesItsOwnBlock(t *testing.T) {
	home := t.TempDir()
	if err := Install(home, "OLD SKILL"); err != nil {
		t.Fatal(err)
	}
	if err := Install(home, "OLD SKILL"); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, ".codex", "AGENTS.md")
	got, _ := os.ReadFile(path)
	if n := strings.Count(string(got), beginMarker); n != 1 {
		t.Fatalf("managed block appears %d times after two installs, want 1", n)
	}

	if err := Install(home, "NEW SKILL"); err != nil {
		t.Fatal(err)
	}
	got, _ = os.ReadFile(path)
	if strings.Contains(string(got), "OLD SKILL") {
		t.Error("a stale skill survived an update")
	}
	if !strings.Contains(string(got), "NEW SKILL") {
		t.Error("the updated skill was not written")
	}
	if n := strings.Count(string(got), beginMarker); n != 1 {
		t.Fatalf("managed block appears %d times after an update, want 1", n)
	}
}

// TestRenderBakesInTheOrigin catches a skill that tells agents to call the
// wrong host — which fails in a way that looks like an auth problem.
func TestRenderBakesInTheOrigin(t *testing.T) {
	out := Render("https://box.example.com/")
	if strings.Contains(out, "{{ORIGIN}}") {
		t.Error("the origin placeholder survived rendering")
	}
	if !strings.Contains(out, "https://box.example.com") {
		t.Error("the origin was not substituted")
	}
	if strings.Contains(out, "example.com//") {
		t.Error("a trailing slash produced a doubled separator")
	}
}
