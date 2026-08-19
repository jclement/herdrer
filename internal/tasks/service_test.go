package tasks

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jclement/herdrer/internal/review"
	"github.com/jclement/herdrer/internal/store"
	"github.com/jclement/herdrer/internal/terminal"
)

// fakeHerdr is the box, scripted. Every verb records what was asked of it.
type fakeHerdr struct {
	mu       sync.Mutex
	enabled  bool
	running  bool
	agents   []terminal.Agent
	prompts  []string
	starts   []string
	tail     string
	failNext string // verb name that should fail once
}

func (f *fakeHerdr) Enabled() bool { return f.enabled }

func (f *fakeHerdr) Snapshot(context.Context) (*terminal.State, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return &terminal.State{Running: f.running, Agents: append([]terminal.Agent(nil), f.agents...)}, nil
}

func (f *fakeHerdr) CreateWorktree(_ context.Context, repo, branch string) (*terminal.Worktree, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failNext == "worktree" {
		f.failNext = ""
		return nil, contextErr("worktree create refused")
	}
	return &terminal.Worktree{Path: filepath.Join(repo, ".wt", branch), WorkspaceID: "w9", PaneID: "w9:p1"}, nil
}

func (f *fakeHerdr) OpenWorktree(_ context.Context, path string) (*terminal.Worktree, error) {
	return &terminal.Worktree{Path: path, WorkspaceID: "w9", PaneID: "w9:p1"}, nil
}

func (f *fakeHerdr) StartAgent(_ context.Context, name, paneID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts = append(f.starts, name)
	f.agents = append(f.agents, terminal.Agent{Name: name, Kind: "claude", Status: "working", PaneID: paneID})
	return nil
}

func (f *fakeHerdr) Prompt(_ context.Context, agentName, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prompts = append(f.prompts, agentName+": "+text)
	return nil
}

func (f *fakeHerdr) ReadTail(context.Context, string, int) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tail, nil
}

func (f *fakeHerdr) setAgentStatus(name, status string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range f.agents {
		if f.agents[i].Name == name {
			f.agents[i].Status = status
		}
	}
}

func (f *fakeHerdr) dropAgent(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.agents[:0]
	for _, a := range f.agents {
		if a.Name != name {
			out = append(out, a)
		}
	}
	f.agents = out
}

type contextErr string

func (e contextErr) Error() string { return string(e) }

