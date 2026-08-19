// Package tasks is the coordinator: a deterministic dispatcher that hands
// queued tasks to Claude Code workers under Herdr and never loses track,
// because the plan is SQLite rows rather than any model's context.
//
// Cone needed an LLM lead because cone is a folder with no daemon — something
// had to hold the plan, and only a model was awake. herdrer is a daemon with a
// database, so the division of labour is strict: Go owns the queue, the cap,
// the claims, the reap and the timeline; Claude Code appears in exactly one
// role, a per-task worker that herdrer provisions, briefs, monitors and reaps.
// herdrer itself never makes an LLM call.
//
// Unlike cone's fire-and-forget heartbeat, dispatch here is acknowledged: the
// worker must call back over the authenticated API to accept, or the dispatch
// demonstrably failed and deterministic code handles it. Cone's ready-set hash
// is not stolen because the problem it solved is deleted.
package tasks

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"time"

	"github.com/jclement/herdrer/internal/notify"
	"github.com/jclement/herdrer/internal/review"
	"github.com/jclement/herdrer/internal/store"
	"github.com/jclement/herdrer/internal/terminal"
)

// Herdr is what the dispatcher needs from the box: the snapshot and the four
// shell-equivalent verbs. Implemented by internal/terminal; faked in tests.
type Herdr interface {
	Enabled() bool
	Snapshot(ctx context.Context) (*terminal.State, error)
	CreateWorktree(ctx context.Context, repoPath, branch string) (*terminal.Worktree, error)
	OpenWorktree(ctx context.Context, path string) (*terminal.Worktree, error)
	StartAgent(ctx context.Context, name, paneID string) error
	Prompt(ctx context.Context, agentName, text string) error
	ReadTail(ctx context.Context, agentName string, lines int) (string, error)
}

// Broadcaster publishes realtime events to connected browsers.
type Broadcaster interface {
	Publish(userID string, event any)
}

// Notifier wakes the human's phone.
type Notifier interface {
	Send(ctx context.Context, userID string, p notify.Payload)
}

// Options are the dispatcher's knobs, resolved from config.
type Options struct {
	RepoRoot      string
	WorkerCap     int
	AcceptTimeout time.Duration
	NudgeAfter    time.Duration
	GiveUpAfter   time.Duration
	TailMaxBytes  int
	MaxAttempts   int
	Origin        string
}

// Service is the coordinator.
type Service struct {
	st     *store.Store
	herdr  Herdr
	review *review.Service
	bus    Broadcaster
	notify Notifier
	opts   Options

	wakeCh chan struct{}
}

// New builds the service. Run starts the loop.
func New(st *store.Store, h Herdr, rv *review.Service, bus Broadcaster, n Notifier, opts Options) *Service {
	if opts.WorkerCap < 1 {
		opts.WorkerCap = 1
	}
	if opts.TailMaxBytes <= 0 {
		opts.TailMaxBytes = 16384
	}
	return &Service{st: st, herdr: h, review: rv, bus: bus, notify: n, opts: opts,
		wakeCh: make(chan struct{}, 1)}
}

// Wake asks the loop to run now rather than at the next tick. Non-blocking.
func (s *Service) Wake() {
	select {
	case s.wakeCh <- struct{}{}:
	default:
	}
}

// Run is the loop: reconcile, then dispatch, every five seconds or on wake.
// Idle cost is one SQLite query; Herdr is only consulted while something is
// in flight or claimable.
func (s *Service) Run(ctx context.Context) {
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			case <-s.wakeCh:
			}
			if err := s.tick(ctx); err != nil {
				// Loud, per cone: a heartbeat that fails quietly is
				// indistinguishable from one with nothing to do.
				slog.Error("task dispatcher tick failed", "err", err)
			}
		}
	}()
}

func (s *Service) tick(ctx context.Context) error {
	active, err := s.st.TasksByStatus(ctx, store.TaskDispatching, store.TaskDoing, store.TaskBlocked)
	if err != nil {
		return err
	}
	ready, err := s.st.TasksByStatus(ctx, store.TaskReady)
	if err != nil {
		return err
	}
	if len(active) == 0 && len(ready) == 0 {
		return nil
	}
	// Task execution is a shell-tier feature: review-only mode keeps the queue
	// visible but neither dispatches nor monitors.
	if !s.herdr.Enabled() {
		return nil
	}

	snap, err := s.herdr.Snapshot(ctx)
	if err != nil {
		return err
	}
	if !snap.Running {
		// An ordinary state on a box that just booted, not an error — but the
		// queue screen must be able to say so, which task age already does.
		return nil
	}

	byName := map[string]terminal.Agent{}
	for _, a := range snap.Agents {
		byName[a.Name] = a
	}

	for _, t := range active {
		s.reconcileOne(ctx, t, byName)
	}
	s.dispatch(ctx, ready, len(active))
	return nil
}

