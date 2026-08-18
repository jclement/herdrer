#!/usr/bin/env bash
#
# devbox.sh — install the development toolchain for the user herdrer runs as.
#
# Run this ON the box, as the herdrer user (not root). It is idempotent: every
# step detects what is already there, and re-running it is a no-op plus any
# tool that has since been added to the list.
#
# Everything that can come from mise comes from mise, so the whole toolchain is
# one declarative file (~/.config/mise/config.toml) that can be diffed, version
# pinned and reproduced on another box. The exceptions are called out inline.
#
# Usage:
#   ./devbox.sh                 install everything
#   ./devbox.sh --dry-run       print what would happen
#   ./devbox.sh --no-agents     skip the coding-agent CLIs
#
set -euo pipefail

DRY_RUN=0
WITH_AGENTS=1

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run)   DRY_RUN=1; shift ;;
		--no-agents) WITH_AGENTS=0; shift ;;
		-h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
		*)           echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

if [ "$(id -u)" -eq 0 ]; then
	echo "refusing to run as root: this installs into \$HOME for the herdrer user" >&2
	exit 1
fi

C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$C_BOLD" "$1" "$C_OFF"; }
ok()   { printf '  ok   %s\n' "$1"; }
skip() { printf '  %sskip %s%s\n' "$C_DIM" "$1" "$C_OFF"; }
run()  {
	printf '  %s$ %s%s\n' "$C_DIM" "$*" "$C_OFF"
	[ "$DRY_RUN" -eq 1 ] || "$@"
}

export PATH="$HOME/.local/bin:$PATH"

# --- 1. mise ------------------------------------------------------------------
# mise is the package manager for everything below, so it is the one thing that
# cannot come from mise.

step "mise"
if command -v mise >/dev/null 2>&1; then
	skip "already installed ($(mise --version 2>/dev/null | head -1))"
else
	run sh -c 'curl -fsSL https://mise.run | sh'
	ok "installed"
fi

# --- 2. shell activation ------------------------------------------------------
# Without this, a PTY spawned by herdrer gets ~/.local/bin but none of mise's
# shims, so every tool below would be invisible in the browser terminal.

step "shell activation"
BASHRC="$HOME/.bashrc"
# shellcheck disable=SC2016  # $HOME must stay literal: it is expanded by the
# shell reading .bashrc, not by this script writing it.
ACTIVATE='eval "$($HOME/.local/bin/mise activate bash)"'
if [ -f "$BASHRC" ] && grep -qF 'mise activate bash' "$BASHRC"; then
	skip "mise already activated in .bashrc"
elif [ "$DRY_RUN" -eq 1 ]; then
	printf '  %s$ append mise activation to %s%s\n' "$C_DIM" "$BASHRC" "$C_OFF"
else
	{
		echo ''
		echo '# mise — puts the toolchain below on PATH for interactive shells,'
		echo '# including the PTYs herdrer spawns for the browser terminal.'
		echo "$ACTIVATE"
	} >> "$BASHRC"
	ok "appended to .bashrc"
fi

# --- 3. the toolchain ---------------------------------------------------------
# One declarative file. `mise install` reconciles the box to it.

step "global tool manifest"
MISE_CONFIG="$HOME/.config/mise/config.toml"
if [ "$DRY_RUN" -eq 0 ]; then
	mkdir -p "$(dirname "$MISE_CONFIG")"
	cat > "$MISE_CONFIG" <<'TOOLS'
# Global development toolchain, managed by mise.
#
# Written by herdrer's scripts/devbox.sh. Edit freely — the script rewrites this
# file, so put machine-specific additions in ~/.config/mise/conf.d/ instead,
# which mise merges and the script never touches.
#
# `latest` rather than pins: this is a personal dev box, not a build artifact,
# and a stale toolchain is the more likely problem. Pin anything that bites.

[tools]
# --- runtimes ---------------------------------------------------------------
node   = "latest"     # also the delivery mechanism for the agent CLIs
bun    = "latest"
go     = "latest"
python = "latest"
uv     = "latest"

