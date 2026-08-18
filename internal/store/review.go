package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Option is one answerable choice on a review item.
type Option struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Detail string `json:"detail,omitempty"`
}

// ReviewItem is a document an agent submitted for a human to act on, or a task
// a human queued for an agent.
type ReviewItem struct {
	ID          string
	UserID      string
	TokenID     *string
	Direction   string
	Kind        string
	Title       string
	BodyMD      string
	Options     []Option
	Recommend   *string
	Context     map[string]any
	Urgency     string
	Status      string
	CreatedAt   time.Time
	ExpiresAt   time.Time
	AnsweredAt  *time.Time
	AnswerValue *string
	AnswerNote  *string
	AnsweredBy  *string
	ClaimedBy   *string
	ClaimedAt   *time.Time

	Attachments []Attachment
}

// Attachment is a diff, code block, mermaid diagram or markdown section kept
// out of the item body so the inbox listing stays small on a phone.
type Attachment struct {
	ID       string `json:"id"`
	Ord      int    `json:"-"`
	Kind     string `json:"kind"`
	Title    string `json:"title,omitempty"`
	Language string `json:"language,omitempty"`
	Content  string `json:"content"`
}

// Item lifecycle statuses.
const (
	StatusOpen      = "open"
	StatusAnswered  = "answered"
	StatusExpired   = "expired"
	StatusCancelled = "cancelled"
	StatusClaimed   = "claimed"
	StatusDone      = "done"
)

// CreateReviewItem inserts an item and its attachments in one transaction.
func (s *Store) CreateReviewItem(ctx context.Context, it *ReviewItem) error {
	opts, _ := json.Marshal(it.Options)
	if it.Options == nil {
		opts = []byte("[]")
	}
	cx, _ := json.Marshal(it.Context)
	if it.Context == nil {
		cx = []byte("{}")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO review_items (id, user_id, token_id, direction, kind, title, body_md,
			options_json, recommend, context_json, urgency, status, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		it.ID, it.UserID, it.TokenID, it.Direction, it.Kind, it.Title, it.BodyMD,
		string(opts), it.Recommend, string(cx), it.Urgency, it.Status,
		it.CreatedAt.Unix(), it.ExpiresAt.Unix()); err != nil {
		return err
	}
	for i, a := range it.Attachments {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO review_attachments (id, item_id, ord, kind, title, language, content)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			a.ID, it.ID, i, a.Kind, a.Title, a.Language, a.Content); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// GetReviewItem loads one item with its attachments.
func (s *Store) GetReviewItem(ctx context.Context, id string) (*ReviewItem, error) {
	it, err := s.scanItem(s.db.QueryRowContext(ctx, reviewSelect+` WHERE id = ?`, id))
	if err != nil {
		return nil, err
	}
	if err := s.loadAttachments(ctx, it); err != nil {
		return nil, err
	}
	return it, nil
}

const reviewSelect = `
	SELECT id, user_id, token_id, direction, kind, title, body_md, options_json,
	       recommend, context_json, urgency, status, created_at, expires_at,
	       answered_at, answer_value, answer_note, answered_by, claimed_by, claimed_at
	FROM review_items`

// ListReviewItems returns a user's items, blocked-first then newest.
//
// The ordering is the product: an inbox that does not put the thing blocking a
// worker at the top is just a list.
func (s *Store) ListReviewItems(ctx context.Context, userID, direction, status string, limit int) ([]*ReviewItem, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	q := reviewSelect + ` WHERE user_id = ? AND direction = ?`
	args := []any{userID, direction}
	switch status {
	case "", "open":
		q += ` AND status = 'open'`
	case "all":
	default:
		q += ` AND status = ?`
		args = append(args, status)
	}
	q += `
		ORDER BY CASE urgency WHEN 'blocking' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
		         created_at DESC
		LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, q, args...)
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

// ListReviewItemsForToken returns the open items a given agent token created,
// which is the only view of the inbox an agent ever gets.
func (s *Store) ListReviewItemsForToken(ctx context.Context, tokenID, status string) ([]*ReviewItem, error) {
	q := reviewSelect + ` WHERE token_id = ?`
	args := []any{tokenID}
	if status != "all" {
		if status == "" {
			status = StatusOpen
		}
		q += ` AND status = ?`
		args = append(args, status)
	}
	q += ` ORDER BY created_at DESC LIMIT 200`
	rows, err := s.db.QueryContext(ctx, q, args...)
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

// CountOpen reports how many open items a user has, for the badge.
func (s *Store) CountOpen(ctx context.Context, userID, direction string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM review_items WHERE user_id = ? AND direction = ? AND status = 'open'`,
		userID, direction).Scan(&n)
	return n, err
}

// CountOpenForToken is the backpressure counter: an agent that has left a pile
// of unanswered questions should be refused a new one rather than burying the
// human deeper.
func (s *Store) CountOpenForToken(ctx context.Context, tokenID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM review_items WHERE token_id = ? AND status = 'open'`, tokenID).Scan(&n)
	return n, err
}

// AnswerReviewItem records a human's answer, atomically and exactly once.
//
// The UPDATE is guarded on status='open', so a double tap on a phone with a
// flaky connection cannot overwrite an answer, and an item that expired a
// moment ago cannot be answered into a stale state.
func (s *Store) AnswerReviewItem(ctx context.Context, id, userID, value, note string) (*ReviewItem, error) {
	now := time.Now()
	res, err := s.db.ExecContext(ctx, `
		UPDATE review_items
		SET status = 'answered', answer_value = ?, answer_note = ?, answered_by = ?, answered_at = ?
		WHERE id = ? AND user_id = ? AND status = 'open' AND expires_at > ?`,
		value, nullIfEmpty(note), userID, now.Unix(), id, userID, now.Unix())
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, fmt.Errorf("%w: item is not open", ErrConflict)
	}
	return s.GetReviewItem(ctx, id)
}

// ErrConflict signals a state transition that was not legal.
var ErrConflict = errors.New("conflict")

// CancelReviewItem withdraws an item. An agent may cancel only its own.
func (s *Store) CancelReviewItem(ctx context.Context, id string, tokenID, userID *string) error {
	q := `UPDATE review_items SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'open'`
	args := []any{time.Now().Unix(), id}
	if tokenID != nil {
		q += ` AND token_id = ?`
		args = append(args, *tokenID)
	}
	if userID != nil {
		q += ` AND user_id = ?`
		args = append(args, *userID)
	}
	res, err := s.db.ExecContext(ctx, q, args...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SweepExpired moves elapsed open items to expired and returns their ids.
//
// This is a swept event, not a lazy read at fetch time. An item whose status is
// only computed when someone looks at it is an item nobody can be woken for,
// and an agent long-polling on it would hang past its own deadline.
func (s *Store) SweepExpired(ctx context.Context) ([]string, error) {
	now := time.Now().Unix()
	rows, err := s.db.QueryContext(ctx,
		`SELECT id FROM review_items WHERE status = 'open' AND expires_at <= ?`, now)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}
	if _, err := s.db.ExecContext(ctx,
		`UPDATE review_items SET status = 'expired' WHERE status = 'open' AND expires_at <= ?`, now); err != nil {
		return nil, err
	}
	return ids, nil
}

// ClaimTask atomically hands the oldest pending task to one agent.
func (s *Store) ClaimTask(ctx context.Context, userID, claimant string) (*ReviewItem, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var id string
	err = tx.QueryRowContext(ctx, `
		SELECT id FROM review_items
		WHERE user_id = ? AND direction = 'task' AND status = 'open'
		ORDER BY created_at LIMIT 1`, userID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE review_items SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ? AND status = 'open'`,
		claimant, time.Now().Unix(), id); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetReviewItem(ctx, id)
}