// --- the monitor -----------------------------------------------------------------

func (s *Service) reconcileOne(ctx context.Context, t *store.Task, agents map[string]terminal.Agent) {
	worker := ""
	if t.ClaimedBy != nil {
		worker = *t.ClaimedBy
	}
	// External claims have no pane to watch; their contract is the API alone.
	if strings.HasPrefix(worker, "ext:") {
		return
	}
	agent, alive := agents[worker]

	if !alive {
		s.reapVanished(ctx, t)
		return
	}

	switch t.Status {
	case store.TaskDispatching:
		if t.DispatchedAt != nil && time.Since(*t.DispatchedAt) > s.opts.AcceptTimeout {
			// The poke demonstrably failed: the worker never called accept.
			// Capture whatever the pane shows first — the prompt may have
			// half-landed, and evidence beats a mystery.
			s.captureTail(ctx, t, worker)
			s.retryOrFail(ctx, t, "accept timeout: the worker never called back")
		}
	case store.TaskDoing:
		if agent.Status != "done" && agent.Status != "idle" {
			return
		}
		// The worker's pane has settled while the task is still assigned: the
		// 2am problem. Capture, nudge once, and if it stays quiet hold the
		// task for review — never silently re-queue work that has evidence.
		s.captureTail(ctx, t, worker)
		last, nudges, err := s.st.LastWorkerActivity(ctx, t.ID)
		if err != nil {
			slog.Error("task quiet check failed", "task", t.ID, "err", err)
			return
		}
		quiet := time.Since(last)
		switch {
		case quiet > s.opts.GiveUpAfter:
			s.holdForReview(ctx, t, "worker went quiet; the terminal capture below is the only account of what happened")
		case quiet > s.opts.NudgeAfter && nudges == 0:
			if err := s.herdr.Prompt(ctx, worker, NudgePrompt(t.ID)); err != nil {
				slog.Warn("nudge failed", "task", t.ID, "err", err)
				return
			}
			_ = s.st.AddTaskEvent(ctx, t.ID, "monitor", "nudged", "pane idle with the task still assigned")
			s.publish(t)
		}
	case store.TaskBlocked:
		// Waiting on a human is the one legitimate way to be quiet.
	}
}

// reapVanished handles a worker whose agent Herdr no longer knows: a crash, a
// closed pane, a Herdr restart.
func (s *Service) reapVanished(ctx context.Context, t *store.Task) {
	hasOpen, err := s.st.HasOpenReviewItemForTask(ctx, t.ID)
	if err != nil {
		slog.Error("reap check failed", "task", t.ID, "err", err)
		return
	}
	if (t.Tail != nil && *t.Tail != "") || hasOpen {
		// There is evidence. Hold for the human rather than re-queueing work
		// that may in fact be finished (the 2am rule).
		if err := s.st.TransitionTask(ctx, t.ID,
			[]string{store.TaskDispatching, store.TaskDoing, store.TaskBlocked},
			store.TaskReview, "monitor", "reaped", "worker vanished; held for review", nil); err != nil {
			return
		}
		if !hasOpen {
			s.postSyntheticItem(ctx, t, "Worker vanished: "+t.Title,
				"The worker for this task disappeared — a crash, a closed pane, or a Herdr "+
					"restart. Its last terminal output is attached to the task. Decide from the "+
					"task page: retry it, close it, or cancel it.")
		}
		s.notifyHuman(ctx, t, "Task needs review", "worker vanished — "+t.Title)
		s.publish(t)
		return
	}
	s.retryOrFail(ctx, t, "worker vanished with nothing to show")
}

