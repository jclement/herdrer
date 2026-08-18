package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Enrollment is a one-time permit to register a passkey.
//
// This is the only thing that authorises registration. There is no open
// signup, no "first request wins" bootstrap, and no default credential: a
// scanner that finds the box before its owner does cannot enroll, because
// creating the permit requires shell access to the machine.
type Enrollment struct {
	ID        string
	Label     string
	CreatedAt time.Time
	ExpiresAt time.Time
	UsedAt    *time.Time
}

// CreateEnrollment records a permit. codeHash is HashToken(code); the code
// itself is printed once by the CLI and never stored.
func (s *Store) CreateEnrollment(ctx context.Context, id, codeHash, label string, ttl time.Duration) (*Enrollment, error) {
	now := time.Now()
	e := &Enrollment{ID: id, Label: label, CreatedAt: now, ExpiresAt: now.Add(ttl)}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO enrollments (id, code_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		id, codeHash, label, now.Unix(), e.ExpiresAt.Unix())
	if err != nil {
		return nil, err
	}
	return e, nil
}

// ConsumeEnrollment validates a code and marks the permit used, atomically. It
// returns ErrNotFound for an unknown, expired or already-used code — the caller
// must not distinguish these to the client.
func (s *Store) ConsumeEnrollment(ctx context.Context, code, userID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var id string
	var expires int64
	var used sql.NullInt64
	err = tx.QueryRowContext(ctx,
		`SELECT id, expires_at, used_at FROM enrollments WHERE code_hash = ?`, HashToken(code)).
		Scan(&id, &expires, &used)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if used.Valid || time.Now().Unix() >= expires {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE enrollments SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL`,
		time.Now().Unix(), userID, id); err != nil {
		return err
	}
	return tx.Commit()
}

// HasOpenEnrollment reports whether any unused, unexpired permit exists. The
// login page uses this to decide whether to offer registration at all.
func (s *Store) HasOpenEnrollment(ctx context.Context) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM enrollments WHERE used_at IS NULL AND expires_at > ?`,
		time.Now().Unix()).Scan(&n)
	return n > 0, err
}
