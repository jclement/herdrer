package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/jclement/herdrer/internal/store"
)

type createTokenReq struct {
	Name    string   `json:"name"`
	Scopes  []string `json:"scopes"`
	TTLDays int      `json:"ttl_days"`
}

// handleCreateToken mints an agent credential.
//
// Only a passkey-authenticated human reaches this handler. An agent cannot mint
// a token, cannot widen its own scopes, and cannot create a second token — the
// privilege gradient only ever runs downhill from a passkey.
func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request) {
	var req createTokenReq
	if !DecodeJSON(w, r, &req) {
		return
	}
	if req.Name == "" {
		WriteError(w, http.StatusBadRequest, CodeValidation, "name is required")
		return
	}
	u := UserFrom(r.Context())
	var ttl time.Duration
	if req.TTLDays > 0 {
		ttl = time.Duration(req.TTLDays) * 24 * time.Hour
	}
	t, secret, err := s.auth.MintToken(r.Context(), u.ID, req.Name, req.Scopes, ttl)
	if err != nil {
		WriteError(w, http.StatusBadRequest, CodeValidation, err.Error())
		return
	}
	s.audit(r, "token.created", t.ID, map[string]any{"name": t.Name, "scopes": t.Scopes})
	// The plaintext appears here and never again; only its SHA-256 is stored.
	WriteJSON(w, http.StatusCreated, map[string]any{"token": publicToken(t), "secret": secret})
}

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	list, err := s.st.ListAPITokens(r.Context(), u.ID)
	if err != nil {
		Internal(w, err, "list tokens")
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, t := range list {
		out = append(out, publicToken(t))
	}
	WriteList(w, http.StatusOK, out, Meta{Total: len(out), Page: 1, PerPage: len(out)})
}

func (s *Server) handleRevokeToken(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	if err := s.st.RevokeAPIToken(r.Context(), u.ID, r.PathValue("id")); err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such token")
		return
	}
	s.audit(r, "token.revoked", r.PathValue("id"), nil)
	w.WriteHeader(http.StatusNoContent)
}

func publicToken(t *store.APIToken) map[string]any {
	return map[string]any{
		"id": t.ID, "name": t.Name, "token_prefix": t.TokenPrefix, "scopes": t.Scopes,
		"created_at": t.CreatedAt, "last_used_at": t.LastUsedAt,
		"expires_at": t.ExpiresAt, "revoked_at": t.RevokedAt,
	}
}

// --- push ------------------------------------------------------------------------

func (s *Server) handlePushKey(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{"public_key": s.notify.PublicKey()})
}

type pushSubReq struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

func (s *Server) handlePushSubscribe(w http.ResponseWriter, r *http.Request) {
	var req pushSubReq
	if !DecodeJSON(w, r, &req) {
		return
	}
	if req.Endpoint == "" || req.Keys.P256dh == "" || req.Keys.Auth == "" {
		WriteError(w, http.StatusBadRequest, CodeValidation, "endpoint and keys are required")
		return
	}
	u := UserFrom(r.Context())
	err := s.st.UpsertPushSub(r.Context(), &store.PushSub{
		ID: uuid.NewString(), UserID: u.ID, Endpoint: req.Endpoint,
		P256dh: req.Keys.P256dh, Auth: req.Keys.Auth,
		UserAgent: r.UserAgent(), CreatedAt: time.Now(),
	})
	if err != nil {
		Internal(w, err, "subscribe push")
		return
	}
	s.audit(r, "push.subscribed", "", nil)
	w.WriteHeader(http.StatusNoContent)
}

// handleListPushSubs shows what the *server* believes is subscribed.
//
// Without this, a browser reporting no subscription is ambiguous: it could be a
// browser that forgot, or a server that never recorded one, and those have
// opposite fixes. The endpoint is deliberately coarse — an endpoint URL is a
// capability to send a push, so only a truncated form and the metadata needed
// to recognise a device are returned.
func (s *Server) handleListPushSubs(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	subs, err := s.st.ListPushSubs(r.Context(), u.ID)
	if err != nil {
		Internal(w, err, "list push subs")
		return
	}
	out := make([]map[string]any, 0, len(subs))
	for _, p := range subs {
		host := p.Endpoint
		if i := strings.Index(host, "://"); i > 0 {
			host = host[i+3:]
		}
		if i := strings.IndexByte(host, '/'); i > 0 {
			host = host[:i]
		}
		out = append(out, map[string]any{
			"id": p.ID, "service": host, "user_agent": p.UserAgent,
			"created_at": p.CreatedAt,
		})
	}
	WriteList(w, http.StatusOK, out, Meta{Total: len(out), Page: 1, PerPage: len(out)})
}

func (s *Server) handlePushTest(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	go s.notify.Send(contextWithoutRequest(r), u.ID, pushTestPayload(s.cfg.Origin))
	w.WriteHeader(http.StatusNoContent)
}

// --- audit -----------------------------------------------------------------------

func (s *Server) handleAudit(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	entries, err := s.st.ListAudit(r.Context(), limit, r.URL.Query().Get("kind"))
	if err != nil {
		Internal(w, err, "list audit")
		return
	}
	WriteList(w, http.StatusOK, entries, Meta{Total: len(entries), Page: 1, PerPage: len(entries)})
}
