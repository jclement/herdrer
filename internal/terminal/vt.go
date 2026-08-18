// vt.go keeps a headless terminal emulator per PTY and turns its state into a
// repaint for a client that has just attached.
//
// The reason it exists: a byte ring cannot repaint a screen. Replaying an
// arbitrary window of a stream that is mostly cursor addressing drops the
// client in mid-escape-sequence, with no idea whether the alt screen is
// active, where the cursor is, what the scroll region is, or what attributes
// are in force. For a scrolling shell that is merely untidy; for the
// full-screen TUI of a coding agent — the thing herdrer exists to watch — it is
// garbage. So every byte the PTY produces is also fed to an emulator that
// maintains real screen state, and an attaching client is sent a repaint
// synthesised from that state.
//
// Live subscribers still get the raw stream. xterm.js is a real terminal and
// handles the raw stream correctly as long as it has been attached the whole
// time; only the repaint-on-attach has to be synthesised.
//
// # Library choice
//
// github.com/charmbracelet/x/vt. It was picked over github.com/hinshun/vt10x
// (last commit 2022, and its grid readback exposes neither alt-screen state nor
// per-cell attributes in a form you can re-serialise) and over the termtest /
// xpty family (which wraps vt10x and adds a PTY layer this package already
// has). x/vt is actively developed, keeps both screen buffers with a real
// scroll region, and — the part that matters here — can be read back cell by
// cell as a grid of styled cells, with `IsAltScreen`, `CursorPosition`, a
// scrollback buffer, and a `Style.Diff` that emits the SGR sequence to move
// from one cell's attributes to the next. That readback is the whole
// requirement; a VT you cannot serialise is of no use for a repaint.
//
// # What a repaint does and does not restore
//
// Restored: which screen buffer is active, every cell's content and
// attributes, the scrollback above the fold on the main screen, cursor
// position, visibility and style, the DECSTBM scroll region, the window title,
// and the DEC private modes in restoredModes (arrow-key mode, autowrap, origin
// mode, the mouse and focus reporting modes, bracketed paste).
//
// Not restored: character-set designations (SCS), custom tab stops, the saved
// cursor (DECSC), OSC-set palette entries, per-cell hyperlinks, and the
// application's current SGR pen. The pen is the notable one — the library has
// no getter for it, so a repaint leaves attributes reset, and an application
// that had a non-default pen active will render its next output with default
// attributes until it emits SGR again. Full-screen TUIs set attributes per run
// and are unaffected; a shell's echo of typed characters is unstyled anyway.

package terminal

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"sync"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
)

// vtScrollbackLines is how much history above the fold the emulator keeps for
// the main screen, and therefore how much a repaint can hand back.
//
// It is deliberately small. A cell costs 112 bytes, so this is a few MB in the
// worst case of full-width lines at laptop geometry and a few hundred KB in
// practice — where the library's own default of 10,000 lines would be ~20 MB
// per session. Two hundred lines is about four phone screens: enough to scroll
// back over what just happened, which is all a watcher needs.
const vtScrollbackLines = 200

// Escape sequences a repaint is built from.
const (
	seqResetStyle      = "\x1b[m"
	seqCursorHome      = "\x1b[H"
	seqEraseDisplay    = "\x1b[2J"
	seqEraseScrollback = "\x1b[3J"
	seqResetMargins    = "\x1b[r"
	seqShowCursor      = "\x1b[?25h"
	seqHideCursor      = "\x1b[?25l"
	seqEnterAltScreen  = "\x1b[?1049h"
	seqLeaveAltScreen  = "\x1b[?1049l"
	seqOriginOff       = "\x1b[?6l"
	seqAutoWrapOff     = "\x1b[?7l"
)

// restoredMode is one DEC private mode a repaint re-asserts, with the value a
// terminal has at reset.
type restoredMode struct {
	mode      ansi.Mode
	byDefault bool
}

