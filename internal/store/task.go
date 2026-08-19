package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Task is one unit of delegated work: filed by the human, dispatched to a
// Claude Code worker under Herdr, delivered back through the review inbox.
//
// The lifecycle is SQLite rows and guarded UPDATEs, deliberately: the plan
// lives here, not in any model's context, so nothing can "lose track" of a
// task without leaving a row that says so.
type Task struct {
	ID           string
	UserID       string
	Title        string
	BodyMD       string
	Kind         string // change | investigate | chore
	Repo         string
	Branch       string
	Priority     int
	Status       string
	ClaimedBy    *string
	Worktree     string
	PaneID       string
	Attempt      int
	Result       *string
	Tail         *string
	TailAt       *time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
	DispatchedAt *time.Time
	AcceptedAt   *time.Time
	FinishedAt   *time.Time
}

// Task lifecycle statuses. inbox → ready → dispatching → doing → blocked ⇄
// doing → review → done, with failed and cancelled as the other exits.
const (
	TaskInbox       = "inbox"
	TaskReady       = "ready"
	TaskDispatching = "dispatching"
	TaskDoing       = "doing"
	TaskBlocked     = "blocked"
	TaskReview      = "review"
	TaskDone        = "done"
	TaskFailed      = "failed"
	TaskCancelled   = "cancelled"
)

// TaskActive reports whether a status holds a worker slot.
func TaskActive(status string) bool {
	switch status {
	case TaskDispatching, TaskDoing, TaskBlocked:
		return true
	}
	return false
}

// TaskTerminal reports whether a status is an exit.
func TaskTerminal(status string) bool {
	switch status {
	case TaskDone, TaskFailed, TaskCancelled:
		return true
	}
	return false
}

// TaskEvent is one row of a task's append-only timeline.
type TaskEvent struct {
	ID     int64
	TaskID string
	At     time.Time
	Actor  string
	Kind   string
	Detail string
}

const taskSelect = `
	SELECT id, user_id, title, body_md, kind, repo, branch, priority, status,
	       claimed_by, worktree, pane_id, attempt, result, tail, tail_at,
	       created_at, updated_at, dispatched_at, accepted_at, finished_at
	FROM tasks`

// CreateTask inserts a task and its "filed" event in one transaction.
func (s *Store) CreateTask(ctx context.Context, t *Task, actor string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO tasks (id, user_id, title, body_md, kind, repo, branch, priority,
			status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ID, t.UserID, t.Title, t.BodyMD, t.Kind, t.Repo, t.Branch, t.Priority,
		t.Status, t.CreatedAt.Unix(), t.UpdatedAt.Unix()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO task_events (task_id, at, actor, kind, detail) VALUES (?, ?, ?, 'filed', ?)`,
		t.ID, t.CreatedAt.Unix(), actor, t.Status); err != nil {
		return err
	}
	return tx.Commit()
}

// GetTask loads one task.
func (s *Store) GetTask(ctx context.Context, id string) (*Task, error) {
	t, err := scanTask(s.db.QueryRowContext(ctx, taskSelect+` WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return t, err
}

// ListTasks returns a user's tasks. status filters to one status; "" returns
// everything non-terminal plus recent terminals, "all" returns everything.
func (s *Store) ListTasks(ctx context.Context, userID, status string, limit int) ([]*Task, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	q := taskSelect + ` WHERE user_id = ?`
	args := []any{userID}
	switch status {
	case "":
		// The default view: the whole board minus old terminal rows, so the
		// queue screen is one call.
		q += ` AND (status NOT IN ('done','failed','cancelled') OR updated_at > ?)`
		args = append(args, time.Now().Add(-7*24*time.Hour).Unix())
	case "all":
	default:
		q += ` AND status = ?`
		args = append(args, status)
	}
	q += ` ORDER BY priority DESC, created_at DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// TasksByStatus returns every task in the given statuses, for the dispatcher.
func (s *Store) TasksByStatus(ctx context.Context, statuses ...string) ([]*Task, error) {
	if len(statuses) == 0 {
		return nil, nil
	}
	q := taskSelect + ` WHERE status IN (?` + repeat(",?", len(statuses)-1) + `)
		ORDER BY priority DESC, created_at ASC`
	args := make([]any, len(statuses))
	for i, st := range statuses {
		args[i] = st
	}
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func repeat(s string, n int) string {
	out := ""
	for range n {
		out += s
	}
	return out
}

// UpdateTaskFields edits title/body/repo/branch/priority while the task has
// not been picked up. Guarded on status so an edit cannot race a dispatch.
func (s *Store) UpdateTaskFields(ctx context.Context, id, userID, title, body, repo, branch string, priority int) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE tasks SET title = ?, body_md = ?, repo = ?, branch = ?, priority = ?, updated_at = ?
		WHERE id = ? AND user_id = ? AND status IN ('inbox','ready')`,
		title, body, repo, branch, priority, time.Now().Unix(), id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("%w: task is not editable in its current state", ErrConflict)
	}
	return nil
}

