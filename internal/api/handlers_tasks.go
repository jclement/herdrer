package api

// The task surface: the human files and steers tasks from the browser; the
// worker reports through the agent tree. The dispatcher itself lives in
// internal/tasks — these handlers only move rows and wake it.

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/jclement/herdrer/internal/review"
	"github.com/jclement/herdrer/internal/store"
	"github.com/jclement/herdrer/internal/terminal"
)

// workerHeader is how a worker names itself. Spoofable by another local
// process, and that is accepted: per D12 the token tree is cross-talk
// prevention and audit naming, not a boundary — the passkey remains the
// boundary, and nothing under /agent/ can reach a shell.
const workerHeader = "X-Herdrer-Agent"

func serializeTask(t *store.Task) map[string]any {
	m := map[string]any{
		"id": t.ID, "title": t.Title, "kind": t.Kind, "repo": t.Repo,
		"branch": t.Branch, "priority": t.Priority, "status": t.Status,
		"claimed_by": t.ClaimedBy, "worktree": t.Worktree, "attempt": t.Attempt,
		"result": t.Result, "has_tail": t.Tail != nil && *t.Tail != "",
		"created_at": t.CreatedAt, "updated_at": t.UpdatedAt,
		"dispatched_at": t.DispatchedAt, "accepted_at": t.AcceptedAt,
		"finished_at": t.FinishedAt,
	}
	return m
}

func serializeTaskFull(t *store.Task) map[string]any {
	m := serializeTask(t)
	m["body_md"] = t.BodyMD
	return m
}

func serializeEvent(e store.TaskEvent) map[string]any {
	return map[string]any{"at": e.At, "actor": e.Actor, "kind": e.Kind, "detail": e.Detail}
}

// --- human side -----------------------------------------------------------------

type createTaskReq struct {
	Title    string `json:"title"`
	BodyMD   string `json:"body_md"`
	Kind     string `json:"kind"`
	Repo     string `json:"repo"`
	Branch   string `json:"branch"`
	Priority int    `json:"priority"`
	RunNow   bool   `json:"run_now"`
}

func (s *Server) validateTaskFields(req *createTaskReq) (string, bool) {
	req.Title = strings.TrimSpace(req.Title)
	req.BodyMD = strings.TrimSpace(req.BodyMD)
	if req.Title == "" {
		req.Title = firstLine(req.BodyMD)
	}
	if req.Title == "" {
		return "a task needs at least a title or a body", false
	}
	if len(req.Title) > 300 {
		return "title must be 300 characters or fewer", false
	}
	if len(req.BodyMD) > 64*1024 {
		return "body_md is over 64 KiB", false
	}
	switch req.Kind {
	case "":
		req.Kind = "change"
	case "change", "investigate", "chore":
	default:
		return "kind must be change, investigate or chore", false
	}
	req.Repo = strings.TrimSpace(strings.Trim(req.Repo, "/"))
	if strings.Contains(req.Repo, "..") {
		return "repo must be a plain path under the repo root", false
	}
	if req.Branch != "" && !terminal.ValidBranch(req.Branch) {
		return "that is not a usable branch name", false
	}
	if req.Priority < -10 || req.Priority > 10 {
		return "priority must be between -10 and 10", false
	}
	return "", true
}

