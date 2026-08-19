#!/usr/bin/env bash
#
# provision.sh — one-time setup of a bare Ubuntu box to host herdrer.
#
# Run this ON the box, as root, once. It is idempotent: running it again on a
# provisioned box changes nothing and says so.
#
# What it does, in order:
#   1. creates the unprivileged user that owns everything (--user, default: the
#      invoking login) and installs the operator's SSH key for it
#   2. enables systemd linger for that user, so its user services start at boot
#      and survive logout
#   3. installs Caddy from its official apt repository
#   4. installs deploy/Caddyfile and reloads Caddy, bound to this node's
#      Tailscale addresses and serving a certificate fetched from tailscaled
#   5. configures ufw: deny incoming, allow 22, 80, 443
#   6. installs deploy/herdrer.service as a systemd *user* unit and enables it
#   7. installs mise for the user
#
# What it deliberately does NOT do:
#   * install the herdrer binary — that is scripts/deploy.sh, run from the Mac
#   * start herdrer — there is no binary yet, and deploy.sh starts it
#   * touch DNS, or anything outside this box
#
# Assumes:
#   * Ubuntu 24.04 or newer (verified against 26.04, systemd 259)
#   * running as root, with network access to apt and dl.cloudsmith.io
#   * tailscaled is up and this node is logged in — --domain is its MagicDNS
#     name, and both the bind addresses and the certificate come from it. No
#     public DNS record and no inbound 80/443 are involved (Caddy retries, so
#     a tailnet that is not up yet is recoverable — fix it and
#     `systemctl reload caddy`)
#   * /root/.ssh/authorized_keys holds the operator's key, unless --ssh-key
#
# Getting it here:
#   rsync -a scripts deploy root@HOST:/opt/herdrer-provision/
#   ssh root@HOST /opt/herdrer-provision/scripts/provision.sh
#
set -euo pipefail

# --- defaults ----------------------------------------------------------------

APP_USER="${HERDRER_DEPLOY_USER:-$(logname 2>/dev/null || echo herdrer)}"
DOMAIN="${HERDRER_DEPLOY_DOMAIN:-}"
# Where herdrer listens. Loopback only, always: Caddy owns the public ports, and
# the process that forks shells should never hold one.
LISTEN_ADDR="${HERDRER_DEPLOY_ADDR:-127.0.0.1:7799}"
# Addresses Caddy binds. Defaults to this node's Tailscale addresses, so herdrer
# is reachable on the tailnet and nowhere else. Empty means "work it out from
# tailscale ip" — see preflight; there is deliberately no fallback to 0.0.0.0,
# because the failure mode of guessing wrong here is a public terminal server.
BIND="${HERDRER_DEPLOY_BIND:-}"
SSH_KEY_SRC=""
DRY_RUN=0
SKIP_CADDY=0
SKIP_UFW=0
SKIP_MISE=0

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
CADDYFILE_SRC="$REPO_ROOT/deploy/Caddyfile.template"
UNIT_SRC="$REPO_ROOT/deploy/herdrer.service.template"

CADDY_KEYRING=/usr/share/keyrings/caddy-stable-archive-keyring.gpg
CADDY_SOURCES=/etc/apt/sources.list.d/caddy-stable.sources

# --- output helpers ----------------------------------------------------------

if [ -t 1 ]; then
	C_BOLD=$(printf '\033[1m'); C_DIM=$(printf '\033[2m')
	C_GRN=$(printf '\033[32m'); C_YEL=$(printf '\033[33m')
	C_RED=$(printf '\033[31m'); C_OFF=$(printf '\033[0m')
else
	C_BOLD=""; C_DIM=""; C_GRN=""; C_YEL=""; C_RED=""; C_OFF=""
fi

