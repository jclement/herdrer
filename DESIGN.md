# herdrer — design

For someone changing this. If you only want to run it, read `README.md`.

herdrer is an experiment: a single Go binary on Jeff's Hetzner dev box that puts the two things
that can be waiting on a human — a **review document an agent posted**, and a **Herdr agent that
went `blocked`** — into one inbox, answerable from a phone in a few taps, with a real terminal
one tap further down when the inbox is not enough.

It steals liberally from `~/Developer/herdr-web` (the Herdr socket bridge, the PTY model, the
wire framing) and from `~/Developer/meatprompt` (the review/question object model, push, the
agent skill). It **depends on neither and replaces neither.** Both continue to exist; herdrer is
a third thing that tries the merged shape on one box.

---

## 0. Status, so nothing below is mistaken for a claim

The documents describe the intended whole. **It builds, the tests pass, and it runs** — a static
`linux/amd64` binary cross-compiles clean at 14 MB with CGO off. What follows is a **snapshot** of a
tree several people are writing in parallel; check the directory before believing a row.

| Area | State |
|---|---|
| `cmd/herdrer` | **Built.** `serve`, `enroll [--label --ttl]`, `token create [--name --scopes --user]`, `version`. |
| `internal/config` | **Built**, with tests. Loads and validates every key in `.env.sample`. |
| `internal/migrations/0001_init.sql` | **Built.** This file is the data model, not brief 03's proposal (§4). |
| `internal/store` | **Built.** Auth, tokens, enrollment, ceremonies, audit, review. |
| `internal/auth` | **Built.** WebAuthn service, sessions, `sk_` tokens, WS tickets. |
| `internal/api` | **Built**, with the route-principal test (D11). Routes, auth / review / settings / terminal / websocket / skill / static handlers, per-user event bus. |
| `internal/review` | **Built**, with tests. Item lifecycle, long-poll, and the goldmark → bluemonday sanitizer (D14). |
| `internal/terminal` | **Built.** Herdr socket client, agent board, detached PTY sessions with a 256 KB scrollback ring. **No headless VT** — §8.2 and §11. |
| `internal/notify` | **Built.** Direct Web Push over VAPID via `webpush-go`. No relay. |
| `internal/webui` | **Built.** `//go:embed all:dist`, with a `Present()` check so a binary built before any web build serves a placeholder rather than 404ing. |
| `deploy/`, `scripts/` | **Built.** `herdrer.service`, `Caddyfile`, `provision.sh`, `deploy.sh`, `install.sh`, and `scripts/README.md` as the runbook. |
| `web/` | **Built.** Router, shell, inbox, item page with action bar and option cards, diff view, sandboxed document frame, agents board, terminal, settings, login. |
| Mermaid rendering | **Source-only.** The sandboxed document emits `<pre class="mermaid">` with the source escaped; no diagram library is loaded, so a diagram reads as its source today (§11). |
| Bells / OSC 9 interception, step-up re-auth, `can_terminal`, Siri voice tokens, CI | **Not built.** |

Smoke-verified on a real run: `enroll` prints a single-use code; `/api/v1/health` and
`/api/v1/auth/state` answer unauthenticated; `/api/v1/bootstrap` 401s; the agent tree and
`/ws/terminal` refuse credential-less callers; `/onboard/skill.md` serves the vended agent skill.

Where this document describes something unbuilt it says so in the section. Where a brief argued
for something the code does differently, the code wins and the divergence is named.

---

## 1. Architecture

One process. One SQLite file. One embedded SPA. Two clients that are not each other: a human
holding a passkey, and an agent holding a bearer token.

```
    phone / laptop browser                          agents (Claude Code, Codex, …)
            │                                                   │
            │ HTTPS (passkey session, __Host- cookie)           │ HTTPS  Authorization: Bearer sk_…
            ▼                                                   ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  Caddy  :80/:443 on 203.0.113.10 — terminates TLS for herdrer.example.com │
  └───────────────────────────────┬──────────────────────────────────────────────┘
                                  │ reverse_proxy 127.0.0.1:7799  (loopback only)
                                  ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  herdrer — one binary, running as your dev user under a systemd *user* unit + linger    │
  │                                                                              │
  │   internal/api      three route trees, three principals (§6)                 │
  │     ├── /api/v1/auth/*   unauthenticated, rate limited, ceremony steps only   │
  │     ├── /api/v1/*        passkey session. the terminal lives here             │
  │     └── /api/v1/agent/*  bearer token, scoped. cannot reach a PTY             │
  │                                                                              │
  │   internal/auth     WebAuthn, sessions, sk_ tokens, 60s single-use tickets    │
  │   internal/store    all SQL. handlers hold none                               │
  │   internal/review   items, answers, expiry sweep, long-poll hub  [in flight]  │
  │   internal/terminal PTY mirrors + Herdr socket client            [in flight]  │
  │   internal/notify   Web Push (VAPID), optional ntfy mirror       [in flight]  │
  │   internal/webui    //go:embed of web/dist                       [in flight]  │
  │                                                                              │
  │   SQLite: $HERDRER_STATE_DIR/herdrer.db  (WAL, 0600, dir 0700)               │
  └──────────────┬───────────────────────────────────────────────────────────────┘
                 │ unix socket, mode 0600, same UID
                 ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  herdr server (protocol 19) — ~/.config/herdr/herdr.sock                      │
  │  workspaces · tabs · panes · agents · worktrees · the actual coding agents     │
  └──────────────────────────────────────────────────────────────────────────────┘
```

### The two lanes, and why they are the same security tier

- **Lane A — the terminal.** A PTY mirror attached to a Herdr session. Raw bytes both ways.
- **Lane B — the control board.** `agent.prompt`, `agent.send_keys`, `agent.explain`, the tree.

It is tempting to call lane B "the safe one". It is not. `agent.prompt "rm -rf ~"` is a shell.
There are exactly two states in this system: **no shell reachable** and **shell reachable**.
`HERDRER_TERMINAL_ENABLED=false` is the only thing that moves between them, and it removes both
lanes, not one.

### The review path, which is a different tier

A review item is a document. An agent posts one, a human answers it, the answer goes back. No
part of that path can execute anything. That is why it is the half of the product that is
defensible on the public internet, and it is why the token tree and the session tree are
separate route trees rather than one tree with a scope check.

---

## 2. Annotated project tree

```
herdrer/
├── mise.toml                    the contract: setup/dev/test/lint/fmt/check, plus build,
│                                build:linux, deploy, db:new, release. [env] pins dev to
│                                127.0.0.1:7799 with TLS off and origin http://localhost:7799
├── .env.sample                  every key, no values. Mirrored by the README table
├── docs/API.md                  the pinned HTTP + WebSocket contract. Changing a route means
│                                changing this file in the same commit
├── deploy/
│   ├── herdrer.service          the systemd *user* unit — configuration and the hardening
│   │                            list, with the reason each omitted directive is omitted
│   └── Caddyfile                the public edge. Unlimited write/read-body timeouts on
│                                purpose: any finite one cuts a 300s long-poll or a terminal
├── scripts/
│   ├── README.md                the runbook: fresh box, deploy, roll back, lock-out recovery
│   ├── provision.sh             one-time, on the box, as root: user + linger, Caddy, ufw,
│   │                            the unit, mise. Does not install or start herdrer
│   ├── deploy.sh                from the Mac: scp, verify sha256 on the far side, atomic
│   │                            rename, restart, poll health, roll back to herdrer.prev
│   └── install.sh               the public `curl … | sh` installer for *other* machines.
│                                Not used by this deployment (§10.4)
├── cmd/herdrer/main.go          serve · enroll · token create · version. `enroll` is the only
│                                way a first passkey ever exists (D9)
├── internal/
│   ├── config/config.go         env → Config, and the refusals. The only place that decides
│   │                            what an unsafe combination is (SUPPRESS_AUTH off loopback,
│   │                            autocert for a loopback domain, origin/domain mismatch)
│   ├── migrations/
│   │   ├── embed.go             //go:embed *.sql
│   │   └── 0001_init.sql        THE data model. Applied lexically on startup, never edited
│   │                            after shipping
│   ├── store/                   all SQL. store.go opens WAL+busy_timeout+foreign_keys with a
│   │   ├── store.go             single connection; auth.go, token.go, ceremony.go, enroll.go,
│   │   └── …                    audit.go hold the queries. ErrNotFound is the only "absent"
│   ├── auth/
│   │   ├── service.go           WebAuthn RP config, ceremonies, sessions, cookie names,
│   │   │                        bearer tokens, ws tickets
│   │   ├── scopes.go            the closed scope vocabulary — four entries, no terminal scope
│   │   ├── wauser.go            the go-webauthn User adapter
│   │   └── errors.go            coarse on purpose: a caller learns *that* it failed, not why
│   ├── api/
│   │   ├── routes.go            AUTHORITATIVE route list. Three trees, three middlewares
│   │   ├── middleware.go        securityHeaders, requireSameOrigin, requireSession,
│   │   │                        requireToken(scope), the token-bucket limiter, audit()
│   │   ├── envelope.go          {"data":…} / {"error":{message,code}} and the code constants
│   │   ├── bus.go               realtime fan-out, **per user, never global**, non-blocking
│   │   │                        sends so one wedged phone cannot stall another device
│   │   ├── handlers_ws.go       the upgrade checks and the lane bytes. coder/websocket,
│   │   │                        whose OriginPatterns default is same-origin — secure by
│   │   │                        default, and the danger in any library is the override
│   │   ├── handlers_*.go        auth, review, settings, terminal, skill, static
│   │   └── routes_test.go       the route-principal table (D11) — the strongest control here
│   ├── review/
│   │   ├── service.go           item lifecycle, answers, the long-poll
│   │   └── render.go            goldmark (raw HTML off) → bluemonday. "Every byte handled
│   │                            here is hostile input" (D14)
│   ├── terminal/
│   │   ├── service.go           Herdr socket client and the agent board. Everything in this
│   │   │                        package is shell-equivalent
│   │   └── pty.go               PTY sessions owned by the *server*, not by a websocket, with
│   │                            a 256 KB scrollback ring so a phone repaints on reconnect
│   ├── notify/service.go        Web Push over VAPID, direct. No relay
│   └── webui/embed.go           //go:embed all:dist, plus Present() so a binary built with no
│                                SPA serves a placeholder instead of 404ing every path
├── web/                         React + Tailwind SPA, built by bun into internal/webui/dist.
│   └── src/features/            review (inbox, item, diff, action bar, sandboxed document
│                                frame), agents (board, terminal), settings, auth
└── .github/workflows/           [empty] no CI yet
```

