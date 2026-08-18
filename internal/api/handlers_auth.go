package api

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/jclement/herdrer/internal/auth"
	"github.com/jclement/herdrer/internal/store"
)

// handleAuthState tells the login screen what to render.
//
// It is unauthenticated and therefore says as little as possible: whether the
// box has any user at all, and whether a registration permit is currently
// open. It never reveals a handle, a display name, or how many users exist.
func (s *Server) handleAuthState(w http.ResponseWriter, r *http.Request) {
	n, err := s.st.CountUsers(r.Context())
	if err != nil {
		Internal(w, err, "count users")
		return
	}
	open, err := s.st.HasOpenEnrollment(r.Context())
	if err != nil {
		Internal(w, err, "enrollment state")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"enrolled":        n > 0,
		"enrollment_open": open,
		"origin":          s.cfg.Origin,
		"rp_id":           s.cfg.RPID(),
	})
}

type registerBeginReq struct {
	Code        string `json:"code"`
	Handle      string `json:"handle"`
	DisplayName string `json:"display_name"`
}

func (s *Server) handleRegisterBegin(w http.ResponseWriter, r *http.Request) {
	var req registerBeginReq
	if !DecodeJSON(w, r, &req) {
		return
	}
	opts, err := s.auth.BeginRegistration(r.Context(), w, req.Code, req.Handle, req.DisplayName)
	if err != nil {
		if errors.Is(err, auth.ErrEnrollmentRequired) {
			s.audit(r, "auth.enroll_rejected", "", nil)
			// Deliberately identical whether the code was wrong, expired,
			// already used, or never existed.
			WriteError(w, http.StatusForbidden, CodeForbidden,
				"registration requires a valid enrollment code from the server console")
			return
		}
		Internal(w, err, "begin registration")
		return
	}
	WriteJSON(w, http.StatusOK, opts)
}

func (s *Server) handleRegisterFinish(w http.ResponseWriter, r *http.Request) {
	u, err := s.auth.FinishRegistration(r.Context(), w, r)
	if err != nil {
		// The client gets a deliberately coarse message, but the operator must
		// be able to find out what actually happened: an opaque failure with
		// no server-side cause is undebuggable from a phone at the exact
		// moment you most need to get in.
		slog.Error("passkey registration failed", "err", err, "ip", clientIP(r), "ua", r.UserAgent())
		s.audit(r, "auth.register_failed", "", map[string]any{"error": err.Error()})

		// These two are worth distinguishing to the user. By the time the code
		// is checked the caller has already completed a real authenticator
		// ceremony, so saying "the code was wrong" enumerates nothing — and
		// "registration could not be completed" when the only problem is a
		// stale code is a genuinely miserable dead end.
		switch {
		case errors.Is(err, auth.ErrEnrollmentRequired):
			WriteError(w, http.StatusForbidden, CodeForbidden,
				"that enrollment code is not valid any more — mint a fresh one with `herdrer enroll` on the server")
		case errors.Is(err, auth.ErrCeremonyMissing):
			WriteError(w, http.StatusForbidden, CodeForbidden,
				"the registration attempt expired or was started in another tab — reload and try again")
		default:
			WriteError(w, http.StatusForbidden, CodeForbidden,
				"the passkey could not be verified — reload and try again")
		}
		return
	}
	WriteJSON(w, http.StatusOK, publicUser(u))
}

func (s *Server) handleLoginBegin(w http.ResponseWriter, r *http.Request) {
	opts, err := s.auth.BeginLogin(r.Context(), w)
	if err != nil {
		Internal(w, err, "begin login")
		return
	}
	WriteJSON(w, http.StatusOK, opts)
}

func (s *Server) handleLoginFinish(w http.ResponseWriter, r *http.Request) {
	u, err := s.auth.FinishLogin(r.Context(), w, r)
	if err != nil {
		slog.Warn("passkey login failed", "err", err, "ip", clientIP(r))
		// One response for every failure mode. A caller cannot distinguish an
		// unknown credential from a bad signature from an expired challenge.
		Unauthorized(w)
		return
	}
	WriteJSON(w, http.StatusOK, publicUser(u))
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if sess := SessionFrom(r.Context()); sess != nil {
		s.auth.RevokeTicketsForSession(sess.ID)
	}
	s.auth.Logout(r.Context(), w, r)
	s.audit(r, "auth.logout", "", nil)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, http.StatusOK, publicUser(UserFrom(r.Context())))
}