func newTestService(t *testing.T) (*Service, *store.Store, *fakeHerdr, *review.Service) {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.CreateUser(ctx, &store.User{
		ID: "user-1", Handle: "jeff", DisplayName: "Jeff", Role: "admin", CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	f := &fakeHerdr{enabled: true, running: true}
	rv := review.New(st, nil, nil, 25, 24, 168)
	svc := New(st, f, rv, nil, nil, Options{
		RepoRoot: t.TempDir(), WorkerCap: 2,
		AcceptTimeout: 5 * time.Minute, NudgeAfter: 10 * time.Minute,
		GiveUpAfter: 30 * time.Minute, TailMaxBytes: 4096, MaxAttempts: 2,
		Origin: "https://example.net",
	})
	rv.SetResolvedHook(svc.OnReviewResolved)
	return svc, st, f, rv
}

func fileTask(t *testing.T, st *store.Store, id, repo, status string) *store.Task {
	t.Helper()
	now := time.Now()
	task := &store.Task{
		ID: id, UserID: "user-1", Title: "do the thing", BodyMD: "details",
		Kind: "change", Repo: repo, Status: status, CreatedAt: now, UpdatedAt: now,
	}
	if err := st.CreateTask(context.Background(), task, "test"); err != nil {
		t.Fatal(err)
	}
	return task
}

// TestDispatchProvisionsAndPokes covers the happy path: a ready task gets a
// worktree, a named worker, and a bootstrap prompt carrying only minted ids.
func TestDispatchProvisionsAndPokes(t *testing.T) {
	svc, st, f, _ := newTestService(t)
	ctx := context.Background()
	fileTask(t, st, "tk_0123456789abcdef", "myrepo", store.TaskReady)

	if err := svc.tick(ctx); err != nil {
		t.Fatal(err)
	}

	task, err := st.GetTask(ctx, "tk_0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != store.TaskDispatching {
		t.Fatalf("status = %q, want dispatching", task.Status)
	}
	if task.ClaimedBy == nil || *task.ClaimedBy != "hw-01234567" {
		t.Fatalf("claimed_by = %v, want hw-01234567", task.ClaimedBy)
	}
	if task.Worktree == "" || task.PaneID != "w9:p1" {
		t.Fatalf("binding not recorded: worktree=%q pane=%q", task.Worktree, task.PaneID)
	}
	if len(f.starts) != 1 || f.starts[0] != "hw-01234567" {
		t.Fatalf("starts = %v", f.starts)
	}
	if len(f.prompts) != 1 || !strings.Contains(f.prompts[0], "tk_0123456789abcdef") {
		t.Fatalf("prompts = %v", f.prompts)
	}
	// The prompt must not carry the task's human-authored content.
	if strings.Contains(f.prompts[0], "do the thing") || strings.Contains(f.prompts[0], "details") {
		t.Fatalf("task-authored bytes reached agent.prompt: %q", f.prompts[0])
	}
}

// TestOneWriterPerRepo proves per-repo exclusivity is structural.
func TestOneWriterPerRepo(t *testing.T) {
	svc, st, f, _ := newTestService(t)
	ctx := context.Background()
	fileTask(t, st, "tk_aaaaaaaaaaaaaaaa", "same", store.TaskReady)
	fileTask(t, st, "tk_bbbbbbbbbbbbbbbb", "same", store.TaskReady)

	if err := svc.tick(ctx); err != nil {
		t.Fatal(err)
	}
	if len(f.starts) != 1 {
		t.Fatalf("started %d workers in one repo, want 1", len(f.starts))
	}
	b, _ := st.GetTask(ctx, "tk_bbbbbbbbbbbbbbbb")
	if b.Status != store.TaskReady {
		t.Fatalf("second task in the repo should stay ready, got %q", b.Status)
	}
}

// TestWorkerCap proves the cap holds across repos.
func TestWorkerCap(t *testing.T) {
	svc, st, f, _ := newTestService(t)
	ctx := context.Background()
	fileTask(t, st, "tk_aaaaaaaaaaaaaaaa", "r1", store.TaskReady)
	fileTask(t, st, "tk_bbbbbbbbbbbbbbbb", "r2", store.TaskReady)
	fileTask(t, st, "tk_cccccccccccccccc", "r3", store.TaskReady)

	if err := svc.tick(ctx); err != nil {
		t.Fatal(err)
	}
	if len(f.starts) != 2 {
		t.Fatalf("started %d workers, want the cap of 2", len(f.starts))
	}
}

// TestRepoUnboundTasksAreLeftForExternalPullers: the local dispatcher only
// runs work it can put in a worktree.
func TestRepoUnboundTasksAreLeftForExternalPullers(t *testing.T) {
	svc, st, f, _ := newTestService(t)
	ctx := context.Background()
	fileTask(t, st, "tk_aaaaaaaaaaaaaaaa", "", store.TaskReady)

	if err := svc.tick(ctx); err != nil {
		t.Fatal(err)
	}
	if len(f.starts) != 0 {
		t.Fatalf("dispatched a repo-unbound task")
	}
	task, _ := st.GetTask(ctx, "tk_aaaaaaaaaaaaaaaa")
	if task.Status != store.TaskReady {
		t.Fatalf("status = %q, want ready", task.Status)
	}
}

// TestAcceptTimeoutRequeuesThenFails covers failure mode #1: poke sent, agent
// never acted. First a retry with the attempt counted; once attempts are
// spent, failed — never a silent hang in dispatching.
func TestAcceptTimeoutRequeuesThenFails(t *testing.T) {
	svc, st, f, _ := newTestService(t)
	svc.opts.AcceptTimeout = 0 // every dispatching task is instantly overdue
	ctx := context.Background()
	fileTask(t, st, "tk_0123456789abcdef", "myrepo", store.TaskReady)

	if err := svc.tick(ctx); err != nil { // dispatch
		t.Fatal(err)
	}
	if err := svc.tick(ctx); err != nil { // accept timeout → ready, attempt 1
		t.Fatal(err)
	}
	task, _ := st.GetTask(ctx, "tk_0123456789abcdef")
	if task.Status != store.TaskReady || task.Attempt != 1 {
		t.Fatalf("after first timeout: status=%q attempt=%d, want ready/1", task.Status, task.Attempt)
	}

	// Exhaust the attempts: dispatch + timeout twice more.
	for range 2 {
		f.dropAgent("hw-01234567") // the stale fake agent from the last round
		if err := svc.tick(ctx); err != nil {
			t.Fatal(err)
		}
		if err := svc.tick(ctx); err != nil {
			t.Fatal(err)
		}
	}
	task, _ = st.GetTask(ctx, "tk_0123456789abcdef")
	if task.Status != store.TaskFailed {
		t.Fatalf("status = %q, want failed after attempts are spent", task.Status)
	}
}

// TestVanishedWorkerWithTailIsHeldForReview is the 2am rule: a task with
// captured output is never silently re-queued.
func TestVanishedWorkerWithTailIsHeldForReview(t *testing.T) {
	svc, st, f, _ := newTestService(t)
	ctx := context.Background()
	fileTask(t, st, "tk_0123456789abcdef", "myrepo", store.TaskReady)

	if err := svc.tick(ctx); err != nil {
		t.Fatal(err)
	}
	// The worker accepts, produces output, then dies.
	if err := st.TransitionTask(ctx, "tk_0123456789abcdef",
		[]string{store.TaskDispatching}, store.TaskDoing, "worker:hw-01234567", "accepted", "", nil); err != nil {
		t.Fatal(err)
	}
	if err := st.SetTaskTail(ctx, "tk_0123456789abcdef", "test suite: 41 passed"); err != nil {
		t.Fatal(err)
	}
	f.dropAgent("hw-01234567")

	if err := svc.tick(ctx); err != nil {
		t.Fatal(err)
	}
	task, _ := st.GetTask(ctx, "tk_0123456789abcdef")
	if task.Status != store.TaskReview {
		t.Fatalf("status = %q, want review — evidence must never be re-queued", task.Status)
	}
	// And a synthetic inbox item exists so the phone buzzes.
	items, err := st.ReviewItemsForTask(ctx, task.ID)
	if err != nil || len(items) == 0 {
		t.Fatalf("no synthetic review item was filed (err=%v)", err)
	}
}

// TestVanishedWorkerWithNothingToShowRequeues: bare crashes go back on the
// queue with the attempt counted.
func TestVanishedWorkerWithNothingToShowRequeues(t *testing.T) {
	svc, st, f, _ := newTestService(t)
	ctx := context.Background()
	fileTask(t, st, "tk_0123456789abcdef", "myrepo", store.TaskReady)

	if err := svc.tick(ctx); err != nil {
		t.Fatal(err)
	}
	if err := st.TransitionTask(ctx, "tk_0123456789abcdef",
		[]string{store.TaskDispatching}, store.TaskDoing, "worker:hw-01234567", "accepted", "", nil); err != nil {
		t.Fatal(err)
	}
	f.dropAgent("hw-01234567")

	if err := svc.tick(ctx); err != nil {
		t.Fatal(err)
	}
	task, _ := st.GetTask(ctx, "tk_0123456789abcdef")
	if task.Status != store.TaskReady || task.Attempt != 1 {
		t.Fatalf("status=%q attempt=%d, want ready/1", task.Status, task.Attempt)
	}
	if task.Worktree == "" {
		t.Fatal("worktree binding lost on requeue; a retry must reuse the checkout")
	}
}

// TestQuietWorkerIsNudgedOnceThenHeld covers failure mode #3: finished without
// reporting. One nudge per quiet period, then held for review.
func TestQuietWorkerIsNudgedOnceThenHeld(t *testing.T) {
	svc, st, f, _ := newTestService(t)
	svc.opts.NudgeAfter = 0 // instantly quiet
	ctx := context.Background()
	fileTask(t, st, "tk_0123456789abcdef", "myrepo", store.TaskReady)

	if err := svc.tick(ctx); err != nil {
		t.Fatal(err)
	}
	if err := st.TransitionTask(ctx, "tk_0123456789abcdef",
		[]string{store.TaskDispatching}, store.TaskDoing, "worker:hw-01234567", "accepted", "", nil); err != nil {
		t.Fatal(err)
	}
	f.setAgentStatus("hw-01234567", "done")
	f.tail = "some terminal output"

	promptsBefore := len(f.prompts)
	if err := svc.tick(ctx); err != nil {
		t.Fatal(err)
	}
	if err := svc.tick(ctx); err != nil { // a second tick must not nudge again
		t.Fatal(err)
	}
	nudges := 0
	for _, p := range f.prompts[promptsBefore:] {
		if strings.Contains(p, "looks idle") {
			nudges++
		}
	}
	if nudges != 1 {
		t.Fatalf("nudged %d times in one quiet period, want exactly 1", nudges)
	}

	// The nudge accomplished nothing and the give-up window elapses.
	svc.opts.GiveUpAfter = 0
	if err := svc.tick(ctx); err != nil {
		t.Fatal(err)
	}
	task, _ := st.GetTask(ctx, "tk_0123456789abcdef")
	if task.Status != store.TaskReview {
		t.Fatalf("status = %q, want review", task.Status)
	}
	if task.Tail == nil || *task.Tail == "" {
		t.Fatal("tail was not captured before holding for review")
	}
}

// TestAnswerUnblocksAndRelays: the review hook moves blocked → doing and tells
// the worker to fetch — without inlining the answer.
func TestAnswerUnblocksAndRelays(t *testing.T) {
	svc, st, f, rv := newTestService(t)
	ctx := context.Background()
	fileTask(t, st, "tk_0123456789abcdef", "myrepo", store.TaskReady)

	if err := svc.tick(ctx); err != nil {
		t.Fatal(err)
	}
	if err := st.TransitionTask(ctx, "tk_0123456789abcdef",
		[]string{store.TaskDispatching}, store.TaskDoing, "worker:hw-01234567", "accepted", "", nil); err != nil {
		t.Fatal(err)
	}

	// The worker asks (as the API handler would): item created and linked,
	// task blocked.
	it, err := rv.Create(ctx, "user-1", "", review.CreateRequest{
		Title: "Which auth flow?", Kind: review.KindConfirm, Recommend: "yes",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.LinkReviewItemToTask(ctx, it.ID, "tk_0123456789abcdef"); err != nil {
		t.Fatal(err)
	}
	if err := st.TransitionTask(ctx, "tk_0123456789abcdef",
		[]string{store.TaskDoing}, store.TaskBlocked, "worker:hw-01234567", "asked", it.Title, nil); err != nil {
		t.Fatal(err)
	}

	promptsBefore := len(f.prompts)
	if _, err := rv.Answer(ctx, it.ID, "user-1", "yes", "but rename the flag first"); err != nil {
		t.Fatal(err)
	}
	task, _ := st.GetTask(ctx, "tk_0123456789abcdef")
	if task.Status != store.TaskDoing {
		t.Fatalf("status = %q, want doing after the answer", task.Status)
	}
	if len(f.prompts) != promptsBefore+1 {
		t.Fatalf("expected exactly one relay prompt, got %d", len(f.prompts)-promptsBefore)
	}
	relay := f.prompts[len(f.prompts)-1]
	if strings.Contains(relay, "rename the flag") || strings.Contains(relay, "Which auth flow") {
		t.Fatalf("the relay inlined human/agent content into agent.prompt: %q", relay)
	}
}

// TestExpiredQuestionNeverAdvancesTheTask: a timeout is not consent, and now
// also not progress.
func TestExpiredQuestionNeverAdvancesTheTask(t *testing.T) {
	svc, st, _, rv := newTestService(t)
	ctx := context.Background()
	fileTask(t, st, "tk_0123456789abcdef", "myrepo", store.TaskReady)
	if err := svc.tick(ctx); err != nil {
		t.Fatal(err)
	}
	if err := st.TransitionTask(ctx, "tk_0123456789abcdef",
		[]string{store.TaskDispatching}, store.TaskBlocked, "worker:hw-01234567", "asked", "", nil); err != nil {
		// blocked straight from dispatching is not a legal move; go via doing
		if err := st.TransitionTask(ctx, "tk_0123456789abcdef",
			[]string{store.TaskDispatching}, store.TaskDoing, "worker:hw-01234567", "accepted", "", nil); err != nil {
			t.Fatal(err)
		}
		if err := st.TransitionTask(ctx, "tk_0123456789abcdef",
			[]string{store.TaskDoing}, store.TaskBlocked, "worker:hw-01234567", "asked", "", nil); err != nil {
			t.Fatal(err)
		}
	}

	it, err := rv.Create(ctx, "user-1", "", review.CreateRequest{
		Title: "Proceed?", Kind: review.KindConfirm, Recommend: "yes", ExpiresInHours: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.LinkReviewItemToTask(ctx, it.ID, "tk_0123456789abcdef"); err != nil {
		t.Fatal(err)
	}

	// Force the expiry and fire the hook the sweeper would fire.
	if _, err := st.DB().ExecContext(ctx,
		`UPDATE review_items SET status = 'expired' WHERE id = ?`, it.ID); err != nil {
		t.Fatal(err)
	}
	expired, err := st.GetReviewItem(ctx, it.ID)
	if err != nil {
		t.Fatal(err)
	}
	svc.OnReviewResolved(ctx, expired)

	task, _ := st.GetTask(ctx, "tk_0123456789abcdef")
	if task.Status != store.TaskBlocked {
		t.Fatalf("status = %q, want blocked — expiry must not advance a task", task.Status)
	}
}

// TestApprovedReviewClosesTheTask: the delivery loop, end to end at the
// service layer.
func TestApprovedReviewClosesTheTask(t *testing.T) {
	svc, st, _, rv := newTestService(t)
	ctx := context.Background()
	fileTask(t, st, "tk_0123456789abcdef", "myrepo", store.TaskReady)
	if err := svc.tick(ctx); err != nil {
		t.Fatal(err)
	}
	if err := st.TransitionTask(ctx, "tk_0123456789abcdef",
		[]string{store.TaskDispatching}, store.TaskDoing, "worker:hw-01234567", "accepted", "", nil); err != nil {
		t.Fatal(err)
	}

	it, err := rv.Create(ctx, "user-1", "", review.CreateRequest{
		Title: "Review: the change", Kind: review.KindReview, BodyMD: "the diff",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.LinkReviewItemToTask(ctx, it.ID, "tk_0123456789abcdef"); err != nil {
		t.Fatal(err)
	}
	if err := st.TransitionTask(ctx, "tk_0123456789abcdef",
		[]string{store.TaskDoing}, store.TaskReview, "worker:hw-01234567", "delivered", "done: the change",
		map[string]any{"result": "done: the change"}); err != nil {
		t.Fatal(err)
	}

	if _, err := rv.Answer(ctx, it.ID, "user-1", "approve", ""); err != nil {
		t.Fatal(err)
	}
	task, _ := st.GetTask(ctx, "tk_0123456789abcdef")
	if task.Status != store.TaskDone {
		t.Fatalf("status = %q, want done after approval", task.Status)
	}
	if task.Result == nil || *task.Result == "" {
		t.Fatal("the result did not survive to done")
	}
}

// TestExternalClaimIsAtomic: cone's contract — many callers, one winner.
func TestExternalClaimIsAtomic(t *testing.T) {
	_, st, _, _ := newTestService(t)
	ctx := context.Background()
	fileTask(t, st, "tk_0123456789abcdef", "", store.TaskReady)

	won := 0
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			if _, err := st.ClaimNextReadyTask(ctx, "user-1", "ext:tok"+string(rune('a'+n)), ""); err == nil {
				mu.Lock()
				won++
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	if won != 1 {
		t.Fatalf("%d claimants won one task, want exactly 1", won)
	}
}