step() { printf '\n%s==> %s%s\n' "$C_BOLD" "$*" "$C_OFF"; }
ok()   { printf '  %sok%s   %s\n' "$C_GRN" "$C_OFF" "$*"; }
skip() { printf '  %sskip%s %s\n' "$C_DIM" "$C_OFF" "$*"; }
warn() { printf '  %swarn%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
die()  { printf '\n%serror%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

# run — echo a state-changing command, then run it (or not, under --dry-run).
# Every destructive step in this script goes through here so that --dry-run is
# a complete and honest preview.
run() {
	printf '  %s$ %s%s\n' "$C_DIM" "$*" "$C_OFF"
	[ "$DRY_RUN" -eq 1 ] && return 0
	"$@"
}

usage() {
	cat <<USAGE
usage: provision.sh [options]

  --user NAME        user that owns and runs herdrer (default: $APP_USER)
  --domain NAME      this node's tailnet name (REQUIRED, no default)
  --addr HOST:PORT   loopback listener herdrer binds (default: $LISTEN_ADDR)
                     must match the site block in deploy/Caddyfile
  --bind ADDRS       addresses Caddy listens on, space separated
                     (default: this node's tailscale ip -4 and -6)
  --ssh-key FILE     authorized_keys source (default: /root/.ssh/authorized_keys)
  --caddyfile FILE   Caddyfile to install (default: deploy/Caddyfile)
  --unit FILE        systemd user unit to install (default: deploy/herdrer.service)
  --skip-caddy       leave Caddy and TLS alone
  --skip-ufw         leave the firewall alone
  --skip-mise        do not install mise for the user
  --dry-run          print every command instead of running it
  -h, --help         this
USAGE
}

# --- argument parsing --------------------------------------------------------

while [ $# -gt 0 ]; do
	case "$1" in
		--user)      APP_USER="${2:?--user needs a value}"; shift 2 ;;
		--domain)    DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
		--addr)      LISTEN_ADDR="${2:?--addr needs a value}"; shift 2 ;;
		--bind)      BIND="${2:?--bind needs a value}"; shift 2 ;;
		--ssh-key)   SSH_KEY_SRC="${2:?--ssh-key needs a value}"; shift 2 ;;
		--caddyfile) CADDYFILE_SRC="${2:?--caddyfile needs a value}"; shift 2 ;;
		--unit)      UNIT_SRC="${2:?--unit needs a value}"; shift 2 ;;
		--skip-caddy) SKIP_CADDY=1; shift ;;
		--skip-ufw)   SKIP_UFW=1; shift ;;
		--skip-mise)  SKIP_MISE=1; shift ;;
		--dry-run)    DRY_RUN=1; shift ;;
		-h|--help)    usage; exit 0 ;;
		*)            usage >&2; die "unknown argument: $1" ;;
	esac
done

# --- preflight ---------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "provision.sh must run as root on the target box."
command -v systemctl >/dev/null || die "no systemd here; this script targets Ubuntu."
[ -f "$CADDYFILE_SRC" ] || die "Caddyfile not found at $CADDYFILE_SRC (pass --caddyfile)"
[ -f "$UNIT_SRC" ]      || die "unit not found at $UNIT_SRC (pass --unit)"

# The domain is required and has no default. It ends up in the TLS certificate
# and in HERDRER_ORIGIN, which WebAuthn binds every passkey to — a wrong value
# here is not a typo you fix later, it is every credential invalidated.
if [ -z "$DOMAIN" ]; then
	die "no domain: pass --domain example.com (or set HERDRER_DEPLOY_DOMAIN)"
fi
# Caddy listens on the tailnet only. Derive it rather than make the operator
# type two addresses, but never invent one: binding the wrong thing here does
# not fail loudly, it publishes a shell-forking service to the internet.
if [ -z "$BIND" ] && [ "$SKIP_CADDY" -eq 0 ]; then
	BIND="$(tailscale ip -4 2>/dev/null || true) $(tailscale ip -6 2>/dev/null || true)"
	BIND="$(printf '%s' "$BIND" | xargs || true)"
	[ -n "$BIND" ] || die "no --bind and tailscale ip returned nothing — is tailscaled up and this node logged in?"
fi

if [ "$SKIP_CADDY" -eq 0 ] && ! grep -q '__DOMAIN__' "$CADDYFILE_SRC"; then
	warn "$CADDYFILE_SRC has no __DOMAIN__ placeholder — is it really the template?"
fi

if [ -z "$SSH_KEY_SRC" ]; then
	SSH_KEY_SRC=/root/.ssh/authorized_keys
fi
[ -r "$SSH_KEY_SRC" ] || die "no readable SSH key source at $SSH_KEY_SRC (pass --ssh-key)"