// handleBootstrap is the single round trip the SPA makes on open.
func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	openItems, err := s.st.CountOpen(r.Context(), u.ID, "ask")
	if err != nil {
		Internal(w, err, "count open")
		return
	}
	var vapid any
	if s.notify != nil {
		vapid = s.notify.PublicKey()
	}
	sess := SessionFrom(r.Context())
	WriteJSON(w, http.StatusOK, map[string]any{
		"user":                   publicUser(u),
		"version":                s.version,
		"stepped_up":             auth.SteppedUpRecently(sess, s.cfg.StepUpWindow),
		"step_up_window_seconds": int(s.cfg.StepUpWindow.Seconds()),
		"terminal_enabled":       s.terminal.Enabled(),
		"herdr_present":          s.terminal.HasHerdr(),
		"counts": map[string]int{
			"review_open":    openItems,
			"agents_blocked": s.terminal.CountBlocked(r.Context()),
		},
		"vapid_public_key": vapid,
	})
}

// handleHealth is unauthenticated, for the reverse proxy and the footer.
//
// It reports liveness and nothing else. Version and update state are in the
// authenticated bootstrap response instead: an unauthenticated endpoint that
// names the running version tells a scanner exactly which advisories to try.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

// --- credentials and sessions ---------------------------------------------------

func (s *Server) handleListCredentials(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	creds, err := s.st.ListCredentials(r.Context(), u.ID)
	if err != nil {
		Internal(w, err, "list credentials")
		return
	}
	out := make([]map[string]any, 0, len(creds))
	for _, c := range creds {
		out = append(out, map[string]any{
			"id": c.ID, "name": c.Name, "created_at": c.CreatedAt,
			"last_used_at": c.LastUsedAt, "backup_state": c.BackupState,
			"transports": c.Transports, "can_terminal": c.CanTerminal,
		})
	}
	WriteList(w, http.StatusOK, out, Meta{Total: len(out), Page: 1, PerPage: len(out)})
}

func (s *Server) handleDeleteCredential(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	if err := s.st.DeleteCredential(r.Context(), u.ID, r.PathValue("id")); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			WriteError(w, http.StatusNotFound, CodeNotFound, "no such passkey")
			return
		}
		WriteError(w, http.StatusConflict, CodeConflict, err.Error())
		return
	}
	s.audit(r, "auth.credential_removed", r.PathValue("id"), nil)
	w.WriteHeader(http.StatusNoContent)
}

type enrollReq struct {
	Label      string `json:"label"`
	TTLMinutes int    `json:"ttl_minutes"`
}