// CompleteTask marks a claimed task done with a result summary.
func (s *Store) CompleteTask(ctx context.Context, id, claimant, result string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE review_items SET status = 'done', answer_note = ?, answered_at = ?
		WHERE id = ? AND claimed_by = ? AND status = 'claimed'`,
		result, time.Now().Unix(), id, claimant)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// --- scanning ------------------------------------------------------------------

type rowScanner interface {
	Scan(dest ...any) error
}

func (s *Store) scanItem(row *sql.Row) (*ReviewItem, error) {
	it, err := scanItemRows(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return it, err
}

func scanItemRows(row rowScanner) (*ReviewItem, error) {
	var it ReviewItem
	var token, recommend, ansVal, ansNote, ansBy, claimBy sql.NullString
	var optsJSON, ctxJSON string
	var created, expires int64
	var answered, claimed sql.NullInt64

	if err := row.Scan(&it.ID, &it.UserID, &token, &it.Direction, &it.Kind, &it.Title,
		&it.BodyMD, &optsJSON, &recommend, &ctxJSON, &it.Urgency, &it.Status,
		&created, &expires, &answered, &ansVal, &ansNote, &ansBy, &claimBy, &claimed); err != nil {
		return nil, err
	}
	if token.Valid {
		it.TokenID = &token.String
	}
	if recommend.Valid {
		it.Recommend = &recommend.String
	}
	_ = json.Unmarshal([]byte(optsJSON), &it.Options)
	_ = json.Unmarshal([]byte(ctxJSON), &it.Context)
	it.CreatedAt = time.Unix(created, 0)
	it.ExpiresAt = time.Unix(expires, 0)
	if answered.Valid {
		t := time.Unix(answered.Int64, 0)
		it.AnsweredAt = &t
	}
	if ansVal.Valid {
		it.AnswerValue = &ansVal.String
	}
	if ansNote.Valid {
		it.AnswerNote = &ansNote.String
	}
	if ansBy.Valid {
		it.AnsweredBy = &ansBy.String
	}
	if claimBy.Valid {
		it.ClaimedBy = &claimBy.String
	}
	if claimed.Valid {
		t := time.Unix(claimed.Int64, 0)
		it.ClaimedAt = &t
	}
	return &it, nil
}

func (s *Store) loadAttachments(ctx context.Context, it *ReviewItem) error {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, ord, kind, title, language, content FROM review_attachments WHERE item_id = ? ORDER BY ord`, it.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var a Attachment
		if err := rows.Scan(&a.ID, &a.Ord, &a.Kind, &a.Title, &a.Language, &a.Content); err != nil {
			return err
		}
		it.Attachments = append(it.Attachments, a)
	}
	return rows.Err()
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
