package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

// User is a human principal. Only a user may reach a shell.
type User struct {
	ID          string
	Handle      string
	DisplayName string
	Role        string
	CreatedAt   time.Time
	LastSeenAt  *time.Time
}

// Credential is one registered passkey.
type Credential struct {
	ID              string
	UserID          string
	CredID          []byte
	PublicKey       []byte
	AttestationType string
	AAGUID          []byte
	SignCount       uint32
	BackupEligible  bool
	BackupState     bool
	Transports      string
	Name            string
	CreatedAt       time.Time
	LastUsedAt      *time.Time
	CanTerminal     bool
}

// Session is a server-side login. Deleting the row ends it immediately.
type Session struct {
	ID            string
	UserID        string
	CredentialID  *string
	UserAgent     string
	IP            string
	CreatedAt     time.Time
	LastSeenAt    time.Time
	ExpiresAt     time.Time
	RevokedAt     *time.Time
	SteppedUpAt   *time.Time
	SteppedUpCred string
}

// HashToken returns the hex SHA-256 of a secret. Session cookies, enrollment
// codes and agent tokens are all stored this way: the database never holds a
// value that could be replayed if it leaked.
func HashToken(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// --- users -------------------------------------------------------------------

// CreateUser inserts a user.
func (s *Store) CreateUser(ctx context.Context, u *User) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO users (id, handle, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)`,
		u.ID, u.Handle, u.DisplayName, u.Role, u.CreatedAt.Unix())
	return err
}

// GetUser returns a user by id.
func (s *Store) GetUser(ctx context.Context, id string) (*User, error) {
	return s.scanUser(s.db.QueryRowContext(ctx,
		`SELECT id, handle, display_name, role, created_at, last_seen_at FROM users WHERE id = ?`, id))
}

// GetUserByHandle returns a user by handle.
func (s *Store) GetUserByHandle(ctx context.Context, handle string) (*User, error) {
	return s.scanUser(s.db.QueryRowContext(ctx,
		`SELECT id, handle, display_name, role, created_at, last_seen_at FROM users WHERE handle = ?`, handle))
}

// CountUsers reports how many users exist. Zero means the box has never been
// enrolled and the UI should say so rather than showing a login form.
func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// ListUsers returns every user, oldest first.
func (s *Store) ListUsers(ctx context.Context) ([]*User, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, handle, display_name, role, created_at, last_seen_at FROM users ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*User
	for rows.Next() {
		var u User
		var created int64
		var seen sql.NullInt64
		if err := rows.Scan(&u.ID, &u.Handle, &u.DisplayName, &u.Role, &created, &seen); err != nil {
			return nil, err
		}
		u.CreatedAt = time.Unix(created, 0)
		if seen.Valid {
			t := time.Unix(seen.Int64, 0)
			u.LastSeenAt = &t
		}
		out = append(out, &u)
	}
	return out, rows.Err()
}

func (s *Store) scanUser(row *sql.Row) (*User, error) {
	var u User
	var created int64
	var seen sql.NullInt64
	err := row.Scan(&u.ID, &u.Handle, &u.DisplayName, &u.Role, &created, &seen)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	u.CreatedAt = time.Unix(created, 0)
	if seen.Valid {
		t := time.Unix(seen.Int64, 0)
		u.LastSeenAt = &t
	}
	return &u, nil
}

// TouchUser records that a user was seen, out of band of the request path.
func (s *Store) TouchUser(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET last_seen_at = ? WHERE id = ?`, time.Now().Unix(), id)
	return err
}

// --- credentials -------------------------------------------------------------

// AddCredential registers a passkey for a user.
func (s *Store) AddCredential(ctx context.Context, c *Credential) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO credentials (id, user_id, cred_id, public_key, attestation_type, aaguid,
			sign_count, backup_eligible, backup_state, transports, name, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.ID, c.UserID, c.CredID, c.PublicKey, c.AttestationType, c.AAGUID,
		c.SignCount, boolInt(c.BackupEligible), boolInt(c.BackupState), c.Transports,
		c.Name, c.CreatedAt.Unix())
	return err
}

// ListCredentials returns every passkey registered to a user.
func (s *Store) ListCredentials(ctx context.Context, userID string) ([]*Credential, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, cred_id, public_key, attestation_type, aaguid, sign_count,
		       backup_eligible, backup_state, transports, name, created_at, last_used_at,
		       can_terminal
		FROM credentials WHERE user_id = ? ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanCredentials(rows)
}

