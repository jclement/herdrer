// vt_test.go checks the repaint the way it is actually used: by replaying it
// into a second, empty terminal and asserting that the second terminal ends up
// showing what the first one shows. That is the property the feature exists
// for — anything weaker (grepping the repaint for a substring) would pass on a
// repaint that is subtly unparseable, which is exactly the failure the byte
// ring had.

package terminal

import (
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/vt"
)

// cellSnapshot is one cell reduced to what a viewer would see.
type cellSnapshot struct {
	content string
	style   uv.Style
}

// snapshot reads a terminal back as a comparable grid.
//
// A cell that was never written carries an empty content string while a cell
// holding a literal space carries " ". They render identically, and a repaint
// necessarily turns the first into the second whenever it has to skip over a
// gap, so the two are folded together here.
func snapshot(term *vt.Emulator, cols, rows int) [][]cellSnapshot {
	grid := make([][]cellSnapshot, rows)
	for y := range rows {
		grid[y] = make([]cellSnapshot, cols)
		for x := range cols {
			cell := term.CellAt(x, y)
			if cell == nil {
				grid[y][x] = cellSnapshot{content: " "}
				continue
			}
			content := cell.Content
			if content == "" {
				content = " "
			}
			grid[y][x] = cellSnapshot{content: content, style: cell.Style}
		}
	}
	return grid
}

// rowText renders a snapshot row as plain text, for readable failures.
func rowText(row []cellSnapshot) string {
	var b strings.Builder
	for _, cell := range row {
		b.WriteString(cell.content)
	}
	return strings.TrimRight(b.String(), " ")
}

// gridText renders a whole terminal as one right-trimmed string per row, for
// assertions and for readable failures.
func gridText(term *vt.Emulator, cols, rows int) []string {
	grid := snapshot(term, cols, rows)
	lines := make([]string, rows)
	for y := range rows {
		lines[y] = rowText(grid[y])
	}
	return lines
}

// replay feeds a repaint into a fresh terminal, which is what the browser does
// with it.
func replay(t *testing.T, repaint []byte, cols, rows int) *vt.Emulator {
	t.Helper()
	term := vt.NewEmulator(cols, rows)
	t.Cleanup(func() { _ = term.Close() })
	if _, err := term.Write(repaint); err != nil {
		t.Fatalf("replaying repaint: %v", err)
	}
	return term
}

// assertSameScreen compares two terminals cell by cell.
func assertSameScreen(t *testing.T, want, got *vt.Emulator, cols, rows int) {
	t.Helper()
	wantGrid := snapshot(want, cols, rows)
	gotGrid := snapshot(got, cols, rows)
	for y := range rows {
		for x := range cols {
			if wantGrid[y][x].content != gotGrid[y][x].content {
				t.Errorf("row %d differs\n want: %q\n  got: %q",
					y, rowText(wantGrid[y]), rowText(gotGrid[y]))
				break
			}
			if !wantGrid[y][x].style.Equal(&gotGrid[y][x].style) {
				t.Errorf("style at (%d,%d) differs: want %q, got %q",
					x, y, wantGrid[y][x].style.String(), gotGrid[y][x].style.String())
				break
			}
		}
	}
}

const (
	testCols = 40
	testRows = 10
)