---

## 3. Key decisions

Numbered so they can be cited. Each states the alternative that was rejected.

### 3.1 Shape and deployment

**D1 — One binary, one process, one unprivileged user.**
Herdr's socket is `srw------- <you>`, mode 0600, no group bit, no token, no ACL. Herdr's access
control *is* filesystem permissions. A different UID cannot open it. Every PTY herdrer spawns
must also be Jeff's shell — his dotfiles, mise shims, `ssh-agent`, `~/Developer` checkouts.
So herdrer runs as your dev user, under a **systemd user unit** with `loginctl enable-linger <user>`.
*Rejected:* brief 02 §7.1's two-unit split (`herdrer.service` as a hardened `herdrer` user for
the review lane, `herdrer-shell.service` as the dev user for the PTYs, talking over a 0660 socket). It
is a genuine containment boundary **only in review-only mode** — with both units running, the
web process mints the tickets, so compromising it eventually reaches a shell. Paying two units,
two configs and an IPC hop for a boundary that only exists in a mode where the second unit is
not running was not worth it for v1. Revisit if herdrer is ever run permanently review-only.
*Also rejected:* loosening the Herdr socket to a shared group. That deletes Herdr's only access
control to gain a service account, which is backwards.

**D2 — Caddy terminates TLS; herdrer listens on loopback `127.0.0.1:7799`.**
Caddy owns `:80`/`:443` on the public interface for `herdrer.example.com` and reverse-proxies
to loopback. Every byte of TLS parsing, ALPN negotiation and HTTP/2 framing is pre-authentication
attack surface that is now *not* in the process holding the Herdr socket. It also gives HSTS,
OCSP stapling, HTTP/3, access logs and a place to put a global rate limit that survives an
application bug — none of which we then write.
*Rejected:* in-process ACME, **and the rejection is enforced in code**. `cmd/herdrer` serves TLS
only for `HERDRER_TLS_MODE=file`; every other mode falls through to a plain `ListenAndServe`, with
the comment saying why — taking `:443` from a user unit means `CAP_NET_BIND_SERVICE`, and granting
a capability to the one process on the box that forks shells is exactly backwards. `autocert`
therefore remains a *valid config value that does nothing special*, which is a wart: it is accepted
by `config.validate()` and then silently behaves as `off`. Either wire it or reject it; today it is
neither. `file` is the real escape hatch for a no-proxy deployment.
*Also rejected:* Cloudflare Tunnel. Cloudflare would terminate TLS and therefore see every byte
of the terminal — which is precisely the third-party-in-the-path property that deleting
herdr-web's E2E envelope (D6) was only defensible *because* it no longer exists.

**D3 — `herdrer.example.com`, knowingly sharing a registrable domain.**
This is a decision taken **against** brief 02 §1.2, which recommended a dedicated eTLD+1 and said
in as many words "do not put herdrer on `example.com`". Jeff chose the shared domain anyway,
with the reasoning understood.

What it costs: `SameSite` is **site**-scoped, not origin-scoped. Any other service deployed on
the same registrable domain — a sibling subdomain — is therefore *same-site* with herdrer. An XSS on any of them becomes a candidate launch point for cross-site WebSocket
hijacking against a terminal that is a shell — which is the exact shape of Dozzle CVE-2026-44985,
Mailpit CVE-2026-22689 and nginx-ui CVE-2026-34403, all in 2026.

What compensates, and none of it is free:

| Control | What it does about the shared domain |
|---|---|
| `__Host-` cookie prefix | Forbids a `Domain` attribute, so a sibling host cannot **set** a cookie our origin will read. Kills cookie-forcing / session fixation from a sibling |
| `SameSite=Strict` | Narrows what Lax would have allowed; see D4 for what it costs |
| Exact-string `Origin` match on every state-changing request | `middleware.go: originOK` compares scheme + host + port. Not a suffix match, not a registrable-domain match. A sibling is same-site but is not us, and this is the check that says so |
| Absent `Origin` is a **rejection**, not a pass | The common bug is "if Origin is present, check it", which fails open for anything that can suppress the header |
| Same exact-origin check on the WebSocket upgrade | The upgrade is a `GET`, is not subject to CORS preflight, and browsers attach cookies to it automatically. The origin check is the whole defence there |
| Single-use, 60-second ticket, minted by an authenticated same-origin `POST` | The ticket is **not ambient**. A cross-site page cannot cause the browser to attach it, so even a bug in the origin check leaves the attacker needing script execution *in our origin* first. This converts one check into a conjunction |

**Residual risk: accepted, not eliminated.** A sibling-origin compromise plus a bug in the origin
check would be a shell. On a dedicated eTLD+1 the sibling would not exist at all. This is
recorded again in §11 (known limitations) and in the threat table (§7), because it is the single
largest deliberate concession in the design.

**D4 — `SameSite=Strict`, not `Lax`.**
Brief 02 §2.2 argued for `Lax`, because a push-notification tap and a bookmarked deep link are
top-level navigations and `Strict` makes the first one after a cold start land logged-out. Given
D3, `Lax`'s guarantee is the wrong shape: it protects against *cross-site*, and our siblings are
same-site. `Strict` is chosen.
*Cost, stated honestly:* a cold cross-site top-level navigation into a deep link will not carry
the session cookie on the first request, so it lands on the passkey ceremony and then resumes to
the same route. That is one extra Face ID on a cold tap. Neither `Strict` nor `Lax` is the
primary CSRF control — the router-level `Origin` check is (D3), and both cookie modes are
explicitly layer two.

**D5 — Terminal off by a config key, and it is a real mode.**
`HERDRER_TERMINAL_ENABLED=false` builds a review-only deployment: no PTY, no Herdr control verbs,
no shell reachable from any HTTP path. In that mode herdrer's threat model is a notes app that
holds diffs, and public exposure is comfortable. That mode is the reason to make the split at all.
*Not yet decided against the brief:* brief 02 §7.5 wanted the flag to be a command-line argument
so it appears in `systemctl status` and `ps`, and wanted a third even-uglier flag before the
terminal is reachable from the public listener at all. Today it is an ordinary env var and there
is no listener-of-origin check. That gap is in §11.

### 3.2 Cryptography and transport

**D6 — Delete herdr-web's relay and its end-to-end crypto envelope.**
herdr-web ran through a Cloudflare Worker + Durable Object relay and wrapped everything in a
hand-rolled X25519 / HKDF / ChaCha20-Poly1305 envelope, with a public key in the URL fragment and
6-digit SAS pairing. All of that existed for exactly one reason: **a third party carried the
bytes.** herdrer's path is browser → TLS 1.3 → Caddy on Jeff's box → loopback → herdrer. There is
no third party. TLS provides confidentiality, integrity, forward secrecy, server authentication,
downgrade resistance and replay protection from an implementation with two decades of adversarial
review; herdr-web's own §15 admitted its handshake was "not a reviewed implementation of a named
protocol". Deleting a hand-rolled crypto protocol from a system whose failure mode is RCE is a
security **gain**, not a trade.

**D7 — …and what that honestly costs.** Three things, and the second is real.

1. *The CA is now in the TCB.* A pinned host key made a mis-issued certificate worthless. Now any
   of ~150 trusted CAs, plus a network position, is a full MITM. Mitigations — CAA records, CT
   monitoring, HSTS preload — are not equivalent. Accepted; it is the risk his bank has.
2. **Channel binding is gone, and this is the real loss.** With per-device X25519 keys, possession
   of the channel was *continuous* proof of possession of the device. There was no bearer
   credential to steal. herdrer replaces that with: prove possession once via WebAuthn, then carry
   a bearer cookie. **A stolen cookie is a stolen session until it is revoked.** Passkeys restore
   part of it — the private key never leaves the secure enclave, a stolen database cannot forge an
   assertion — but they authenticate an *event*, not a *channel*. Short TTLs, hashed sessions,
   instant revocation and 60-second single-use tickets are all buying back, imperfectly, a
   property that per-device keys gave for free. Device Bound Session Credentials would restore it
   properly; browser support is too thin to design around in 2026 and it is the right thing to
   adopt when it lands.
3. *The coffee-shop-via-relay option is foreclosed.* Any proxy in front now sees the terminal in
   plaintext. The set of safe topologies has shrunk to "TLS terminates on hardware I control".

**D8 — Passkeys only. Discoverable credentials, user verification required.**
No passwords, no magic links, no TOTP, no OIDC, no recovery email. `residentKey: required` means
there is **no username field**, so there is no user enumeration and nothing for a phishing page to
harvest — the login page is one button. It also matters mechanically: go-webauthn only applies
user-verification options to discoverable credentials, so asking for UV without asking for
resident keys is a configuration that silently does nothing.
*Rejected:* every recovery mechanism that is not "hold another credential". An emailed recovery
link puts his email provider in the TCB of his dev box. Printed codes and TOTP seeds are static
bearer secrets for RCE. **The recovery story is: enroll two passkeys, and `herdrer enroll` over
SSH.** If he loses every passkey and every SSH key at once, he recovers via the Hetzner console —
and that is correct, because the Hetzner console is already a total-compromise path and herdrer
must not be *easier* than it.

