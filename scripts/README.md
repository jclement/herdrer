# Operating herdrer on herdrer.example.com

Everything in this directory and in `../deploy/` exists to put one Go binary on one
Hetzner box and keep it running. Four files:

| File | What it is |
|---|---|
| `provision.sh` | One-time setup of a bare Ubuntu box. Runs **on the box, as root**. |
| `deploy.sh` | Ship a new binary. Runs **on the Mac**, or via `mise run deploy`. |
| `install.sh` | The public `curl … \| sh` installer, for putting herdrer on *other* machines. Not part of this deployment. |
| `../deploy/Caddyfile` | The reverse proxy: TLS on 80/443, proxy to `127.0.0.1:7799`. |
| `../deploy/herdrer.service` | The systemd **user** unit. |

## The shape

```
internet ──443──▶ Caddy (system service, root-ish, holds the cert)
                    │
                    └── 127.0.0.1:7799 ──▶ herdrer (systemd *user* unit, runs as dev)
                                              │
                                              ├── ~/.config/herdr/herdr.sock   (0600, dev)
                                              ├── ~/.local/state/herdrer/      (0700, the DB)
                                              └── PTYs: dev's shell, dev's dotfiles
```

Two facts drive the whole design and neither is negotiable:

1. **herdrer runs as `dev`, not root and not a service account.** Herdr's socket is mode
   `0600` with no group bit, so a different UID physically cannot open it — and every
   PTY herdrer spawns has to be Jeff's shell, with his mise shims, ssh-agent and
   `~/Developer` checkouts.
2. **Caddy, not herdrer, holds the public ports and the certificate.** The process that
   forks arbitrary shells should not be the one binding `:443` on the internet. herdrer
   listens on loopback only and never sees an ACME challenge.

The corollary worth saying out loud: **a registered passkey on herdrer is a shell as
`dev` on this box.** No systemd hardening directive changes that. What protects the
service is the passkey, the one-time enrollment token, and the absence of any open
registration endpoint.

## Fresh box, in order

Assumes DNS for `herdrer.example.com` already points at the box's public IP and
`ssh root@herdrer.example.com` works with key auth.

```sh
# 1. put the provisioning assets on the box
rsync -a scripts deploy root@herdrer.example.com:/opt/herdrer-provision/

# 2. see what it would do (does nothing)
ssh root@herdrer.example.com /opt/herdrer-provision/scripts/provision.sh --dry-run

# 3. do it
ssh root@herdrer.example.com /opt/herdrer-provision/scripts/provision.sh
```

That creates `dev` with your SSH key, enables linger, installs Caddy from its official
apt repo, installs the Caddyfile and reloads (which triggers the Let's Encrypt HTTP-01
challenge), sets ufw to deny-incoming/allow-22-80-443, installs and enables the systemd
user unit, and installs mise for `dev`. It does **not** install herdrer.

```sh
# 4. build, ship, restart, health-check — from the Mac, in the repo root
mise run deploy

# 5. first passkey — on the box, as dev
ssh dev@herdrer.example.com
herdrer enroll --label "iPhone"
```

`provision.sh` is idempotent. Re-running it prints `skip` for everything already done.

## Deploying an update

```sh
mise run deploy              # = mise run build:linux, then scripts/deploy.sh
```

or, if the binary is already built:

```sh
./scripts/deploy.sh --dry-run    # print the plan, change nothing
./scripts/deploy.sh
```

What it does: checks `dist/herdrer-linux-amd64` is really an ELF binary, scp's it to
`~/.local/bin/.herdrer.incoming`, re-checks the sha256 **on the box**, copies the current
binary to `~/.local/bin/herdrer.prev`, atomically renames the new one into place, restarts
the user unit, then polls `http://127.0.0.1:7799/api/v1/health` for 30 seconds. If health
never comes up it restores `herdrer.prev`, restarts, dumps the last 40 journal lines, and
exits non-zero.

Overrides, all optional:

| Variable | Default |
|---|---|
| `HERDRER_DEPLOY_HOST` | `herdrer.example.com` |
| `HERDRER_DEPLOY_USER` | `dev` |
| `HERDRER_DEPLOY_PORT` | `7799` |
| `HERDRER_DEPLOY_BINARY` | `dist/herdrer-linux-amd64` |

They are namespaced `HERDRER_DEPLOY_*` on purpose: `mise.toml`'s `[env]` block exports
`HERDRER_DOMAIN`, `HERDRER_ADDR` and friends for *local development*, and a deploy script
reading those would quietly aim at `localhost`.

## Rolling back

The last-known-good binary is always one command away:

```sh
ssh dev@herdrer.example.com
cp ~/.local/bin/herdrer.prev ~/.local/bin/herdrer
systemctl --user restart herdrer
curl -fsS http://127.0.0.1:7799/api/v1/health
```