func (s *Server) handleCreateTask(w http.ResponseWriter, r *http.Request) {
	var req createTaskReq
	if !DecodeJSON(w, r, &req) {
		return
	}
	if msg, ok := s.validateTaskFields(&req); !ok {
		WriteError(w, http.StatusBadRequest, CodeValidation, msg)
		return
	}
	u := UserFrom(r.Context())
	now := time.Now()
	status := store.TaskInbox
	if req.RunNow {
		status = store.TaskReady
	}
	t := &store.Task{
		ID:     "tk_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16],
		UserID: u.ID, Title: req.Title, BodyMD: req.BodyMD, Kind: req.Kind,
		Repo: req.Repo, Branch: req.Branch, Priority: req.Priority,
		Status: status, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.st.CreateTask(r.Context(), t, "user:"+u.ID); err != nil {
		Internal(w, err, "create task")
		return
	}
	s.audit(r, "task.created", t.ID, map[string]any{"repo": t.Repo, "run_now": req.RunNow})
	if s.tasks != nil {
		s.tasks.Wake()
	}
	s.bus.Publish(u.ID, map[string]any{"type": "task.updated", "id": t.ID})
	WriteJSON(w, http.StatusCreated, serializeTaskFull(t))
}

func (s *Server) handleListTasks(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	items, err := s.st.ListTasks(r.Context(), u.ID, r.URL.Query().Get("status"), 200)
	if err != nil {
		Internal(w, err, "list tasks")
		return
	}
	out := make([]map[string]any, 0, len(items))
	for _, t := range items {
		out = append(out, serializeTask(t))
	}
	WriteList(w, http.StatusOK, out, Meta{Total: len(out), Page: 1, PerPage: len(out)})
}

// taskForUser loads a task and verifies ownership; an id in a URL is an
// attacker-controlled value even behind a session.
func (s *Server) taskForUser(r *http.Request) (*store.Task, error) {
	u := UserFrom(r.Context())
	t, err := s.st.GetTask(r.Context(), r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	if t.UserID != u.ID {
		return nil, store.ErrNotFound
	}
	return t, nil
}

func (s *Server) handleGetTask(w http.ResponseWriter, r *http.Request) {
	t, err := s.taskForUser(r)
	if err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such task")
		return
	}
	events, err := s.st.ListTaskEvents(r.Context(), t.ID)
	if err != nil {
		Internal(w, err, "task events")
		return
	}
	items, err := s.st.ReviewItemsForTask(r.Context(), t.ID)
	if err != nil {
		Internal(w, err, "task items")
		return
	}
	evOut := make([]map[string]any, 0, len(events))
	for _, e := range events {
		evOut = append(evOut, serializeEvent(e))
	}
	itOut := make([]map[string]any, 0, len(items))
	for _, it := range items {
		itOut = append(itOut, serializeItem(it, false))
	}
	out := serializeTaskFull(t)
	out["events"] = evOut
	out["items"] = itOut
	WriteJSON(w, http.StatusOK, out)
}

func (s *Server) handleEditTask(w http.ResponseWriter, r *http.Request) {
	t, err := s.taskForUser(r)
	if err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such task")
		return
	}
	var req createTaskReq
	if !DecodeJSON(w, r, &req) {
		return
	}
	if msg, ok := s.validateTaskFields(&req); !ok {
		WriteError(w, http.StatusBadRequest, CodeValidation, msg)
		return
	}
	u := UserFrom(r.Context())
	if err := s.st.UpdateTaskFields(r.Context(), t.ID, u.ID,
		req.Title, req.BodyMD, req.Repo, req.Branch, req.Priority); err != nil {
		WriteError(w, http.StatusConflict, CodeConflict,
			"a task can only be edited before it is picked up")
		return
	}
	s.audit(r, "task.edited", t.ID, nil)
	out, err := s.st.GetTask(r.Context(), t.ID)
	if err != nil {
		Internal(w, err, "reload task")
		return
	}
	WriteJSON(w, http.StatusOK, serializeTaskFull(out))
}

// humanTransition is the shared shape of ready/cancel/retry/close.
func (s *Server) humanTransition(w http.ResponseWriter, r *http.Request,
	from []string, to, eventKind, detail string, set map[string]any, conflictMsg string) *store.Task {
	t, err := s.taskForUser(r)
	if err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such task")
		return nil
	}
	u := UserFrom(r.Context())
	if err := s.st.TransitionTask(r.Context(), t.ID, from, to, "user:"+u.ID, eventKind, detail, set); err != nil {
		WriteError(w, http.StatusConflict, CodeConflict, conflictMsg)
		return nil
	}
	s.audit(r, "task."+eventKind, t.ID, nil)
	if s.tasks != nil {
		s.tasks.Wake()
	}
	s.bus.Publish(u.ID, map[string]any{"type": "task.updated", "id": t.ID})
	out, err := s.st.GetTask(r.Context(), t.ID)
	if err != nil {
		Internal(w, err, "reload task")
		return nil
	}
	WriteJSON(w, http.StatusOK, serializeTaskFull(out))
	return out
}

func (s *Server) handleReadyTask(w http.ResponseWriter, r *http.Request) {
	s.humanTransition(w, r, []string{store.TaskInbox}, store.TaskReady,
		"triaged", "", nil, "only an inbox task can be marked ready")
}

func (s *Server) handleCancelTask(w http.ResponseWriter, r *http.Request) {
	t := s.humanTransition(w, r,
		[]string{store.TaskInbox, store.TaskReady, store.TaskDispatching,
			store.TaskDoing, store.TaskBlocked, store.TaskReview},
		store.TaskCancelled, "cancelled", "",
		map[string]any{"claimed_by": nil, "finished_at": time.Now().Unix()},
		"this task is already finished")
	if t == nil {
		return
	}
	// Withdraw the task's open questions too: an inbox full of questions
	// nobody needs answered any more is how the inbox stops being useful.
	u := UserFrom(r.Context())
	if items, err := s.st.ReviewItemsForTask(r.Context(), t.ID); err == nil {
		for _, it := range items {
			if it.Status == store.StatusOpen {
				_ = s.review.Cancel(r.Context(), it.ID, nil, &u.ID)
			}
		}
	}
}