// handleCreateEnrollment mints a permit so an already-authenticated human can
// add a second device without shell access to the box.
//
// The bootstrap case is different and deliberately harder: with no users at
// all, the only way to create a permit is `herdrer enroll` on the machine
// itself. That asymmetry is the point — a scanner that reaches a fresh box
// before its owner cannot register.
func (s *Server) handleCreateEnrollment(w http.ResponseWriter, r *http.Request) {
	var req enrollReq
	if r.ContentLength > 0 && !DecodeJSON(w, r, &req) {
		return
	}
	ttl := time.Duration(req.TTLMinutes) * time.Minute
	if ttl <= 0 || ttl > time.Hour {
		ttl = s.cfg.EnrollTTL
	}
	code := auth.NewEnrollmentCode()
	e, err := s.st.CreateEnrollment(r.Context(), uuid.NewString(), store.HashToken(code), req.Label, ttl)
	if err != nil {
		Internal(w, err, "create enrollment")
		return
	}
	s.audit(r, "auth.enrollment_created", e.ID, map[string]any{"label": req.Label})
	WriteJSON(w, http.StatusCreated, map[string]any{"code": code, "expires_at": e.ExpiresAt})
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	cur := SessionFrom(r.Context())
	list, err := s.st.ListSessions(r.Context(), u.ID)
	if err != nil {
		Internal(w, err, "list sessions")
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, sess := range list {
		out = append(out, map[string]any{
			"id": sess.ID[:12], "user_agent": sess.UserAgent, "ip": sess.IP,
			"created_at": sess.CreatedAt, "last_seen_at": sess.LastSeenAt,
			"expires_at": sess.ExpiresAt, "current": cur != nil && sess.ID == cur.ID,
		})
	}
	WriteList(w, http.StatusOK, out, Meta{Total: len(out), Page: 1, PerPage: len(out)})
}

func (s *Server) handleRevokeSession(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	prefix := r.PathValue("id")
	list, err := s.st.ListSessions(r.Context(), u.ID)
	if err != nil {
		Internal(w, err, "list sessions")
		return
	}
	// Sessions are exposed by a 12-character prefix so the full cookie hash
	// never leaves the server; resolve it against this user's own sessions
	// only, which also makes the lookup an authorisation check.
	for _, sess := range list {
		if len(sess.ID) >= 12 && sess.ID[:12] == prefix {
			_ = s.st.RevokeSession(r.Context(), sess.ID)
			s.auth.RevokeTicketsForSession(sess.ID)
			s.audit(r, "auth.session_revoked", prefix, nil)
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	WriteError(w, http.StatusNotFound, CodeNotFound, "no such session")
}

func (s *Server) handleRevokeAllSessions(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	n, err := s.st.RevokeAllSessions(r.Context(), u.ID)
	if err != nil {
		Internal(w, err, "revoke all")
		return
	}
	s.audit(r, "auth.all_sessions_revoked", "", map[string]any{"count": n})
	s.auth.Logout(r.Context(), w, r)
	WriteJSON(w, http.StatusOK, map[string]any{"revoked": n})
}

func publicUser(u *store.User) map[string]any {
	if u == nil {
		return nil
	}
	return map[string]any{
		"id": u.ID, "handle": u.Handle, "display_name": u.DisplayName,
		"role": u.Role, "created_at": u.CreatedAt,
	}
}

// --- step-up ---------------------------------------------------------------------

func (s *Server) handleStepUpBegin(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	opts, err := s.auth.BeginStepUp(r.Context(), w, u.ID)
	if err != nil {
		Internal(w, err, "begin step-up")
		return
	}
	WriteJSON(w, http.StatusOK, opts)
}

func (s *Server) handleStepUpFinish(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	sess := SessionFrom(r.Context())
	cred, err := s.auth.FinishStepUp(r.Context(), w, r, sess, u.ID)
	if err != nil {
		Unauthorized(w)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"stepped_up_until": time.Now().Add(s.cfg.StepUpWindow),
		"credential":       map[string]any{"id": cred.ID, "name": cred.Name, "can_terminal": cred.CanTerminal},
	})
}

type credTerminalReq struct {
	Allowed bool `json:"allowed"`
}

// handleSetCredentialTerminal flips a passkey between full access and
// review-only.
//
// Changing a permission is itself a privileged act, so it requires a fresh
// assertion: otherwise a stolen session could simply grant itself the terminal
// rights the step-up gate was there to withhold.
func (s *Server) handleSetCredentialTerminal(w http.ResponseWriter, r *http.Request) {
	var req credTerminalReq
	if !DecodeJSON(w, r, &req) {
		return
	}
	sess := SessionFrom(r.Context())
	if !auth.SteppedUpRecently(sess, s.cfg.StepUpWindow) {
		WriteError(w, http.StatusForbidden, CodeStepUpRequired,
			"changing terminal permission needs a fresh passkey check")
		return
	}
	u := UserFrom(r.Context())
	if err := s.st.SetCredentialTerminal(r.Context(), u.ID, r.PathValue("id"), req.Allowed); err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such passkey")
		return
	}
	s.audit(r, "auth.credential_terminal_changed", r.PathValue("id"),
		map[string]any{"allowed": req.Allowed})
	w.WriteHeader(http.StatusNoContent)
}