// retryOrFail re-queues a task that produced no evidence, or fails it loudly
// once the attempts are spent.
func (s *Service) retryOrFail(ctx context.Context, t *store.Task, why string) {
	from := []string{store.TaskDispatching, store.TaskDoing, store.TaskBlocked}
	if t.Attempt+1 > s.opts.MaxAttempts {
		if err := s.st.TransitionTask(ctx, t.ID, from, store.TaskFailed, "monitor", "failed",
			why+fmt.Sprintf(" (attempt %d of %d)", t.Attempt+1, s.opts.MaxAttempts),
			map[string]any{"attempt": t.Attempt + 1, "claimed_by": nil,
				"finished_at": time.Now().Unix()}); err != nil {
			return
		}
		s.notifyHuman(ctx, t, "Task failed", t.Title)
		s.publish(t)
		return
	}
	if err := s.st.TransitionTask(ctx, t.ID, from, store.TaskReady, "monitor", "reaped",
		why, map[string]any{"attempt": t.Attempt + 1, "claimed_by": nil}); err != nil {
		return
	}
	s.publish(t)
}

// holdForReview parks a finished-looking task for the human, with a synthetic
// inbox item so the phone buzzes.
func (s *Service) holdForReview(ctx context.Context, t *store.Task, why string) {
	if err := s.st.TransitionTask(ctx, t.ID,
		[]string{store.TaskDoing, store.TaskBlocked},
		store.TaskReview, "monitor", "captured", why, nil); err != nil {
		return
	}
	hasOpen, _ := s.st.HasOpenReviewItemForTask(ctx, t.ID)
	if !hasOpen {
		s.postSyntheticItem(ctx, t, "Worker went quiet: "+t.Title,
			"The worker stopped reporting while this task was still assigned to it. Its "+
				"terminal capture is on the task page — the work may be finished and unreported, "+
				"or stuck. Decide from the task page: retry, close as done, or cancel.")
	}
	s.notifyHuman(ctx, t, "Task needs review", t.Title)
	s.publish(t)
}

// captureTail replaces the task's terminal evidence with the pane's current
// screen. Replaced, not appended; capped; never search-indexed.
func (s *Service) captureTail(ctx context.Context, t *store.Task, worker string) {
	tail, err := s.herdr.ReadTail(ctx, worker, 200)
	if err != nil || strings.TrimSpace(tail) == "" {
		return
	}
	if len(tail) > s.opts.TailMaxBytes {
		// Keep the end: the latest output is the evidence.
		tail = tail[len(tail)-s.opts.TailMaxBytes:]
	}
	if err := s.st.SetTaskTail(ctx, t.ID, tail); err != nil {
		slog.Error("tail capture failed", "task", t.ID, "err", err)
	}
}

// --- the dispatcher ---------------------------------------------------------------

func (s *Service) dispatch(ctx context.Context, ready []*store.Task, active int) {
	for _, t := range ready {
		if active >= s.opts.WorkerCap {
			return
		}
		// Repo-unbound tasks are for external pullers (cone's contract); the
		// local dispatcher only runs work it can put in a worktree.
		if t.Repo == "" {
			continue
		}
		repoPath, err := s.resolveRepo(t.Repo)
		if err != nil {
			_ = s.st.TransitionTask(ctx, t.ID, []string{store.TaskReady}, store.TaskFailed,
				"dispatcher", "failed", err.Error(),
				map[string]any{"finished_at": time.Now().Unix()})
			s.publish(t)
			continue
		}
		if busy, err := s.st.ActiveTaskInRepo(ctx, t.UserID, t.Repo); err != nil || busy {
			continue // one writer per repo, structurally
		}

		worker := workerName(t.ID)
		if err := s.st.TransitionTask(ctx, t.ID, []string{store.TaskReady}, store.TaskDispatching,
			"dispatcher", "dispatched", "starting a worker",
			map[string]any{"claimed_by": worker, "dispatched_at": time.Now().Unix(),
				"attempt": t.Attempt}); err != nil {
			continue // someone else won the claim; not an error
		}

		if err := s.provision(ctx, t, worker, repoPath); err != nil {
			slog.Warn("dispatch failed", "task", t.ID, "err", err)
			_ = s.st.AddTaskEvent(ctx, t.ID, "dispatcher", "error", err.Error())
			fresh, gerr := s.st.GetTask(ctx, t.ID)
			if gerr == nil {
				s.retryOrFail(ctx, fresh, "could not start a worker")
			}
			continue
		}
		active++
		s.publish(t)
	}
}