func (s *Server) handleRetryTask(w http.ResponseWriter, r *http.Request) {
	s.humanTransition(w, r, []string{store.TaskFailed, store.TaskReview}, store.TaskReady,
		"triaged", "retried by the human; the worktree is reused",
		map[string]any{"attempt": 0, "claimed_by": nil},
		"only a failed or in-review task can be retried")
}

type closeTaskReq struct {
	Result string `json:"result"`
}

// handleCloseTask lets the human close a task that is held for review — the
// exit for the vanished-worker and went-quiet paths, where the tail shows the
// work is actually done and no one is left to report it.
func (s *Server) handleCloseTask(w http.ResponseWriter, r *http.Request) {
	var req closeTaskReq
	if !DecodeJSON(w, r, &req) {
		return
	}
	result := strings.TrimSpace(req.Result)
	if result == "" {
		result = "closed by the operator"
	}
	s.humanTransition(w, r, []string{store.TaskReview}, store.TaskDone,
		"done", "closed by the human",
		map[string]any{"result": result, "finished_at": time.Now().Unix()},
		"only a task held for review can be closed; cancel or retry the others")
}

func (s *Server) handleTaskTail(w http.ResponseWriter, r *http.Request) {
	t, err := s.taskForUser(r)
	if err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such task")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"tail": t.Tail, "tail_at": t.TailAt,
		"note": "terminal capture — evidence, not a verified result",
	})
}

// --- agent side -------------------------------------------------------------------

// taskForWorker loads a task and verifies the caller is its assigned worker:
// either the Herdr agent named in the header, or the external token that
// claimed it. Everything else sees NOT_FOUND, not FORBIDDEN — an agent must
// not be able to enumerate another worker's tasks.
func (s *Server) taskForWorker(r *http.Request) (*store.Task, string, error) {
	tok := TokenFrom(r.Context())
	t, err := s.st.GetTask(r.Context(), r.PathValue("id"))
	if err != nil {
		return nil, "", err
	}
	if t.UserID != tok.UserID || t.ClaimedBy == nil {
		return nil, "", store.ErrNotFound
	}
	worker := strings.TrimSpace(r.Header.Get(workerHeader))
	switch {
	case *t.ClaimedBy == "ext:"+tok.ID:
		return t, *t.ClaimedBy, nil
	case worker != "" && *t.ClaimedBy == worker:
		return t, "worker:" + worker, nil
	}
	return nil, "", store.ErrNotFound
}

// workerConflict maps a refused transition to what the worker should be told.
func workerConflict(w http.ResponseWriter, t *store.Task) {
	if t.Status == store.TaskCancelled {
		WriteError(w, http.StatusConflict, CodeConflict,
			"TASK_CANCELLED: the human withdrew this task — stop working on it")
		return
	}
	WriteError(w, http.StatusConflict, CodeConflict, "task is not in an eligible state for that")
}

// handleAgentNextTask returns the task assigned to the calling worker, in
// full. 204 when there is none.
func (s *Server) handleAgentNextTask(w http.ResponseWriter, r *http.Request) {
	tok := TokenFrom(r.Context())
	worker := strings.TrimSpace(r.Header.Get(workerHeader))
	if worker == "" {
		WriteError(w, http.StatusBadRequest, CodeValidation,
			workerHeader+" header is required: it names the worker you are")
		return
	}
	t, err := s.st.TaskForWorker(r.Context(), worker)
	if err != nil || t.UserID != tok.UserID {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	WriteJSON(w, http.StatusOK, serializeTaskFull(t))
}

// handleAgentAcceptTask is the ack that proves the poke landed — the call that
// makes dispatch acknowledged rather than fire-and-forget.
func (s *Server) handleAgentAcceptTask(w http.ResponseWriter, r *http.Request) {
	t, actor, err := s.taskForWorker(r)
	if err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such task assigned to you")
		return
	}
	err = s.st.TransitionTask(r.Context(), t.ID, []string{store.TaskDispatching}, store.TaskDoing,
		actor, "accepted", "", map[string]any{"accepted_at": time.Now().Unix()})
	if err != nil && t.Status != store.TaskDoing {
		// Accepting twice is an idempotent retry, not an error; anything else
		// is a real conflict.
		fresh, gerr := s.st.GetTask(r.Context(), t.ID)
		if gerr != nil || fresh.Status != store.TaskDoing {
			workerConflict(w, t)
			return
		}
	}
	s.audit(r, "task.accepted", t.ID, nil)
	s.bus.Publish(t.UserID, map[string]any{"type": "task.updated", "id": t.ID})
	out, err := s.st.GetTask(r.Context(), t.ID)
	if err != nil {
		Internal(w, err, "reload task")
		return
	}
	WriteJSON(w, http.StatusOK, serializeTaskFull(out))
}