// TestRepaintReconstructsScreen is the core of the change: whatever the
// application did, a client replaying the repaint must end up looking at the
// same screen, on the same screen buffer, with the same cursor.
func TestRepaintReconstructsScreen(t *testing.T) {
	tests := []struct {
		name  string
		input string
		alt   bool
	}{
		{
			name:  "plain scrolling output",
			input: "first line\r\nsecond line\r\nthird line\r\n",
		},
		{
			name:  "colours and attributes",
			input: "\x1b[1;31mbold red\x1b[0m plain \x1b[4;32munderlined green\x1b[0m\r\n",
		},
		{
			name:  "background bar to the right edge",
			input: "\x1b[44m" + strings.Repeat(" ", testCols) + "\x1b[0m\r\nbelow the bar",
		},
		{
			name: "alt screen TUI",
			// Enter the alt screen, clear it, and draw a framed box the way a
			// full-screen application would.
			input: "\x1b[?1049h\x1b[2J" +
				"\x1b[1;1H\x1b[7m herdrer agent \x1b[0m" +
				"\x1b[3;3Hstatus: running" +
				"\x1b[5;3H\x1b[33m> waiting for input\x1b[0m" +
				"\x1b[?25l",
			alt: true,
		},
		{
			name: "alt screen entered after scrolling output",
			input: "one\r\ntwo\r\nthree\r\n" +
				"\x1b[?1049h\x1b[2J\x1b[4;6HINSIDE THE ALT SCREEN",
			alt: true,
		},
		{
			name:  "alt screen entered and left again",
			input: "\x1b[?1049h\x1b[2Jtransient\x1b[?1049l\r\nback on the main screen",
		},
		{
			name: "every cell written, including the last",
			input: "\x1b[?1049h\x1b[2J" + func() string {
				var b strings.Builder
				for y := 1; y <= testRows; y++ {
					fmt.Fprintf(&b, "\x1b[%d;1H%s", y, strings.Repeat("#", testCols))
				}
				return b.String()
			}(),
			alt: true,
		},
		{
			name:  "full-width bottom row on the main screen",
			input: strings.Repeat("\r\n", testRows-1) + strings.Repeat("=", testCols),
		},
		{
			name:  "wide graphemes",
			input: "日本語テキスト\r\nascii after\r\n",
		},
		{
			name:  "cursor parked mid screen",
			input: "\x1b[?1049h\x1b[2J\x1b[4;12Hprompt: \x1b[?25h",
			alt:   true,
		},
		{
			name:  "scroll region narrowed",
			input: "\x1b[3;8r\x1b[3;1Hinside the region\r\nsecond",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			source := newEmulator(testCols, testRows)
			source.Feed([]byte(tc.input))

			client := replay(t, source.Repaint(), testCols, testRows)

			if got := client.IsAltScreen(); got != tc.alt {
				t.Fatalf("alt screen after repaint = %v, want %v", got, tc.alt)
			}
			if got, want := client.IsAltScreen(), source.term.IsAltScreen(); got != want {
				t.Fatalf("alt screen after repaint = %v, source is %v", got, want)
			}
			if got, want := client.CursorPosition(), source.term.CursorPosition(); got != want {
				t.Errorf("cursor after repaint = %v, want %v", got, want)
			}
			assertSameScreen(t, source.term, client, testCols, testRows)
		})
	}
}

// TestRepaintRestoresAltScreenMode is the regression this whole change exists
// to prevent. A byte-ring replay could leave a client on the main screen
// looking at fragments of an alt-screen stream; the repaint must switch the
// client's buffer explicitly and put the drawn content on it.
func TestRepaintRestoresAltScreenMode(t *testing.T) {
	source := newEmulator(testCols, testRows)
	source.Feed([]byte("scrollback line one\r\nscrollback line two\r\n"))
	source.Feed([]byte("\x1b[?1049h\x1b[2J\x1b[2;4HAGENT-TUI-FRAME\x1b[?25l"))

	repaint := source.Repaint()

	if !strings.HasPrefix(string(repaint), seqEnterAltScreen) {
		t.Fatalf("repaint must enter the alt screen before painting; got prefix %q",
			firstBytes(repaint, 24))
	}
	if !strings.Contains(string(repaint), seqHideCursor) {
		t.Error("repaint did not restore the hidden cursor")
	}
	if strings.Contains(string(repaint), "scrollback line one") {
		t.Error("repaint leaked main-screen history into an alt-screen repaint")
	}

	client := replay(t, repaint, testCols, testRows)
	if !client.IsAltScreen() {
		t.Fatal("client is not on the alt screen after the repaint")
	}
	if got := rowText(snapshot(client, testCols, testRows)[1]); got != "   AGENT-TUI-FRAME" {
		t.Errorf("alt screen content not restored: got %q", got)
	}
}