// provision creates (or reopens) the worktree, starts a named Claude Code
// agent in its root pane, and sends the bootstrap poke. herdrer does this
// deterministically so a task never depends on a model remembering to open a
// worktree.
func (s *Service) provision(ctx context.Context, t *store.Task, worker, repoPath string) error {
	// Starting Claude Code waits for interactive readiness, so this leg gets
	// its own generous timeout rather than inheriting the tick's.
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()

	var wt *terminal.Worktree
	var err error
	if t.Worktree != "" {
		// A retry: reuse the recorded checkout so work already on the branch
		// survives.
		wt, err = s.herdr.OpenWorktree(ctx, t.Worktree)
	} else {
		branch := t.Branch
		if branch == "" {
			branch = "task/" + strings.TrimPrefix(t.ID, "tk_")
		}
		if !terminal.ValidBranch(branch) {
			return fmt.Errorf("branch %q is not a usable branch name", branch)
		}
		wt, err = s.herdr.CreateWorktree(ctx, repoPath, branch)
	}
	if err != nil {
		return err
	}
	if err := s.st.SetTaskBinding(ctx, t.ID, wt.Path, wt.PaneID); err != nil {
		return err
	}
	if err := s.herdr.StartAgent(ctx, worker, wt.PaneID); err != nil {
		return err
	}
	return s.herdr.Prompt(ctx, worker, BootstrapPrompt(t.ID, worker))
}

// resolveRepo maps a task's repo field to a real checkout under RepoRoot, and
// nothing else: a repo value is attacker-adjacent input on its way to argv.
func (s *Service) resolveRepo(repo string) (string, error) {
	if s.opts.RepoRoot == "" {
		return "", fmt.Errorf("no HERDRER_REPO_ROOT configured; cannot place a worktree")
	}
	clean := filepath.Clean(repo)
	if clean != repo || strings.HasPrefix(clean, ".") || strings.HasPrefix(clean, "/") ||
		strings.Contains(clean, "..") {
		return "", fmt.Errorf("repo %q is not a plain path under the repo root", repo)
	}
	abs := filepath.Join(s.opts.RepoRoot, clean)
	return abs, nil
}

// workerName derives the server-minted worker handle from the task id.
func workerName(taskID string) string {
	return "hw-" + strings.TrimPrefix(taskID, "tk_")[:8]
}

// --- the review hook ---------------------------------------------------------------

// OnReviewResolved is called by the review service whenever an item leaves the
// open state. Task-linked items drive task transitions; everything else is
// ignored.
func (s *Service) OnReviewResolved(ctx context.Context, it *store.ReviewItem) {
	if it.TaskID == nil {
		return
	}
	t, err := s.st.GetTask(ctx, *it.TaskID)
	if err != nil {
		return
	}

	switch it.Status {
	case store.StatusAnswered:
		if it.Kind == review.KindReview {
			s.onDeliveryAnswered(ctx, t, it)
			return
		}
		// A question came back. Unblock and tell the worker to fetch it — the
		// answer itself is never inlined into agent.prompt (prompts.go).
		note := ""
		if it.AnswerNote != nil && *it.AnswerNote != "" {
			note = " (with a note)"
		}
		if err := s.st.TransitionTask(ctx, t.ID, []string{store.TaskBlocked}, store.TaskDoing,
			"monitor", "answered", "question answered"+note, nil); err == nil {
			s.relay(ctx, t, AnswerPrompt(t.ID))
			s.publish(t)
		}
	case store.StatusCancelled:
		// A withdrawal, not a denial — but a blocked task with no open item is
		// a wedge, so let the worker carry on.
		if t.Status == store.TaskBlocked {
			if open, _ := s.st.HasOpenReviewItemForTask(ctx, t.ID); !open {
				if err := s.st.TransitionTask(ctx, t.ID, []string{store.TaskBlocked}, store.TaskDoing,
					"monitor", "answered", "question withdrawn by the human", nil); err == nil {
					s.relay(ctx, t, NudgePrompt(t.ID))
					s.publish(t)
				}
			}
		}
	case store.StatusExpired:
		// A timeout is never consent, and now also never progress: the task
		// stays blocked, visibly, rather than advancing on silence.
		_ = s.st.AddTaskEvent(ctx, t.ID, "monitor", "note",
			"a question expired unanswered — nothing was decided")
		s.publish(t)
	}
}

