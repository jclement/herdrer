package terminal

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
)

// Session is one PTY, owned by the server rather than by a websocket.
//
// Decoupling the two is what makes a phone usable: iOS suspends a backgrounded
// tab and drops the socket within seconds, and a PTY that died with its socket
// would lose the session every time the screen locked. Here the shell keeps
// running, a headless terminal emulator keeps tracking what the screen looks
// like, and the next connection is repainted from that state — see vt.go for
// why a repaint has to come from terminal state rather than from a replay of
// the bytes that produced it.
type Session struct {
	ID      string
	Cols    uint16
	Rows    uint16
	Created time.Time

	cmd  *exec.Cmd
	file *os.File

	mu      sync.Mutex
	screen  *emulator
	subs    map[chan []byte]struct{}
	closed  bool
	lastUse time.Time
}

// Manager owns the live sessions.
type Manager struct {
	svc *Service

	mu       sync.Mutex
	sessions map[string]*Session
	perUser  map[string]int
	maxPer   int
}

// NewManager builds the manager and starts the idle reaper.
func NewManager(ctx context.Context, svc *Service, maxPerUser int) *Manager {
	m := &Manager{svc: svc, sessions: map[string]*Session{}, perUser: map[string]int{}, maxPer: maxPerUser}
	go m.reap(ctx)
	return m
}

// ErrTooMany means the user already has the maximum number of live PTYs.
var ErrTooMany = errors.New("too many terminal sessions")

// ErrDisabled means the shell lane is switched off in this deployment.
var ErrDisabled = errors.New("terminal is disabled on this server")

// Open starts a PTY.
func (m *Manager) Open(ctx context.Context, userID, key, session string, cols, rows uint16) (*Session, error) {
	if !m.svc.Enabled() {
		return nil, ErrDisabled
	}
	m.mu.Lock()
	if s, ok := m.sessions[key]; ok && !s.isClosed() {
		m.mu.Unlock()
		s.Resize(cols, rows)
		return s, nil
	}
	if m.perUser[userID] >= m.maxPer {
		m.mu.Unlock()
		return nil, ErrTooMany
	}
	m.mu.Unlock()

	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}

	// The PTY outlives the request, so it is detached from the request context
	// deliberately; the manager's own lifetime governs it instead.
	cmd := m.svc.command(context.WithoutCancel(ctx), session)
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}

	s := &Session{
		ID: key, Cols: cols, Rows: rows, Created: time.Now(),
		cmd: cmd, file: f, screen: newEmulator(cols, rows),
		subs: map[chan []byte]struct{}{}, lastUse: time.Now(),
	}

	m.mu.Lock()
	m.sessions[key] = s
	m.perUser[userID]++
	m.mu.Unlock()

	go s.pump()
	go func() {
		_ = cmd.Wait()
		s.Close()
		m.mu.Lock()
		delete(m.sessions, key)
		if m.perUser[userID] > 0 {
			m.perUser[userID]--
		}
		m.mu.Unlock()
		slog.Info("terminal session ended", "key", key)
	}()

	slog.Info("terminal session started", "key", key, "cols", cols, "rows", rows, "herdr", m.svc.HasHerdr())
	return s, nil
}

// Get returns a live session by key.
func (m *Manager) Get(key string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[key]
	return s, ok && !s.isClosed()
}

// CloseAll tears everything down, on shutdown.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	list := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.mu.Unlock()
	for _, s := range list {
		s.Close()
	}
}

// reap closes sessions nobody has attached to for a long time, so a forgotten
// tab does not leave a shell running for the life of the process.
func (m *Manager) reap(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			m.CloseAll()
			return
		case <-t.C:
			m.mu.Lock()
			var stale []*Session
			for _, s := range m.sessions {
				s.mu.Lock()
				idle := len(s.subs) == 0 && time.Since(s.lastUse) > 2*time.Hour
				s.mu.Unlock()
				if idle {
					stale = append(stale, s)
				}
			}
			m.mu.Unlock()
			for _, s := range stale {
				slog.Info("reaping idle terminal", "key", s.ID)
				s.Close()
			}
		}
	}
}

// --- session --------------------------------------------------------------------

// pump reads the PTY, advances the emulator, and fans the raw output out to
// every attached socket.
//
// Both happen under the one lock, and Attach takes the same lock to snapshot a
// repaint and subscribe together. That is what makes an attach exact: a client
// cannot be handed a repaint of state that already includes bytes it is about
// to receive live, nor miss bytes written between the two.
func (s *Session) pump() {
	b := make([]byte, 32*1024)
	for {
		n, err := s.file.Read(b)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, b[:n])
			s.mu.Lock()
			if s.screen != nil {
				s.screen.Feed(chunk)
			}
			for ch := range s.subs {
				// A slow client must not stall the shell or every other
				// viewer, so a full channel drops the frame. The terminal lane
				// is loss-tolerant by design, and now genuinely recoverable:
				// the emulator has seen every byte, so a client that fell
				// behind can be made exact again by a fresh repaint.
				select {
				case ch <- chunk:
				default:
				}
			}
			s.mu.Unlock()
		}
		if err != nil {
			s.Close()
			return
		}
	}
}

// Attach subscribes to output and returns a repaint of the current screen.
//
// The second return value is the repaint: a complete, self-contained sequence
// that puts the client's terminal into the state the emulator is in — right
// screen buffer, right contents, right cursor, right modes. It is written to
// the client before any live byte.
func (s *Session) Attach() (<-chan []byte, []byte, func()) {
	ch := make(chan []byte, 256)
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		close(ch)
		return ch, nil, func() {}
	}
	s.subs[ch] = struct{}{}
	s.lastUse = time.Now()
	var repaint []byte
	if s.screen != nil {
		repaint = s.screen.Repaint()
	}
	s.mu.Unlock()

	return ch, repaint, func() {
		s.mu.Lock()
		if _, ok := s.subs[ch]; ok {
			delete(s.subs, ch)
			close(ch)
		}
		s.lastUse = time.Now()
		s.mu.Unlock()
	}
}

// Write sends keystrokes to the shell.
func (s *Session) Write(p []byte) (int, error) {
	s.mu.Lock()
	closed := s.closed
	s.lastUse = time.Now()
	s.mu.Unlock()
	if closed {
		return 0, io.ErrClosedPipe
	}
	return s.file.Write(p)
}

// Resize changes the window size of both the PTY and the emulator. They have
// to move together, or the next repaint would be drawn at the old geometry.
func (s *Session) Resize(cols, rows uint16) {
	if cols == 0 || rows == 0 {
		return
	}
	s.mu.Lock()
	s.Cols, s.Rows = cols, rows
	if s.screen != nil {
		s.screen.Resize(cols, rows)
	}
	s.mu.Unlock()
	_ = pty.Setsize(s.file, &pty.Winsize{Cols: cols, Rows: rows})
}

// Close terminates the PTY and releases every subscriber.
func (s *Session) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	for ch := range s.subs {
		close(ch)
	}
	s.subs = map[chan []byte]struct{}{}
	// Drop the emulator here rather than waiting for the session to fall out
	// of the manager's map: its two screen buffers and scrollback are the
	// largest thing a session owns.
	s.screen = nil
	s.mu.Unlock()

	_ = s.file.Close()
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
}

func (s *Session) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}