// TestRepaintLeavesAltScreenWhenTheAppDid covers the other direction: a client
// whose terminal was left on the alt screen by an earlier connection has to be
// brought back.
func TestRepaintLeavesAltScreenWhenTheAppDid(t *testing.T) {
	source := newEmulator(testCols, testRows)
	source.Feed([]byte("\x1b[?1049h\x1b[2Jtransient\x1b[?1049l\r\nshell prompt $ "))

	repaint := source.Repaint()
	if !strings.HasPrefix(string(repaint), seqLeaveAltScreen) {
		t.Fatalf("repaint must leave the alt screen; got prefix %q", firstBytes(repaint, 24))
	}

	// Simulate a browser terminal that is still on the alt screen from before.
	client := vt.NewEmulator(testCols, testRows)
	t.Cleanup(func() { _ = client.Close() })
	if _, err := client.Write([]byte("\x1b[?1049h\x1b[2Jstale frame")); err != nil {
		t.Fatalf("priming client: %v", err)
	}
	if _, err := client.Write(repaint); err != nil {
		t.Fatalf("replaying repaint: %v", err)
	}
	if client.IsAltScreen() {
		t.Fatal("client left on the alt screen")
	}
	if got := rowText(snapshot(client, testCols, testRows)[1]); got != "shell prompt $" {
		t.Errorf("main screen content not restored: got %q", got)
	}
}

// TestRepaintCarriesScrollbackAboveTheFold checks the modest history a shell
// session keeps: lines that have scrolled off the top come back, and they come
// back above the current screen rather than inside it.
func TestRepaintCarriesScrollbackAboveTheFold(t *testing.T) {
	source := newEmulator(testCols, testRows)
	for i := range 30 {
		source.Feed(fmt.Appendf(nil, "line-%02d\r\n", i))
	}

	repaint := string(source.Repaint())
	if !strings.Contains(repaint, "line-00") {
		t.Error("earliest line missing from the repaint")
	}
	if !strings.Contains(repaint, "line-29") {
		t.Error("most recent line missing from the repaint")
	}

	// The last rows lines of the repaint have to be the screen, so a client
	// that replays it ends up with the same viewport rather than the history.
	client := replay(t, []byte(repaint), testCols, testRows)
	assertSameScreen(t, source.term, client, testCols, testRows)
}

// TestScrollbackIsBounded guards the memory budget: history is capped, so a
// session left running overnight cannot grow without limit.
func TestScrollbackIsBounded(t *testing.T) {
	source := newEmulator(testCols, testRows)
	for i := range vtScrollbackLines * 3 {
		source.Feed(fmt.Appendf(nil, "line-%05d\r\n", i))
	}
	if got := source.term.ScrollbackLen(); got > vtScrollbackLines {
		t.Errorf("scrollback grew to %d lines, cap is %d", got, vtScrollbackLines)
	}
}

// TestRepaintRestoresModes checks that the modes an application depends on
// survive a reconnect. Losing mouse reporting or bracketed paste leaves a TUI
// that looks right and does not work.
func TestRepaintRestoresModes(t *testing.T) {
	source := newEmulator(testCols, testRows)
	source.Feed([]byte("\x1b[?1049h\x1b[?1h\x1b[?1000h\x1b[?1006h\x1b[?2004h"))

	repaint := source.Repaint()
	client := replay(t, repaint, testCols, testRows)

	// The emulator has no mode getter, so the check is that the client and the
	// source agree about what a mode query would answer. Feeding both the same
	// probe and comparing the resulting screens is not possible, so assert on
	// the sequences instead — they are the contract with xterm.js.
	for _, want := range []string{"\x1b[?1h", "\x1b[?1000h", "\x1b[?1006h", "\x1b[?2004h"} {
		if !strings.Contains(string(repaint), want) {
			t.Errorf("repaint did not restore mode sequence %q", want)
		}
	}
	// Modes the application never touched must be reset, not left to whatever
	// the previous connection had.
	if !strings.Contains(string(repaint), "\x1b[?1003l") {
		t.Error("repaint did not reset an untouched mode")
	}
	if !client.IsAltScreen() {
		t.Error("client not on the alt screen")
	}
}

// TestResizeMovesTheEmulator checks that a repaint taken after a resize is
// drawn at the new geometry.
func TestResizeMovesTheEmulator(t *testing.T) {
	source := newEmulator(testCols, testRows)
	source.Feed([]byte("\x1b[?1049h\x1b[2J\x1b[1;1Hheader"))

	const (
		wideCols = 100
		tallRows = 30
	)
	source.Resize(wideCols, tallRows)
	source.Feed([]byte("\x1b[30;1Hbottom row of the taller screen"))

	if got := source.term.Width(); got != wideCols {
		t.Errorf("emulator width = %d, want %d", got, wideCols)
	}
	if got := source.term.Height(); got != tallRows {
		t.Errorf("emulator height = %d, want %d", got, tallRows)
	}

	client := replay(t, source.Repaint(), wideCols, tallRows)
	assertSameScreen(t, source.term, client, wideCols, tallRows)
	if got := rowText(snapshot(client, wideCols, tallRows)[tallRows-1]); got != "bottom row of the taller screen" {
		t.Errorf("content at the new bottom row = %q", got)
	}
}

