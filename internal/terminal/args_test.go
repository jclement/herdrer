package terminal

import (
	"context"
	"reflect"
	"testing"
)

// TestHerdrArgs pins the launch argv.
//
// This exists because the first version used `herdr attach`, which is not a
// command Herdr has. It failed only at runtime, in a PTY, where the output
// reads as "the browser terminal is broken" rather than "the argv is wrong".
// Cheap to assert, expensive to debug.
func TestHerdrArgs(t *testing.T) {
	for _, tc := range []struct {
		session string
		want    []string
	}{
		{"", nil},
		{"be", []string{"--session", "be"}},
	} {
		if got := herdrArgs(tc.session); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("herdrArgs(%q) = %v, want %v", tc.session, got, tc.want)
		}
	}
	// Guard the specific mistake rather than only the correct shape.
	for _, s := range []string{"", "be"} {
		for _, a := range herdrArgs(s) {
			if a == "attach" {
				t.Fatalf("herdrArgs(%q) contains \"attach\", which Herdr rejects", s)
			}
		}
	}
}

// TestFocusRejectsHostileIdentifiers is the guard on the one write herdrer
// makes into Herdr. These values become argv for a subprocess and arrive from a
// browser, so the allowlist is what keeps a focus call from becoming a way to
// run something else.
func TestFocusRejectsHostileIdentifiers(t *testing.T) {
	svc := New(true, "")
	for _, bad := range []string{
		"; rm -rf /",
		"$(whoami)",
		"`id`",
		"a b",
		"--help",
		"w1\nw2",
		"", // empty is "no target"
		"../../etc/passwd",
	} {
		err := svc.Focus(context.Background(), FocusTarget{Agent: bad})
		if err == nil {
			t.Errorf("Focus accepted hostile agent id %q", bad)
		}
	}
}

// TestFocusRequiresExactlyOneTarget keeps the intent unambiguous.
func TestFocusRequiresExactlyOneTarget(t *testing.T) {
	svc := New(true, "")
	for _, tc := range []FocusTarget{
		{},
		{Agent: "a", TabID: "w1:t1"},
		{Agent: "a", WorkspaceID: "w1"},
		{Agent: "a", TabID: "w1:t1", WorkspaceID: "w1"},
	} {
		if err := svc.Focus(context.Background(), tc); err == nil {
			t.Errorf("Focus accepted an ambiguous target %+v", tc)
		}
	}
}