type noteReq struct {
	Text string `json:"text"`
}

// handleAgentNoteTask appends a finding without changing state. Notes are what
// make the timeline worth reading — and what survives if the worker dies.
func (s *Server) handleAgentNoteTask(w http.ResponseWriter, r *http.Request) {
	t, actor, err := s.taskForWorker(r)
	if err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such task assigned to you")
		return
	}
	var req noteReq
	if !DecodeJSON(w, r, &req) {
		return
	}
	req.Text = strings.TrimSpace(req.Text)
	if req.Text == "" || len(req.Text) > 16*1024 {
		WriteError(w, http.StatusBadRequest, CodeValidation, "a note needs text, under 16 KiB")
		return
	}
	if store.TaskTerminal(t.Status) {
		workerConflict(w, t)
		return
	}
	if err := s.st.AddTaskEvent(r.Context(), t.ID, actor, "note", req.Text); err != nil {
		Internal(w, err, "task note")
		return
	}
	s.bus.Publish(t.UserID, map[string]any{"type": "task.updated", "id": t.ID})
	w.WriteHeader(http.StatusNoContent)
}

// handleAgentAskTask files a question as an ordinary review item linked to the
// task, and blocks the task on it. All of §5's semantics apply: recommend is
// mandatory for choice/confirm, expiry is never consent, the note outranks the
// button.
func (s *Server) handleAgentAskTask(w http.ResponseWriter, r *http.Request) {
	t, actor, err := s.taskForWorker(r)
	if err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such task assigned to you")
		return
	}
	tok := TokenFrom(r.Context())
	var req review.CreateRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if err := s.st.TransitionTask(r.Context(), t.ID, []string{store.TaskDoing}, store.TaskBlocked,
		actor, "asked", req.Title, nil); err != nil {
		workerConflict(w, t)
		return
	}
	it, err := s.review.Create(r.Context(), tok.UserID, tok.ID, req)
	if err != nil {
		// Roll the block back: a task blocked on a question that was refused
		// would wait forever on nothing.
		_ = s.st.TransitionTask(r.Context(), t.ID, []string{store.TaskBlocked}, store.TaskDoing,
			actor, "note", "question was refused: "+err.Error(), nil)
		switch {
		case errors.Is(err, review.ErrValidation):
			WriteError(w, http.StatusBadRequest, CodeValidation, err.Error())
		case errors.Is(err, review.ErrBackpressure):
			WriteError(w, http.StatusConflict, CodeConflict, err.Error())
		default:
			Internal(w, err, "task ask")
		}
		return
	}
	_ = s.st.LinkReviewItemToTask(r.Context(), it.ID, t.ID)
	s.audit(r, "task.asked", t.ID, map[string]any{"item": it.ID})
	s.bus.Publish(t.UserID, map[string]any{"type": "task.updated", "id": t.ID})
	WriteJSON(w, http.StatusCreated, map[string]any{
		"id":         it.ID,
		"url":        strings.TrimRight(s.cfg.Origin, "/") + "/r/" + it.ID,
		"expires_at": it.ExpiresAt,
		"status":     it.Status,
	})
}

type doneReq struct {
	Result       string `json:"result"`
	ReviewItemID string `json:"review_item_id"`
}

