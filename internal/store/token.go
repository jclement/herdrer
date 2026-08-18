package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// APIToken is an agent credential. It is not a user and cannot become one: no
// code path turns a token into a session, and the terminal handlers reject it
// unconditionally.
type APIToken struct {
	ID          string
	UserID      string
	Name        string
	TokenPrefix string
	Scopes      []string
	CreatedAt   time.Time
	LastUsedAt  *time.Time
	ExpiresAt   *time.Time
	RevokedAt   *time.Time
}

// HasScope reports whether the token carries a scope.
func (t *APIToken) HasScope(want string) bool {
	for _, s := range t.Scopes {
		if s == want {
			return true
		}
	}
	return false
}

// CreateAPIToken stores a token's hash. The plaintext is shown to the caller
// exactly once and never persisted.
func (s *Store) CreateAPIToken(ctx context.Context, t *APIToken, tokenHash string) error {
	var exp any
	if t.ExpiresAt != nil {
		exp = t.ExpiresAt.Unix()
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, scopes, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ID, t.UserID, t.Name, tokenHash, t.TokenPrefix,
		strings.Join(t.Scopes, " "), t.CreatedAt.Unix(), exp)
	return err
}

// APITokenByHash resolves a presented bearer token. Revoked and expired tokens
// return ErrNotFound so callers cannot tell the difference from a bad token.
func (s *Store) APITokenByHash(ctx context.Context, hash string) (*APIToken, error) {
	var t APIToken
	var scopes string
	var created int64
	var used, exp, revoked sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, name, token_prefix, scopes, created_at, last_used_at, expires_at, revoked_at
		FROM api_tokens WHERE token_hash = ?`, hash).
		Scan(&t.ID, &t.UserID, &t.Name, &t.TokenPrefix, &scopes, &created, &used, &exp, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid {
		return nil, ErrNotFound
	}
	if exp.Valid && time.Now().Unix() >= exp.Int64 {
		return nil, ErrNotFound
	}
	t.Scopes = strings.Fields(scopes)
	t.CreatedAt = time.Unix(created, 0)
	if used.Valid {
		x := time.Unix(used.Int64, 0)
		t.LastUsedAt = &x
	}
	if exp.Valid {
		x := time.Unix(exp.Int64, 0)
		t.ExpiresAt = &x
	}
	return &t, nil
}

// ListAPITokens returns a user's tokens, including revoked ones, for the audit
// trail in settings.
func (s *Store) ListAPITokens(ctx context.Context, userID string) ([]*APIToken, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, name, token_prefix, scopes, created_at, last_used_at, expires_at, revoked_at
		FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*APIToken
	for rows.Next() {
		var t APIToken
		var scopes string
		var created int64
		var used, exp, revoked sql.NullInt64
		if err := rows.Scan(&t.ID, &t.UserID, &t.Name, &t.TokenPrefix, &scopes,
			&created, &used, &exp, &revoked); err != nil {
			return nil, err
		}
		t.Scopes = strings.Fields(scopes)
		t.CreatedAt = time.Unix(created, 0)
		if used.Valid {
			x := time.Unix(used.Int64, 0)
			t.LastUsedAt = &x
		}
		if exp.Valid {
			x := time.Unix(exp.Int64, 0)
			t.ExpiresAt = &x
		}
		if revoked.Valid {
			x := time.Unix(revoked.Int64, 0)
			t.RevokedAt = &x
		}
		out = append(out, &t)
	}
	return out, rows.Err()
}

// TouchAPIToken records use. Best effort and out of band of the response.
func (s *Store) TouchAPIToken(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, time.Now().Unix(), id)
	return err
}

// RevokeAPIToken soft-deletes a token, keeping the row for the audit trail.
func (s *Store) RevokeAPIToken(ctx context.Context, userID, id string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
		time.Now().Unix(), id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// LiveAPITokenByName finds an unrevoked, unexpired token with the given name.
//
// Used to decide whether herdrer still needs to provision a credential for the
// agents on this box, without ever needing the plaintext — which it does not
// have and cannot recover.
func (s *Store) LiveAPITokenByName(ctx context.Context, userID, name string) (*APIToken, error) {
	list, err := s.ListAPITokens(ctx, userID)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	for _, t := range list {
		if t.Name != name || t.RevokedAt != nil {
			continue
		}
		if t.ExpiresAt != nil && now.After(*t.ExpiresAt) {
			continue
		}
		return t, nil
	}
	return nil, ErrNotFound
}