// CredentialByCredID looks up a passkey by the authenticator's credential id.
func (s *Store) CredentialByCredID(ctx context.Context, credID []byte) (*Credential, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, cred_id, public_key, attestation_type, aaguid, sign_count,
		       backup_eligible, backup_state, transports, name, created_at, last_used_at,
		       can_terminal
		FROM credentials WHERE cred_id = ?`, credID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list, err := scanCredentials(rows)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, ErrNotFound
	}
	return list[0], nil
}

// AllCredentials returns every passkey on the box. Discoverable-credential
// login needs this to resolve a raw credential id to its owner.
func (s *Store) AllCredentials(ctx context.Context) ([]*Credential, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, cred_id, public_key, attestation_type, aaguid, sign_count,
		       backup_eligible, backup_state, transports, name, created_at, last_used_at,
		       can_terminal
		FROM credentials ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanCredentials(rows)
}

func scanCredentials(rows *sql.Rows) ([]*Credential, error) {
	var out []*Credential
	for rows.Next() {
		var c Credential
		var be, bs, ct int
		var created int64
		var used sql.NullInt64
		if err := rows.Scan(&c.ID, &c.UserID, &c.CredID, &c.PublicKey, &c.AttestationType,
			&c.AAGUID, &c.SignCount, &be, &bs, &c.Transports, &c.Name, &created, &used, &ct); err != nil {
			return nil, err
		}
		c.BackupEligible, c.BackupState, c.CanTerminal = be == 1, bs == 1, ct == 1
		c.CreatedAt = time.Unix(created, 0)
		if used.Valid {
			t := time.Unix(used.Int64, 0)
			c.LastUsedAt = &t
		}
		out = append(out, &c)
	}
	return out, rows.Err()
}

// UpdateCredentialUse persists the authenticator's signature counter after a
// successful assertion. A counter that fails to advance is how a cloned
// authenticator is detected; the caller decides what to do about it.
func (s *Store) UpdateCredentialUse(ctx context.Context, id string, signCount uint32, backupState bool) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE credentials SET sign_count = ?, backup_state = ?, last_used_at = ? WHERE id = ?`,
		signCount, boolInt(backupState), time.Now().Unix(), id)
	return err
}

// DeleteCredential removes a passkey. Refuses to remove the last one for a
// user, which would lock the box against its only human.
func (s *Store) DeleteCredential(ctx context.Context, userID, id string) error {
	var n int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM credentials WHERE user_id = ?`, userID).Scan(&n); err != nil {
		return err
	}
	if n <= 1 {
		return fmt.Errorf("refusing to remove the only passkey for this user")
	}
	res, err := s.db.ExecContext(ctx, `DELETE FROM credentials WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// --- sessions ----------------------------------------------------------------

// CreateSession records a login. id is the hex SHA-256 of the cookie value.
func (s *Store) CreateSession(ctx context.Context, sess *Session) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO sessions (id, user_id, credential_id, user_agent, ip, created_at, last_seen_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		sess.ID, sess.UserID, sess.CredentialID, sess.UserAgent, sess.IP,
		sess.CreatedAt.Unix(), sess.LastSeenAt.Unix(), sess.ExpiresAt.Unix())
	return err
}

// GetSession returns a live session by cookie hash, or ErrNotFound if it is
// absent, revoked or expired. Expiry is enforced here, never client-side.
func (s *Store) GetSession(ctx context.Context, id string) (*Session, error) {
	var sess Session
	var cred sql.NullString
	var created, seen, expires int64
	var revoked, stepped sql.NullInt64
	var steppedCred sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, credential_id, user_agent, ip, created_at, last_seen_at, expires_at,
		       revoked_at, stepped_up_at, stepped_up_cred
		FROM sessions WHERE id = ?`, id).
		Scan(&sess.ID, &sess.UserID, &cred, &sess.UserAgent, &sess.IP, &created, &seen, &expires,
			&revoked, &stepped, &steppedCred)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid {
		return nil, ErrNotFound
	}
	if time.Now().Unix() >= expires {
		return nil, ErrNotFound
	}
	if cred.Valid {
		sess.CredentialID = &cred.String
	}
	sess.CreatedAt = time.Unix(created, 0)
	sess.LastSeenAt = time.Unix(seen, 0)
	sess.ExpiresAt = time.Unix(expires, 0)
	if stepped.Valid {
		t := time.Unix(stepped.Int64, 0)
		sess.SteppedUpAt = &t
	}
	sess.SteppedUpCred = steppedCred.String
	return &sess, nil
}

// RefreshSession slides the expiry forward on activity.
func (s *Store) RefreshSession(ctx context.Context, id string, ttl time.Duration) error {
	now := time.Now()
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL`,
		now.Unix(), now.Add(ttl).Unix(), id)
	return err
}

// ListSessions returns a user's live sessions, newest first.
func (s *Store) ListSessions(ctx context.Context, userID string) ([]*Session, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, credential_id, user_agent, ip, created_at, last_seen_at, expires_at, revoked_at
		FROM sessions
		WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
		ORDER BY last_seen_at DESC`, userID, time.Now().Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Session
	for rows.Next() {
		var sess Session
		var cred sql.NullString
		var created, seen, expires int64
		var revoked sql.NullInt64
		if err := rows.Scan(&sess.ID, &sess.UserID, &cred, &sess.UserAgent, &sess.IP,
			&created, &seen, &expires, &revoked); err != nil {
			return nil, err
		}
		if cred.Valid {
			sess.CredentialID = &cred.String
		}
		sess.CreatedAt = time.Unix(created, 0)
		sess.LastSeenAt = time.Unix(seen, 0)
		sess.ExpiresAt = time.Unix(expires, 0)
		out = append(out, &sess)
	}
	return out, rows.Err()
}

// RevokeSession ends one session immediately.
func (s *Store) RevokeSession(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE sessions SET revoked_at = ? WHERE id = ?`, time.Now().Unix(), id)
	return err
}