// restoredModes are the modes a repaint re-asserts, in the order it emits
// them. Every one is emitted unconditionally — set or reset — so the client
// lands in a known state rather than inheriting whatever a previous connection
// left behind.
//
// The defaults duplicate the emulator's own reset table, because the library
// applies it inside its constructor before there is anywhere to observe it
// from. They are re-asserted from callbacks after that, so the only way this
// list can drift is if the library changes a documented VT default.
//
// Cursor visibility (?25) and the alt-screen and cursor-save modes (?1047,
// ?1048, ?1049) are absent on purpose: repaint handles those itself, because
// where they sit relative to painting changes what they do.
var restoredModes = []restoredMode{
	{ansi.ModeCursorKeys, false},       // ?1    arrow keys send SS3 rather than CSI
	{ansi.ModeOrigin, false},           // ?6    addressing is relative to the margins
	{ansi.ModeAutoWrap, true},          // ?7
	{ansi.ModeMouseX10, false},         // ?9
	{ansi.ModeNumericKeypad, false},    // ?66
	{ansi.ModeMouseNormal, false},      // ?1000
	{ansi.ModeMouseButtonEvent, false}, // ?1002
	{ansi.ModeMouseAnyEvent, false},    // ?1003
	{ansi.ModeFocusEvent, false},       // ?1004
	{ansi.ModeMouseExtSgr, false},      // ?1006
	{ansi.ModeBracketedPaste, false},   // ?2004
}

// scrollRegion is a DECSTBM margin pair, 1-based and inclusive. The zero value
// means the whole screen scrolls.
type scrollRegion struct{ top, bottom int }

// screenBuffer indexes the per-screen state a terminal keeps two of.
type screenBuffer int

const (
	mainScreen screenBuffer = 0
	altScreen  screenBuffer = 1
)

// emulator is the server's model of one PTY's screen. It is safe for
// concurrent use; Session serialises feed against attach on top of this so
// that a repaint and the live stream cannot interleave, but the type is
// self-contained either way.
type emulator struct {
	mu   sync.Mutex
	term *vt.Emulator
	cols int
	rows int

	// Tracked from callbacks because the library exposes them that way and has
	// no getter for them on the emulator.
	cursorVisible bool
	cursorStyle   vt.CursorStyle
	cursorSteady  bool
	title         string
	modes         map[ansi.Mode]bool

	// margins is the scroll region per screen buffer, observed from DECSTBM
	// for the same reason.
	margins [2]scrollRegion
}

// newEmulator builds an emulator sized to the PTY.
func newEmulator(cols, rows uint16) *emulator {
	e := &emulator{
		term:          vt.NewEmulator(int(cols), int(rows)),
		cols:          int(cols),
		rows:          int(rows),
		cursorVisible: true,
		modes:         make(map[ansi.Mode]bool, len(restoredModes)),
	}
	for _, m := range restoredModes {
		e.modes[m.mode] = m.byDefault
	}
	e.term.SetScrollbackSize(vtScrollbackLines)

	// The emulator answers device queries — DA, DSR, DECRQM — by writing the
	// reply to an io.Pipe. An io.Pipe write blocks until someone reads it, and
	// nobody here ever will, so the first `\x1b[c` an application emitted would
	// wedge the goroutine draining the PTY. Closing the write end up front
	// makes those replies fail instantly and harmlessly instead, which is the
	// right answer anyway: the browser on the other end of the websocket is a
	// real terminal and answers the application's queries itself.
	if closer, ok := e.term.InputPipe().(io.Closer); ok {
		_ = closer.Close()
	}

	e.term.SetCallbacks(vt.Callbacks{
		Title:            func(title string) { e.title = sanitiseTitle(title) },
		CursorVisibility: func(visible bool) { e.cursorVisible = visible },
		CursorStyle: func(style vt.CursorStyle, blink bool) {
			e.cursorStyle, e.cursorSteady = style, !blink
		},
		EnableMode:  func(mode ansi.Mode) { e.setModeIfTracked(mode, true) },
		DisableMode: func(mode ansi.Mode) { e.setModeIfTracked(mode, false) },
	})
	e.observeScrollRegion()
	return e
}

// setModeIfTracked records a mode change, ignoring the modes repaint handles
// itself. Callbacks fire from inside term.Write, which the caller already
// holds the lock for.
func (e *emulator) setModeIfTracked(mode ansi.Mode, on bool) {
	if _, tracked := e.modes[mode]; tracked {
		e.modes[mode] = on
	}
}