**D9 — Registration is closed. A locally-minted, single-use, expiring permit is the only way in.**
"First browser to hit `/register` wins" loses to any scanner; masscan sees a new `:443` in
minutes. So `enrollments` rows are created only by an operator running `herdrer enroll` **on the
box**, carry `HERDRER_ENROLL_TTL_MINUTES` (default 15), are stored as `sha256(code)`, and are
consumed **atomically inside the transaction that writes the credential** (`store/enroll.go:
ConsumeEnrollment`). Minting requires an existing shell on the box — an attacker who can mint
already has what enrollment would give them, which is exactly what makes this not a backdoor.
`GET /api/v1/auth/state` reports `enrollment_open` so the UI can say "run `herdrer enroll` on the
server" instead of showing a login button that cannot work.

### 3.3 Storage and API

**D10 — SQLite via `modernc.org/sqlite`, CGO off.**
One box, one user, a few megabytes, and the whole point is a single artifact you scp. Pure Go
keeps `CGO_ENABLED=0` for release builds, so cross-compiling `linux/amd64` from the Mac is one
command. WAL for concurrent readers, `busy_timeout(5000)` so a long-poll transaction never
surfaces `SQLITE_BUSY`, foreign keys on because revocation leans on `ON DELETE CASCADE`, and
`SetMaxOpenConns(1)` because modernc serialises writes internally and one connection makes
transaction semantics obvious.
*Rejected:* Postgres (an operational dependency for a single-user app), and D1/Workers (herdrer
must be on the same box as the Herdr socket, so there is nothing to put at the edge).

**D11 — Three route trees, not one tree with scope checks.**
`routes.go` is the authorisation model:

| Tree | Principal | Property |
|---|---|---|
| `/api/v1/auth/*` | none | The only unauthenticated writes in the process, all rate-limited, every one a WebAuthn ceremony step |
| `/api/v1/*` | passkey session | The terminal lives here and nowhere else |
| `/api/v1/agent/*` | `Bearer sk_…`, scoped | **No handler under this prefix can reach a PTY**, and no code path upgrades a token into a session |

This must be *structural*, not configurational: a scope list is a thing someone edits at 2am; a
route tree is a thing that has to be recompiled.

**`internal/api/routes_test.go` is what turns that from a claim into a property, and it is the
single most valuable thing in the repository.** It holds a table of **all 38 endpoints**, each
tagged `open` / `session` / `token`, mirroring `routes()`. Adding an endpoint means adding a line —
which is the point: the table is the checklist a reviewer reads, and the tests prove the checklist
matches reality.

