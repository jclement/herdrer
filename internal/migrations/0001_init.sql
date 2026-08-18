-- Initial schema.
--
-- Two principals exist in this system and they are deliberately not the same
-- thing. A *user* is a human holding a passkey; a user may do anything,
-- including reach a shell. A *token* is an agent credential minted by a
-- passkey-authenticated user; a token may submit review items and read the
-- answers to its own, and nothing else. The privilege boundary between them is
-- enforced in the API layer and recorded here by keeping their credentials in
-- separate tables with no shared identifier.

CREATE TABLE users (
    id           TEXT PRIMARY KEY,
    handle       TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'admin',
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER
);

-- WebAuthn credentials. `cred_id` is the raw credential id from the
-- authenticator; `sign_count` is persisted so a cloned authenticator can be
-- detected on use.
CREATE TABLE credentials (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cred_id         BLOB NOT NULL UNIQUE,
    public_key      BLOB NOT NULL,
    attestation_type TEXT NOT NULL DEFAULT '',
    aaguid          BLOB,
    sign_count      INTEGER NOT NULL DEFAULT 0,
    backup_eligible INTEGER NOT NULL DEFAULT 0,
    backup_state    INTEGER NOT NULL DEFAULT 0,
    transports      TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL,
    last_used_at    INTEGER
);
CREATE INDEX idx_credentials_user ON credentials(user_id);

-- Server-side sessions. Never a JWT: the point is that deleting the row logs
-- the device out on its next request, with no window.
CREATE TABLE sessions (
    id            TEXT PRIMARY KEY,        -- sha256 of the cookie value, hex
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
    user_agent    TEXT NOT NULL DEFAULT '',
    ip            TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    revoked_at    INTEGER
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- In-flight WebAuthn ceremonies. Short TTL, single use, deleted on completion.
CREATE TABLE webauthn_ceremonies (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,              -- 'register' | 'login'
    user_id    TEXT,
    data       BLOB NOT NULL,              -- serialised SessionData
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX idx_ceremonies_expires ON webauthn_ceremonies(expires_at);

-- The bootstrap enrollment window. A row here is the only thing that permits
-- registering a passkey. Rows are created by an operator running
-- `herdrer enroll` on the box itself, carry a short TTL, and are consumed
-- atomically by the first successful registration.
CREATE TABLE enrollments (
    id         TEXT PRIMARY KEY,
    code_hash  TEXT NOT NULL,              -- sha256 of the enrollment code, hex
    label      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    used_by    TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_enrollments_expires ON enrollments(expires_at);

-- Agent credentials. Deliberately not a session and not a user.
CREATE TABLE api_tokens (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,     -- sha256 of the sk_ token, hex
    token_prefix TEXT NOT NULL,            -- first 8 chars, for display
    scopes       TEXT NOT NULL DEFAULT 'review:write',
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    expires_at   INTEGER,
    revoked_at   INTEGER
);
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);

-- Web Push subscriptions, one per installed PWA.
CREATE TABLE push_subs (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    failed_at  INTEGER
);
CREATE INDEX idx_push_subs_user ON push_subs(user_id);

-- A review item: the document an agent submits for a human to act on.
--
-- `status` transitions: open -> answered | expired | cancelled.
-- An expired item has answer_value NULL and is NEVER interpreted as consent.
CREATE TABLE review_items (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_id     TEXT REFERENCES api_tokens(id) ON DELETE SET NULL,
    direction    TEXT NOT NULL DEFAULT 'ask',   -- 'ask' (agent->human) | 'task' (human->agent)
    kind         TEXT NOT NULL,                 -- confirm | choice | ack | manual | review
    title        TEXT NOT NULL,
    body_md      TEXT NOT NULL DEFAULT '',
    options_json TEXT NOT NULL DEFAULT '[]',
    recommend    TEXT,
    context_json TEXT NOT NULL DEFAULT '{}',    -- repo, branch, worker, links
    urgency      TEXT NOT NULL DEFAULT 'normal',-- low | normal | blocking
    status       TEXT NOT NULL DEFAULT 'open',
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    answered_at  INTEGER,
    answer_value TEXT,
    answer_note  TEXT,
    answered_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    claimed_by   TEXT,
    claimed_at   INTEGER,
    cancelled_at INTEGER
);
CREATE INDEX idx_review_items_inbox ON review_items(user_id, status, urgency, created_at);
CREATE INDEX idx_review_items_expires ON review_items(status, expires_at);
CREATE INDEX idx_review_items_token ON review_items(token_id);

-- Attachments to a review item: diffs and code kept out of the body so they can
-- be lazily loaded on a phone rather than shipped with the inbox listing.
CREATE TABLE review_attachments (
    id        TEXT PRIMARY KEY,
    item_id   TEXT NOT NULL REFERENCES review_items(id) ON DELETE CASCADE,
    ord       INTEGER NOT NULL DEFAULT 0,
    kind      TEXT NOT NULL,              -- diff | code | markdown | mermaid
    title     TEXT NOT NULL DEFAULT '',
    language  TEXT NOT NULL DEFAULT '',
    content   TEXT NOT NULL
);
CREATE INDEX idx_review_attachments_item ON review_attachments(item_id, ord);

-- Append-only audit trail. Security events and item lifecycle share a table so
-- that "what happened on this box" is one query.
CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL,
    actor      TEXT NOT NULL DEFAULT '',   -- user:<id> | token:<id> | system | anon
    kind       TEXT NOT NULL,
    subject    TEXT NOT NULL DEFAULT '',
    ip         TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    detail     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_at ON audit_log(at);
CREATE INDEX idx_audit_kind ON audit_log(kind, at);