// onDeliveryAnswered closes the loop on a worker's delivered review.
func (s *Service) onDeliveryAnswered(ctx context.Context, t *store.Task, it *store.ReviewItem) {
	val := ""
	if it.AnswerValue != nil {
		val = strings.ToLower(*it.AnswerValue)
	}
	approved := val == "approve" || val == "approved" || val == "yes" || val == "lgtm" || val == "ship"

	if approved {
		if err := s.st.TransitionTask(ctx, t.ID,
			[]string{store.TaskReview, store.TaskDoing, store.TaskBlocked},
			store.TaskDone, "monitor", "approved", "review approved",
			map[string]any{"finished_at": time.Now().Unix()}); err == nil {
			// A note on an approval is still an instruction; make sure the
			// worker sees it rather than the button alone.
			if it.AnswerNote != nil && *it.AnswerNote != "" {
				s.relay(ctx, t, AnswerPrompt(t.ID))
			}
			s.publish(t)
		}
		return
	}

	// Changes requested. Back to the worker if it is still alive, otherwise to
	// the queue with the decision preserved on the timeline.
	alive := s.workerAlive(ctx, t)
	if alive {
		if err := s.st.TransitionTask(ctx, t.ID,
			[]string{store.TaskReview, store.TaskDoing, store.TaskBlocked},
			store.TaskDoing, "monitor", "changes_requested", "changes requested on review", nil); err == nil {
			s.relay(ctx, t, AnswerPrompt(t.ID))
			s.publish(t)
		}
		return
	}
	if err := s.st.TransitionTask(ctx, t.ID,
		[]string{store.TaskReview, store.TaskDoing, store.TaskBlocked},
		store.TaskReady, "monitor", "changes_requested",
		"changes requested; the worker is gone, so the task is queued for a fresh one",
		map[string]any{"claimed_by": nil}); err == nil {
		s.publish(t)
	}
}

func (s *Service) workerAlive(ctx context.Context, t *store.Task) bool {
	if t.ClaimedBy == nil || strings.HasPrefix(*t.ClaimedBy, "ext:") {
		return false
	}
	snap, err := s.herdr.Snapshot(ctx)
	if err != nil || !snap.Running {
		return false
	}
	for _, a := range snap.Agents {
		if a.Name == *t.ClaimedBy {
			return true
		}
	}
	return false
}

// relay prompts the task's worker, if there is one to prompt. Failure is an
// event, not an error: the worker also long-polls, so the prompt is a
// latency optimisation, not the delivery mechanism.
func (s *Service) relay(ctx context.Context, t *store.Task, prompt string) {
	if t.ClaimedBy == nil || strings.HasPrefix(*t.ClaimedBy, "ext:") {
		return
	}
	if !s.workerAlive(ctx, t) {
		return
	}
	if err := s.herdr.Prompt(ctx, *t.ClaimedBy, prompt); err != nil {
		slog.Warn("relay prompt failed", "task", t.ID, "err", err)
	}
}

// --- odds and ends ------------------------------------------------------------------

// postSyntheticItem files an inbox item on herdrer's own behalf, so a task that
// needs eyes buzzes the phone the same way an agent's question does.
func (s *Service) postSyntheticItem(ctx context.Context, t *store.Task, title, body string) {
	it, err := s.review.Create(ctx, t.UserID, "", review.CreateRequest{
		Title: title, Kind: review.KindAck, BodyMD: body,
		Context:        map[string]any{"repo": t.Repo, "worker": deref(t.ClaimedBy), "task": t.ID},
		Urgency:        review.UrgencyNormal,
		ExpiresInHours: 7 * 24,
	})
	if err != nil {
		slog.Error("could not post a synthetic review item", "task", t.ID, "err", err)
		return
	}
	_ = s.st.LinkReviewItemToTask(ctx, it.ID, t.ID)
}

func (s *Service) notifyHuman(ctx context.Context, t *store.Task, title, body string) {
	if s.notify == nil {
		return
	}
	s.notify.Send(context.WithoutCancel(ctx), t.UserID, notify.Payload{
		Title: title, Body: body,
		URL: strings.TrimRight(s.opts.Origin, "/") + "/tasks/" + t.ID,
		Tag: t.ID, Kind: "task",
	})
}

func (s *Service) publish(t *store.Task) {
	if s.bus != nil {
		s.bus.Publish(t.UserID, map[string]any{"type": "task.updated", "id": t.ID})
	}
	s.Wake()
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
