package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// PutCeremony stores in-flight WebAuthn session data under a random id. The id
// travels to the browser in a short-lived cookie; the challenge itself never
// leaves the server, so a stolen ceremony cookie is useless without also
// completing the authenticator interaction.
func (s *Store) PutCeremony(ctx context.Context, id, kind, userID string, data []byte, ttl time.Duration) error {
	now := time.Now()
	var uid any
	if userID != "" {
		uid = userID
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO webauthn_ceremonies (id, kind, user_id, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
		id, kind, uid, data, now.Unix(), now.Add(ttl).Unix())
	return err
}

// TakeCeremony atomically fetches and deletes a ceremony, so a challenge can be
// used exactly once. An expired row is treated as absent.
func (s *Store) TakeCeremony(ctx context.Context, id, kind string) (userID string, data []byte, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", nil, err
	}
	defer tx.Rollback()

	var uid sql.NullString
	var expires int64
	err = tx.QueryRowContext(ctx,
		`SELECT user_id, data, expires_at FROM webauthn_ceremonies WHERE id = ? AND kind = ?`, id, kind).
		Scan(&uid, &data, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, ErrNotFound
	}
	if err != nil {
		return "", nil, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM webauthn_ceremonies WHERE id = ?`, id); err != nil {
		return "", nil, err
	}
	if err := tx.Commit(); err != nil {
		return "", nil, err
	}
	if time.Now().Unix() >= expires {
		return "", nil, ErrNotFound
	}
	return uid.String, data, nil
}
