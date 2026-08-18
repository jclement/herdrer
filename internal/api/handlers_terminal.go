package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jclement/herdrer/internal/auth"
	"github.com/jclement/herdrer/internal/notify"
	"github.com/jclement/herdrer/internal/terminal"
)

// handleHerdrState returns the whole session tree for the agents UI.
func (s *Server) handleHerdrState(w http.ResponseWriter, r *http.Request) {
	st, err := s.terminal.Snapshot(r.Context())
	if err != nil {
		Internal(w, err, "herdr snapshot")
		return
	}
	WriteJSON(w, http.StatusOK, st)
}

func (s *Server) handleListAgents(w http.ResponseWriter, r *http.Request) {
	agents, err := s.terminal.Agents(r.Context())
	if err != nil {
		// A missing or unhealthy herdr is a normal state, not a server error:
		// the box may not have one yet. Report it as an empty board with a
		// note rather than a 500 that makes the phone look broken.
		WriteList(w, http.StatusOK, []any{}, Meta{})
		return
	}
	WriteList(w, http.StatusOK, agents, Meta{Total: len(agents), Page: 1, PerPage: len(agents)})
}

// handleTerminalTicket mints the single-use credential for a shell upgrade.
//
// This handler is behind requireSession and requireSameOrigin, so a ticket can
// only be obtained by a passkey-authenticated browser on herdrer's own origin.
// Every issue is audited and pushed to the user's phone: a terminal opening is
// the single event most worth noticing if it was not you.
func (s *Server) handleTerminalTicket(w http.ResponseWriter, r *http.Request) {
	if !s.terminal.Enabled() {
		Forbidden(w, "the terminal is disabled on this server")
		return
	}
	u := UserFrom(r.Context())
	sess := SessionFrom(r.Context())

	// Step-up. A session cookie alone must not open a shell: TLS terminating
	// on our own box removed the channel binding that herdr-web's crypto
	// envelope provided, so a stolen cookie is otherwise a stolen shell. A
	// fresh authenticator assertion — a real biometric or PIN, seconds ago —
	// puts that property back exactly where it is worth the friction.
	if !auth.SteppedUpRecently(sess, s.cfg.StepUpWindow) {
		s.audit(r, "terminal.stepup_required", "", nil)
		WriteError(w, http.StatusForbidden, CodeStepUpRequired,
			"opening a terminal needs a fresh passkey check")
		return
	}

	// The credential that satisfied the step-up is the one whose permission
	// counts, not whichever key happened to create the session. A phone marked
	// review-only stays review-only even while holding a valid session.
	allowed, err := s.st.CredentialCanTerminal(r.Context(), u.ID, sess.SteppedUpCred)
	if err != nil {
		Internal(w, err, "credential permission")
		return
	}
	if !allowed {
		s.audit(r, "terminal.denied_by_credential", sess.SteppedUpCred, nil)
		Forbidden(w, "this passkey is not permitted to open a terminal")
		return
	}

	tok := s.auth.MintTicket(sess.ID, u.ID, "terminal")

	s.audit(r, "terminal.ticket_issued", "", nil)
	go s.notify.Send(contextWithoutRequest(r), u.ID, notify.Payload{
		Title: "Terminal opened",
		Body:  "A shell was opened on " + s.cfg.Domain + " from " + clientIP(r),
		URL:   s.cfg.Origin + "/settings", Kind: "security", Tag: "terminal-open",
	})

	WriteJSON(w, http.StatusCreated, map[string]any{
		"ticket": tok, "expires_at": time.Now().Add(60 * time.Second),
	})
}

func (s *Server) handleStreamTicket(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	sess := SessionFrom(r.Context())
	WriteJSON(w, http.StatusCreated, map[string]any{
		"ticket":     s.auth.MintTicket(sess.ID, u.ID, "stream"),
		"expires_at": time.Now().Add(60 * time.Second),
	})
}

func parseDim(v string, def uint16) uint16 {
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 || n > 1000 {
		return def
	}
	return uint16(n)
}

// contextWithoutRequest detaches work that must outlive the response.
func contextWithoutRequest(r *http.Request) context.Context {
	return context.WithoutCancel(r.Context())
}

func pushTestPayload(origin string) notify.Payload {
	return notify.Payload{
		Title: "herdrer", Body: "Notifications are working.",
		URL: origin + "/", Kind: "test", Tag: "test",
	}
}

// handleFocus brings a workspace, tab or agent to the foreground in Herdr.
//
// This is the one write herdrer makes into the Herdr session, and it is
// deliberately the narrowest one that makes the agents board useful: it changes
// what is focused and nothing else. It cannot start, stop, rename, or send
// keystrokes to anything.
//
// It requires the same step-up as opening a terminal. Focus decides where the
// browser terminal's keystrokes — and a pasted image path — will land, so
// steering it is shell-adjacent even though it types nothing itself.
func (s *Server) handleFocus(w http.ResponseWriter, r *http.Request) {
	if !s.terminal.Enabled() {
		Forbidden(w, "the terminal is disabled on this server")
		return
	}
	sess := SessionFrom(r.Context())
	if !auth.SteppedUpRecently(sess, s.cfg.StepUpWindow) {
		WriteError(w, http.StatusForbidden, CodeStepUpRequired,
			"changing what the terminal is pointed at needs a fresh passkey check")
		return
	}

	var t terminal.FocusTarget
	if !DecodeJSON(w, r, &t) {
		return
	}
	if err := s.terminal.Focus(r.Context(), t); err != nil {
		if errors.Is(err, terminal.ErrNoFocusTarget) {
			WriteError(w, http.StatusBadRequest, CodeValidation, err.Error())
			return
		}
		WriteError(w, http.StatusConflict, CodeConflict, err.Error())
		return
	}
	s.audit(r, "herdr.focus", firstNonEmpty(t.Agent, t.TabID, t.WorkspaceID), nil)
	w.WriteHeader(http.StatusNoContent)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
