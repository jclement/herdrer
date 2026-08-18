package terminal

import (
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