printf '%sherdrer provisioning%s\n' "$C_BOLD" "$C_OFF"
printf '  host      %s\n' "$(hostname -f 2>/dev/null || hostname)"
# shellcheck source=/dev/null
printf '  os        %s\n' "$( . /etc/os-release && echo "$PRETTY_NAME" )"
printf '  user      %s\n' "$APP_USER"
printf '  domain    %s\n' "$DOMAIN"
printf '  ssh key   %s\n' "$SSH_KEY_SRC"
[ "$DRY_RUN" -eq 1 ] && printf '  %sDRY RUN — nothing will be changed%s\n' "$C_YEL" "$C_OFF"

# --- 1. the user -------------------------------------------------------------

step "user $APP_USER"

if id -u "$APP_USER" >/dev/null 2>&1; then
	skip "user $APP_USER already exists"
else
	run adduser --disabled-password --gecos "" --shell /bin/bash "$APP_USER"
	ok "created $APP_USER"
fi

if id -nG "$APP_USER" 2>/dev/null | tr ' ' '\n' | grep -qx sudo; then
	skip "$APP_USER is already in the sudo group"
else
	run usermod -aG sudo "$APP_USER"
	ok "$APP_USER added to the sudo group"
	warn "$APP_USER has no password, so sudo will prompt and fail."
	warn "Set one when you want it:  passwd $APP_USER"
	warn "Passwordless sudo is NOT configured on purpose: a registered passkey is"
	warn "already a shell as $APP_USER, and NOPASSWD would make it a root shell."
fi

# Home directory paths are needed from here on. Under --dry-run the user may
# not exist yet, so fall back to the conventional location.
# `|| true` matters: under `set -euo pipefail`, getent exits 2 when the user
# does not exist, which is exactly the state --dry-run is always in (it never
# created the user). Without this, the dry run — the safety feature — dies at
# the first step and can never preview the rest.
# render_to_stdout substitutes the template placeholders. Kept separate from
# render() so the idempotency check can compare against what *would* be written
# without writing it.
#
# The values are hostnames, ports and a username — no shell metacharacters
# expected — but they go through sed's replacement side, so a stray & or / would
# corrupt the output silently. Escape them rather than trust the input.
render_to_stdout() {
	_esc() { printf '%s' "$1" | sed -e 's/[&/\\]/\\&/g'; }
	sed \
		-e "s/__DOMAIN__/$(_esc "$DOMAIN")/g" \
		-e "s/__BIND__/$(_esc "$BIND")/g" \
		-e "s/__ADDR__/$(_esc "$LISTEN_ADDR")/g" \
		-e "s/__UPSTREAM__/$(_esc "$LISTEN_ADDR")/g" \
		-e "s/__USER__/$(_esc "$APP_USER")/g" \
		"$1"
}

# render writes a rendered template to a destination, and refuses to leave an
# unsubstituted placeholder behind — a half-rendered unit file starts and then
# fails in a way that is tedious to diagnose from a phone.
render() {
	_src="$1"; _dst="$2"; _mode="$3"; _own="$4"; _grp="$5"
	if [ "$DRY_RUN" -eq 1 ]; then
		printf '  %s$ render %s -> %s%s\n' "$C_DIM" "$_src" "$_dst" "$C_OFF"
		return 0
	fi
	_tmp="$(mktemp)"
	render_to_stdout "$_src" > "$_tmp"
	if grep -q '__[A-Z_]*__' "$_tmp"; then
		rm -f "$_tmp"
		die "unsubstituted placeholder left in $_dst — check $_src"
	fi
	install -m "$_mode" -o "$_own" -g "$_grp" "$_tmp" "$_dst"
	rm -f "$_tmp"
	printf '  %s$ render %s -> %s%s\n' "$C_DIM" "$_src" "$_dst" "$C_OFF"
}

USER_HOME="$(getent passwd "$APP_USER" | cut -d: -f6 || true)"
USER_HOME="${USER_HOME:-/home/$APP_USER}"
USER_UID="$(id -u "$APP_USER" 2>/dev/null || echo 1000)"

step "ssh key for $APP_USER"

AUTH_KEYS="$USER_HOME/.ssh/authorized_keys"
run install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$USER_HOME/.ssh"
if [ ! -f "$AUTH_KEYS" ] && [ "$DRY_RUN" -eq 0 ]; then
	install -m 0600 -o "$APP_USER" -g "$APP_USER" /dev/null "$AUTH_KEYS"
fi

