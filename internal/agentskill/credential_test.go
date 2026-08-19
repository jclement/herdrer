package agentskill

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const credFile = `# Credential the coding agents on this box use to reach herdrer.
export HERDRER_URL=https://old.example.net
export HERDRER_TOKEN=sk_secret
`

// TestRepointURLKeepsTheToken is the one that matters.
//
// The origin moves — a rename, or a box that moves onto a tailnet — and the
// recorded URL goes stale with no other correction path. Repointing must not
// cost the agents their credential: every pane already holds this token in its
// environment, and rewriting it would break them all to fix a hostname.
func TestRepointURLKeepsTheToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.env")
	if err := os.WriteFile(path, []byte(credFile), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := repointURL(path, "https://new.example.net"); err != nil {
		t.Fatal(err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "export HERDRER_URL=https://new.example.net\n") {
		t.Errorf("URL not repointed:\n%s", got)
	}
	if !strings.Contains(string(got), "export HERDRER_TOKEN=sk_secret\n") {
		t.Errorf("token did not survive:\n%s", got)
	}
	if !strings.HasPrefix(string(got), "# Credential") {
		t.Errorf("comments did not survive:\n%s", got)
	}
}

func TestRepointURLLeavesAMatchingFileAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.env")
	if err := os.WriteFile(path, []byte(credFile), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	if err := repointURL(path, "https://old.example.net"); err != nil {
		t.Fatal(err)
	}

	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Error("rewrote a file that already named the right origin")
	}
}