// handleAgentDoneTask records the outcome. `result` is required, always — an
// investigation must record what it found. A change must additionally deliver
// a review: the task is then held for the human rather than closed.
func (s *Server) handleAgentDoneTask(w http.ResponseWriter, r *http.Request) {
	t, actor, err := s.taskForWorker(r)
	if err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such task assigned to you")
		return
	}
	tok := TokenFrom(r.Context())
	var req doneReq
	if !DecodeJSON(w, r, &req) {
		return
	}
	req.Result = strings.TrimSpace(req.Result)
	if req.Result == "" {
		WriteError(w, http.StatusBadRequest, CodeValidation,
			"result is required: record what you found or did, not just that you finished")
		return
	}
	if len(req.Result) > 32*1024 {
		WriteError(w, http.StatusBadRequest, CodeValidation, "result is over 32 KiB")
		return
	}

	if req.ReviewItemID != "" {
		it, err := s.st.GetReviewItem(r.Context(), req.ReviewItemID)
		if err != nil || it.TokenID == nil || *it.TokenID != tok.ID {
			WriteError(w, http.StatusBadRequest, CodeValidation,
				"review_item_id does not name a review item this token submitted")
			return
		}
		if err := s.st.LinkReviewItemToTask(r.Context(), it.ID, t.ID); err != nil {
			Internal(w, err, "link review")
			return
		}
	}

	hasOpen, err := s.st.HasOpenReviewItemForTask(r.Context(), t.ID)
	if err != nil {
		Internal(w, err, "task done")
		return
	}
	if t.Kind == "change" && !hasOpen {
		WriteError(w, http.StatusBadRequest, CodeValidation,
			"a change is delivered by review: post a review item first "+
				"(POST /api/v1/agent/review, then pass its id as review_item_id)")
		return
	}

	from := []string{store.TaskDoing, store.TaskBlocked}
	if hasOpen {
		// Held for the human; the review item's answer decides what happens.
		if err := s.st.TransitionTask(r.Context(), t.ID, from, store.TaskReview,
			actor, "delivered", req.Result, map[string]any{"result": req.Result}); err != nil {
			workerConflict(w, t)
			return
		}
	} else {
		if err := s.st.TransitionTask(r.Context(), t.ID, from, store.TaskDone,
			actor, "done", req.Result,
			map[string]any{"result": req.Result, "finished_at": time.Now().Unix()}); err != nil {
			workerConflict(w, t)
			return
		}
	}
	s.audit(r, "task.done", t.ID, map[string]any{"held_for_review": hasOpen})
	if s.tasks != nil {
		s.tasks.Wake()
	}
	s.bus.Publish(t.UserID, map[string]any{"type": "task.updated", "id": t.ID})
	out, err := s.st.GetTask(r.Context(), t.ID)
	if err != nil {
		Internal(w, err, "reload task")
		return
	}
	WriteJSON(w, http.StatusOK, serializeTaskFull(out))
}

type releaseReq struct {
	Note string `json:"note"`
}

// handleAgentReleaseTask puts a task back on the queue: cone's rule is
// "release before you stop — releasing is not failure, holding is."
func (s *Server) handleAgentReleaseTask(w http.ResponseWriter, r *http.Request) {
	t, actor, err := s.taskForWorker(r)
	if err != nil {
		WriteError(w, http.StatusNotFound, CodeNotFound, "no such task assigned to you")
		return
	}
	var req releaseReq
	if !DecodeJSON(w, r, &req) {
		return
	}
	req.Note = strings.TrimSpace(req.Note)
	if req.Note == "" {
		WriteError(w, http.StatusBadRequest, CodeValidation,
			"note is required: say why you are releasing, for whoever picks it up next")
		return
	}
	if err := s.st.TransitionTask(r.Context(), t.ID,
		[]string{store.TaskDispatching, store.TaskDoing, store.TaskBlocked}, store.TaskReady,
		actor, "released", req.Note, map[string]any{"claimed_by": nil}); err != nil {
		workerConflict(w, t)
		return
	}
	s.audit(r, "task.released", t.ID, nil)
	if s.tasks != nil {
		s.tasks.Wake()
	}
	s.bus.Publish(t.UserID, map[string]any{"type": "task.updated", "id": t.ID})
	w.WriteHeader(http.StatusNoContent)
}

// handleAgentClaimTask is cone's inbox contract: one GET hands the caller one
// queued task, 204 when there are none. External pullers only claim tasks the
// local dispatcher will not run — repo-unbound ones, or an explicit ?repo=.
func (s *Server) handleAgentClaimTask(w http.ResponseWriter, r *http.Request) {
	tok := TokenFrom(r.Context())
	repo := strings.TrimSpace(r.URL.Query().Get("repo"))
	t, err := s.st.ClaimNextReadyTask(r.Context(), tok.UserID, "ext:"+tok.ID, repo)
	if errors.Is(err, store.ErrNotFound) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		Internal(w, err, "claim task")
		return
	}
	s.audit(r, "task.claimed", t.ID, map[string]any{"external": true})
	s.bus.Publish(t.UserID, map[string]any{"type": "task.updated", "id": t.ID})
	WriteJSON(w, http.StatusOK, serializeTaskFull(t))
}