added=0
while IFS= read -r key; do
	case "$key" in ""|\#*) continue ;; esac
	if [ "$DRY_RUN" -eq 0 ] && grep -qxF "$key" "$AUTH_KEYS" 2>/dev/null; then
		continue
	fi
	printf '  %s$ append key %.40s… to %s%s\n' "$C_DIM" "$key" "$AUTH_KEYS" "$C_OFF"
	[ "$DRY_RUN" -eq 0 ] && printf '%s\n' "$key" >> "$AUTH_KEYS"
	added=$((added + 1))
done < "$SSH_KEY_SRC"

if [ "$added" -eq 0 ]; then
	skip "authorized_keys already current"
else
	run chown "$APP_USER:$APP_USER" "$AUTH_KEYS"
	run chmod 0600 "$AUTH_KEYS"
	ok "$added key(s) installed for $APP_USER"
fi

# --- 2. linger ---------------------------------------------------------------
# Without this the user manager stops at logout and herdrer dies with it, and
# nothing starts at boot. This is the single directive that makes a user unit a
# real service.

step "linger for $APP_USER"

if [ "$(loginctl show-user "$APP_USER" --property=Linger --value 2>/dev/null || echo no)" = "yes" ]; then
	skip "linger already enabled"
else
	run loginctl enable-linger "$APP_USER"
	ok "linger enabled — $APP_USER's units now start at boot"
fi

# The user manager needs a moment to come up before `systemctl --user` will
# talk to it. Wait rather than race.
if [ "$DRY_RUN" -eq 0 ]; then
	for _ in $(seq 1 30); do
		[ -S "/run/user/$USER_UID/bus" ] && break
		sleep 1
	done
	[ -S "/run/user/$USER_UID/bus" ] || die "user manager for $APP_USER did not start (no /run/user/$USER_UID/bus)"
fi

# user_systemctl — drive $APP_USER's systemd instance from root. This is the
# supported way to do it without a login session: point sd-bus at the user's
# runtime directory, which linger guarantees exists.
user_systemctl() {
	run runuser -u "$APP_USER" -- \
		env "XDG_RUNTIME_DIR=/run/user/$USER_UID" \
		    "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$USER_UID/bus" \
		systemctl --user "$@"
}

# --- 3. Caddy ----------------------------------------------------------------

if [ "$SKIP_CADDY" -eq 1 ]; then
	step "Caddy (skipped)"
else
	step "Caddy from the official apt repository"

	if command -v caddy >/dev/null 2>&1; then
		skip "caddy already installed ($(caddy version 2>/dev/null | head -1))"
	else
		run apt-get update -qq
		run apt-get install -y --no-install-recommends \
			debian-keyring debian-archive-keyring apt-transport-https curl gpg ca-certificates

		if [ -s "$CADDY_KEYRING" ]; then
			skip "signing key already present at $CADDY_KEYRING"
		else
			printf '  %s$ curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o %s%s\n' \
				"$C_DIM" "$CADDY_KEYRING" "$C_OFF"
			if [ "$DRY_RUN" -eq 0 ]; then
				curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
					| gpg --batch --yes --dearmor -o "$CADDY_KEYRING"
				chmod 0644 "$CADDY_KEYRING"
			fi
			ok "signing key installed"
		fi

		# deb822 format. The suite is literally "any-version" — Cloudsmith serves
		# one pool for every Debian/Ubuntu release, which is why this works on a
		# codename ("resolute") that no third-party repo has heard of.
		if [ "$DRY_RUN" -eq 0 ]; then
			tmp_src="$(mktemp)"
			cat > "$tmp_src" <<-SOURCES
			Types: deb
			URIs: https://dl.cloudsmith.io/public/caddy/stable/deb/debian
			Suites: any-version
			Components: main
			Signed-By: $CADDY_KEYRING
			SOURCES
			if cmp -s "$tmp_src" "$CADDY_SOURCES"; then
				rm -f "$tmp_src"
				skip "$CADDY_SOURCES already current"
			else
				install -m 0644 "$tmp_src" "$CADDY_SOURCES"
				rm -f "$tmp_src"
				ok "wrote $CADDY_SOURCES"
			fi
		else
			printf '  %s$ write %s (deb822, suite any-version)%s\n' "$C_DIM" "$CADDY_SOURCES" "$C_OFF"
		fi

		run apt-get update -qq
		run apt-get install -y caddy
		ok "caddy installed"
	fi

	# The .deb creates /var/log/caddy, but assert it: the Caddyfile writes an
	# access log there and Caddy refuses to start if it cannot.
	run install -d -m 0755 -o caddy -g caddy /var/log/caddy

	# Caddy fetches the *.ts.net certificate over the tailscaled LocalAPI, which
	# is root-only until TS_PERMIT_CERT_UID names the user allowed to ask. Without
	# it Caddy starts normally and then serves no certificate — a failure you find
	# in a browser, not in a log — so assert it here.
	step "tailscale certificate access for caddy"
	if grep -q '^TS_PERMIT_CERT_UID=' /etc/default/tailscaled 2>/dev/null; then
		skip "TS_PERMIT_CERT_UID already set"
	elif [ "$DRY_RUN" -eq 1 ]; then
		printf '  %s$ append TS_PERMIT_CERT_UID=caddy to /etc/default/tailscaled%s\n' "$C_DIM" "$C_OFF"
	else
		cat >> /etc/default/tailscaled <<'TSENV'

