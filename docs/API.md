# herdrer API contract

Envelope: `{"data": …}`; lists add `{"meta":{total,page,per_page}}`; errors are
`{"error":{"message","code"}}` with codes `VALIDATION_ERROR`, `UNAUTHORIZED`,
`FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL_ERROR`.

All timestamps are RFC3339 strings. All ids are opaque strings.

## Three trees

| Prefix | Principal | Notes |
|---|---|---|
| `/api/v1/auth/*` | none | Rate limited. The only unauthenticated writes in the process; every one is a WebAuthn ceremony step. |
| `/api/v1/*` | passkey session | Cookie `__Host-herdrer_session`. The terminal lives here. |
| `/api/v1/agent/*` | `Authorization: Bearer sk_…` | Scoped. No route here can reach a PTY. |

Non-GET requests from a browser require an exact `Origin` match; there is no
CSRF token because the origin check plus `SameSite=Strict` covers it.

## Auth

```
GET  /api/v1/auth/state   -> {enrolled: bool, enrollment_open: bool, origin, rp_id}
POST /api/v1/auth/login/begin    {}                    -> {publicKey: …}   (CredentialRequestOptions)
POST /api/v1/auth/login/finish   <assertion JSON>      -> {user}
POST /api/v1/auth/register/begin {code, handle?, display_name?} -> {publicKey: …}
POST /api/v1/auth/register/finish <attestation JSON>   -> {user}
POST /api/v1/auth/logout  -> 204

POST /api/v1/auth/stepup/begin   {}               -> {publicKey: …}
POST /api/v1/auth/stepup/finish  <assertion JSON> -> {stepped_up_until, credential}
```

**Step-up.** A session cookie alone cannot open a terminal. `POST
/api/v1/terminal/ticket` requires a WebAuthn assertion completed within the
last 5 minutes, and returns `403 STEP_UP_REQUIRED` otherwise — a *recoverable*
code: prompt, assert, retry. The credential that satisfied the step-up is the
one whose `can_terminal` permission is checked, so a phone marked review-only
stays review-only even while holding a valid session.

`enrolled:false` means the box has no users; the UI shows "run `herdrer enroll`
on the server" rather than a login button. `enrollment_open` is true only while
an unused permit exists.

`user` = `{id, handle, display_name, role, created_at}`.

## Bootstrap (one round trip on app open)

```
GET /api/v1/bootstrap -> {
  user, version, terminal_enabled: bool, herdr_present: bool,
  stepped_up: bool, step_up_window_seconds: 300,
  counts: {review_open: n, agents_blocked: n},
  vapid_public_key: string|null
}
```

## Review inbox (human)

```
GET    /api/v1/review?status=open|answered|all   -> [item]
GET    /api/v1/review/{id}                       -> item (with attachments)
POST   /api/v1/review/{id}/answer  {value, note?} -> item
DELETE /api/v1/review/{id}                       -> 204   (dismiss/cancel)
GET    /api/v1/review/{id}/render                -> text/html, sandboxed document
```

`item`:
```jsonc
{
  "id": "rv_8f3a…", "title": "…", "kind": "confirm|choice|ack|manual|review",
  "urgency": "low|normal|blocking", "status": "open|answered|expired|cancelled",
  "body_md": "…",                    // raw markdown, for the phone preview only
  "options": [{"key":"A","label":"…","detail":"…"}],
  "recommend": "A"|null,             // omitted entirely when status=expired
  "context": {"repo":"…","branch":"…","worker":"…","links":[…]},
  "attachments": [{"id","kind":"diff|code|markdown|mermaid","title","language","content"}],
  "created_at": "…", "expires_at": "…", "answered_at": null,
  "answer_value": null, "answer_note": null,
  "source": "agent"                  // or "herdr" for a synthesized blocked-agent row
}
```

Answering: `value` must be one of the option keys for `choice`, `yes`/`no` for
`confirm`, `ack` for `ack`, or free text for `manual`. `note` is always allowed
and **outranks the button** — an agent that ignores a present note has misread
the answer.

**Expiry is a timeout and a timeout is never consent.** An expired item
serialises with `answer_value: null` *and drops `recommend`*, so an agent
cannot read its own suggestion back out of a timeout.

## Tasks — the reverse channel (human writes, agent claims)

```
GET  /api/v1/tasks                    -> [task]
POST /api/v1/tasks  {body, scope?}    -> task
```

## Terminal and realtime (human only)

```
GET  /api/v1/agents                   -> [{name, workspace, kind, status, pane_id, title, cwd, focused}]
GET  /api/v1/herdr/state              -> the whole session tree, below
POST /api/v1/terminal/ticket {session?} -> {ticket, expires_at}
POST /api/v1/stream/ticket            -> {ticket, expires_at}
GET  /ws/terminal?ticket=…&cols=&rows=&session=
GET  /ws/stream?ticket=…
```

```
POST /api/v1/herdr/focus  {agent} | {tab_id} | {workspace_id}  -> 204
```

`focus` is the only write herdrer makes into the Herdr session, and deliberately
the narrowest one that makes the agents board useful: it changes what is
focused and nothing else — it cannot start, stop, rename, or send keystrokes.
Exactly one target field may be set. It requires **step-up**, because focus
decides where the browser terminal's keystrokes and a pasted image path will
land, which is shell-adjacent even though it types nothing itself. Identifiers
are validated against an allowlist that also forbids a leading dash, since
`herdr agent focus --help` exits zero and would otherwise look like success.

`herdr/state` is what the agents UI is built on:

```jsonc
{
  "running": true, "version": "0.8.0", "protocol": 19, "blocked": 0,
  "focused_pane_id": "w1:p1", "focused_tab_id": "w1:t1", "focused_workspace_id": "w1",
  "workspaces": [{
    "id": "w1", "label": "", "number": 1, "focused": true,
    "agent_status": "unknown", "tab_count": 1, "pane_count": 1,
    "tabs": [{
      "id": "w1:t1", "workspace_id": "w1", "label": "", "number": 1,
      "focused": true, "agent_status": "unknown",
      "panes": [{
        "id": "w1:p1", "tab_id": "w1:t1", "workspace_id": "w1",
        "title": "…", "cwd": "/home/dev", "focused": true,
        "agent_status": "unknown",
        "agent": {"name": "…", "kind": "claude", "status": "blocked", …}
      }]
    }]
  }],
  "agents": [ … the flat list, for a board … ]
}
```

`running: false` with an empty tree is an ordinary state, not an error: a box
that has just booted may not have a Herdr server yet. herdrer starts one at
boot, so this should be brief — but a UI must render it, not crash on it.

Tickets are single use and live 60 seconds. The upgrade also checks `Origin`
exactly. A bearer token is refused on both sockets unconditionally.

`/ws/terminal` frames: first byte is the lane.
`0x00` = terminal bytes (binary, both directions),
`0x01` = JSON control (`{"type":"resize","cols":…,"rows":…}`, `{"type":"bell"}`).

`/ws/stream` is JSON text frames: `{"type":"review.created"|"review.answered"|
"agent.status"|"counts", …}`.

## Pasting an image at an agent

```
POST /api/v1/paste        raw image bytes, or multipart with field "image"
                       -> {path, content_type, bytes}
```

A terminal cannot carry an image: xterm.js hands the page a `File` on paste,
but the far end is a byte stream, and the escape sequences that exist for
images are for *display*, not for handing a file to a program. Both Claude Code
and Codex will read an image given a path, so the image travels out of band
over HTTP and what goes down the PTY is text.

The client then writes `<path>` into the terminal websocket on lane `0x00` —
exactly as if it had been typed. **No new wire protocol is involved.**

The returned path is safe to inject by construction, not by escaping: the
directory is fixed (`<state>/pastes/`, 0700), the basename is server-generated
hex, and the extension comes from sniffing the bytes against a closed set
(png/jpeg/gif/webp). Nothing in the path originates with the caller, so there
is no traversal to block, no leading dash for the next command to parse as a
flag, and no metacharacter to quote. Non-images are refused, 12 MiB cap, files
reaped after 24 hours.

## Push

```
GET  /api/v1/push/key                 -> {public_key}
POST /api/v1/push/subscribe {endpoint, keys:{p256dh, auth}} -> 204
POST /api/v1/push/test                -> 204
```

## Settings

```
GET    /api/v1/credentials            -> [{id, name, created_at, last_used_at, backup_state}]
DELETE /api/v1/credentials/{id}       -> 204   (refuses the last one)
POST   /api/v1/credentials/{id}/terminal {allowed: bool} -> 204  (needs step-up)
POST   /api/v1/credentials/enroll {label?, ttl_minutes?} -> {code, expires_at}
GET    /api/v1/sessions               -> [{id, user_agent, ip, created_at, last_seen_at, current}]
DELETE /api/v1/sessions/{id}          -> 204
POST   /api/v1/sessions/revoke-all    -> {revoked: n}
GET    /api/v1/tokens                 -> [{id, name, token_prefix, scopes, created_at, last_used_at, revoked_at}]
POST   /api/v1/tokens {name, scopes[], ttl_days?} -> {token: {…}, secret: "sk_…"}   // secret shown once
DELETE /api/v1/tokens/{id}            -> 204
GET    /api/v1/audit?limit=&kind=     -> [{id, at, actor, kind, subject, ip, user_agent, detail}]
```

## Agent tree

```
POST   /api/v1/agent/review           create; -> {id, url, expires_at}
GET    /api/v1/agent/review/{id}      current state
GET    /api/v1/agent/review/{id}?wait=300   long-poll until answered/expired
DELETE /api/v1/agent/review/{id}      cancel (the worker died or it went stale)
GET    /api/v1/agent/review?status=open     what this token is still waiting on
GET    /api/v1/agent/tasks/claim?scope=…    atomically claim the oldest pending task
POST   /api/v1/agent/tasks/{id}/complete {result} 
```

Create body:
```jsonc
{
  "title": "…",                    // required
  "body_md": "…",
  "kind": "confirm|choice|ack|manual|review",
  "options": [{"key":"A","label":"…","detail":"…"}],
  "recommend": "A",                // REQUIRED for choice and confirm
  "attachments": [{"kind":"diff","title":"…","language":"diff","content":"…"}],
  "context": {"repo":"…","branch":"…","worker":"…"},
  "urgency": "low|normal|blocking",
  "expires_in_hours": 12
}
```

A `choice` or `confirm` with no `recommend` is refused with `VALIDATION_ERROR`.
Presenting options with no opinion offloads the thinking onto the expensive
model.

Long-poll: `?wait=` is capped at `HERDRER_LONGPOLL_MAX_SECONDS` (default 300).
The server writes a whitespace heartbeat every 20s so intermediaries do not
time the connection out, and returns `{"data":{…,"status":"open"}}` when the
wait elapses. The client re-issues. This is a loop the agent runs, not a
promise the server makes.
