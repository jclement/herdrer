package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Lane bytes on the terminal socket. The first byte of every binary frame says
// what the rest is.
const (
	laneTerminal byte = 0x00
	laneControl  byte = 0x01
)

// acceptWS performs the upgrade with the checks that make a WebSocket safe.
//
// A WebSocket upgrade is the softest spot in a browser application: it is not
// covered by CORS, historical SameSite behaviour on handshakes has varied
// between browsers, and the endpoint on the other end of this one is a shell.
// So the upgrade is gated three ways — an exact Origin match, a single-use
// ticket that had to be fetched by an authenticated same-origin request within
// the last minute, and an outright refusal of bearer tokens.
func (s *Server) acceptWS(w http.ResponseWriter, r *http.Request, purpose string) (*websocket.Conn, string, bool) {
	if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		// An agent token must never reach a socket. Refused before anything
		// else so the intent is unmistakable in the code and in the audit log.
		s.audit(r, "security.ws_token_refused", purpose, nil)
		Forbidden(w, "agent tokens cannot open sockets")
		return nil, "", false
	}
	if !s.originOK(r.Header.Get("Origin")) {
		s.audit(r, "security.ws_origin_refused", purpose,
			map[string]any{"origin": r.Header.Get("Origin")})
		Forbidden(w, "cross-origin websocket rejected")
		return nil, "", false
	}
	userID, _, ok := s.auth.RedeemTicket(r.URL.Query().Get("ticket"), purpose)
	if !ok {
		s.audit(r, "security.ws_ticket_refused", purpose, nil)
		Unauthorized(w)
		return nil, "", false
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The ticket and the Origin check above are the authorisation; this
		// list is belt and braces for the library's own check.
		OriginPatterns:  []string{s.cfg.Domain},
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		slog.Warn("websocket accept failed", "err", err)
		return nil, "", false
	}
	return conn, userID, true
}

// handleTerminalSocket bridges a PTY to the browser.
func (s *Server) handleTerminalSocket(w http.ResponseWriter, r *http.Request) {
	if !s.terminal.Enabled() {
		Forbidden(w, "the terminal is disabled on this server")
		return
	}
	conn, userID, ok := s.acceptWS(w, r, "terminal")
	if !ok {
		return
	}
	defer conn.CloseNow()

	q := r.URL.Query()
	cols, rows := parseDim(q.Get("cols"), 80), parseDim(q.Get("rows"), 24)
	session := q.Get("session")

	// The PTY key includes the geometry class so a phone at 40 columns and a
	// laptop at 120 get their own view rather than fighting over one viewport
	// — Herdr allows independent geometry per client, so there is no reason to
	// make them share.
	key := userID + "|" + session + "|" + geometryClass(cols)

	ctx := context.WithoutCancel(r.Context())
	sess, err := s.ptys.Open(ctx, userID, key, session, cols, rows)
	if err != nil {
		_ = conn.Close(websocket.StatusPolicyViolation, err.Error())
		return
	}
	s.audit(r, "terminal.attached", key, map[string]any{"cols": cols, "rows": rows})

	out, backlog, detach := sess.Attach()
	defer detach()

	// Repaint from the ring buffer so a phone that locked its screen and came
	// back sees its shell rather than a blank rectangle.
	if len(backlog) > 0 {
		_ = conn.Write(ctx, websocket.MessageBinary, append([]byte{laneTerminal}, backlog...))
	}

	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer cancel()
		for {
			select {
			case <-connCtx.Done():
				return
			case chunk, alive := <-out:
				if !alive {
					_ = conn.Close(websocket.StatusNormalClosure, "session ended")
					return
				}
				wctx, wcancel := context.WithTimeout(connCtx, 15*time.Second)
				err := conn.Write(wctx, websocket.MessageBinary, append([]byte{laneTerminal}, chunk...))
				wcancel()
				if err != nil {
					return
				}
			}
		}
	}()

	for {
		typ, data, err := conn.Read(connCtx)
		if err != nil {
			break
		}
		if len(data) == 0 {
			continue
		}
		switch data[0] {
		case laneTerminal:
			if _, err := sess.Write(data[1:]); err != nil {
				break
			}
		case laneControl:
			var msg struct {
				Type string `json:"type"`
				Cols uint16 `json:"cols"`
				Rows uint16 `json:"rows"`
			}
			if json.Unmarshal(data[1:], &msg) == nil && msg.Type == "resize" {
				sess.Resize(msg.Cols, msg.Rows)
			}
		default:
			_ = typ
		}
	}
	cancel()
	wg.Wait()
}

// geometryClass buckets widths so a few pixels of rotation do not spawn a new
// shell, while a phone and a laptop still get their own.
func geometryClass(cols uint16) string {
	switch {
	case cols < 60:
		return "narrow"
	case cols < 100:
		return "medium"
	default:
		return "wide"
	}
}

// handleStreamSocket pushes review and agent events to an open browser.
func (s *Server) handleStreamSocket(w http.ResponseWriter, r *http.Request) {
	conn, userID, ok := s.acceptWS(w, r, "stream")
	if !ok {
		return
	}
	defer conn.CloseNow()

	ctx := r.Context()
	events, unsubscribe := s.bus.Subscribe(userID)
	defer unsubscribe()

	// A read loop is required even though the client sends nothing: it is how
	// a closed connection is noticed.
	go func() {
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
		}
	}()

	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ping.C:
			if err := conn.Ping(ctx); err != nil {
				return
			}
		case ev, alive := <-events:
			if !alive {
				return
			}
			b, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err = conn.Write(wctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				return
			}
		}
	}
}