// TransitionTask moves a task between statuses with an atomic guard: the
// UPDATE only fires if the task is still in one of the expected statuses, so
// two racing actors cannot both win a transition. Every successful transition
// appends a timeline event in the same transaction.
func (s *Store) TransitionTask(ctx context.Context, id string, from []string, to, actor, eventKind, detail string, set map[string]any) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	now := time.Now().Unix()
	q := `UPDATE tasks SET status = ?, updated_at = ?`
	args := []any{to, now}
	for _, col := range []string{"claimed_by", "worktree", "pane_id", "attempt", "result",
		"dispatched_at", "accepted_at", "finished_at"} {
		if v, ok := set[col]; ok {
			q += `, ` + col + ` = ?`
			args = append(args, v)
		}
	}
	q += ` WHERE id = ? AND status IN (?` + repeat(",?", len(from)-1) + `)`
	args = append(args, id)
	for _, f := range from {
		args = append(args, f)
	}

	res, err := tx.ExecContext(ctx, q, args...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("%w: task is not in an eligible state", ErrConflict)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO task_events (task_id, at, actor, kind, detail) VALUES (?, ?, ?, ?, ?)`,
		id, now, actor, eventKind, detail); err != nil {
		return err
	}
	return tx.Commit()
}

// AddTaskEvent appends to the timeline without changing state (cone's `note`).
func (s *Store) AddTaskEvent(ctx context.Context, taskID, actor, kind, detail string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO task_events (task_id, at, actor, kind, detail) VALUES (?, ?, ?, ?, ?)`,
		taskID, time.Now().Unix(), actor, kind, detail)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE tasks SET updated_at = ? WHERE id = ?`,
		time.Now().Unix(), taskID)
	return err
}

// ListTaskEvents returns a task's timeline, oldest first.
func (s *Store) ListTaskEvents(ctx context.Context, taskID string) ([]TaskEvent, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, task_id, at, actor, kind, detail FROM task_events
		WHERE task_id = ? ORDER BY at, id LIMIT 500`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TaskEvent
	for rows.Next() {
		var e TaskEvent
		var at int64
		if err := rows.Scan(&e.ID, &e.TaskID, &at, &e.Actor, &e.Kind, &e.Detail); err != nil {
			return nil, err
		}
		e.At = time.Unix(at, 0)
		out = append(out, e)
	}
	return out, rows.Err()
}

// LastWorkerActivity returns when the task's timeline last moved for a reason
// other than the dispatcher nudging it, and how many nudges have happened
// since. This is what the monitor's quiet-period logic reads.
func (s *Store) LastWorkerActivity(ctx context.Context, taskID string) (last time.Time, nudgesSince int, err error) {
	var at sql.NullInt64
	err = s.db.QueryRowContext(ctx, `
		SELECT MAX(at) FROM task_events WHERE task_id = ? AND kind NOT IN ('nudged','captured')`,
		taskID).Scan(&at)
	if err != nil {
		return time.Time{}, 0, err
	}
	if at.Valid {
		last = time.Unix(at.Int64, 0)
	}
	err = s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM task_events WHERE task_id = ? AND kind = 'nudged' AND at >= ?`,
		taskID, at.Int64).Scan(&nudgesSince)
	return last, nudgesSince, err
}

// SetTaskBinding records where a task's worker lives: the worktree path (the
// durable half) and the pane id (advisory; pane ids do not survive pane.move).
func (s *Store) SetTaskBinding(ctx context.Context, taskID, worktree, paneID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE tasks SET worktree = ?, pane_id = ?, updated_at = ? WHERE id = ?`,
		worktree, paneID, time.Now().Unix(), taskID)
	return err
}

// LinkReviewItemToTask attaches an existing review item to a task. Server-side
// only: the submitting agent never chooses the link.
func (s *Store) LinkReviewItemToTask(ctx context.Context, itemID, taskID string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE review_items SET task_id = ? WHERE id = ?`, taskID, itemID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetTaskTail replaces the captured terminal evidence. Replaced, not appended:
// Herdr marks agents done at the end of every turn, so an append would stack
// near-duplicates of the same screen.
func (s *Store) SetTaskTail(ctx context.Context, taskID, tail string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE tasks SET tail = ?, tail_at = ? WHERE id = ?`,
		tail, time.Now().Unix(), taskID)
	return err
}

