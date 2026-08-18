package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/jclement/herdrer/internal/review"
	"github.com/jclement/herdrer/internal/store"
)

// serializeItem renders an item for the wire.
//
// The expired case is the one that matters. An expired item comes back with no
// answer AND no recommendation: an agent that reads its own suggestion back out
// of a timeout and acts on it has turned "nobody was looking" into "the human
// said yes", which is the single failure mode this whole subsystem exists to
// prevent.
func serializeItem(it *store.ReviewItem, full bool) map[string]any {
	m := map[string]any{
		"id": it.ID, "title": it.Title, "kind": it.Kind, "urgency": it.Urgency,
		"status": it.Status, "options": it.Options, "context": it.Context,
		"created_at": it.CreatedAt, "expires_at": it.ExpiresAt,
		"answered_at": it.AnsweredAt, "answer_value": it.AnswerValue,
		"answer_note": it.AnswerNote, "source": "agent",
	}
	if it.Status == store.StatusExpired {
		m["recommend"] = nil
		m["expired_note"] = "This item expired unanswered. A timeout is not consent: " +
			"do not proceed as though it were approved."
	} else {
		m["recommend"] = it.Recommend
	}
	if full {
		m["body_md"] = it.BodyMD
		m["attachments"] = it.Attachments
	}
	return m
}

// --- human side -----------------------------------------------------------------

func (s *Server) handleListReview(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	items, err := s.st.ListReviewItems(r.Context(), u.ID, "ask", r.URL.Query().Get("status"), 200)
	if err != nil {
		Internal(w, err, "list review")
		return
	}
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		out = append(out, serializeItem(it, false))
	}
	WriteList(w, http.StatusOK, out, Meta{Total: len(out), Page: 1, PerPage: len(out)})
}

// itemForUser loads an item and verifies it belongs to the caller. Every
// per-resource handler goes through this: authentication is not authorisation,
// and an id in a URL is an attacker-controlled value.
func (s *Server) itemForUser(r *http.Request) (*store.ReviewItem, error) {
	u := UserFrom(r.Context())
	it, err := s.st.GetReviewItem(r.Context(), r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	if it.UserID != u.ID {
		return nil, store.ErrNotFound
	}
	return it, nil
}

func (s *Server) handleGetReview(w http.ResponseWriter, r *http.Request) {
	it, err := s.itemForUser(r)
	if err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such item")
		return
	}
	WriteJSON(w, http.StatusOK, serializeItem(it, true))
}

type answerReq struct {
	Value string `json:"value"`
	Note  string `json:"note"`
}

func (s *Server) handleAnswerReview(w http.ResponseWriter, r *http.Request) {
	var req answerReq
	if !DecodeJSON(w, r, &req) {
		return
	}
	u := UserFrom(r.Context())
	it, err := s.review.Answer(r.Context(), r.PathValue("id"), u.ID, req.Value, req.Note)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrNotFound):
			WriteError(w, http.StatusNotFound, CodeNotFound, "no such item")
		case errors.Is(err, review.ErrValidation):
			WriteError(w, http.StatusBadRequest, CodeValidation, err.Error())
		case errors.Is(err, store.ErrConflict):
			WriteError(w, http.StatusConflict, CodeConflict,
				"this item is no longer open — it was answered, cancelled or expired")
		default:
			Internal(w, err, "answer review")
		}
		return
	}
	s.audit(r, "review.answered", it.ID, map[string]any{"value": req.Value, "had_note": req.Note != ""})
	WriteJSON(w, http.StatusOK, serializeItem(it, true))
}

func (s *Server) handleDismissReview(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	id := r.PathValue("id")
	if err := s.review.Cancel(r.Context(), id, nil, &u.ID); err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such open item")
		return
	}
	s.audit(r, "review.dismissed", id, nil)
	w.WriteHeader(http.StatusNoContent)
}

// handleRenderReview serves the sanitised document for the sandboxed iframe.
//
// It returns text/html and is the only endpoint in the application that does.
// The SPA must load it in an iframe with sandbox="allow-scripts" and WITHOUT
// allow-same-origin; the Content-Security-Policy carried in the document
// assumes an opaque origin.
func (s *Server) handleRenderReview(w http.ResponseWriter, r *http.Request) {
	it, err := s.itemForUser(r)
	if err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such item")
		return
	}

	sections := make([]review.Section, 0, len(it.Attachments)+1)
	if strings.TrimSpace(it.BodyMD) != "" {
		sections = append(sections, review.Section{Kind: "markdown", Content: it.BodyMD})
	}
	for _, a := range it.Attachments {
		sections = append(sections, review.Section{
			ID: a.ID, Kind: a.Kind, Title: a.Title, Language: a.Language, Content: a.Content,
		})
	}

	doc, err := s.review.Renderer().Document(it.Title, sections, r.URL.Query().Get("theme") == "dark")
	if err != nil {
		Internal(w, err, "render review")
		return
	}

	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("X-Content-Type-Options", "nosniff")
	// This document is meant to be framed by our own SPA and nothing else.
	h.Set("Content-Security-Policy", "frame-ancestors 'self'")
	h.Del("X-Frame-Options")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(doc))
}

// --- tasks: the reverse channel --------------------------------------------------

type taskReq struct {
	Body  string `json:"body"`
	Scope string `json:"scope"`
}