# Lets the non-root caddy user fetch this node's Tailscale certificate.
TS_PERMIT_CERT_UID=caddy
TSENV
		run systemctl restart tailscaled
		ok "caddy may now fetch the tailnet certificate"
	fi

	# Caddy binds addresses that do not exist until tailscaled has brought up
	# tailscale0. Ordering alone still races the address assignment, so retry too.
	step "caddy service ordering"
	run install -d -m 0755 /etc/systemd/system/caddy.service.d
	if [ "$DRY_RUN" -eq 0 ]; then
		cat > /etc/systemd/system/caddy.service.d/tailscale.conf <<'DROPIN'
# Caddy binds this box's Tailscale addresses, which do not exist until
# tailscaled has brought up tailscale0. Ordering alone is not enough — the
# address can still be a moment behind the unit — so retry rather than die.
[Unit]
After=tailscaled.service
Wants=tailscaled.service

[Service]
Restart=on-failure
RestartSec=5s
DROPIN
		run systemctl daemon-reload
	fi
	ok "caddy ordered after tailscaled"

	step "Caddyfile for $DOMAIN"

	if [ "$DRY_RUN" -eq 0 ] && cmp -s <(render_to_stdout "$CADDYFILE_SRC") /etc/caddy/Caddyfile; then
		skip "/etc/caddy/Caddyfile already current"
	else
		if [ -f /etc/caddy/Caddyfile ] && [ "$DRY_RUN" -eq 0 ]; then
			backup="/etc/caddy/Caddyfile.$(date -u +%Y%m%dT%H%M%SZ).bak"
			run cp -a /etc/caddy/Caddyfile "$backup"
			ok "previous Caddyfile saved as $backup"
		fi
		run install -d -m 0755 /etc/caddy
		render "$CADDYFILE_SRC" /etc/caddy/Caddyfile 0644 root root

		# Validate before reloading. A bad Caddyfile that is only discovered by
		# `systemctl reload` takes the site down; caught here it takes nothing.
		if [ "$DRY_RUN" -eq 0 ]; then
			caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null \
				|| die "Caddyfile failed validation — /etc/caddy/Caddyfile is in place but NOT loaded"
		fi
		ok "Caddyfile installed and validated"
	fi

	# `caddy validate` actually opens the access log's writer, so running it as
	# root above leaves /var/log/caddy/*.log owned by root — and then the caddy
	# user cannot write to it and the service fails to start. Fix it every time
	# rather than only after a validate; it is cheap and it is a silent failure.
	run chown -R caddy:caddy /var/log/caddy

	run systemctl enable caddy
	if [ "$DRY_RUN" -eq 0 ] && systemctl is-active --quiet caddy; then
		run systemctl reload caddy
		ok "caddy reloaded"
	else
		run systemctl restart caddy
		ok "caddy started"
	fi
	printf '  %sCaddy serves %s on %s, with a certificate from tailscaled.%s\n' "$C_DIM" "$DOMAIN" "$BIND" "$C_OFF"
	printf '  %sWatch it:  journalctl -u caddy -f%s\n' "$C_DIM" "$C_OFF"
fi

# --- 4. firewall -------------------------------------------------------------
# Order matters: allow 22 BEFORE enabling, or `ufw enable` locks this session
# out of the box.

if [ "$SKIP_UFW" -eq 1 ]; then
	step "ufw (skipped)"
