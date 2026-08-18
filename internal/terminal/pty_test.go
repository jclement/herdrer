// pty_test.go drives real PTYs, because the properties worth checking here —
// that a session outlives its websocket, that a reattach repaints, that a
// resize reaches the tty — only exist end to end.
//
// These tests never sleep for a fixed interval hoping a shell has caught up.
// They poll for the condition they need with a deadline, so a slow CI box is
// slow rather than flaky, and they skip rather than hang where a PTY cannot be
// opened at all.

package terminal

import (
	"context"
	"strings"
	"syscall"
	"testing"
	"time"
)

// pollInterval and pollTimeout bound every wait in this file. The timeout is
// generous because the thing being waited on is a login shell starting up on a
// shared CI machine, not a computation.
const (
	pollInterval = 10 * time.Millisecond
	pollTimeout  = 20 * time.Second
)

// newTestManager builds a manager that spawns a plain shell rather than
// attaching to herdr, so the test does not depend on a herdr session existing
// or on the developer's own one being reachable.
func newTestManager(t *testing.T) *Manager {
	t.Helper()
	t.Setenv("SHELL", "/bin/sh")

	ctx, cancel := context.WithCancel(context.Background())
	manager := NewManager(ctx, &Service{enabled: true}, 4)
	t.Cleanup(func() {
		manager.CloseAll()
		cancel()
	})
	return manager
}

// openTestSession starts a session, skipping the test if the platform will not
// give us a PTY.
func openTestSession(t *testing.T, manager *Manager, key string, cols, rows uint16) *Session {
	t.Helper()
	session, err := manager.Open(context.Background(), "test-user", key, "", cols, rows)
	if err != nil {
		t.Skipf("cannot open a PTY here: %v", err)
	}
	t.Cleanup(session.Close)
	return session
}

// waitForRepaint polls fresh attaches until one contains want, and returns it.
// Attaching is cheap and side-effect free, which is what makes polling on it
// reasonable.
func waitForRepaint(t *testing.T, session *Session, want string) []byte {
	t.Helper()
	deadline := time.Now().Add(pollTimeout)
	var last []byte
	for time.Now().Before(deadline) {
		_, repaint, detach := session.Attach()
		detach()
		last = repaint
		if strings.Contains(string(repaint), want) {
			return repaint
		}
		time.Sleep(pollInterval)
	}
	t.Fatalf("timed out waiting for %q in a repaint; last repaint was %q", want, last)
	return nil
}