// TestRepaintSurvivesTornSequences feeds the emulator escape sequences split
// across writes, which is what a PTY read boundary does in practice. The
// emulator has to reassemble them; a repaint taken in the middle must not
// contain half a sequence.
func TestRepaintSurvivesTornSequences(t *testing.T) {
	source := newEmulator(testCols, testRows)
	full := "\x1b[?1049h\x1b[2J\x1b[3;5H\x1b[1;36mtorn write test\x1b[0m"
	for i := range len(full) {
		source.Feed([]byte(full[i : i+1]))
	}

	client := replay(t, source.Repaint(), testCols, testRows)
	if !client.IsAltScreen() {
		t.Fatal("alt screen lost when the sequence arrived one byte at a time")
	}
	assertSameScreen(t, source.term, client, testCols, testRows)
}

// TestDeviceQueriesDoNotBlock is a regression guard on the emulator's reply
// pipe. An application asking for device attributes would otherwise block the
// goroutine draining the PTY forever, taking the session down with it.
func TestDeviceQueriesDoNotBlock(t *testing.T) {
	source := newEmulator(testCols, testRows)
	done := make(chan struct{})
	go func() {
		defer close(done)
		// Primary DA, secondary DA, device status, cursor position report, and
		// a mode request: every sequence the emulator answers.
		source.Feed([]byte("\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?25$pstill alive"))
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("feeding device queries blocked")
	}

	client := replay(t, source.Repaint(), testCols, testRows)
	if got := rowText(snapshot(client, testCols, testRows)[0]); got != "still alive" {
		t.Errorf("screen after device queries = %q", got)
	}
}

func firstBytes(b []byte, n int) string {
	if len(b) > n {
		return string(b[:n])
	}
	return string(b)
}

// --- cost ------------------------------------------------------------------
//
// One emulator per session is the thing to watch, since sessions outlive their
// websockets and four per user are allowed. These benchmarks are what the
// numbers in the commit message come from; run them with -benchmem.

// BenchmarkFeed measures the cost of putting PTY output through the emulator,
// which happens on every read from every live session.
func BenchmarkFeed(b *testing.B) {
	// A frame of a full-screen TUI: absolute addressing, colour, and text.
	var frame strings.Builder
	for y := 1; y <= 50; y++ {
		fmt.Fprintf(&frame, "\x1b[%d;1H\x1b[38;5;%dm%s\x1b[0m", y, y%256, strings.Repeat("x", 180))
	}
	payload := []byte(frame.String())

	e := newEmulator(200, 50)
	b.SetBytes(int64(len(payload)))
	b.ResetTimer()
	for b.Loop() {
		e.Feed(payload)
	}
}

// BenchmarkRepaint measures what an attach costs, which is the only moment the
// emulator is read back.
func BenchmarkRepaint(b *testing.B) {
	e := newEmulator(200, 50)
	for i := range 400 {
		e.Feed(fmt.Appendf(nil, "\x1b[3%dmline %d %s\x1b[0m\r\n", i%8, i, strings.Repeat("y", 120)))
	}
	b.ResetTimer()
	for b.Loop() {
		sink = e.Repaint()
	}
	b.ReportMetric(float64(len(sink)), "repaint-bytes")
}

var sink []byte

// BenchmarkEmulatorFootprint reports the heap a live session's emulator holds:
// two screen buffers plus capped scrollback.
func BenchmarkEmulatorFootprint(b *testing.B) {
	const sessions = 20
	line := []byte(strings.Repeat("z", 190) + "\r\n")

	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	held := make([]*emulator, sessions)
	for i := range held {
		e := newEmulator(200, 50)
		for range vtScrollbackLines * 2 {
			e.Feed(line)
		}
		held[i] = e
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	b.ReportMetric(float64(after.HeapAlloc-before.HeapAlloc)/sessions/(1<<20), "MB/session")
	runtime.KeepAlive(held)
}