func (s *Server) handleCreateTask(w http.ResponseWriter, r *http.Request) {
	var req taskReq
	if !DecodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Body) == "" {
		WriteError(w, http.StatusBadRequest, CodeValidation, "body is required")
		return
	}
	u := UserFrom(r.Context())
	now := time.Now()
	it := &store.ReviewItem{
		ID: "tk_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16], UserID: u.ID,
		Direction: "task", Kind: review.KindManual, Title: firstLine(req.Body),
		BodyMD: req.Body, Urgency: review.UrgencyNormal, Status: store.StatusOpen,
		Context:   map[string]any{"scope": req.Scope},
		CreatedAt: now, ExpiresAt: now.Add(30 * 24 * time.Hour),
	}
	if err := s.st.CreateReviewItem(r.Context(), it); err != nil {
		Internal(w, err, "create task")
		return
	}
	s.audit(r, "task.created", it.ID, nil)
	WriteJSON(w, http.StatusCreated, serializeItem(it, true))
}

func (s *Server) handleListTasks(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	items, err := s.st.ListReviewItems(r.Context(), u.ID, "task", r.URL.Query().Get("status"), 200)
	if err != nil {
		Internal(w, err, "list tasks")
		return
	}
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		out = append(out, serializeItem(it, true))
	}
	WriteList(w, http.StatusOK, out, Meta{Total: len(out), Page: 1, PerPage: len(out)})
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i > 0 {
		s = s[:i]
	}
	if len(s) > 120 {
		s = s[:120]
	}
	return strings.TrimSpace(s)
}

// --- agent side -------------------------------------------------------------------

func (s *Server) handleAgentCreateReview(w http.ResponseWriter, r *http.Request) {
	t := TokenFrom(r.Context())
	var req review.CreateRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	it, err := s.review.Create(r.Context(), t.UserID, t.ID, req)
	if err != nil {
		switch {
		case errors.Is(err, review.ErrValidation):
			WriteError(w, http.StatusBadRequest, CodeValidation, err.Error())
		case errors.Is(err, review.ErrBackpressure):
			WriteError(w, http.StatusConflict, CodeConflict, err.Error())
		default:
			Internal(w, err, "create review")
		}
		return
	}
	s.audit(r, "review.created", it.ID, map[string]any{"kind": it.Kind, "urgency": it.Urgency})
	WriteJSON(w, http.StatusCreated, map[string]any{
		"id":         it.ID,
		"url":        strings.TrimRight(s.cfg.Origin, "/") + "/r/" + it.ID,
		"expires_at": it.ExpiresAt,
		"status":     it.Status,
	})
}

// itemForToken enforces that an agent sees only what it submitted.
func (s *Server) itemForToken(r *http.Request) (*store.ReviewItem, error) {
	t := TokenFrom(r.Context())
	it, err := s.st.GetReviewItem(r.Context(), r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	if it.TokenID == nil || *it.TokenID != t.ID {
		return nil, store.ErrNotFound
	}
	return it, nil
}

// handleAgentGetReview is the blocking call that makes this usable.
//
// With ?wait= the request holds open until the item resolves. A whitespace
// heartbeat every 20 seconds keeps reverse proxies and mobile radios from
// tearing the connection down mid-wait; on timeout the item comes back still
// open and the agent re-issues. This is a loop the agent runs, not a promise
// the server makes.
func (s *Server) handleAgentGetReview(w http.ResponseWriter, r *http.Request) {
	it, err := s.itemForToken(r)
	if err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such item")
		return
	}

	waitSec, _ := strconv.Atoi(r.URL.Query().Get("wait"))
	if waitSec <= 0 || it.Status != store.StatusOpen {
		WriteJSON(w, http.StatusOK, serializeItem(it, false))
		return
	}
	max := int(s.cfg.LongpollMax.Seconds())
	if waitSec > max {
		waitSec = max
	}

	flusher, canFlush := w.(http.Flusher)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")

	heartbeat := func() {
		if canFlush {
			// Leading whitespace is legal in JSON and is ignored by every
			// parser, so the eventual body stays valid.
			_, _ = w.Write([]byte(" "))
			flusher.Flush()
		}
	}

	out, err := s.review.Wait(r.Context(), it.ID, time.Duration(waitSec)*time.Second, heartbeat)
	if err != nil {
		Internal(w, err, "wait review")
		return
	}
	WriteJSON(w, http.StatusOK, serializeItem(out, false))
}

func (s *Server) handleAgentCancelReview(w http.ResponseWriter, r *http.Request) {
	t := TokenFrom(r.Context())
	id := r.PathValue("id")
	if err := s.review.Cancel(r.Context(), id, &t.ID, nil); err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such open item")
		return
	}
	s.audit(r, "review.cancelled", id, nil)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAgentListReview(w http.ResponseWriter, r *http.Request) {
	t := TokenFrom(r.Context())
	items, err := s.st.ListReviewItemsForToken(r.Context(), t.ID, r.URL.Query().Get("status"))
	if err != nil {
		Internal(w, err, "list agent review")
		return
	}
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		out = append(out, serializeItem(it, false))
	}
	WriteList(w, http.StatusOK, out, Meta{Total: len(out), Page: 1, PerPage: len(out)})
}

func (s *Server) handleAgentClaimTask(w http.ResponseWriter, r *http.Request) {
	t := TokenFrom(r.Context())
	it, err := s.st.ClaimTask(r.Context(), t.UserID, "token:"+t.ID)
	if err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no pending tasks")
		return
	}
	s.audit(r, "task.claimed", it.ID, nil)
	WriteJSON(w, http.StatusOK, serializeItem(it, true))
}

type completeReq struct {
	Result string `json:"result"`
}

func (s *Server) handleAgentCompleteTask(w http.ResponseWriter, r *http.Request) {
	t := TokenFrom(r.Context())
	var req completeReq
	if !DecodeJSON(w, r, &req) {
		return
	}
	if err := s.st.CompleteTask(r.Context(), r.PathValue("id"), "token:"+t.ID, req.Result); err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such claimed task")
		return
	}
	s.audit(r, "task.completed", r.PathValue("id"), nil)
	w.WriteHeader(http.StatusNoContent)
}