# --- the tools you actually type -------------------------------------------
ripgrep  = "latest"   # rg
fd       = "latest"
bat      = "latest"
fzf      = "latest"
jq       = "latest"
yq       = "latest"
eza      = "latest"
delta    = "latest"   # git diffs worth reading
zoxide   = "latest"
gh       = "latest"
lazygit  = "latest"
just     = "latest"
direnv   = "latest"
btop     = "latest"

# --- editors ----------------------------------------------------------------
# Both, deliberately: helix is the good-out-of-the-box one for a fresh box with
# no dotfiles, neovim is the one with the muscle memory.
helix  = "latest"
neovim = "latest"
TOOLS
	ok "wrote $MISE_CONFIG"
else
	printf '  %s$ write %s%s\n' "$C_DIM" "$MISE_CONFIG" "$C_OFF"
fi

step "installing tools (this takes a few minutes on a cold box)"
run mise install --yes

# --- 4. herdr -----------------------------------------------------------------
# Not in the mise registry, and its own `herdr update` is the supported path.

step "herdr"
if command -v herdr >/dev/null 2>&1; then
	skip "already installed ($(herdr --version 2>/dev/null | head -1))"
else
	ARCH="$(uname -m)"
	case "$ARCH" in
		x86_64)  HERDR_ASSET=herdr-linux-x86_64 ;;
		aarch64) HERDR_ASSET=herdr-linux-aarch64 ;;
		*)       echo "  no herdr build for $ARCH" >&2; HERDR_ASSET= ;;
	esac
	if [ -n "$HERDR_ASSET" ]; then
		run sh -c "curl -fsSL -o '$HOME/.local/bin/herdr' \
			'https://github.com/herdrdev/herdr/releases/latest/download/$HERDR_ASSET'"
		run chmod +x "$HOME/.local/bin/herdr"
		ok "installed"
	fi
fi

# --- 5. coding agents ---------------------------------------------------------
# npm-delivered, onto mise's node. Kept out of the mise manifest because they
# are updated far more often than anything above and carry their own updaters.

if [ "$WITH_AGENTS" -eq 1 ]; then
	step "coding agents"
	if [ "$DRY_RUN" -eq 1 ]; then
		printf '  %s$ mise exec node -- npm install -g @anthropic-ai/claude-code @openai/codex%s\n' "$C_DIM" "$C_OFF"
	else
		# --location=global installs into mise's node prefix, which is on PATH
		# via the shims, so no sudo and nothing lands in /usr/lib.
		mise exec node -- npm install -g @anthropic-ai/claude-code @openai/codex
		ok "claude and codex installed"
		# shellcheck disable=SC2016  # backticks are prose here, not a subshell.
		printf '  %sBoth need auth on first use: run `claude` and `codex` once.%s\n' "$C_DIM" "$C_OFF"
	fi
fi

# --- 6. git -------------------------------------------------------------------

step "git defaults"
if [ "$DRY_RUN" -eq 0 ]; then
	git config --global --get init.defaultBranch >/dev/null 2>&1 || git config --global init.defaultBranch main
	git config --global --get pull.rebase        >/dev/null 2>&1 || git config --global pull.rebase true
	# delta is installed above; wiring it here is the whole reason to have it.
	git config --global core.pager   "delta"
	git config --global interactive.diffFilter "delta --color-only"
	git config --global delta.navigate true
	ok "init.defaultBranch=main, pull.rebase=true, delta as the pager"
	if ! git config --global --get user.email >/dev/null 2>&1; then
		printf '  %sgit user.name/user.email are NOT set — commits will fail until you set them.%s\n' "$C_DIM" "$C_OFF"
	fi
fi

# --- done ---------------------------------------------------------------------

printf '\n%s toolchain ready %s\n\n' "$C_BOLD" "$C_OFF"
printf '  Open a new shell (or: exec bash -l) so the shims are on PATH, then:\n\n'
printf '    mise ls                 what is installed\n'
printf '    herdr                   start the persistent session\n'
printf '    claude / codex          the agents (auth on first run)\n\n'
