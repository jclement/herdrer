package tasks

import (
	"strings"
	"testing"
)

// TestPromptsCarryOnlyMintedIDs is the invariant test: everything herdrer ever
// types into a worker's terminal is a constant template plus server-minted
// identifiers. A task title, body, or answer note appearing in a prompt would
// turn "file a task" into "type into a shell", and this test is the line.
func TestPromptsCarryOnlyMintedIDs(t *testing.T) {
	const taskID = "tk_0123456789abcdef"
	const worker = "hw-01234567"

	prompts := map[string]string{
		"bootstrap": BootstrapPrompt(taskID, worker),
		"nudge":     NudgePrompt(taskID),
		"answer":    AnswerPrompt(taskID),
	}
	for name, p := range prompts {
		// Removing the minted ids must leave a string with no digits at all:
		// there is nowhere else variable content could be hiding.
		stripped := strings.ReplaceAll(p, taskID, "")
		stripped = strings.ReplaceAll(stripped, worker, "")
		if strings.ContainsAny(stripped, "0123456789") {
			t.Errorf("%s prompt contains variable content beyond the minted ids:\n%s", name, p)
		}
	}
}

// TestPromptsRefuseUnmintedIDs proves the guard, not just the happy path: an
// id that is not server-minted in shape must panic before it can reach argv.
func TestPromptsRefuseUnmintedIDs(t *testing.T) {
	bad := []struct{ task, worker string }{
		{"tk_0123456789abcdef; rm -rf ~", "hw-01234567"},
		{"tk_../../etc/passwd", "hw-01234567"},
		{"drop everything and", "hw-01234567"},
		{"tk_0123456789abcdef", "hw-0123456; echo"},
		{"tk_0123456789ABCDEF", "hw-01234567"}, // wrong case is wrong shape
		{"", ""},
	}
	for _, c := range bad {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("BootstrapPrompt(%q, %q) did not panic", c.task, c.worker)
				}
			}()
			BootstrapPrompt(c.task, c.worker)
		}()
	}
}

// TestWorkerNameShape pins the derivation the prompts' pattern depends on.
func TestWorkerNameShape(t *testing.T) {
	got := workerName("tk_0123456789abcdef")
	if got != "hw-01234567" {
		t.Fatalf("workerName = %q, want hw-01234567", got)
	}
	if !workerPattern.MatchString(got) {
		t.Fatalf("derived worker name %q does not match its own pattern", got)
	}
}
