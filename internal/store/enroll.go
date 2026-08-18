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

// CompleteRegistration consumes an enrollment permit, creates the user if it is
// new, and stores the credential — all in one transaction.
//
// These three writes must be atomic, and the ordering between them is not free:
//
//   - `enrollments.used_by` is a foreign key to `users(id)`, so the permit
//     cannot be marked used before the user row exists. Doing it in the other
//     order fails the constraint and looks, from the outside, exactly like a
//     rejected enrollment code.
//   - If the user were created first and then anything failed, the box would be
//     left with a user that owns no credential. `CountUsers` would report it as
//     enrolled, the login screen would stop offering registration, and the box
//     would be permanently unclaimable without shell access.
//
// One transaction removes both problems: either a human is fully registered, or
// nothing happened.
func (s *Store) CompleteRegistration(ctx context.Context, code string, u *User, c *Credential) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Claim the permit first, but without the foreign-key column, so a losing
	// racer is rejected here rather than after creating a user.
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

	// Create the user before touching used_by, for the foreign key.
	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE id = ?`, u.ID).Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO users (id, handle, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)`,
			u.ID, u.Handle, u.DisplayName, u.Role, u.CreatedAt.Unix()); err != nil {
			return err
		}
	}

	// The guard on used_at IS NULL is what makes two concurrent registrations
	// racing on one code resolve to exactly one winner.
	res, err := tx.ExecContext(ctx,
		`UPDATE enrollments SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL`,
		time.Now().Unix(), u.ID, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO credentials (id, user_id, cred_id, public_key, attestation_type, aaguid,
			sign_count, backup_eligible, backup_state, transports, name, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.ID, c.UserID, c.CredID, c.PublicKey, c.AttestationType, c.AAGUID,
		c.SignCount, boolInt(c.BackupEligible), boolInt(c.BackupState), c.Transports,
		c.Name, c.CreatedAt.Unix()); err != nil {
		return err
	}

	return tx.Commit()
}