// ClaimNextReadyTask atomically hands one ready task to an external puller
// (cone's inbox contract). Only repo-unbound tasks, or tasks matching the
// caller's repo, are eligible: a puller on another box cannot usefully take
// work bound to this box's checkouts.
func (s *Store) ClaimNextReadyTask(ctx context.Context, userID, claimant, repo string) (*Task, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	q := `SELECT id FROM tasks WHERE user_id = ? AND status = 'ready'`
	args := []any{userID}
	if repo == "" {
		q += ` AND repo = ''`
	} else {
		q += ` AND repo = ?`
		args = append(args, repo)
	}
	q += ` ORDER BY priority DESC, created_at LIMIT 1`

	var id string
	err = tx.QueryRowContext(ctx, q, args...).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	now := time.Now().Unix()
	res, err := tx.ExecContext(ctx, `
		UPDATE tasks SET status = 'doing', claimed_by = ?, accepted_at = ?, updated_at = ?
		WHERE id = ? AND status = 'ready'`, claimant, now, now, id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO task_events (task_id, at, actor, kind, detail) VALUES (?, ?, ?, 'accepted', 'external claim')`,
		id, now, claimant); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetTask(ctx, id)
}

// TaskForWorker returns the task currently assigned to a worker name.
func (s *Store) TaskForWorker(ctx context.Context, worker string) (*Task, error) {
	t, err := scanTask(s.db.QueryRowContext(ctx,
		taskSelect+` WHERE claimed_by = ? AND status IN ('dispatching','doing','blocked','review') ORDER BY updated_at DESC LIMIT 1`,
		worker))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return t, err
}

// CountTasks returns per-status counts for the badge and the queue header.
func (s *Store) CountTasks(ctx context.Context, userID string) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT status, COUNT(*) FROM tasks WHERE user_id = ? GROUP BY status`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var st string
		var n int
		if err := rows.Scan(&st, &n); err != nil {
			return nil, err
		}
		out[st] = n
	}
	return out, rows.Err()
}

// ActiveTaskInRepo reports whether some task is already being worked in a
// repo. One writer per repo is structural, not advisory.
func (s *Store) ActiveTaskInRepo(ctx context.Context, userID, repo string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM tasks
		WHERE user_id = ? AND repo = ? AND status IN ('dispatching','doing','blocked')`,
		userID, repo).Scan(&n)
	return n > 0, err
}

// OpenReviewItemsForTask reports whether the task has an open linked item, and
// returns all linked items for the detail page.
func (s *Store) ReviewItemsForTask(ctx context.Context, taskID string) ([]*ReviewItem, error) {
	rows, err := s.db.QueryContext(ctx, reviewSelect+` WHERE task_id = ? ORDER BY created_at`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*ReviewItem
	for rows.Next() {
		it, err := scanItemRows(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// HasOpenReviewItemForTask is the reap path's "is there evidence" check.
func (s *Store) HasOpenReviewItemForTask(ctx context.Context, taskID string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM review_items WHERE task_id = ? AND status = 'open'`, taskID).Scan(&n)
	return n > 0, err
}

func scanTask(row rowScanner) (*Task, error) {
	var t Task
	var claimedBy, result, tail sql.NullString
	var tailAt, dispatchedAt, acceptedAt, finishedAt sql.NullInt64
	var created, updated int64

	if err := row.Scan(&t.ID, &t.UserID, &t.Title, &t.BodyMD, &t.Kind, &t.Repo, &t.Branch,
		&t.Priority, &t.Status, &claimedBy, &t.Worktree, &t.PaneID, &t.Attempt,
		&result, &tail, &tailAt, &created, &updated,
		&dispatchedAt, &acceptedAt, &finishedAt); err != nil {
		return nil, err
	}
	if claimedBy.Valid {
		t.ClaimedBy = &claimedBy.String
	}
	if result.Valid {
		t.Result = &result.String
	}
	if tail.Valid {
		t.Tail = &tail.String
	}
	if tailAt.Valid {
		v := time.Unix(tailAt.Int64, 0)
		t.TailAt = &v
	}
	t.CreatedAt = time.Unix(created, 0)
	t.UpdatedAt = time.Unix(updated, 0)
	if dispatchedAt.Valid {
		v := time.Unix(dispatchedAt.Int64, 0)
		t.DispatchedAt = &v
	}
	if acceptedAt.Valid {
		v := time.Unix(acceptedAt.Int64, 0)
		t.AcceptedAt = &v
	}
	if finishedAt.Valid {
		v := time.Unix(finishedAt.Int64, 0)
		t.FinishedAt = &v
	}
	return &t, nil
}