// waitForStream reads an attached subscriber's channel until want shows up in
// the live bytes.
func waitForStream(t *testing.T, out <-chan []byte, want string) {
	t.Helper()
	var seen strings.Builder
	deadline := time.After(pollTimeout)
	for {
		select {
		case chunk, alive := <-out:
			if !alive {
				t.Fatalf("session ended before %q arrived; saw %q", want, seen.String())
			}
			seen.Write(chunk)
			if strings.Contains(seen.String(), want) {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q on the live stream; saw %q", want, seen.String())
		}
	}
}

// runShell sends a command line to the shell.
func runShell(t *testing.T, session *Session, line string) {
	t.Helper()
	if _, err := session.Write([]byte(line + "\n")); err != nil {
		t.Fatalf("writing %q to the session: %v", line, err)
	}
}

// TestRepaintShowsCommandOutput is the shell case: run something with known
// output, attach fresh, and the repaint has to show it.
//
// The marker is split by shell quoting so that the shell's echo of the command
// line cannot satisfy the assertion — only the command's actual output can.
func TestRepaintShowsCommandOutput(t *testing.T) {
	manager := newTestManager(t)
	session := openTestSession(t, manager, "repaint-output", 80, 24)

	runShell(t, session, `echo herdrer-mark''er-alpha`)
	repaint := waitForRepaint(t, session, "herdrer-marker-alpha")

	// The repaint has to be a valid terminal program, not just a string that
	// happens to contain the text.
	client := replay(t, repaint, 80, 24)
	if !strings.Contains(strings.Join(gridText(client, 80, 24), "\n"), "herdrer-marker-alpha") {
		t.Errorf("output missing from the replayed screen:\n%s",
			strings.Join(gridText(client, 80, 24), "\n"))
	}
}

// TestRepaintRestoresAltScreenFromPTY is the regression the change exists for,
// end to end: an application takes the alt screen and draws a frame, and a
// client attaching afterwards has to land on the alt screen looking at that
// frame.
func TestRepaintRestoresAltScreenFromPTY(t *testing.T) {
	manager := newTestManager(t)
	session := openTestSession(t, manager, "repaint-alt", 80, 24)

	// Enter the alt screen, clear it, draw at a known spot, hide the cursor —
	// the shape of every full-screen TUI's first frame.
	runShell(t, session, `printf '\033[?1049h\033[2J\033[3;5HALT-FRA''ME-OK\033[?25l'`)
	repaint := waitForRepaint(t, session, "ALT-FRAME-OK")

	if !strings.HasPrefix(string(repaint), seqEnterAltScreen) {
		t.Fatalf("repaint does not enter the alt screen first; prefix was %q",
			firstBytes(repaint, 24))
	}
	if !strings.Contains(string(repaint), seqHideCursor) {
		t.Error("repaint did not restore the hidden cursor")
	}

	client := replay(t, repaint, 80, 24)
	if !client.IsAltScreen() {
		t.Fatal("client is not on the alt screen after the repaint")
	}
	// The shell's next prompt lands wherever the cursor was left, so the row
	// starts with the drawn frame rather than consisting only of it.
	if got := gridText(client, 80, 24)[2]; !strings.HasPrefix(got, "    ALT-FRAME-OK") {
		t.Errorf("alt screen row 3 = %q, want it to start with the drawn frame", got)
	}
}

// TestResizeReachesPTYAndEmulator checks both halves move together: the tty
// reports the new size to the process, and the repaint is drawn at it.
func TestResizeReachesPTYAndEmulator(t *testing.T) {
	manager := newTestManager(t)
	session := openTestSession(t, manager, "resize", 80, 24)

	// Wait for the shell to be alive before resizing, so the resize cannot
	// land before the process exists.
	runShell(t, session, `echo read''y-one`)
	waitForRepaint(t, session, "ready-one")

	const (
		wideCols = 100
		tallRows = 30
	)
	session.Resize(wideCols, tallRows)

	if session.Cols != wideCols || session.Rows != tallRows {
		t.Errorf("session geometry = %dx%d, want %dx%d",
			session.Cols, session.Rows, wideCols, tallRows)
	}

	// stty asks the tty itself, so this only passes if the resize reached the
	// PTY rather than only the emulator.
	runShell(t, session, "stty size")
	repaint := waitForRepaint(t, session, "30 100")

	client := replay(t, repaint, wideCols, tallRows)
	if got := client.Width(); got != wideCols {
		t.Errorf("replayed screen width = %d, want %d", got, wideCols)
	}
	lines := gridText(client, wideCols, tallRows)
	if !strings.Contains(strings.Join(lines, "\n"), "30 100") {
		t.Errorf("stty output missing from the replayed screen:\n%s", strings.Join(lines, "\n"))
	}
}

// TestSessionSurvivesDetachAndReattach is the whole reason sessions are owned
// by the server: a phone locking its screen drops the socket, and the shell
// has to still be there — with its history — when it comes back.
func TestSessionSurvivesDetachAndReattach(t *testing.T) {
	manager := newTestManager(t)
	const key = "detach-reattach"
	session := openTestSession(t, manager, key, 80, 24)

	first, _, detach := session.Attach()
	runShell(t, session, `echo before-the-dis''connect`)
	waitForStream(t, first, "before-the-disconnect")

	// The phone goes away.
	detach()

	if session.isClosed() {
		t.Fatal("session closed when its only client detached")
	}
	if _, live := manager.Get(key); !live {
		t.Fatal("manager dropped the session when its only client detached")
	}
	// Signal 0 asks the kernel whether the process is still there without
	// touching it. Reading cmd.ProcessState instead would race with the
	// manager's own Wait.
	if err := session.cmd.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("the shell exited when its only client detached: %v", err)
	}

	// The phone comes back. The repaint has to still show what happened.
	second, repaint, detachSecond := session.Attach()
	t.Cleanup(detachSecond)
	if !strings.Contains(string(repaint), "before-the-disconnect") {
		t.Errorf("repaint after reattach lost the earlier output:\n%q", string(repaint))
	}

	// And the shell has to still take input.
	runShell(t, session, `echo after-the-recon''nect`)
	waitForStream(t, second, "after-the-reconnect")
}

// TestManagerReusesSessionForKey checks that a second connection with the same
// key lands on the running shell rather than spawning another one — the
// property that makes two tabs on one phone share a session.
func TestManagerReusesSessionForKey(t *testing.T) {
	manager := newTestManager(t)
	const key = "reuse"
	first := openTestSession(t, manager, key, 80, 24)

	second, err := manager.Open(context.Background(), "test-user", key, "", 80, 24)
	if err != nil {
		t.Fatalf("reopening the session: %v", err)
	}
	if second != first {
		t.Fatal("a second open on the same key spawned a new session")
	}
}

// TestClosedSessionAttachesEmpty checks the shutdown path: attaching to a dead
// session yields a closed channel and no repaint rather than a panic.
func TestClosedSessionAttachesEmpty(t *testing.T) {
	manager := newTestManager(t)
	session := openTestSession(t, manager, "closed", 80, 24)
	session.Close()

	out, repaint, detach := session.Attach()
	defer detach()
	if repaint != nil {
		t.Errorf("closed session produced a repaint: %q", string(repaint))
	}
	select {
	case _, alive := <-out:
		if alive {
			t.Error("closed session produced output")
		}
	case <-time.After(time.Second):
		t.Error("channel from a closed session was not closed")
	}
}