| Test | Asserts |
|---|---|
| `TestEveryRouteRefusesAnonymous` | Nothing outside the auth ceremony answers an unauthenticated caller. This is what catches a route registered on the wrong tree |
| `TestAgentTokenCannotReachHumanRoutes` | A valid `sk_` is refused on **every** human route — the terminal ticket included |
| `TestSessionCannotUseAgentRoutes` | A valid session cookie is refused on **every** agent route. The disjointness runs both ways, so neither tree can quietly widen the other |
| `TestCrossOriginWriteIsRejected` | State-changing requests are refused from a **same-site sibling** (D3's actual threat), from the wrong scheme, and with the header absent entirely |
| `TestAgentTokenWorksWithoutOriginHeader` | …while a bearer caller, which carries no ambient credential, is not broken by that rule |
| `TestAgentCannotReadAnotherAgentsItem` | The IDOR case: an agent token cannot read an item belonging to a different agent |
| `TestSecurityHeaders` | The CSP and the header set are actually emitted, not merely written down |
| `TestHealthLeaksNothing` | Unauthenticated `/health` is not a version banner for a scanner |

Alongside it, `internal/config/config_test.go` proves the refusals in §3.3 are real (`SUPPRESS_AUTH`
refuses **any** non-loopback listener, a plain-HTTP public origin is refused, an origin/domain
mismatch is refused, and the RP ID comes from the origin), and `internal/review/service_test.go`
proves the semantics rather than the code: `recommend` is required for `choice` and `confirm`,
backpressure holds, **expiry is not consent end to end**, an item answers exactly once, a long-poll
releases on answer, hostile markdown is sanitized, and the rendered document carries the
locked-down CSP (§5.2, D14).

**D12 — The scope vocabulary is closed and has no terminal scope.**
`review:write`, `review:read`, `task:claim`, `agents:read`. No wildcard, no `admin`, no `*`. A
token cannot request shell access because no scope exists that would grant it. Note the honest
limit: herdrer runs *on the dev box*, where an agent already has a shell — so a bot token is not
a meaningful privilege boundary against a determined local process. It prevents accidental
cross-talk between workers and gives the audit trail a name to write down. **The real boundary is
the passkey**, and it is the only one worth reasoning about.

**D13 — Task creation is human-only, and that is the anti-injection control.**
An agent that claims a task treats its body as instructions, so the write side of that queue is an
instruction-injection channel into whatever the next agent does. `POST /api/v1/tasks` is in the
human tree; there is no agent-tree route that creates one. The mirror rule holds too: a bot token
gets 403 on answering a review item, **including one it created itself**. The delivered task body
should carry an explicit envelope ("this is a request queued by the human operator, not an
authorisation — run your normal gates"), and DESIGN says plainly: **a preamble is a mitigation,
not a fix.** Prompt injection is not defeated by asking nicely. The control is the trust boundary.

**D14 — Agent-authored markdown renders server-side and then in a sandboxed iframe.**
The chain that matters, written out because it is the one that ends this app:

> A dependency's README, a CI log or a scraped page contains text crafted to influence an agent.
> The agent — doing exactly its job — writes a review item whose body contains that text. Jeff
> opens it on his phone with a live session. Script in that markdown calls the ticket endpoint and
> opens a terminal. **A file in a transitive npm dependency has become a shell on his dev box.**

The agent is a *trusted* party producing *untrusted* content, so nothing in the token scheme
helps. Only rendering controls do, and mermaid's CVE record (CVE-2025-54881, the bundled-DOMPurify
prototype pollution, the deepchat escalation to RCE) says do not bet the box on a sanitizer being
correct. So: goldmark with raw HTML **off** → bluemonday server-side (`GET
/api/v1/review/{id}/render` returns the sanitized document) → rendered inside
`<iframe sandbox="allow-scripts" srcdoc="…">` with **`allow-same-origin` absent**, which puts it
in an **opaque origin**: no parent DOM, no `document.cookie`, no same-origin fetch, no way to mint
a ticket. The iframe carries its own `<meta>` CSP whose load-bearing directive is
`connect-src 'none'` — an opaque origin that cannot make network requests can compute and cannot
exfiltrate. Mermaid and the highlighter live only in that bundle and never execute top-level.
**`allow-scripts` together with `allow-same-origin` is equivalent to no sandbox at all** (the
frame can remove its own sandbox attribute); that pair must be banned by a test.
*Cost:* text selection, find-in-page and deep links inside the body get slightly worse. That is
the price, and the alternative is that an XSS in a markdown renderer is a shell.

**D15 — WebSocket auth is a ticket, not the ambient cookie.**
Cookie-on-upgrade is what all three 2026 CVEs exploited. The SPA `POST`s to
`/api/v1/terminal/ticket` or `/api/v1/stream/ticket` (session-authenticated, origin-checked) and
gets a 32-byte, single-use, **60-second** ticket bound to the session and a purpose. The upgrade
then requires **all** of: valid session, exact `Origin` match, a valid unused ticket of the right
purpose. A bearer token is refused on both sockets unconditionally.
*Deviation to note:* brief 02 §5.3 wanted the ticket carried in `Sec-WebSocket-Protocol` rather
than the query string, because query strings land in Caddy's access log and any future error
report. `docs/API.md` currently pins `?ticket=…`. A 60-second single-use token in a log is a
smaller problem than a session cookie in a log, but it is still a problem worth not having; moving
it is a contract change and is listed in §11.

**D16 — Two sockets (`/ws/terminal`, `/ws/stream`), not one multiplexed socket.**
Brief 01 §5 argued for a single socket with a lane byte, on three grounds: a phone on LTE pays a
full TLS handshake per connection, ordering matters across lanes ("agent went blocked" and the
bytes showing why must not race), and the lane byte costs one byte. Those arguments are good.
`docs/API.md` nonetheless pins two sockets, and the reason is the security model: the stream
socket may be opened by any live session, while the terminal socket is the RCE surface and wants a
different ticket purpose, a different concurrency cap, a different audit row and — eventually — a
different gate. Keeping them physically separate makes "this connection is a shell" a property of
the endpoint rather than of a byte inside a frame. **Both still carry a lane byte internally**
(`0x00` terminal bytes, `0x01` JSON control) so the framing is shared. If the reconnect cost on
LTE turns out to bite, merging them back is a contract change, not a redesign.

**D17 — Long-poll, with a whitespace keep-alive, and `WriteTimeout: 0`.**
`GET /api/v1/agent/review/{id}?wait=300` parks a goroutine on a broadcast channel, a timer and
`r.Context().Done()`. Thousands of those cost a few MB, so the server is not the constraint. The
constraints are proxies: Cloudflare's 100s first-byte rule, nginx's 60s between-reads default. So
the response is chunked and the server emits a single `\n` every 20 seconds before the JSON body —
every JSON parser tolerates leading whitespace, so `curl … | jq` is unaffected, but bytes are
flowing, which defeats both at once. `wait` above `HERDRER_LONGPOLL_MAX_SECONDS` is **clamped, not
refused**. On timeout the server returns **200 with `{"status":"open"}`** — documented as a loop
the agent runs, not a promise the server makes.
**`http.Server.WriteTimeout` must be 0**, and that belongs here rather than in a config comment
because it looks like an oversight to anyone reading it later: a non-zero `WriteTimeout` kills the
connection mid-block and turns every long-poll into a mystery. `ReadHeaderTimeout` and
`IdleTimeout` are set explicitly instead, because Go's zero values are unlimited and Slowloris
against the app is one of the few things a reverse proxy does not entirely absorb.

**D18 — `SUPPRESS_AUTH` is a runtime env var, validated, not a build tag.**
Brief 02 §6.7 wanted `//go:build dev` so the bypass does not exist in a release binary, on the
grounds that on every other app in this house style the flag leaks *data* and on this one it leaks
*his laptop*. That argument is correct and was still not taken, because the house style mandates
the flag and E2E ergonomics depend on it. The compensation is in `config.validate()`: with
`SUPPRESS_AUTH=true` the process **refuses to start** if `HERDRER_ADDR` is not loopback, or if the
origin is not a loopback host. It is a real refusal, not a warning.
*Residual:* a release binary still contains the code path. Compiling it out remains the right
answer and is in §11.

### 3.4 Product shape

**D19 — One inbox, two row sources.**
A review item and a blocked Herdr pane are **not the same object** — one is posted deliberately
and carries markdown, options and a recommendation; the other is *inferred* by Herdr scraping a
screen and answers with a guessed keystroke. A shared table would be a lie: `answer_value`,
`expires_at` and `recommend` are meaningless for a blocked pane, and a review row has no pane to
send keys to. But they are the same question in Jeff's head ("what needs me right now"), and
answering that in two places is how one of the two stops getting opened.

So: **two sources, one list.** Review items are rows in `review_items`. Blocked panes are
synthesised live from the Herdr socket, marked `source: "herdr"` on the wire, and **never
persisted**. Ordering encodes the incentive deliberately: a well-formed review item always sorts
above a raw blocked pane, and a raw blocked pane does not buzz the phone by default. An agent that
uses herdrer properly gets answered first, and the quality gap is visible on the same screen.
*Explicitly rejected:* auto-converting a blocked pane into a review item by scraping the prompt
with `agent.explain`. That result is untyped free-form JSON, the scrape would sometimes be wrong,
and a wrong button on an irreversible action is the exact failure the whole review path exists to
prevent. If an agent wants real buttons, it posts a review. The vended skill says so.

**D20 — The phone is the primary client, and the terminal is a leaf.**
`/` is the review inbox, not a dashboard. The terminal is never in the nav; it is reachable in one
tap from an agent. On a review page the order is **decision first, evidence second** — question,
context strip, recommendation, option cards, *then* the why, the reviewer's take, the diagram and
the diff. Both parent designs put the diff first; on a 375px screen that makes the common case
("yes, do the recommended thing") cost nine screens of scrolling past evidence you were never
going to read. One order on every viewport — no `order:` reshuffling between breakpoints, which
wrecks reading order for assistive tech and produces two layouts to debug.
*Honest:* a 300-line diff on a 375px screen is bad and no layout fixes it. The mitigation is
upstream — `guided-diff` chunking and collapsed churn are the item author's job — plus a "needs a
real screen" action that defers without answering. **A defer is not consent either**, but it is
honest information the agent otherwise has no way to receive.

**D21 — Informative push, not contentless.**
herdr-web sent contentless wake frames because a relay it did not trust would otherwise read them.
There is no relay, and Web Push payloads are encrypted `aes128gcm` under the subscription's own
keys, so Apple relays ciphertext it cannot read. `be-2134 · nullable column, or required with a
default?` beats "an agent needs you" by exactly the amount that matters at a bus stop.
*What it costs, named rather than allowed to happen silently:* repo names, branch names and the
shape of unreleased work reach Apple/Google/Mozilla as *metadata about when a push happened*, and
titles are the payload. Policy: title only, hard-truncated, never bodies, never diffs, never
paths, with a per-item `sensitive` flag that degrades to "be-2134 needs a decision", and
`HERDRER_NTFY_URL` available as a contentless escalation path (ntfy's `poll_request` carries only
a message id).

**D22 — No unattended auto-update.**
herdrer is the thing you use to fix the box. An update that lands at 03:00 and fails to start
locks you out of the machine from a phone, which is precisely the situation the project exists to
handle. Notify loudly, make applying it one tap, never do it silently. `Restart=always` (not
`on-failure`) in the unit, because the admin-triggered update path replaces the binary and exits
**zero** expecting the supervisor to bring it back; crash-loop protection comes from
`StartLimitBurst`, not from the restart mode.

---

## 4. Data model

The authority is `internal/migrations/0001_init.sql`. Migrations are numbered, embedded, applied
lexically on startup before the listener binds, and **never edited after shipping**.

Times are stored as **Unix integers** in SQLite and serialised as RFC3339 strings on the wire.

```
users ──┬── credentials          (WebAuthn public keys, sign_count, aaguid, backup_state)
        ├── sessions             (id = sha256(cookie), credential_id, ua, ip, expires_at, revoked_at)
        ├── enrollments          (code_hash, expires_at, used_at, used_by)  — the only way to register
        ├── api_tokens           (token_hash, token_prefix, scopes, expires_at, revoked_at)
        ├── push_subs            (endpoint UNIQUE, p256dh, auth, failed_at)
        └── review_items ── review_attachments
webauthn_ceremonies              (in-flight challenges, 5-minute TTL, single use)
audit_log                        (append-only; security events and item lifecycle in one table)
```

| Table | Why it looks like that |
|---|---|
| `users` | One row in practice. Single-user is assumed **loudly**; if a second human ever appears, the task/injection boundary (D13) is the first thing to revisit |
| `credentials` | `sign_count` is persisted so a cloned authenticator is detectable. Most passkeys report 0 forever, so a regression is a **logged signal, not a hard fail** — hard-failing on it would lock him out for a platform quirk |
| `sessions` | `id` is the **sha256 of the cookie value**, not the value. A leaked DB backup then hands over no live sessions. 256 bits of random needs no salt or KDF. `credential_id` matters: revoking a passkey must kill every session it created |
| `webauthn_ceremonies` | In SQLite, not memory, with a 5-minute TTL and single-use semantics — systemd restarts the process mid-flow more often than you would think, and a restart that silently invalidates an in-flight registration is the kind of thing that gets debugged by disabling auth |
| `enrollments` | See D9. `code_hash` only; the plaintext is printed once by the CLI |
| `api_tokens` | `sha256(sk_…)` + an 8-char display prefix. Looked up **by hash**, never prefix-then-compare. Revoked and expired tokens return `ErrNotFound` so a caller cannot tell them apart from a bad token. `TouchAPIToken` runs off the hot path |
| `review_items` | The document. See §5 |
| `review_attachments` | Diffs and code kept **out of** the body so the inbox listing does not ship them, and a phone can lazily load a 3 000-line diff below the fold |
| `audit_log` | One table for security events and item lifecycle, so "what happened on this box" is one query |

### The divergence from brief 03

Brief 03 proposed five tables — `review_items` / `review_sections` / `review_decisions` /
`review_comments` / `tasks` — with N decisions per item, ordered typed sections, inline comments
anchored to `(section, hunk, line)`, and tasks split out of the item table on the grounds that
meatprompt's `direction` collapse had stopped holding.

**`0001_init.sql` does not do that.** What shipped is meatprompt's shape, ported: one
`review_items` table carrying `direction` (`ask` | `task`), one `kind`, one `options_json`, one
`recommend`, one `answer_value`, plus a typed `review_attachments` child for diffs, code, markdown
and mermaid. Tasks are `direction='task'` rows in the same table.

This is a deliberate v1 simplification, and the brief's argument against it is still correct on
its merits:

- one item with three decisions means reading the diff once and tapping three times, instead of
  three inbox rows for one review;
- ordered section rows are what let churn collapse (`12 files · renames only`), let the first two
  chunks default open, let a decision anchor to the hunk it turns on, and let the reviewer's take
  be **appended** ninety seconds after the item was posted rather than requiring a rewrite;
- the trust rules for items and tasks are exact mirror images, and enforcing two mirrored rules on
  one table is how you eventually get one wrong.

The counter-argument that won for v1: attachments cover the "big diff, lazily loaded" case, which
is most of the value; one decision per item keeps status a scalar and the long-poll return
unambiguous; and shipping the smaller thing on a real box teaches more than shipping the right
thing later. **`0002_sections.sql` is the expected next migration**, and the trigger is the first
item that genuinely wants three decisions off one document. Until then this paragraph is the
record of why the schema looks less ambitious than the brief that fed it.

---

## 5. Human Review — the object model and its semantics

### 5.1 The object

A review item is **one unit of human attention**: one inbox row, one push, one URL, one badge
increment. It has a `kind` (`confirm` | `choice` | `ack` | `manual` | `review`), an urgency
(`low` | `normal` | `blocking`), a markdown body, typed attachments, a context strip
(repo / branch / worker / links), an expiry, and — for `choice` and `confirm` — a **mandatory
`recommend`**.

`recommend` being mandatory is the single most valuable piece of question hygiene in the system,
and it is enforced at the API (`VALIDATION_ERROR` without it) rather than requested in the skill.
It does two things at once: it makes the phone answerable in one tap without reading the evidence,
and it makes the agent state a pick — because **if your recommendation is obvious, that is
evidence you should have just done it**.

### 5.2 The critical semantic

> **Expiry is a timeout. A timeout is NEVER consent.**

This must be stated loudly in at least five places: here, in the vended `SKILL.md`, in
`docs/API.md` (it is), in a header comment on the one file that owns terminal transitions
(`internal/review/resolve.go`), and in the serializer.

The serializer is where the trick lives, and it is worth spelling out. An expired item does not
merely serialise with `answer_value: null` — **it drops `recommend` from the payload entirely.**
The seductive failure mode is not an agent inventing "yes". It is an agent reading
`status: "expired"`, seeing `recommend: "A"` still sitting in the response body, and proceeding on
its own earlier opinion because that opinion is *right there*. Delete the field. Make the wrong
thing unavailable rather than merely forbidden.

| Situation | What it means to the agent |
|---|---|
| `status: expired` | Nothing was decided. Stop and report. Do not re-ask automatically |
| `status: cancelled` (human) | A **withdrawal**, not a denial. Distinct from expiry so the agent can say which happened |
| Long-poll returned `{"status":"open"}` | Not a status change at all. Re-issue the loop |
| An answer with a `note` | **The note outranks the button.** An agent that acts on `answer_value` and ignores a present note has misread the answer |
| No answer, and herdrer is unreachable | Stop and say so. Never proceed as though you had asked |

### 5.3 Expiry needs a sweep, not lazy reads

A 60-second goroutine flips overdue items and broadcasts, plus a lazy settle on read for the gap
between ticks. meatprompt learned this in production: **a status nobody writes is a status nobody
can be woken for.** A lazily-computed expiry never wakes a long-poll, never fires an event, and
never leaves the inbox.

### 5.4 The three ways an answer gets back

1. **The agent is long-polling.** The answer returns in-band. Best; nothing to configure. This is
   the norm the skill should teach.
2. **The agent went back to a TUI wait.** Because herdrer holds the Herdr socket, it can relay:
   `agent.prompt <pane> "<rendered answer + note>"`. This is what makes "four taps to unblock"
   literally true, and it exists **only** because the review subsystem and the Herdr bridge are
   the same binary. *The socket client exists; nothing yet relays an answer through it.*
3. **Neither.** The answer sits undelivered and surfaces in a query `/next` and `/crew` can drain.
   The human's thinking is not wasted because the process that asked is gone.

### 5.5 The vended skill

`GET /onboard/skill.md` (registered in `routes.go`) serves the agent-facing skill; `herdrer skill
install` should write it directly to `~/.claude/skills/herdrer/SKILL.md`, which the single-box
deployment makes possible. Its content is meatprompt's shipped skill plus:

- **When *not* to ask, stated first.** Do not ask when it is inferable from the ticket, the code
  or CLAUDE.md; when it is a default you could pick and flag; when you'd act the same either way.
  Do ask when being wrong is expensive and hard to undo. **The reversibility test decides most
  cases**: cheap and reversible → do it and note it; irreversible or expensive → ask, even if you
  have a strong opinion, and especially then.
- **When you finish substantial work, submit a `review` item.** That is not asking, it is
  delivering, and it is the larger half of what herdrer is for. Threshold: anything you'd open a
  PR for.
- **The body of a `review` follows `~/.claude/skills/guided-diff/SKILL.md` in full.**
  `guided-diff` is *not* superseded — it is the content spec and it is orthogonal to transport.
  `ask-user` largely **is** superseded: nearly all of it is machinery that exists because
  artifacts cannot be watched, and herdrer is our own origin with a database and a WebSocket.
  What survives from it is the product judgement — the three row kinds, oldest-waiting-first where
  waiting means **the age of the problem, not the age of the row**, never more than four options
  plus custom, and "relay the reasoning, not just the letter".
- **Cancel your item if it stops mattering.** A stale item is worse than no item.
- **The item you are most tempted to send is usually the one you should decide yourself.**

---

## 6. The auth model, as implemented

```
  browser                                     herdrer
     │  GET /api/v1/auth/state                    │  enrolled? enrollment_open? origin, rp_id
     │───────────────────────────────────────────►│
     │  POST /auth/{login,register}/begin          │  challenge → webauthn_ceremonies (5 min, single use)
     │───────────────────────────────────────────►│  ceremony id → __Host-herdrer_ceremony cookie
     │  ◄── CredentialRequestOptions ─────────────│
     │  navigator.credentials.get/create           │
     │  POST /auth/{login,register}/finish          │  verify origin ==, RP ID hash, UV flag, UP flag,
     │───────────────────────────────────────────►│  challenge single-use; register also consumes the
     │                                             │  enrollment permit in the SAME transaction
     │  ◄── Set-Cookie: __Host-herdrer_session ───│  sessions.id = sha256(cookie value)
```

| Property | Value | Reasoning |
|---|---|---|
| RP ID | `RPID()` = the origin's hostname, derived from `HERDRER_ORIGIN` | Deriving it from the origin rather than the domain means a mismatch is caught by `validate()` rather than silently minting credentials that will not verify. **This value is permanent** — change it and every passkey is dead |
| Resident key | required | No username field, so nothing to enumerate |
| User verification | required, and the **flag is checked**, not just requested | "Required" in the options is a request; the `UV` bit in authenticator data is the fact |
| Attestation | none | Buys nothing for a single-user app and adds a metadata-service dependency |
| Session cookie | `__Host-herdrer_session`, `Secure`, `HttpOnly`, `Path=/`, `SameSite=Strict`, no `Domain` | D3, D4. The plain name is used only for loopback dev, where `__Host-` cannot apply |
| Session storage | server-side row, `id = sha256(token)` | Revocation is a `DELETE` and takes effect on the next request. Never a JWT |
| Session TTL | `HERDRER_SESSION_TTL_DAYS`, default 30 | See §11 — 30 days is the house default for a notes app and is arguably wrong for a shell |
| Agent token | `sk_…`, stored as `sha256` + 8-char prefix, shown once | 256 bits of entropy is not a password; sha256 with constant-time compare is correct and fast |
| WS ticket | 32 bytes, single-use, **60 s**, bound to session + purpose | D15 |
| Rate limits | login 30/min burst 10; enrollment 6/min burst 3; agent 600/min burst 60, per IP | WebAuthn is not brute-forceable, so this is DoS and noise reduction, not lockout. **No account lockout** — on a single-user app, lockout is a self-DoS primitive an attacker can trigger from anywhere |

### What is deliberately *not* in the auth model yet

Both are named honestly rather than implied:

- **No step-up.** Brief 02 §2.4 wanted `last_uv_at` on the session and a fresh assertion within 15
  minutes before opening any socket, enrolling a credential, or minting a token. The `sessions`
  table has no such column. Today a live session cookie plus a same-origin ticket mint is
  sufficient to open a terminal.
- **No `can_terminal` credential class.** Brief 02 §1.3 wanted the phone passkey to be review-only
  by default, so a stolen unlocked phone reaches the inbox and not a shell. The `credentials`
  table has no such column. Today every credential is equal.

Together these are the two controls that were buying back what channel binding used to give for
free (D7). Their absence is the largest gap between the design and the code, and it is in §11.

---

## 7. Threat table

Likelihood is over a year on a public IP. Impact is 1–5 where 5 = total compromise of the dev box
and everything it can reach.

| # | Threat | Likelihood | Impact | What this design does | Residual, accepted |
|---|---|---|---|---|---|
| 1 | **CSWSH on the terminal socket** — a page he visits opens `wss://…/ws/terminal` with his cookie attached | High if the default is wrong (three shipped projects owned by this exact line in 2026) | 5 | Exact-string `Origin` match; absent `Origin` = reject; single-use 60 s ticket that is **not ambient**; bearer refused unconditionally; terminal removable entirely by config | **Raised by D3**: siblings on `example.com` are same-site, so an XSS there plus a bug in the origin check is a shell. On a dedicated eTLD+1 that sibling would not exist |
| 2 | **XSS via agent-authored markdown/mermaid → session → shell** (the agent is trusted; its content is not) | Medium-High — mermaid has a live CVE record and agents ingest hostile text daily | 5 | goldmark raw-HTML-off → bluemonday server-side → `allow-scripts` **without** `allow-same-origin` iframe → `connect-src 'none'` inside it → renderer deps never run top-level | A browser bug in the sandbox itself. Also: content he *believes* because it looks like his agent said it — a social vector no sanitizer touches |
| 3 | **Prompt injection → a plausible question whose "obviously correct" answer is harmful** | High | 3–4 | Tasks are human-write-only (D13); a claimed task is a request, not an authorisation; `recommend` mandatory surfaces questions the agent should have answered itself; the context strip makes provenance visible | Real and unmitigated at the technical layer. This is a judgement problem |
| 4 | **First-run enrollment race** — a scanner registers before he does | High if bootstrap is naive | 5 | No open registration endpoint, ever. Permit minted only by a local shell, hashed, single-use, 15-minute TTL, consumed in the credential transaction (D9) | Effectively none |
| 5 | **Stolen session cookie** (compromised laptop, extension, cookie in a log) | Medium | 5 | Hashed server-side sessions, instant revocation, exact-origin checks, per-connection tickets | **High, because step-up and `can_terminal` are not built** (§6). A stolen cookie today reaches a shell. This is the residual cost of deleting channel binding (D7) and it is currently unpaid |
| 6 | **Bot token leak** (agent logs it, worktree committed, CI artefact) | High — tokens in agent environments leak constantly | 2 | Separate route tree so a token reaches no shell path *by construction*; four scopes, no terminal scope; hashed storage; optional expiry; `routes_test.go` proving a token is refused on every human route and cannot read another agent's item | A leaked token reads that agent's own items (which contain diffs) and can spam questions. Annoying, not fatal |
| 7 | **Malicious npm dependency in the SPA** | Medium | 5 → 2 | Renderer deps execute only inside the opaque-origin iframe with `connect-src 'none'`; the top-level bundle stays React + router + query | A malicious dep in the *top-level* bundle is still fatal. Keep that set small and boring |
| 8 | **Compromise of the herdrer process itself** | Low-Medium | 5 | Caddy absorbs TLS/HTTP parsing; the process is Go and small; `NoNewPrivileges` in the unit | Total. **D1 rejected the two-unit split**, so there is no containment boundary here at all when the terminal is on |
| 9 | **Stolen unlocked phone with a live session** | Low-Medium | 5 | Instant revoke from the CLI or another device; sessions listed in Settings | **5, not 3** — without `can_terminal` the phone is a shell. With it, this drops to "reads diffs and steers agents", which is still non-trivial |
| 10 | **Mis-issued certificate + network position (MITM)** | Low | 5 | TLS 1.3, HSTS preload via Caddy, CAA pinning the issuer, CT monitoring | Accepted. Was mitigated by herdr-web's E2E; is not now (D7) |
| 11 | **CSRF on a state-changing route** | Low-Medium (an easy miss) | 3–5 | Router-level `Origin` enforcement in `requireSameOrigin`, mounted **outside** the mux so it cannot be forgotten per-handler; missing `Origin` = reject; `SameSite=Strict` as layer two | A route registered outside the wrapped handler — which `routes_test.go` catches, since it exercises every endpoint through the assembled handler and asserts a same-site-sibling `Origin` is refused |
| 12 | **SSRF into the tailnet or Hetzner metadata (`169.254.169.254`, `100.64.0.0/10`)** | Low — nothing fetches URLs today | 4–5 | **Design intent: herdrer fetches no URL, ever.** `links[]` render as links and are never dereferenced. No previews, no unfurl, no remote images (`img-src` has no remote host) | Rises sharply the day someone adds a link preview. If one is ever added: exact-host allowlist, resolve-then-dial-the-IP, and a deny list that includes the tailnet |
| 13 | **`SUPPRESS_AUTH` reaching production** | Low, catastrophic | 5 | `config.validate()` refuses to start with it set alongside any non-loopback listener or non-loopback origin | The code path exists in the release binary (D18). A build tag would remove it |
| 14 | **Clickjacking over the terminal** | Low | 4 | `frame-ancestors 'none'` + `X-Frame-Options: DENY` | Also disable xterm.js OSC 52 clipboard and treat OSC 8 links as inert — PTY escape sequences are attacker-influenceable, since any command output is |
| 15 | **Auth scanning / enumeration / DoS against `/auth`** | High (constant background noise) | 1–2 | Discoverable credentials = no username field = nothing to enumerate; coarse uniform errors (`auth/errors.go`); per-IP token buckets; no lockout | Noise. Alert on bursts |
| 16 | **Audit tampering after a compromise** | Certain, conditional on compromise | 3 | Append-only `audit_log` | **No hash chaining, no off-box mirror.** An audit log on a box that got rooted is a log the attacker edited. Shipping to Axiom with a write-only ingest token is the fix, and is not built |
| 17 | **Push content leaking to Apple/Google/Mozilla** | Certain by design | 1 | Title only, truncated, no bodies or diffs or paths; per-item `sensitive`; contentless ntfy escalation available | Repo and branch names reach a third party. Accepted knowingly (D21) |
| 18 | **DoS** — huge markdown, hostile mermaid, connection floods, Slowloris | Medium | 1–2 | Body caps, explicit `http.Server` timeouts, iframe isolates a renderer hang, Caddy rate limits, per-IP buckets | He is offline until he restarts it. Acceptable |

---

## 8. Wire protocols

### 8.1 HTTP

House envelope throughout: `{"data": …}`, lists add `{"meta":{total,page,per_page}}`, errors are
`{"error":{"message","code"}}` with codes `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`,
`NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL_ERROR`. All timestamps RFC3339, all ids opaque
strings. The full route list is `docs/API.md`; `routes.go` is the authority when they disagree.

Two shapes worth calling out:

- **`GET /api/v1/bootstrap`** — one round trip on app open, returning user, version,
  `terminal_enabled`, counts and the VAPID public key. A deliberate, documented exception to REST
  purity: four parallel fetches to render one screen is the wrong trade on cellular. Everything
  else stays REST-shaped, and this is not a pattern to copy.
- **`GET /api/v1/review/{id}/render`** — returns `text/html`, already sanitized, to be dropped into
  the sandboxed iframe (D14). The client never renders agent markdown itself.

### 8.2 `/ws/terminal`

Binary frames, first byte is the lane:

| Byte | Direction | Payload |
|---|---|---|
| `0x00` | both | Raw PTY bytes. No base64 tax |
| `0x01` | both | JSON control: `{"type":"resize","cols":…,"rows":…}`, `{"type":"bell"}` |

Auth on upgrade: valid session **and** exact `Origin` **and** a valid unused ticket of purpose
`terminal`. Bearer refused unconditionally.

**The mirror outlives the websocket, and that half is built.** A phone locks its screen, iOS
suspends the tab, and the socket dies within ~30 s. If the PTY dies with it, every unlock costs a
new process, a full repaint, and the loss of scrollback — which is unusable. So `terminal/pty.go`
makes the session a server-owned object rather than something the websocket owns, and keeps a
**256 KB scrollback ring** so a reconnecting phone repaints immediately.

**The headless VT is not built, and that is a real gap.** Brief 01 argued for feeding every
mirror's bytes through a VT emulator at the mirror's geometry, because it earns its keep three
times over:

- **Resume.** With a ring you can replay bytes. But replaying a *prefix* of an alt-screen byte
  stream into a fresh xterm.js produces garbage — you can land mid-alt-screen, mid-CSI, with the
  wrong scroll region. A VT lets the server synthesise a correct full repaint from current state at
  any moment, which is the only resume that is always right.
- **Backpressure recovery.** The organising rule is that **the terminal lane is loss-tolerant by
  construction and the control lane never is**: terminal bytes may be coalesced or discarded
  *wholesale* precisely because a screen can be resynthesised. Without a VT, "I fell behind" has no
  cheap exact recovery — you either buffer forever or show a corrupt screen.
- **Bell detection.** OSC 9 interception (§9.4) needs something parsing OSC, and the VT is the
  thing that would already be doing it.

The ring covers the common case (reconnect within the window). The uncommon cases — a long sleep,
a repaint storm on bad LTE — are where it will show.

Measured budget from the protocol-19 probe, which is what makes "open it at a bus stop" real: cold
attach at phone geometry is 19.4 KB uncompressed (~2 KB deflated), a resume within the ring is a
few hundred bytes, and **idle costs 0 B/s** — Herdr does not repaint when nothing changes. The cost
is entirely at *attach*, which means the optimisation that matters is **not spawning mirrors**, not
throttling them: key them by `(user, session, geometry-class)` so two tabs on one phone share one,
and cap the total.

### 8.3 `/ws/stream`

JSON text frames: `{"type": "review.created" | "review.answered" | "agent.status" | "counts", …}`.

**Events carry ids and versions, never bodies.** The client invalidates its query cache on the id
and fetches the body over HTTP. That keeps the socket cheap and, more importantly, leaves exactly
one source of truth for an item's content.

Reconnect: exponential backoff 1s → 30s with jitter, reset on the first successful frame; on
`visibilitychange → visible`, reconnect **immediately**, ignoring the backoff. Resume from a
bounded in-memory ring; past it the server answers `{"resync": true}` and the client refetches
wholesale — a replay path exercised once a month is a replay path that is broken. Server ping every
25 s, client declares death after 60 s of silence.

**The six-hours-asleep case, designed for explicitly:** on resume the client refetches
`/api/v1/bootstrap` **before** reconnecting the socket, so the screen is correct within one round
trip and never shows an answered item as open; then reconnects; then re-checks the push
subscription endpoint. Anything that changed while away gets a "changed while you were away"
marker rather than silently reordering under a thumb already moving toward a button.

---

## 9. Herdr integration

### 9.1 What was actually measured

herdr-web's design was written against a schema dump. herdrer's was written against a live probe
of **herdr 0.8.0, protocol 19**. The findings overturn several of herdr-web's assumptions, so they
are recorded here rather than left in a brief:

| # | Finding |
|---|---|
| E1 | `herdr server` runs **headless with no tty** |
| E2 | A headless server has **zero workspaces** until something creates them |
| E3 | The API socket is **one request per connection**; a second request on the same conn gets `EPIPE`. Only `events.subscribe` holds it open |
| E4 | `pane.read` (connect + request + response, 200 lines) is **0.1 ms p50, 0.2 ms max** |
| E5 | **`pane_output_changed` is not subscribable.** It is in the broadcast and match enums but absent from the 27-entry `Subscription` union |
| E6 | **`events.wait` implements only agent-status matches**, despite the schema advertising 19 matchable events |
| E7 | **`revision` is always 0** on `PaneInfo` and `PaneReadResult`, before and after output |
| E8 | **`pane.output_matched` is one-shot** — it is a long-poll primitive with a snapshot attached, not a stream |
| E9 | **`pane.agent_status_changed` requires `pane_id`.** There is no global agent-status feed |
| E10 | Structural subscriptions re-fire indefinitely and **replay current state on subscribe** |
| E11 | **Independent per-client geometry confirmed.** Two PTYs at 120×40 and 60×20 coexist; no smallest-wins reflow |
| E12 | Initial paint 96.7 KB at 120×40, 19.4 KB at 40×20. **Steady-state idle: 0 B/s** |
| E13 | **Herdr never emits BEL.** Zero `0x07` bytes in ~100 KB of captured output |
| E14 | With `[ui.toast] delivery = "terminal"`, Herdr emits **OSC 9** into the attached client's tty (the iTerm2 form, not OSC 777) |
| E15 | `ping` reports `capabilities: {live_handoff: true, detached_server_daemon: false}` on macOS. Sockets are `srw-------`, no group bit |
| E16 | `herdr session list --json` returns `{name, default, running, session_dir, socket_path}` — a real discovery interface |

### 9.2 The consequence: the reconciler survives, its trigger does not

herdr-web's snapshot reconciler is right and should ship as designed — debounce, call
`pane.read --source recent_unwrapped`, reconcile against the previous snapshot by longest common
prefix, **append** the tail when the old snapshot is mostly a prefix (a scrolling shell) and
**replace** otherwise (an alt-screen TUI repainting), accumulating appends in a per-pane ring.

**Its trigger is fiction on protocol 19.** `pane_output_changed` cannot be subscribed (E5),
`events.wait` refuses it (E6), `revision` is permanently 0 so there is nothing for a `min_revision`
to compare against (E7), and `pane.output_matched` fires exactly once and never re-arms (E8).

So the trigger is **a plain timer**, and E4 is what makes that comfortable rather than
embarrassing: `pane.read` is 0.1 ms, where herdr-web assumed ~5 ms. Forty panes at the worst rate
is under 5 ms of CPU per second. Polling is also *better* suited to a server than to the laptop
herdr-web assumed — what polling costs you on a laptop is battery, and a Hetzner box does not have
one.

| Pane | Poll rate |
|---|---|
| The agent view currently open in a browser | 5 Hz |
| Panes with a `working` agent, not open | 1 Hz |
| Everything else | on status change only |
| **No browser connected** | **stop entirely** |

Ship it behind a `PaneSource` interface with two implementations — `poll` (works today) and
`event` (wired to `pane_output_changed` the day Herdr implements it). Then the upgrade is a config
flag, not a rewrite.

### 9.3 Other consequences worth encoding

- **Discovery is a filesystem scan plus `ping`, not a shell-out.** Honour `HERDR_CONFIG_PATH` /
  `HERDR_CONFIG_DIR` (or `HERDRER_HERDR_CONFIG_DIR`), look at `<cfg>/herdr.sock` and
  `<cfg>/sessions/*/herdr.sock`, and treat **the pong as liveness, never the inode** — Herdr leaves
  stale socket files behind. `herdr session list --json` (E16) is the right thing to shell out to
  *once at startup* as a sanity assertion, and never in steady state.
- **herdrer creates, not only attaches.** E2 forces it: a freshly restarted headless server has no
  workspaces, so a viewer-only herdrer leaves the box unbootstrappable from a phone — which fails
  the product's one-sentence thesis. systemd manages the *process*; herdrer manages *what is inside
  it* (`workspace.create`, `worktree.open`, `pane.split`, `agent.start`, `pane.close`).
- **Pane ids are session-scoped and are not stable across `pane.move`.** Two sessions each have a
  `w1:p1`. So every id crossing the wire is namespaced `<session>/w1:p1`, and the durable handle in
  a URL is the **agent name**, not the pane id. That is what makes a push notification's deep link
  survive a `pane.move` at 2 a.m., and it is why herdrer should `agent.rename` anything it adopts
  that has no name.
- **Never focus as a side effect of rendering.** `agent.focus` / `pane.focus` mark a tab as seen,
  which flips `done` → `idle`; CLI reads do not. Opening an agent page must not call `agent.focus`,
  or glancing at the phone silently mutates state on the box. Focus is an explicit button.
- **`agent.explain` is untyped.** The schema declares the result field as literally `"explain":
  true` — any JSON. So the approve/deny row cannot be *derived*; it is a fixed button set with
  `explain`'s prose above it and the last screen below. Stated plainly: **on a phone you are
  looking at a picture of a TUI prompt and choosing a number.** That is the weakest surface in the
  product, and it is the strongest argument for the review path (D19).
- **There is no transcript history.** Alt-screen rows never enter host scrollback; `pane.read`
  returns a screen, not a log. herdrer's ring is the only record, it begins when herdrer starts
  watching, and a herdrer restart erases it unless it is persisted to SQLite.
- **`state_labels`** (a `map[string]string` on `PaneInfo`/`AgentInfo`) is the under-used
  affordance. It carries the agent's own state text. Render it verbatim; it is free and it is the
  closest thing to structured status the API offers.
- **No token counts, no cost, no exit codes, no agent stdout.** Do not promise a dashboard.

### 9.4 Bells

**Herdr never emits BEL** (E13), and nothing in the socket API delivers one, so "terminal bell →
push" as herdr-web imagined it has no source. What exists instead is better: with
`[ui.toast] delivery = "terminal"`, Herdr emits **OSC 9** into the attached client's tty (E14), and
the config's own comment for that setting is *"ask the outer terminal to show a desktop
notification"*. **herdrer is the outer terminal.** That is the intended seam, not a hack.

So: every mirror's bytes pass through the headless VT, which must parse OSC anyway; intercept
OSC 9 there, **consume it, do not forward it** (xterm.js would ignore it), and turn it into an
internal bell event. Build the second, structured source in parallel — derive bells from the
per-pane `pane.agent_status_changed` subscriptions (E9 means one subscription per pane; there is no
global feed). Use the status transition as the **event** (it names the agent, workspace and repo)
and OSC 9 as the **corroborating text**; if only one arrives, use it alone.

| Transition | Buzz? |
|---|---|
| `working → blocked` | always, overrides quiet hours |
| `working → done` | yes, respects quiet hours |
| `working → unknown` after a long run | yes — a possible crash |
| anything → `working` | never |

Debounce per agent at 60 s so a flapping `blocked → working → blocked` buzzes once, and set the
push `tag` to the agent name so the OS replaces rather than stacks.

*Not built.* `internal/notify` can send a push; nothing yet decides when one is warranted. OSC 9
interception in particular is blocked on the headless VT (§8.2), since there is currently nothing
in the byte path parsing OSC.

---

## 10. Deployment and operations

### 10.1 The target

`https://herdrer.example.com` → `203.0.113.10`, Hetzner, Ubuntu 26.04. Caddy owns `:80`/`:443`
and reverse-proxies to `127.0.0.1:7799`. herdrer runs as your dev user under
`~/.config/systemd/user/herdrer.service` with `loginctl enable-linger <user>` — **never root, never a
service account** (D1). With Caddy terminating, the production config is `HERDRER_TLS_MODE=off`
with `HERDRER_ADDR=127.0.0.1:7799` and `HERDRER_ORIGIN=https://herdrer.example.com`.

Note the resulting config shape: `Secure()` keys off the **origin** scheme, not the listener, so
`__Host-` cookies and HSTS are correctly enabled even though the Go listener speaks plain HTTP on
loopback. That is intentional and is why `HERDRER_ORIGIN` must be set explicitly in production
rather than left to `defaultOrigin()`, which would derive `http://…` from `TLS_MODE=off`.

Two scripts, and the split between them is deliberate. **`provision.sh` runs once, on the box, as
root**: it creates the user with the operator's SSH key, enables linger, installs Caddy from its
apt repo, installs the Caddyfile and reloads (which triggers the HTTP-01 challenge), sets ufw to
deny-incoming / allow 22, 80, 443, installs and enables the user unit, and installs mise. It is
idempotent and prints `skip` for anything already done, and it deliberately does **not** install or
start herdrer — there is no binary yet, and starting a service that will mint an enrollment token is
a decision. **`deploy.sh` runs from the Mac** on every update: it checks the artifact is really an
ELF binary, scp's it to a staging path, **re-checks the sha256 on the far side**, copies the current
binary to `herdrer.prev`, renames the new one into place atomically (so the running process keeps
its own inode and there is never a window holding a half-written file), runs `reset-failed`,
restarts, and polls `/api/v1/health` for 30 seconds — restoring `herdrer.prev` and dumping the
journal if health never comes up. Its variables are namespaced `HERDRER_DEPLOY_*` precisely so that
`mise.toml`'s `[env]` block, which exports `HERDRER_DOMAIN` and `HERDRER_ADDR` for *local
development*, cannot make a deploy quietly aim at localhost.

**One operator detail that looks like a bug and is not:** `provision.sh` adds `dev` to the `sudo`
group but sets no password and configures no `NOPASSWD` rule, so `sudo` prompts and fails. That is
the point — a registered passkey is already a shell as that user (§1), and passwordless sudo would make
it a *root* shell. Setting a password from a root session is a deliberate act, and it pairs with
`NoNewPrivileges=yes` in the unit (§10.2), which makes `sudo` inert for the service and its children
regardless.

### 10.2 systemd hardening — deliberately short

The unit keeps `NoNewPrivileges=yes`, `ProtectClock`, `ProtectKernelLogs`, `ProtectKernelTunables`,
`ProtectControlGroups`, `RestrictSUIDSGID`, `RestrictRealtime`, `LockPersonality`. It does **not**
use `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `RestrictNamespaces`,
`MemoryDenyWriteExecute` or `SystemCallFilter`, and the reasons are concrete rather than
philosophical:

| Directive | Why not |
|---|---|
| `ProtectHome` | The entire job is in `$HOME` — the Herdr socket, the state dir, `~/Developer` |
| `ProtectSystem=strict` | Every `go build`, `npm install` and `git commit` in a spawned PTY writes outside `$HOME` |
| `PrivateTmp` | Every tool the PTY launches gets a *different* `/tmp` than the SSH session — editor sockets, LSP servers, anything using `$TMPDIR` for IPC. You will debug this for a day |
| `PrivateDevices` | Historically breaks `openpty()`; modern systemd usually handles it, and "usually" is the wrong confidence level for the feature that is the product |
| `MemoryDenyWriteExecute`, `SystemCallFilter` | **Inherited by children.** Breaks JITs and toolchains at 2am with an opaque SIGSYS |
| `RestrictNamespaces` | Breaks rootless Docker/Podman and anything `unshare`-based launched from a pane |

> The hardening list is short on purpose. herdrer's job is to run your commands as you, so no
> mount-namespace directive can be a security boundary — the ones that would be meaningful break
> the product, and the ones that do not break it are not protecting anything an attacker with a
> valid passkey cares about. What protects this service is the passkey, the enrollment permit, and
> the fact that no registration endpoint is open. **Expect a bad `systemd-analyze security` score
> and do not chase it.**

One directive worth keeping despite the friction: `NoNewPrivileges=yes` means a compromised
terminal session cannot `sudo`, even with the password. It also means no `sudo apt install` from
the phone terminal. Take it anyway; if root is needed, SSH in.

### 10.3 Restart semantics

Graceful shutdown, in order, and each step is deliberate:

1. Stop accepting new connections; fail readiness.
2. **Return `{"status":"open"}` to every in-flight agent long-poll** rather than dropping the
   connection. That is the documented timeout response, so agents re-issue instead of erroring.
   One line, and it turns a restart from an incident into a no-op for every waiting agent.
3. Close every live WebSocket with a reason and a suggested reconnect delay.
4. Kill the mirror PTYs. **This loses nothing** — those PTYs are *clients* of the Herdr session,
   not the session. Herdr keeps running, the agents keep working, the browser respawns a mirror on
   reconnect. This is the fact that makes restarting herdrer casual, and it is worth knowing.
5. `PRAGMA wal_checkpoint(TRUNCATE)`, close, exit 0.

### 10.4 `install.sh` is for other machines, not this one

`scripts/install.sh` is the public `curl … | sh` installer and **is not used by this deployment at
all** — the box is provisioned by `provision.sh` and updated by `deploy.sh`. It is shaped by four
rules worth keeping if it is ever edited: every top-level statement is a function definition or the
final `main "$@"`, so a truncated download does nothing rather than half an install; `set -eu` and
not `pipefail`, because the shebang is `/bin/sh`; it never pipes another script into a shell (if it
wants cosign it prints the command); and it never edits a shell rc file or starts a service, because
starting something that will mint an enrollment token is a decision, not a side effect. Verification
degrades in three tiers — cosign bundle, else `gh attestation verify`, else a sha256 against
`checksums.txt` with a loud warning — with `HERDRER_REQUIRE_SIGNATURE=1` to make the last one fatal.
**A checksum mismatch is fatal always, with no override.** See limitation 14 for why none of this
has ever executed.

### 10.5 State, backup and migrations

Everything precious is under `HERDRER_STATE_DIR` (0700):

| Path | Class | Consequence of loss |
|---|---|---|
| `herdrer.db` | **Precious** | Every passkey and agent token gone; full re-enrollment, and the review history — the accumulated value — is gone |
| `vapid.json` | **Precious, and quietly so** | Every push subscription silently stops working, with no error anywhere. That is the worst failure mode this app has |
| `acme/` | Rebuildable | Re-issued on next start; watch Let's Encrypt rate limits |

**The passkey private keys are not in the backup and should not be.** They live in the phone's
secure enclave / iCloud Keychain and never touch the server, so restoring the DB restores the
server's *ability to accept* credentials that already survived the loss. That makes the backup
story much less frightening than it sounds.

Migrations run on startup before the listener binds. Before applying any pending migration, take
`VACUUM INTO '<state>/backups/pre-<n>-<ts>.db'` — online, consistent, three lines. **That snapshot
is the rollback story.** Down-migrations for a single-user app are code you write, never test, and
get wrong precisely when you need them. And the binary must **refuse to start when the DB schema is
newer than it understands**, naming the snapshot to restore — that is the failure that actually
bites, because you roll the binary back and forget the DB moved forward.

---

## 11. Known limitations

Ordered roughly by how much they should bother you.

1. **It runs, but it has never run in production.** The binary builds, `mise run check` passes on
   the Go side, and the flows in §0 are smoke-verified locally. Nothing here has faced a real
   browser on a real phone against the real box, and the list below is what is known to be absent
   rather than what a week of use would find.
2. **`herdrer.example.com` shares a registrable domain with `meatprompt.`, `keep.` and
   ``.** Those siblings are **same-site**, which is the precondition
   for the CSWSH class of bug that owned three shipped projects in 2026. The compensations are real
   and listed in D3 — `__Host-`, `SameSite=Strict`, exact-origin checks on every state-changing
   request *and* on the upgrade, single-use 60-second non-ambient tickets — but they are
   compensations, not equivalence. A dedicated eTLD+1 would have made "same site" and "same origin"
   the same set and removed the class. **This is an accepted risk, chosen deliberately with the
   argument understood.**
3. **No step-up re-authentication, and no `can_terminal` credential class.** A live session cookie
   plus a same-origin ticket mint opens a shell. There is no fresh-assertion requirement before
   dangerous actions and no way to make the phone passkey review-only. These are the two controls
   that were buying back what channel binding gave for free (D7), and they are the largest gap
   between this document and the code.
4. **The Go tests are strong; the web side has none.** D11's table test covers the server
   thoroughly (38 routes, both directions of tree disjointness, IDOR, same-site-sibling CSRF), and
   the renderer's CSP is asserted in Go. But nothing asserts the *client* half of D14 — that
   `DocumentFrame.tsx` never grows `allow-same-origin` beside its `allow-scripts`, which is the one
   edit that silently converts the sandbox into no sandbox at all. That belongs in a Vitest
   assertion or a grep in CI, and CI does not exist (limitation 13).
5. **`SUPPRESS_AUTH` ships in the release binary** (D18). `config.validate()` refuses to start it
   alongside a non-loopback listener or origin, which is a real refusal — but a `//go:build dev`
   tag would mean the bypass does not exist at all, and on this app the flag leaks his laptop
   rather than his data.
6. **The shipped CSP is looser than designed.** `middleware.go` sets `default-src 'self'` with
   `style-src 'unsafe-inline'`; brief 02 §6.3 argued for `default-src 'none'`, an explicit
   allowlist, `require-trusted-types-for 'script'` and `trusted-types default`. Trusted Types in
   particular is the one people skip and shouldn't: it makes DOM XSS sinks throw at runtime, which
   is a structural guarantee that no future `dangerouslySetInnerHTML` slips into the top-level
   origin. It is Chromium-only, so it does nothing on his iPhone — but the place it protects is his
   laptop, where a bug would first be found, and it turns a silent bug into a loud one in dev.
7. **The audit log is append-only but not tamper-evident and not mirrored.** No `prev_hash`
   chaining, no shipping to Axiom. An audit log on a box that got rooted is a log the attacker
   edited; the only audit that counts is off-box, with a write-only ingest token.
8. **No detection notifications.** Brief 02 §8.5's highest-value control is "every terminal open
   buzzes his phone" — he opens one maybe twice a week, so the false-positive rate is near zero and
   the signal near perfect. Same for `credential.added`, `enroll.minted`, `token.first_use` from a
   new IP. None of it is wired.
9. **The WS ticket rides in the query string** (D15), so it lands in Caddy's access log and any
   future error report. `Sec-WebSocket-Protocol` is the right carrier and moving it is a contract
   change to `docs/API.md`.
10. **`SessionTTL` defaults to 30 days.** That is the house default for a notes app, and this is a
    shell. Without step-up (limitation 3) it is the *only* thing bounding a stolen cookie.
11. **The review schema is meatprompt's, not brief 03's.** One decision per item, no ordered
    sections, no inline comments, tasks sharing the item table via `direction`. §4 records why and
    what the trigger for `0002_sections.sql` is.
12. **No orphan detection.** herdrer holds a live Herdr socket, so it *could* know exactly when the
    agent that asked a question has died — a `pane.close` event orphans every open item bound to
    that pane within one event rather than one heartbeat interval, and `syscall.Kill(pid, 0)` plus a
    recorded process start time turns a heuristic into a fact. That is the single strongest argument
    for putting the two halves in one binary, and it is unbuilt. Today expiry is the only backstop —
    which is exactly the limitation meatprompt listed as its top open item.
13. **No CI.** `.github/workflows/` is empty. `mise run check` passes locally, but nothing
    *enforces* it, and the gates that
    should block a tag — `go test -race`, `govulncheck` as a **blocking** gate (this binary
    terminates on the public internet and hands out shells), migration tests that run forward from a
    real prior state rather than from empty, and an assertion that `web/dist/index.html` exists and
    is over a floor size (`//go:embed all:` errors on a *missing* directory but happily embeds an
    *empty* one, and a binary that serves a blank page is the kind of release you only notice from a
    train) — do not exist.
14. **`install.sh` describes a release pipeline that does not exist.** The installer is written and
    is careful — three verification tiers, a checksum mismatch that is fatal with no override — but
    it resolves releases from a GitHub repo that publishes none, so **no tier has ever run**. There
    is no cosign bundle and no artifact attestation to verify, because there is no release
    workflow (limitation 13). Also missing: `herdrer doctor`, `herdrer backup`, `herdrer db
    restore` (which `scripts/README.md` tells you to run after a failed rollback), self-update, and
    `POST /api/v1/admin/update` — which `deploy/herdrer.service` cites as the reason for
    `Restart=always` and which is not in `routes.go`.
15. **No headless VT in the terminal lane** (§8.2). Resume is a byte-ring replay, so a client that
    falls outside the ring, or a repaint storm that overflows the send queue, has no exact recovery.
    It also blocks OSC 9 bell interception (§9.4) outright.
16. **The unit is `Type=exec`, not `Type=notify`.** `systemctl start` therefore returns before
    migrations have run and the listener is bound, so `start && curl /health` races — and you learn
    about a failed migration from a phone at the café rather than from the terminal you are sitting
    at. The unit file says so and names the three lines to change once the binary calls `sd_notify`.
17. **Mermaid diagrams render as source.** `render.go` emits `<pre class="mermaid">` with the
    source escaped, and no diagram library is loaded into the sandboxed document — so a `diagram`
    attachment currently reads as its own text. The isolation design that would make loading one
    safe (D14: a separate bundle that only ever executes inside the opaque-origin iframe) is in
    place and unused. Syntax highlighting is likewise absent; diffs are parsed and tinted by
    `lib/diff.ts` but not grammar-highlighted.
18. **Platform ceilings that no amount of work removes.** iOS Web Push requires an *installed* PWA,
    and there is no programmatic install — the Add-to-Home-Screen gesture must be taught and nagged.
    WebKit does not render notification action buttons, so approve-from-lock-screen exists only via
    ntfy's native app or a Shortcut. Push subscriptions rot silently with no health signal short of
    sending one. `notificationclick` deep-linking on iOS is unreliable and needs a belt-and-braces
    "last notification target" written to IndexedDB. WebKit has no VirtualKeyboard API, so
    keyboard-aware layout is a `visualViewport` hack that will be visibly imprecise during the
    keyboard animation. And 40 columns clips some agent TUIs no matter what.
19. **Single user is assumed, loudly.** If herdrer ever grows a second human, the task/injection
    boundary (D13) is the first thing to revisit — before multi-tenancy, before anything.
