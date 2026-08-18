package store

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"
)

// AuditEntry is one line of the append-only security log.
type AuditEntry struct {
	ID        int64          `json:"id"`
	At        time.Time      `json:"at"`
	Actor     string         `json:"actor"`
	Kind      string         `json:"kind"`
	Subject   string         `json:"subject"`
	IP        string         `json:"ip"`
	UserAgent string         `json:"user_agent"`
	Detail    map[string]any `json:"detail"`
}

// Audit appends an entry. Auditing must never fail a request, so an error here
// is logged and swallowed — but it is logged loudly, because a database that
// cannot record an authentication failure is itself an incident.
func (s *Store) Audit(ctx context.Context, e AuditEntry) {
	detail := "{}"
	if e.Detail != nil {
		if b, err := json.Marshal(e.Detail); err == nil {
			detail = string(b)
		}
	}
	at := e.At
	if at.IsZero() {
		at = time.Now()
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO audit_log (at, actor, kind, subject, ip, user_agent, detail)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		at.Unix(), e.Actor, e.Kind, e.Subject, e.IP, e.UserAgent, detail); err != nil {
		slog.Error("audit write failed", "kind", e.Kind, "err", err)
	}
}

// ListAudit returns the most recent entries, newest first.
func (s *Store) ListAudit(ctx context.Context, limit int, kind string) ([]*AuditEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	q := `SELECT id, at, actor, kind, subject, ip, user_agent, detail FROM audit_log`
	args := []any{}
	if kind != "" {
		q += ` WHERE kind = ?`
		args = append(args, kind)
	}
	q += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*AuditEntry
	for rows.Next() {
		var e AuditEntry
		var at int64
		var detail string
		if err := rows.Scan(&e.ID, &at, &e.Actor, &e.Kind, &e.Subject, &e.IP, &e.UserAgent, &detail); err != nil {
			return nil, err
		}
		e.At = time.Unix(at, 0)
		_ = json.Unmarshal([]byte(detail), &e.Detail)
		out = append(out, &e)
	}
	return out, rows.Err()
}
