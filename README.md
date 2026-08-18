# herdrer

One inbox for everything your coding agents are waiting on you for — answerable from a phone.

---

## What it is

A single Go binary that sits on the dev box next to [Herdr](https://github.com/jclement/herdr)
and answers one question well: **what needs me right now?**

Two things can be waiting on you, and in your pocket they feel identical:

- a **review document** an agent posted — markdown, a diagram, a real diff, and a decision with a
  recommendation attached; and
- a **Herdr agent that went `blocked`** at its own TUI prompt.

herdrer merges them into one list, sorted oldest-waiting first, behind a passkey. Tap a review and
answer it in two taps. Tap a blocked agent and you get its screen, `agent.explain`'s prose, and an
approve/deny row. If neither is enough, a real terminal mirror is one tap further down.

The reason it exists is that a stopped agent burns wall-clock, and the human is usually not at the
desk. SSH from a phone is a bad answer to that. Four taps is a better one.

herdrer is a **new experiment**. It borrows heavily from `~/Developer/herdr-web` (the Herdr socket
bridge, the PTY model, the wire framing) and from `~/Developer/meatprompt` (the review object
model, push, the agent skill), but it **depends on neither and replaces neither**. Both still
exist; this is a third thing trying the merged shape on one box.

## Status

**Early, but it runs.** It has never run in production.

The binary builds and the Go test suite passes. `herdrer serve` comes up, `herdrer enroll` prints a
single-use registration code, the SPA is embedded and served, `/api/v1/health` and
`/api/v1/auth/state` answer unauthenticated, `/api/v1/bootstrap` 401s, the agent tree and
`/ws/terminal` refuse credential-less callers, and `/onboard/skill.md` serves the vended agent
skill. A static `linux/amd64` binary cross-compiles clean at 14 MB with CGO off, and the provision
and deploy scripts for the Hetzner box are written.

The test suite is the part worth pointing at: `internal/api/routes_test.go` tables **all 38
endpoints** and proves that every non-ceremony route refuses anonymous callers, that an agent token
is refused on every human route, that a session cookie is refused on every agent route, that
cross-origin writes are rejected — including from a same-site sibling, the wrong scheme, and an
absent `Origin` — and that one agent cannot read another agent's item.

Still unbuilt, and worth knowing before you rely on any of it:

- **Mermaid renders as source.** The sandboxed document escapes the diagram source into a `<pre>`;
  no diagram library is loaded yet. Syntax highlighting is absent too.
- **No CI.** `mise run check` passes locally, but nothing enforces it, and there is no release
  pipeline — so `scripts/install.sh`'s signature verification has never actually run against a
  published release.
- **No step-up re-authentication.** A live session plus a same-origin ticket mint opens a terminal;
  there is no fresh-assertion requirement before dangerous actions.
- **No per-credential terminal permission.** Every passkey is equal, so the phone passkey can open a
  shell. There is no `can_terminal` flag to make it review-only.
- No bells or OSC 9 interception, no orphan detection, and no `herdrer doctor` / `backup` / update.

`DESIGN.md` §0 has the file-by-file snapshot and §11 the full list of honest gaps.

## Quick start

```sh
git clone https://github.com/jclement/herdrer && cd herdrer
mise run setup          # go mod download, bun install, create ./state
mise run dev            # Go server + Vite, both stopped by one Ctrl-C
```

Dev runs on plain HTTP at `http://localhost:7799`, which is fine: WebAuthn treats
`http://localhost` as a secure context, so passkeys work with no certificate. `mise.toml` pins the
dev environment (`HERDRER_ADDR`, `HERDRER_TLS_MODE=off`, `HERDRER_DOMAIN=localhost`,
`HERDRER_ORIGIN`, `HERDRER_STATE_DIR`), so a fresh checkout needs no `.env` at all.

The browser must only ever talk to **one** origin in dev. Vite proxies `/api` and `/ws` to the Go
server; if you point the browser at the Go port directly while the SPA is served from Vite,
WebAuthn fails with an opaque error because the RP ID no longer matches the page's origin.

**There is no open registration.** To get in, mint a one-time enrollment permit on the machine
itself:

```sh
go run ./cmd/herdrer enroll --label "iPhone"
```

It prints a code with a short TTL. Registering a passkey consumes it atomically. A scanner that
finds the box before you do cannot enroll, because creating the permit requires a shell on the
box — which is the thing being protected in the first place.

The whole CLI surface:

| Command | Does |
|---|---|
| `herdrer serve` | Run the server. The default when no verb is given |
| `herdrer enroll [--label <name>] [--ttl <dur>]` | Mint a one-time passkey registration code. Defaults to `HERDRER_ENROLL_TTL_MINUTES` |
| `herdrer token create --name <name> [--scopes review:write,review:read] [--user <id>]` | Mint an agent token. The `sk_` secret is printed once and never stored |
| `herdrer version` | Version, commit, build date |

Everything is configured from the environment; there is no config file.

## Configuration

Every key. Set them in the systemd unit in production, or a gitignored `.env` locally; the
committed `.env.sample` mirrors this table.

### Identity and origin

| Variable | Default | What it does |
|---|---|---|
| `HERDRER_DOMAIN` | `localhost` | The hostname browsers use. **WebAuthn binds every passkey to this; changing it invalidates all of them.** |
| `HERDRER_ORIGIN` | derived — `https://<domain>`, or `http://<domain>[:port]` when TLS is off | The full origin. Must match `HERDRER_DOMAIN`, or the process refuses to start. The WebAuthn RP ID is this URL's hostname, and cookie `Secure` keys off this scheme — so behind a TLS-terminating proxy you **must** set it explicitly to the `https://` name. |

### Listeners and TLS

| Variable | Default | What it does |
|---|---|---|
| `HERDRER_ADDR` | `:443` | The main listener. Behind Caddy this is `127.0.0.1:7799`. |
| `HERDRER_TLS_MODE` | `autocert` | `file` serves TLS from `HERDRER_TLS_CERT`/`KEY` — the escape hatch for a deployment with no proxy. `off` is plain HTTP, legitimate on loopback or behind a terminating proxy. **`autocert` is accepted but not wired**: binding `:443` would need `CAP_NET_BIND_SERVICE` on the process that forks shells, so it currently behaves as `off`. |
| `HERDRER_TLS_CERT` | — | PEM certificate. Required when mode is `file`. |
| `HERDRER_TLS_KEY` | — | PEM key. Required when mode is `file`. |
| `HERDRER_ACME_EMAIL` | — | Contact address for the ACME account. |

### State

| Variable | Default | What it does |
|---|---|---|
| `HERDRER_STATE_DIR` | `$XDG_STATE_HOME/herdrer`, else `~/.local/state/herdrer` | Created `0700`. Holds `herdrer.db` (chmod `0600`), the `acme/` cache and `vapid.json`. **Back this up.** |

### Auth

| Variable | Default | What it does |
|---|---|---|
| `HERDRER_SESSION_TTL_DAYS` | `30` | Session lifetime, refreshed on activity. See `DESIGN.md` §11 — 30 days is a notes-app default and this is a shell. |
| `HERDRER_ENROLL_TTL_MINUTES` | `15` | How long a minted enrollment permit stays usable. |
| `SUPPRESS_AUTH` | `false` | Dev only. Skips WebAuthn entirely. **The process refuses to start with this set alongside any non-loopback listener or origin.** |

### Herdr bridge

| Variable | Default | What it does |
|---|---|---|
| `HERDRER_HERDR_CONFIG_DIR` | — (autodetect) | Directory holding `herdr.sock` and `sessions/<name>/herdr.sock`. Empty means look under the run-as user's XDG config. |
| `HERDRER_TERMINAL_ENABLED` | `true` | Set `false` for a review-only deployment: no PTY, no Herdr control verbs, **no shell reachable from any HTTP path**. |

### Notifications

| Variable | Default | What it does |
|---|---|---|
| `HERDRER_VAPID_PUBLIC_KEY` | generated into `vapid.json` on first run | Overrides the generated keypair. |
| `HERDRER_VAPID_PRIVATE_KEY` | generated into `vapid.json` on first run | Ditto. **Losing this silently kills every push subscription, with no error anywhere.** |
| `HERDRER_VAPID_SUBJECT` | — | Must be a valid `mailto:` or `https:` URL. Apple rejects `@localhost`, and the server clock must be right or the JWT `exp` fails — NTP is a real dependency. |
| `HERDRER_NTFY_URL` | — | Optional contentless escalation channel (an ntfy topic URL). Off unless set. |

### Limits

| Variable | Default | What it does |
|---|---|---|
| `HERDRER_LONGPOLL_MAX_SECONDS` | `300` | Ceiling on `?wait=`. Requests above it are **clamped, not refused**. A whitespace heartbeat every 20s keeps intermediaries from timing the connection out. |
| `HERDRER_MAX_OPEN_ITEMS` | `50` | Per-agent backpressure. An agent that is always asking is an agent that isn't thinking. |
| `HERDRER_DEFAULT_EXPIRY_HOURS` | `24` | How long an item waits before giving up. **An expired item is never consent.** |
| `HERDRER_MAX_EXPIRY_HOURS` | `168` | Ceiling an agent may request. Must be ≥ the default, or the process refuses to start. |

## Tasks

```
mise tasks
```

| Task | Does |
|---|---|
| `setup` | Zero → runnable: `go mod download`, `bun install`, create `./state` |
| `dev` | Go server + Vite dev server together; one Ctrl-C stops both |
| `dev:server` | Only the Go server, SPA served from the embedded build |
| `test` | `go test ./...` plus the web suite, non-interactive |
| `lint` | `gofmt -l`, `go vet`, web typecheck. Never mutates files |
| `fmt` | The mutating counterpart of `lint` |
| `check` | `lint` + `test` — the gate before calling work done |
| `build` | `./bin/herdrer` for this machine, SPA embedded |
| `build:linux` | Static `linux/amd64` into `./dist` |
| `deploy` | `build:linux`, then `scripts/deploy.sh` |
| `web:install` / `web:build` | SPA dependencies / build into `internal/webui/dist` |
| `db:new <name>` | Scaffold the next numbered migration |
| `clean` | Build artifacts |
| `dev:reset` | Also `node_modules`, and — after a prompt — the local database and passkeys |
| `release` | Interactive: pick patch/minor/major, tag, push. CI builds from the tag |

## Install and deployment

The target is a Hetzner box, Ubuntu 26.04, at `https://herdrer.example.com`.

**Caddy terminates TLS** on `:80`/`:443` and reverse-proxies to herdrer on loopback
`127.0.0.1:7799`. herdrer runs as an ordinary user under a **systemd user unit with linger** —
never root and never a service account. That is not a preference: Herdr's socket is mode `0600`
with no group bit, so a different UID simply cannot open it, and every PTY herdrer spawns has to
be *your* shell with your dotfiles, mise shims, `ssh-agent` and checkouts.

**Once, on the box, as root** — creates the user, enables linger, installs Caddy and the
`Caddyfile`, configures ufw (deny incoming; allow 22, 80, 443), installs the user unit, installs
mise. Idempotent, and it deliberately does not install or start herdrer:

```sh
sudo ./scripts/provision.sh --domain herdrer.example.com --user dev
```

**Every deploy, from the Mac** — cross-compiles, scp's, verifies the sha256 on the far side, keeps
the old binary as `herdrer.prev`, renames atomically, restarts the unit and polls health, rolling
back if health never comes up:

```sh
mise run deploy
```

Configuration lives in `deploy/herdrer.service` — `HERDRER_ADDR=127.0.0.1:7799`,
`HERDRER_TLS_MODE=off`, `HERDRER_DOMAIN=herdrer.example.com`,
`HERDRER_ORIGIN=https://herdrer.example.com` — with secrets in an optional
`~/.config/herdrer/herdrer.env`. Note that `HERDRER_ORIGIN` is the `https://` name even though the
Go listener speaks plain HTTP on loopback: cookie `Secure`, HSTS and the WebAuthn RP ID are all
derived from the origin, not the listener.

Two things in those files are load-bearing and look like mistakes if you don't know why:

- **The Caddyfile sets write and read-body timeouts to 0.** Any finite value cuts a 300-second
  agent long-poll or a terminal WebSocket mid-flight, and the symptom — a terminal that dies after
  exactly N seconds, or an agent that sees a hang-up instead of `{"status":"open"}` — is the single
  most likely way this deployment breaks. Do not tidy them into real numbers.
- **The unit sets `Restart=always`, not `on-failure`.** The admin update path replaces the binary
  and exits *zero*, expecting the supervisor to bring the new one up; under `on-failure` that clean
  exit is a clean stop and the box goes dark from a phone. Crash-loop protection comes from
  `StartLimitBurst`, not from the restart mode.

The unit keeps `NoNewPrivileges=yes` and a short list of cheap protections, and deliberately does
**not** set `ProtectHome`, `ProtectSystem=strict`, `PrivateTmp`, `PrivateDevices`,
`RestrictNamespaces`, `MemoryDenyWriteExecute` or `SystemCallFilter` — each breaks something the
product needs, every one of them is inherited by the shells herdrer spawns, and none is a boundary
against an attacker holding a valid passkey. Expect a bad `systemd-analyze security` score and
don't chase it. The unit file and `DESIGN.md` §10.2 carry the per-directive reasoning.

`scripts/README.md` is the runbook — fresh box, deploys, rollback, and what to do when you lock
yourself out. Three details from it worth having here:

- **The service user is in the `sudo` group but has no password**, deliberately. A registered passkey is
  already a shell as that user; passwordless sudo would make it a *root* shell. Set a password from a
  root session if you want sudo to work.
- **Rollback is one command** (`cp ~/.local/bin/herdrer.prev ...`), and `deploy.sh` does it
  automatically when a fresh deploy fails its health check. What rollback does *not* cover is the
  database: if the version you are rolling back from applied a migration, the older binary refuses
  to start rather than half-work.
- **`scripts/install.sh` is for putting herdrer on some *other* machine** and is not used by this
  deployment. It verifies via cosign, else `gh attestation verify`, else a sha256 with a loud
  warning; a checksum mismatch is fatal with no override. Since there is no release pipeline yet,
  none of that has ever run for real.

There is no self-update, no `herdrer doctor`, no `herdrer backup`, and no CI.

## Security, in short

**A registered passkey on herdrer is a shell on the dev box.** That sentence governs everything
else. herdrer is, by construction, a full-privilege unauthenticated client of the Herdr socket,
and both the terminal and the control board are shell-equivalent — there is no "safe lane".

- **Passkeys only.** Discoverable credentials with user verification required, so there is no
  username field and nothing to enumerate. No passwords, no magic links, no TOTP, no recovery
  email. Recovery is "enroll a second passkey" plus `herdrer enroll` over SSH.
- **Registration is closed.** Permits are minted only by a local shell, hashed, single-use, and
  consumed in the same transaction that writes the credential. "First request wins" loses to a
  scanner.
- **Three route trees, and the split is the authorisation model.** Bearer tokens live under
  `/api/v1/agent/*` where no handler can reach a PTY; sessions live under `/api/v1/*`. No code path
  turns a token into a session, and the scope vocabulary has no terminal scope.
- **Sessions are server-side and stored hashed.** Revocation is a `DELETE` that takes effect on the
  next request. Never a JWT.
- **CSRF is an exact-string `Origin` match** at the router, on every state-changing request, with a
  missing `Origin` treated as a rejection. `SameSite=Strict` and the `__Host-` cookie prefix are
  explicitly layer two.
- **WebSocket upgrades need a single-use 60-second ticket** minted by an authenticated same-origin
  POST, on top of the session and the origin check. Cookie-on-upgrade is what owned three shipped
  projects in 2026.
- **Agent-authored markdown is sanitized server-side and rendered in an opaque-origin sandboxed
  iframe** with `connect-src 'none'`. An agent is a trusted party producing untrusted content, and
  a sanitizer bug should be a rendering glitch rather than a shell.
- **Set `HERDRER_TERMINAL_ENABLED=false`** for a review-only deployment. That is a genuinely
  different threat model — a document surface with no code execution behind it — and it is the mode
  worth running most of the time.

Two things to know honestly. herdr-web's relay and hand-rolled end-to-end crypto are **deleted on
purpose**: TLS now terminates on hardware you control, so there is no third party in the byte path
to defend against, and deleting a hand-rolled protocol from a system whose failure mode is RCE is a
gain. What is genuinely lost with it is **channel binding** — herdr-web's per-device keys made
possession of the channel continuous proof of possession of the device; a session cookie is a
bearer credential, and a stolen one is a stolen session until it is revoked. And
`herdrer.example.com` **shares a registrable domain with other services**, which makes them
same-site; the mitigations are listed above and the residual risk is accepted knowingly.

**That split is tested, not just asserted.** `internal/api/routes_test.go` tables all 38 endpoints
and proves both directions of it — no agent token reaches a human route, no session cookie reaches
an agent route, no route outside the ceremony answers an anonymous caller, and cross-origin writes
are refused including from a same-site sibling.

`DESIGN.md` §7 has the ranked threat table and §11 the unbuilt controls, which currently include
step-up re-authentication, per-credential terminal permissions, and off-box audit.

## License

MIT. © 2026 Jeff Clement.