// RevokeAllSessions ends every session for a user — the panic button.
func (s *Store) RevokeAllSessions(ctx context.Context, userID string) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
		time.Now().Unix(), userID)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// PurgeExpired deletes stale sessions and ceremonies. Called periodically.
func (s *Store) PurgeExpired(ctx context.Context) error {
	now := time.Now().Unix()
	if _, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at < ?`, now); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM webauthn_ceremonies WHERE expires_at < ?`, now); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM enrollments WHERE expires_at < ? AND used_at IS NULL`, now)
	return err
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// --- push subscriptions --------------------------------------------------------

// PushSub is one browser's Web Push registration.
type PushSub struct {
	ID        string
	UserID    string
	Endpoint  string
	P256dh    string
	Auth      string
	UserAgent string
	CreatedAt time.Time

	// Outcome of the most recent delivery attempt, so "it does not work" can
	// be answered with evidence rather than a shrug.
	LastStatus int
	LastError  string
	LastSentAt *time.Time
	SentCount  int
}

// UpsertPushSub records a subscription, replacing any earlier one with the same
// endpoint so a reinstalled PWA does not accumulate duplicates.
func (s *Store) UpsertPushSub(ctx context.Context, p *PushSub) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO push_subs (id, user_id, endpoint, p256dh, auth, user_agent, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(endpoint) DO UPDATE SET
			user_id = excluded.user_id, p256dh = excluded.p256dh,
			auth = excluded.auth, user_agent = excluded.user_agent, failed_at = NULL`,
		p.ID, p.UserID, p.Endpoint, p.P256dh, p.Auth, p.UserAgent, p.CreatedAt.Unix())
	return err
}

// ListPushSubs returns a user's live subscriptions.
func (s *Store) ListPushSubs(ctx context.Context, userID string) ([]*PushSub, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, endpoint, p256dh, auth, user_agent, created_at,
		        COALESCE(last_status, 0), COALESCE(last_error, ''), last_sent_at,
		        COALESCE(sent_count, 0)
		 FROM push_subs WHERE user_id = ? ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*PushSub
	for rows.Next() {
		var p PushSub
		var created int64
		var sent sql.NullInt64
		if err := rows.Scan(&p.ID, &p.UserID, &p.Endpoint, &p.P256dh, &p.Auth, &p.UserAgent,
			&created, &p.LastStatus, &p.LastError, &sent, &p.SentCount); err != nil {
			return nil, err
		}
		p.CreatedAt = time.Unix(created, 0)
		if sent.Valid {
			t := time.Unix(sent.Int64, 0)
			p.LastSentAt = &t
		}
		out = append(out, &p)
	}
	return out, rows.Err()
}

// DeletePushSub removes a dead subscription.
func (s *Store) DeletePushSub(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM push_subs WHERE id = ?`, id)
	return err
}

// MarkPushFailed records a transient failure without dropping the subscription.
func (s *Store) MarkPushFailed(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE push_subs SET failed_at = ? WHERE id = ?`, time.Now().Unix(), id)
	return err
}

// RecordPushAttempt stores the outcome of one delivery attempt.
func (s *Store) RecordPushAttempt(ctx context.Context, id string, status int, errMsg string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE push_subs
		SET last_status = ?, last_error = ?, last_sent_at = ?, sent_count = COALESCE(sent_count, 0) + 1
		WHERE id = ?`, status, errMsg, time.Now().Unix(), id)
	return err
}

// --- step-up and terminal permission -------------------------------------------

// SetCredentialTerminal marks a passkey as allowed, or not allowed, to open a
// shell. Scoped to the owning user so an id from a URL cannot reach another
// user's credential.
func (s *Store) SetCredentialTerminal(ctx context.Context, userID, credID string, allowed bool) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE credentials SET can_terminal = ? WHERE id = ? AND user_id = ?`,
		boolInt(allowed), credID, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// CredentialCanTerminal reports whether a credential may open a shell.
func (s *Store) CredentialCanTerminal(ctx context.Context, userID, credID string) (bool, error) {
	var v int
	err := s.db.QueryRowContext(ctx,
		`SELECT can_terminal FROM credentials WHERE id = ? AND user_id = ?`, credID, userID).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrNotFound
	}
	if err != nil {
		return false, err
	}
	return v == 1, nil
}

// MarkSessionSteppedUp records a fresh assertion against a session.
func (s *Store) MarkSessionSteppedUp(ctx context.Context, sessionID, credID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET stepped_up_at = ?, stepped_up_cred = ? WHERE id = ? AND revoked_at IS NULL`,
		time.Now().Unix(), credID, sessionID)
	return err
}
