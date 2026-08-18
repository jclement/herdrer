#!/usr/bin/env bash
#
# deploy.sh — ship a freshly cross-compiled herdrer to the Hetzner box.
#
# Run this from the Mac, from the repo root, or via `mise run deploy` (which
# builds dist/herdrer-linux-amd64 first).
#
# What it does:
#   1. checks the local linux/amd64 binary exists and records its sha256
#   2. scp's it to a staging path in the target user's ~/.local/bin
#   3. verifies the checksum on the far side, keeps the current binary as
#      herdrer.prev, and atomically renames the new one into place
#   4. restarts the systemd user unit and polls /api/v1/health
#   5. rolls back to herdrer.prev and restarts if health never comes up,
#      then prints the journal and exits non-zero
#
# The rename in step 3 is what makes this safe to run against a live box: the
# running process keeps its own inode, so nothing is disturbed until the
# restart, and there is no window where the path holds a half-written file.
#
# Assumes:
#   * scripts/provision.sh has already run on the target
#   * ssh to $HERDRER_DEPLOY_USER@$HERDRER_DEPLOY_HOST works with key auth, no prompt
#   * the target's herdrer listens on 127.0.0.1:$HERDRER_DEPLOY_PORT with Caddy in front
#
# Environment:
#   HERDRER_DEPLOY_HOST    target host        (REQUIRED, no default)
#   HERDRER_DEPLOY_USER    target user        (default: $USER)
#   HERDRER_DEPLOY_PORT    loopback port      (default: 7799)
#   HERDRER_DEPLOY_BINARY  local binary path  (default: dist/herdrer-linux-amd64)
#
set -euo pipefail

HOST="${HERDRER_DEPLOY_HOST:-}"
TARGET_USER="${HERDRER_DEPLOY_USER:-${USER:-herdrer}}"
PORT="${HERDRER_DEPLOY_PORT:-7799}"

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="${HERDRER_DEPLOY_BINARY:-$REPO_ROOT/dist/herdrer-linux-amd64}"

DRY_RUN=0
HEALTH_TRIES=30

# Relative to the remote user's home; scp and the remote shell both start there.
REMOTE_BIN=".local/bin/herdrer"
REMOTE_STAGE=".local/bin/.herdrer.incoming"
REMOTE_PREV=".local/bin/herdrer.prev"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

if [ -t 1 ]; then
	C_BOLD=$(printf '\033[1m'); C_DIM=$(printf '\033[2m')
	C_GRN=$(printf '\033[32m'); C_YEL=$(printf '\033[33m')
	C_RED=$(printf '\033[31m'); C_OFF=$(printf '\033[0m')
else
	C_BOLD=""; C_DIM=""; C_GRN=""; C_YEL=""; C_RED=""; C_OFF=""
fi

step() { printf '\n%s==> %s%s\n' "$C_BOLD" "$*" "$C_OFF"; }
ok()   { printf '  %sok%s   %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '  %swarn%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
die()  { printf '\n%serror%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }
cmd()  { printf '  %s$ %s%s\n' "$C_DIM" "$*" "$C_OFF"; }

usage() {
	cat <<USAGE
usage: deploy.sh [--dry-run] [--host HOST] [--user USER] [--binary PATH]

  --host HOST     target host   (REQUIRED, or set \$HERDRER_DEPLOY_HOST)
  --user USER     target user   (default: $TARGET_USER, or \$HERDRER_DEPLOY_USER)
  --binary PATH   local binary  (default: $BINARY, or \$HERDRER_DEPLOY_BINARY)
  --dry-run       print what would happen; touch nothing, local or remote
  -h, --help      this
USAGE
}

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run) DRY_RUN=1; shift ;;
		--host)    HOST="${2:?--host needs a value}"; shift 2 ;;
		--user)    TARGET_USER="${2:?--user needs a value}"; shift 2 ;;
		--binary)  BINARY="${2:?--binary needs a value}"; shift 2 ;;
		-h|--help) usage; exit 0 ;;
		*)         usage >&2; die "unknown argument: $1" ;;
	esac