// observeScrollRegion watches the sequences that move the scroll margins.
//
// The emulator keeps a scroll region per screen but has no getter for it, so
// the only way to know it is to watch DECSTBM go past. Handlers run
// last-registered-first and a handler returning false falls through to the
// next, so these observe without taking over: the emulator's own handlers
// still do the work.
func (e *emulator) observeScrollRegion() {
	e.term.RegisterCsiHandler('r', func(params ansi.Params) bool {
		top, _, _ := params.Param(0, 1)
		bottom, _, _ := params.Param(1, e.rows)
		if top < 1 {
			top = 1
		}
		if bottom < 1 || bottom > e.rows {
			bottom = e.rows
		}

		screen := mainScreen
		if e.term.IsAltScreen() {
			screen = altScreen
		}
		// An inverted pair is ignored by the emulator too, and a full-height
		// pair is the same thing as no margins at all.
		if top >= bottom || (top == 1 && bottom == e.rows) {
			e.margins[screen] = scrollRegion{}
		} else {
			e.margins[screen] = scrollRegion{top: top, bottom: bottom}
		}
		return false
	})

	e.term.RegisterEscHandler('c', func() bool {
		// RIS resets both screens.
		e.margins = [2]scrollRegion{}
		return false
	})
}

// Feed advances the emulator by the bytes the PTY just produced.
func (e *emulator) Feed(p []byte) {
	e.mu.Lock()
	defer e.mu.Unlock()
	_, _ = e.term.Write(p)
}

// Resize changes the emulated window size. The library resets each screen's
// scroll region on resize, so the observed margins go with it.
func (e *emulator) Resize(cols, rows uint16) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cols, e.rows = int(cols), int(rows)
	e.margins = [2]scrollRegion{}
	e.term.Resize(int(cols), int(rows))
}

// Repaint returns the bytes that reconstruct the current screen on a client
// that has just attached.
func (e *emulator) Repaint() []byte {
	e.mu.Lock()
	defer e.mu.Unlock()

	var out bytes.Buffer
	alt := e.term.IsAltScreen()
	screen := mainScreen
	if alt {
		screen = altScreen
	}

	// The screen buffer has to be selected first, because everything after
	// this paints into whichever one is active. A client reconnecting into a
	// reused xterm.js may be on the wrong one, so both directions are stated.
	if alt {
		out.WriteString(seqEnterAltScreen)
	} else {
		out.WriteString(seqLeaveAltScreen)
	}

	// Paint from a neutral state. Origin mode and autowrap are switched off for
	// the duration so absolute addressing means what it says and a full-width
	// row cannot scroll the screen out from under the paint; both are restored
	// from tracked state below.
	out.WriteString(seqResetStyle)
	out.WriteString(seqResetMargins)
	out.WriteString(seqOriginOff)
	out.WriteString(seqAutoWrapOff)
	out.WriteString(seqCursorHome)
	out.WriteString(seqEraseDisplay)
	if !alt {
		// Drop whatever history the client had, so replayed scrollback cannot
		// appear twice on a reconnect that reused the same terminal.
		out.WriteString(seqEraseScrollback)
	}

	if alt {
		e.writeAltScreen(&out)
	} else {
		e.writeMainScreen(&out)
	}

	out.WriteString(seqResetStyle)

	// Modes the application had set, so its keys and its mouse keep working on
	// the new connection. These come before the cursor is placed: origin mode
	// changes what a cursor address means, and setting it homes the cursor.
	for _, m := range restoredModes {
		if e.modes[m.mode] {
			out.WriteString(ansi.SetMode(m.mode))
		} else {
			out.WriteString(ansi.ResetMode(m.mode))
		}
	}

	// DECSTBM also homes the cursor, so it too comes before the address.
	margins := e.margins[screen]
	if margins.top > 0 {
		fmt.Fprintf(&out, "\x1b[%d;%dr", margins.top, margins.bottom)
	}

	e.writeCursor(&out, margins)

	if e.title != "" {
		fmt.Fprintf(&out, "\x1b]2;%s\x07", e.title)
	}
	return out.Bytes()
}

// writeAltScreen paints the alt screen by absolute addressing, one row at a
// time, skipping rows that are entirely blank. Nothing here may scroll: the
// alt screen has no history to scroll into and a stray line feed on the last
// row would shift the whole frame up by one.
func (e *emulator) writeAltScreen(out *bytes.Buffer) {
	for y := range e.rows {
		row := renderCells(e.row(y))
		if row == "" {
			continue
		}
		fmt.Fprintf(out, "\x1b[%d;1H", y+1)
		out.WriteString(row)
	}
}