`deploy.sh` does this automatically when a fresh deploy fails its health check, so a
manual rollback is only for the case where the new version *starts* but misbehaves.

To go back further, build the older tag locally and deploy it:

```sh
git checkout v1.1.0 && mise run deploy
```

**The database is the thing rollback does not cover.** If the version you are rolling back
from applied a migration, the schema has moved forward and the older binary will refuse to
start rather than half-work. Restore the pre-migration snapshot it wrote before starting:

```sh
ls ~/.local/state/herdrer/backups/
herdrer db restore ~/.local/state/herdrer/backups/pre-<n>-<timestamp>.db
```

## Where everything lives

| | Path |
|---|---|
| Binary | `~dev/.local/bin/herdrer` |
| Previous binary | `~dev/.local/bin/herdrer.prev` |
| Database, VAPID key, snapshots | `~dev/.local/state/herdrer/` (0700) |
| Optional env overrides / secrets | `~dev/.config/herdrer/herdrer.env` (0600, optional) |
| Herdr socket herdrer talks to | `~dev/.config/herdr/herdr.sock` (0600) |
| systemd user unit | `~dev/.config/systemd/user/herdrer.service` |
| herdrer logs | journald: `journalctl --user -u herdrer` |
| Caddy config | `/etc/caddy/Caddyfile` |
| Caddy access log | `/var/log/caddy/herdrer.access.log` (JSON, rotated) |
| Caddy logs | journald: `journalctl -u caddy` |
| TLS certificates | `/var/lib/caddy/.local/share/caddy/` (Caddy manages renewal) |

## Day-to-day

```sh
# as dev on the box
systemctl --user status herdrer
systemctl --user restart herdrer
journalctl --user -u herdrer -f
journalctl --user -u herdrer --since '1 hour ago'

# the edge — needs sudo
sudo systemctl reload caddy          # after editing /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo journalctl -u caddy -f
sudo tail -f /var/log/caddy/herdrer.access.log

# from anywhere
curl -fsS https://herdrer.example.com/api/v1/health
```

### The failure that will happen eventually

A terminal that dies after a fixed number of seconds, or an agent long-poll that gets a
connection reset instead of `{"status":"open"}`, is **always** a proxy timeout. The
`timeouts` block in `deploy/Caddyfile` sets `write` and `read_body` to `0` for exactly this
reason. If someone "tidies" those into real numbers, this is the symptom.

### Start-limit lockout

Five failed starts in sixty seconds and systemd stops trying:

```sh
systemctl --user reset-failed herdrer
systemctl --user start herdrer
```

`deploy.sh` runs `reset-failed` before every restart, so a deploy is never a silent no-op
against a locked-out unit.

## If you lock yourself out

In rough order of how bad things are.

**Lost the passkey, or the phone.** SSH still works; the passkey is not the way in to the
box, only to the web UI. Mint a fresh enrollment token over SSH:

```sh
ssh dev@herdrer.example.com
herdrer enroll --label "iPhone"
```

**ufw locked out SSH.** It should not: `provision.sh` allows 22 before `ufw enable`. If it
happens anyway, Hetzner's web console gives you a serial console with root, and
`ufw disable` from there fixes it.

**`dev`'s SSH key stopped working.** `root`'s key is untouched by all of this, so
`ssh root@herdrer.example.com` is the back door. Re-run `provision.sh` — it re-installs
`root`'s authorized_keys for `dev`.

**`dev` cannot sudo.** By design: `provision.sh` adds `dev` to the `sudo` group but sets no
password and configures no NOPASSWD rule, because a passkey is already a shell as that user
and NOPASSWD would make it a *root* shell. Give it a password from a root session when you
want sudo to work:

```sh
ssh root@herdrer.example.com passwd dev
```

**Certificate did not issue.** Caddy retries on its own schedule; the usual causes are DNS
not resolving to this box or port 80 blocked. Both are visible in `journalctl -u caddy`.
Nothing about herdrer needs fixing — it never sees ACME.

**herdrer will not start at all and you are on a phone.** There is no way around SSH for
this one, and that is the honest boundary of the design: herdrer is the thing you use to
fix the box, so it cannot also be the thing that fixes itself when it is down. This is why
`deploy.sh` rolls back automatically and why `Restart=always` is set — the two mechanisms
that keep "down" from being a state you have to be at a laptop to leave.

## About install.sh

`install.sh` is for putting herdrer on some *other* machine — it is not used by this
deployment at all. It refuses to run as root, installs to `~/.local/bin`, verifies the
download (cosign bundle if cosign is present, `gh attestation verify` if gh is
authenticated, otherwise a sha256 against `checksums.txt` with a loud warning), and prints
next steps without starting anything. `HERDRER_REQUIRE_SIGNATURE=1` makes a missing
signature fatal. A checksum mismatch is fatal always, with no override.

```sh
sh scripts/install.sh --dry-run
```