done

# No default host. Shipping a binary is a state-changing act against a machine;
# a baked-in default is how the wrong box gets deployed to.
[ -n "$HOST" ] || die "no host: pass --host example.com (or set HERDRER_DEPLOY_HOST)"

DEST="$TARGET_USER@$HOST"

# --- 1. local binary ---------------------------------------------------------

step "local binary"

[ -f "$BINARY" ] || die "no binary at $BINARY — run: mise run build:linux"

# Refuse to ship a Mach-O binary to a Linux box. `file` is not always present,
# so fall back to the ELF magic bytes, which always are.
if [ "$(head -c 4 "$BINARY" | od -An -tx1 | tr -d ' \n')" != "7f454c46" ]; then
	die "$BINARY is not an ELF executable — was it built with GOOS=linux?"
fi

if command -v sha256sum >/dev/null 2>&1; then
	SHA="$(sha256sum "$BINARY" | awk '{print $1}')"
else
	SHA="$(shasum -a 256 "$BINARY" | awk '{print $1}')"
fi

SIZE="$(wc -c < "$BINARY" | tr -d ' ')"
ok "$BINARY  ($((SIZE / 1024 / 1024)) MB, sha256 ${SHA:0:16}…)"

printf '\n%splan%s\n' "$C_BOLD" "$C_OFF"
printf '  from    %s\n' "$BINARY"
printf '  to      %s:~/%s\n' "$DEST" "$REMOTE_BIN"
printf '  restart systemctl --user restart herdrer\n'
printf '  health  http://127.0.0.1:%s/api/v1/health (up to %ss)\n' "$PORT" "$HEALTH_TRIES"
printf '  public  https://%s/api/v1/health\n' "$HOST"

if [ "$DRY_RUN" -eq 1 ]; then
	printf '\n  %sDRY RUN — the commands below are not executed%s\n' "$C_YEL" "$C_OFF"
	cmd "scp ${SSH_OPTS[*]} $BINARY $DEST:$REMOTE_STAGE"
	cmd "ssh ${SSH_OPTS[*]} $DEST bash -s  # verify sha256, keep $REMOTE_PREV,"
	cmd "                                  # mv staging -> $REMOTE_BIN,"
	cmd "                                  # systemctl --user restart herdrer,"
	cmd "                                  # poll health, roll back on failure"
	printf '\n'
	exit 0
fi

# --- 2. ship -----------------------------------------------------------------

step "upload"

cmd "scp $BINARY $DEST:~/$REMOTE_STAGE"
scp "${SSH_OPTS[@]}" -q "$BINARY" "$DEST:$REMOTE_STAGE" \
	|| die "scp failed — is $DEST reachable with key auth?"
ok "staged at ~/$REMOTE_STAGE"

# --- 3-5. swap, restart, verify, roll back -----------------------------------
# One remote script rather than a chain of ssh calls: a connection that drops
# midway then cannot leave the box between the rename and the restart.

step "install and restart on $HOST"

set +e
ssh "${SSH_OPTS[@]}" "$DEST" \
	REMOTE_BIN="$REMOTE_BIN" REMOTE_STAGE="$REMOTE_STAGE" REMOTE_PREV="$REMOTE_PREV" \
	SHA="$SHA" PORT="$PORT" TRIES="$HEALTH_TRIES" \
	bash -s <<'REMOTE'
set -uo pipefail

say() { printf '  %s\n' "$*"; }
fail() { printf '  ERROR %s\n' "$*" >&2; }

cd "$HOME" || exit 1
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

[ -f "$REMOTE_STAGE" ] || { fail "staged binary missing"; exit 1; }