// writeMainScreen paints the history and then the screen as one run of lines
// separated by newlines.
//
// Scrolling is the point rather than a hazard here: emitting
// len(history)+rows lines into a terminal that is rows tall pushes the history
// into the client's own scrollback and leaves the last rows lines — the
// screen — filling the viewport, which is exactly the shape of the server's
// state. Absolute addressing could not do that, because there is nowhere to
// address history.
func (e *emulator) writeMainScreen(out *bytes.Buffer) {
	history := e.term.Scrollback()
	lines := make([]string, 0, e.rows+vtScrollbackLines)
	if history != nil {
		for _, line := range history.Lines() {
			lines = append(lines, renderCells(line))
		}
	}
	for y := range e.rows {
		lines = append(lines, renderCells(e.row(y)))
	}
	out.WriteString(strings.Join(lines, "\r\n"))
}

// writeCursor places the cursor and restores its visibility and shape.
func (e *emulator) writeCursor(out *bytes.Buffer, margins scrollRegion) {
	pos := e.term.CursorPosition()
	row, col := pos.Y+1, pos.X+1
	if e.modes[ansi.ModeOrigin] && margins.top > 0 {
		// With origin mode on, the client reads a row number as an offset from
		// the top margin.
		row -= margins.top - 1
	}
	row = clamp(row, 1, e.rows)
	col = clamp(col, 1, e.cols)
	fmt.Fprintf(out, "\x1b[%d;%dH", row, col)

	if e.cursorVisible {
		out.WriteString(seqShowCursor)
	} else {
		out.WriteString(seqHideCursor)
	}
	fmt.Fprintf(out, "\x1b[%d q", cursorStyleParam(e.cursorStyle, e.cursorSteady))
}

// row copies one row of the active screen out of the emulator.
func (e *emulator) row(y int) []uv.Cell {
	cells := make([]uv.Cell, e.cols)
	for x := range e.cols {
		if cell := e.term.CellAt(x, y); cell != nil {
			cells[x] = *cell
		}
	}
	return cells
}

// --- serialisation ---------------------------------------------------------

// renderCells turns one row of cells into the bytes that reproduce it: only
// the SGR changes between adjacent cells, and no trailing run of blanks, since
// the screen was cleared before painting started. A cell carrying a background
// colour is not blank, so a coloured bar running to the right edge survives.
func renderCells(cells []uv.Cell) string {
	last := -1
	for i := range cells {
		if !isBlank(&cells[i]) {
			last = i
		}
	}
	if last < 0 {
		return ""
	}

	var row strings.Builder
	var pen uv.Style
	for i := 0; i <= last; i++ {
		cell := &cells[i]
		if seq := cell.Style.Diff(&pen); seq != "" {
			row.WriteString(seq)
			pen = cell.Style
		}
		if cell.Content == "" {
			row.WriteString(" ")
		} else {
			row.WriteString(cell.Content)
		}
		if cell.Width > 1 {
			// A wide grapheme owns the placeholder cells to its right; writing
			// it once advances the client's cursor over all of them.
			i += cell.Width - 1
		}
	}
	if !pen.IsZero() {
		row.WriteString(seqResetStyle)
	}
	return row.String()
}

// isBlank reports whether a cell contributes nothing to the screen. It uses
// the same test the library's own scrollback uses when it trims a line.
func isBlank(cell *uv.Cell) bool {
	return cell == nil || cell.IsZero() || cell.Equal(&uv.EmptyCell)
}

// cursorStyleParam maps a cursor shape onto its DECSCUSR parameter.
func cursorStyleParam(style vt.CursorStyle, steady bool) int {
	param := int(style)*2 + 1
	if steady {
		param++
	}
	return param
}

// sanitiseTitle strips the control characters that would end or hijack the OSC
// string the title is replayed inside.
func sanitiseTitle(title string) string {
	clean := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, title)
	const maxTitleRunes = 256
	if runes := []rune(clean); len(runes) > maxTitleRunes {
		clean = string(runes[:maxTitleRunes])
	}
	return clean
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