else
	step "firewall"

	command -v ufw >/dev/null || run apt-get install -y ufw

	run ufw default deny incoming
	run ufw default allow outgoing
	for port in 22/tcp 80/tcp 443/tcp; do
		if [ "$DRY_RUN" -eq 0 ] && ufw status | grep -q "^${port%%/*}/tcp .*ALLOW"; then
			skip "$port already allowed"
		else
			run ufw allow "$port"
		fi
	done

	# grep -qx against the exact line, NOT `grep -q active`: `ufw status`
	# prints "Status: inactive" when it is off, and "active" is a substring of
	# "inactive", so the loose match reports success and silently skips
	# enabling the firewall.
	if [ "$DRY_RUN" -eq 0 ] && ufw status | head -1 | grep -qx "Status: active"; then
		skip "ufw already active"
	else
		# --force skips the "this may disrupt existing ssh connections" prompt.
		# 22 is allowed above, so it will not.
		run ufw --force enable
		ok "ufw enabled: deny incoming, allow 22/80/443"
	fi
fi

# --- 5. directories and the systemd user unit --------------------------------

step "herdrer directories"

run install -d -m 0755 -o "$APP_USER" -g "$APP_USER" "$USER_HOME/.local" "$USER_HOME/.local/bin"
run install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$USER_HOME/.local/state" "$USER_HOME/.local/state/herdrer"
run install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$USER_HOME/.config" "$USER_HOME/.config/herdrer"
run install -d -m 0755 -o "$APP_USER" -g "$APP_USER" "$USER_HOME/.config/systemd" "$USER_HOME/.config/systemd/user"
ok "$USER_HOME/.local/bin, .local/state/herdrer (0700), .config/herdrer (0700)"

step "systemd user unit"

UNIT_DST="$USER_HOME/.config/systemd/user/herdrer.service"
if [ "$DRY_RUN" -eq 0 ] && cmp -s "$UNIT_SRC" "$UNIT_DST"; then
	skip "$UNIT_DST already current"
else
	render "$UNIT_SRC" "$UNIT_DST" 0644 "$APP_USER" "$APP_USER"
	ok "installed $UNIT_DST"
fi

user_systemctl daemon-reload
user_systemctl enable herdrer.service
ok "herdrer.service enabled (not started — there is no binary yet)"

# --- 6. mise -----------------------------------------------------------------

if [ "$SKIP_MISE" -eq 1 ]; then
	step "mise (skipped)"
else
	step "mise for $APP_USER"

	if [ -x "$USER_HOME/.local/bin/mise" ]; then
		skip "mise already installed ($("$USER_HOME/.local/bin/mise" --version 2>/dev/null | head -1))"
	else
		# The one place this script pipes a vendor script to a shell. It is
		# mise's own official installer over https to mise.run, it installs to
		# ~/.local/bin/mise as an unprivileged user, and it is named here rather
		# than buried so the decision is visible.
		printf '  %s$ runuser -u %s -- sh -c "curl -fsSL https://mise.run | sh"%s\n' "$C_DIM" "$APP_USER" "$C_OFF"
		if [ "$DRY_RUN" -eq 0 ]; then
			runuser -u "$APP_USER" -- env "HOME=$USER_HOME" sh -c 'curl -fsSL https://mise.run | sh' \
				|| warn "mise install failed — not fatal, herdrer does not need it"
		fi
		ok "mise installed to $USER_HOME/.local/bin/mise"
	fi

	# Shell activation is offered, never written silently.
	if [ "$DRY_RUN" -eq 0 ] && ! grep -qs 'mise activate' "$USER_HOME/.bashrc"; then
		printf '  %sTo activate mise for %s, add to %s/.bashrc:%s\n' "$C_DIM" "$APP_USER" "$USER_HOME" "$C_OFF"
		# shellcheck disable=SC2016  # this is literal text for the user to paste
		printf '  %s    eval "$(~/.local/bin/mise activate bash)"%s\n' "$C_DIM" "$C_OFF"
	fi
fi

# --- done --------------------------------------------------------------------

cat <<DONE

$C_BOLD provisioned $C_OFF

  Next, from the Mac checkout:

    mise run deploy                  build linux/amd64, ship it, restart, health-check

  Then, on the box as $APP_USER:

    systemctl --user status herdrer
    journalctl --user -u herdrer -f
    herdrer enroll --label "iPhone"   mint the first passkey registration code

  Verify the edge once herdrer is up:

    curl -fsS https://$DOMAIN/api/v1/health

DONE