# Checksum first. A truncated scp that still exits 0 is rare but not
# impossible, and finding out via a crashloop is much worse than finding out
# here. There is no override for a mismatch.
if ! printf '%s  %s\n' "$SHA" "$REMOTE_STAGE" | sha256sum -c - >/dev/null 2>&1; then
	fail "sha256 mismatch on the uploaded binary — refusing to install"
	fail "  expected $SHA"
	fail "  got      $(sha256sum "$REMOTE_STAGE" | awk '{print $1}')"
	rm -f "$REMOTE_STAGE"
	exit 1
fi
say "sha256 verified on the box"

chmod 0755 "$REMOTE_STAGE"

if [ -f "$REMOTE_BIN" ]; then
	OLD_VERSION="$("$REMOTE_BIN" --version 2>/dev/null | head -1 || true)"
	cp -f "$REMOTE_BIN" "$REMOTE_PREV" || { fail "could not save rollback copy"; exit 1; }
	say "kept previous binary as ~/$REMOTE_PREV  ${OLD_VERSION:+($OLD_VERSION)}"
else
	say "no previous binary — this is the first deploy, rollback is not available"
fi

# Atomic within the same filesystem. The running process holds its own inode
# and is undisturbed until the restart below.
mv -f "$REMOTE_STAGE" "$REMOTE_BIN" || { fail "rename into place failed"; exit 1; }
say "installed ~/$REMOTE_BIN  $("$REMOTE_BIN" --version 2>/dev/null | head -1 || echo '(version unknown)')"

systemctl --user daemon-reload
# reset-failed clears any start-limit lockout left by a previous bad deploy,
# which would otherwise make restart a silent no-op.
systemctl --user reset-failed herdrer.service >/dev/null 2>&1
systemctl --user restart herdrer.service || fail "restart returned non-zero; checking health anyway"

healthy=0
for _ in $(seq 1 "$TRIES"); do
	BODY="$(curl -fsS -m 3 "http://127.0.0.1:$PORT/api/v1/health" 2>/dev/null)"
	if [ -n "$BODY" ]; then healthy=1; break; fi
	sleep 1
done

if [ "$healthy" -eq 1 ]; then
	say "health ok: $BODY"
	systemctl --user is-enabled herdrer.service >/dev/null 2>&1 \
		|| say "note: herdrer.service is not enabled; run systemctl --user enable herdrer"
	exit 0
fi

fail "herdrer did not answer /api/v1/health within ${TRIES}s"

if [ -f "$REMOTE_PREV" ]; then
	fail "rolling back to ~/$REMOTE_PREV"
	cp -f "$REMOTE_PREV" "$REMOTE_BIN"
	systemctl --user restart herdrer.service
	for _ in $(seq 1 15); do
		if curl -fsS -m 3 "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1; then
			fail "rolled back; the previous version is serving again"
			break
		fi
		sleep 1
	done
else
	fail "no ~/$REMOTE_PREV to roll back to — the service is down"
fi

printf '\n  --- journalctl --user -u herdrer -n 40 ---\n' >&2
journalctl --user -u herdrer -n 40 --no-pager >&2 || true
exit 1
REMOTE
rc=$?
set -e

[ "$rc" -eq 0 ] || die "deploy failed (see above). The box is running the previous binary if one existed."

# --- public check ------------------------------------------------------------
# Non-fatal: the loopback health check above is the authority on whether the
# deploy worked. This one also exercises DNS, ufw, Caddy and the certificate,
# so a failure here means the edge is broken, not the deploy.

step "edge check"

cmd "curl -fsS https://$HOST/api/v1/health"
if PUBLIC="$(curl -fsS -m 15 "https://$HOST/api/v1/health" 2>/dev/null)"; then
	ok "https://$HOST → $PUBLIC"
else
	warn "https://$HOST/api/v1/health did not answer."
	warn "herdrer itself is healthy on loopback, so look at the edge:"
	warn "  ssh $DEST sudo journalctl -u caddy -n 50 --no-pager"
fi

printf '\n%sdeployed%s  %s\n\n' "$C_BOLD" "$C_OFF" "$HOST"
