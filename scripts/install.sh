#!/bin/sh
#
# install.sh — install the herdrer binary into ~/.local/bin.
#
#   curl -fsSL https://herdrer.jclem.dev/install.sh | sh
#
# or, if you would rather read it first (recommended, it is short):
#
#   curl -fsSL https://herdrer.jclem.dev/install.sh -o install.sh
#   less install.sh
#   sh install.sh
#
# This is the *client* installer — it puts the binary on a machine. Setting up
# the Hetzner box is scripts/provision.sh plus scripts/deploy.sh, not this.
#
# Design notes, because they are the reason this file is shaped the way it is:
#
#   * Every statement at the top level is either a function definition or the
#     final `main "$@"`. A download truncated anywhere defines some functions
#     and exits having done nothing, rather than running half an install.
#   * `set -eu`, not `set -o pipefail`: pipefail is not POSIX and the shebang
#     here is /bin/sh, which is dash on Debian and Ubuntu.
#   * It never pipes another script into a shell. If it wants cosign, it prints
#     the command for you to run.
#   * It never edits a shell rc file. If ~/.local/bin is not on PATH it prints
#     the exact line to add and stops there.
#   * It does not start anything. Writing a unit and starting a service that
#     will mint an enrollment token is a decision, not a side effect.
#
# Assumes: curl, tar, mktemp, install, and one of sha256sum / shasum.
#
set -eu
IFS=' 	
'

REPO="jclement/herdrer"
API="https://api.github.com/repos/$REPO"

# Set by main() from flags and environment.
VERSION=""
PREFIX=""
DRY_RUN=0
FORCE=0
REQUIRE_SIGNATURE=0
TMP=""

# --- output ------------------------------------------------------------------

if [ -t 1 ]; then
	C_BOLD=$(printf '\033[1m'); C_DIM=$(printf '\033[2m')
	C_GRN=$(printf '\033[32m'); C_YEL=$(printf '\033[33m')
	C_RED=$(printf '\033[31m'); C_OFF=$(printf '\033[0m')
else
	C_BOLD=""; C_DIM=""; C_GRN=""; C_YEL=""; C_RED=""; C_OFF=""
fi

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
die()  { printf '\n%serror%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }
cmd()  { printf '  %s$ %s%s\n' "$C_DIM" "$*" "$C_OFF"; }

usage() {
	cat <<USAGE
usage: install.sh [options]

  --version TAG         install a specific release, e.g. v1.2.0
                        (env: HERDRER_VERSION)
  --prefix DIR          install root; binary goes in DIR/bin
                        (default: \$HOME/.local, env: HERDRER_PREFIX)
  --require-signature   fail instead of falling back to a bare checksum
                        (env: HERDRER_REQUIRE_SIGNATURE=1)
  --force               install even if an equal or newer version is present
  --dry-run             print every command and change nothing
  -h, --help            this
USAGE
}

cleanup() {
	[ -n "$TMP" ] && [ -d "$TMP" ] && rm -rf "$TMP"
	return 0
}

need() {
	command -v "$1" >/dev/null 2>&1 || die "$1 is required and was not found on PATH"
}

# sha256 of $1, on the one line, whichever tool this box has.
sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

# Pull "value" out of "key": "value" in a JSON blob on stdin. Enough for the
# two fields this script needs, and avoids requiring jq on a bare box.
json_strings() {
	grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | sed 's/.*: *"\(.*\)"/\1/'
}

# 0 if $1 >= $2 as semver-ish strings. Falls back to equality when sort -V is
# unavailable, which errs towards installing rather than towards refusing.
version_ge() {
	[ "$1" = "$2" ] && return 0
	if printf 'x' | sort -V >/dev/null 2>&1; then
		[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]
	else
		return 1
	fi
}

detect_platform() {
	os=$(uname -s)
	arch=$(uname -m)
	case "$os" in
		Linux)  os=linux ;;
		Darwin) os=darwin ;;
		*) die "unsupported operating system: $os (herdrer ships linux and macOS only)" ;;
	esac
	case "$arch" in
		x86_64|amd64) arch=amd64 ;;
		aarch64|arm64) arch=arm64 ;;
		*) die "unsupported architecture: $arch" ;;
	esac
	if [ "$os" = darwin ] && [ "$arch" != arm64 ]; then
		die "macOS builds are Apple Silicon only; there is no darwin/amd64 release"
	fi
	printf '%s %s\n' "$os" "$arch"
}

# --- verification ------------------------------------------------------------
# Three tiers, in descending order of what they actually prove. The tier that
# runs is printed, always, so an unverified install is never a silent one.

verify_signature() {
	checksums="$1"
	bundle="$2"
	tarball="$3"

	if command -v cosign >/dev/null 2>&1 && [ -s "$bundle" ]; then
		say "verifying the Sigstore bundle with cosign"
		# Both --certificate-identity(-regexp) and --certificate-oidc-issuer are
		# mandatory for keyless flows. Without them this would only prove that
		# *somebody* signed the file, which is worth nothing.
		if cosign verify-blob \
			--bundle "$bundle" \
			--certificate-oidc-issuer https://token.actions.githubusercontent.com \
			--certificate-identity-regexp "^https://github\\.com/$REPO/\\.github/workflows/release\\.yml@refs/tags/v" \
			"$checksums" >/dev/null 2>&1
		then
			ok "signature verified (cosign, keyless, GitHub Actions identity)"
			return 0
		fi
		die "cosign could not verify $bundle — refusing to install. This is either a
       tampered release or a signing-identity change; check the release page."
	fi

	if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
		say "verifying the GitHub build provenance attestation with gh"
		if gh attestation verify "$tarball" --repo "$REPO" >/dev/null 2>&1; then
			ok "attestation verified (gh, GitHub artifact attestation)"
			return 0
		fi
		warn "gh attestation verify failed for this artifact."
		warn "That may mean the release predates attestations rather than that it is bad."
		return 1
	fi

	return 1
}

warn_unverified() {
	warn "Signature not verified: neither cosign nor an authenticated gh is installed."
	warn "The SHA-256 matched checksums.txt from the same release, which proves the"
	warn "download was not corrupted in transit. It does NOT prove the release is"
	warn "authentic — the same server served both files."
	warn ""
	warn "To verify properly, install cosign and re-run:"
	warn "    mise use -g cosign@latest       # if mise is installed — verified download"
	warn "    # or see https://docs.sigstore.dev/system_config/installation/"
	warn ""
	warn "To refuse an unverified install:  HERDRER_REQUIRE_SIGNATURE=1"
}

# --- main --------------------------------------------------------------------

main() {
	VERSION="${HERDRER_VERSION:-}"
	PREFIX="${HERDRER_PREFIX:-$HOME/.local}"
	case "${HERDRER_REQUIRE_SIGNATURE:-0}" in 1|true|yes) REQUIRE_SIGNATURE=1 ;; esac

	while [ $# -gt 0 ]; do
		case "$1" in
			--version) VERSION="${2:?--version needs a tag}"; shift 2 ;;
			--prefix)  PREFIX="${2:?--prefix needs a directory}"; shift 2 ;;
			--require-signature) REQUIRE_SIGNATURE=1; shift ;;
			--force)   FORCE=1; shift ;;
			--dry-run) DRY_RUN=1; shift ;;
			-h|--help) usage; exit 0 ;;
			*) usage >&2; die "unknown argument: $1" ;;
		esac
	done

	# --- preflight -----------------------------------------------------------

	if [ "$(id -u)" -eq 0 ]; then
		die "refusing to run as root. herdrer installs to \$HOME/.local/bin and runs
       as your own user — it has to, because it opens herdr's 0600 socket and
       spawns your shells. Re-run as the user who will use it."
	fi

	need curl
	need tar
	need mktemp
	need install
	if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
		die "need sha256sum or shasum to verify the download"
	fi

	platform=$(detect_platform)
	os=${platform% *}
	arch=${platform#* }

	printf '\n%sherdrer installer%s\n' "$C_BOLD" "$C_OFF"
	say "platform  $os/$arch"
	say "prefix    $PREFIX"
	[ "$DRY_RUN" -eq 1 ] && printf '  %sDRY RUN — nothing will be downloaded or written%s\n' "$C_YEL" "$C_OFF"

	# --- resolve the release -------------------------------------------------

	if [ -n "$VERSION" ]; then
		release_url="$API/releases/tags/$VERSION"
	else
		release_url="$API/releases/latest"
	fi

	if [ "$DRY_RUN" -eq 1 ]; then
		cmd "curl -fsSL $release_url"
		cmd "download <project>_<version>_${os}_${arch}.tar.gz, checksums.txt, checksums.txt.sigstore.json"
		cmd "verify (cosign > gh attestation > sha256 with a warning)"
		cmd "install -m 0755 herdrer $PREFIX/bin/herdrer"
		printf '\n'
		exit 0
	fi

	release=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$release_url") \
		|| die "could not reach the GitHub releases API. Offline, rate-limited, or the tag does not exist."

	tag=$(printf '%s' "$release" | json_strings tag_name | head -1)
	[ -n "$tag" ] || die "no tag_name in the release response"
	say "release   $tag"

	# Asset names are derived from the response, never constructed here: the
	# script is served from tip-of-main and must keep working against both the
	# newest release and the one before it.
	urls=$(printf '%s' "$release" | json_strings browser_download_url)

	tar_url=$(printf '%s\n' "$urls" | grep -i "_${os}_${arch}\.tar\.gz$" | head -1)
	[ -n "$tar_url" ] || die "release $tag has no ${os}/${arch} tarball"
	sums_url=$(printf '%s\n' "$urls" | grep -i 'checksums\.txt$' | head -1)
	[ -n "$sums_url" ] || die "release $tag has no checksums.txt — refusing to install unverified"
	bundle_url=$(printf '%s\n' "$urls" | grep -i 'checksums\.txt\.sigstore\.json$' | head -1)

	# --- already installed? --------------------------------------------------

	if [ "$FORCE" -eq 0 ] && command -v herdrer >/dev/null 2>&1; then
		installed=$(herdrer --version 2>/dev/null | tr ' ' '\n' | grep -m1 '^v\?[0-9]' || true)
		if [ -n "$installed" ]; then
			case "$installed" in v*) ;; *) installed="v$installed" ;; esac
			if [ "$installed" = "$tag" ]; then
				ok "herdrer $tag is already installed at $(command -v herdrer)"
				exit 0
			fi
			if version_ge "$installed" "$tag"; then
				die "installed herdrer $installed is newer than $tag. Use --force to downgrade."
			fi
			say "upgrading  $installed → $tag"
		fi
	fi

	# --- download ------------------------------------------------------------

	TMP=$(mktemp -d "${TMPDIR:-/tmp}/herdrer-install.XXXXXX")
	trap cleanup EXIT INT TERM

	tarball="$TMP/$(basename "$tar_url")"
	checksums="$TMP/checksums.txt"
	bundle="$TMP/checksums.txt.sigstore.json"

	curl -fsSL -o "$tarball" "$tar_url"   || die "download failed: $tar_url"
	curl -fsSL -o "$checksums" "$sums_url" || die "download failed: $sums_url"
	if [ -n "$bundle_url" ]; then
		curl -fsSL -o "$bundle" "$bundle_url" || warn "could not fetch the signature bundle"
	fi
	ok "downloaded $(basename "$tarball")"

	# --- verify --------------------------------------------------------------

	if verify_signature "$checksums" "$bundle" "$tarball"; then
		: # checksums.txt is now authenticated; the sha check below is the real gate
	elif [ "$REQUIRE_SIGNATURE" -eq 1 ]; then
		die "no signature could be verified and --require-signature was given.
       Install cosign (mise use -g cosign@latest) and try again."
	else
		warn_unverified
	fi

	# The checksum comparison runs in every tier, and a mismatch is fatal with
	# no override — no flag, no env var, no --force. If these two hashes differ
	# the bytes on this disk are not the bytes the release lists.
	want=$(grep -i " \*\{0,1\}$(basename "$tarball")\$" "$checksums" | cut -d' ' -f1 | head -1)
	[ -n "$want" ] || die "$(basename "$tarball") is not listed in checksums.txt"
	got=$(sha256_of "$tarball")
	if [ "$want" != "$got" ]; then
		die "SHA-256 mismatch — refusing to install.
       expected $want
       got      $got"
	fi
	ok "sha256 matches checksums.txt"

	# --- install -------------------------------------------------------------

	tar -xzf "$tarball" -C "$TMP" || die "could not extract $(basename "$tarball")"
	[ -f "$TMP/herdrer" ] || die "no 'herdrer' binary inside the archive"

	mkdir -p "$PREFIX/bin"
	install -m 0755 "$TMP/herdrer" "$PREFIX/bin/herdrer" \
		|| die "could not write $PREFIX/bin/herdrer"
	ok "installed  $PREFIX/bin/herdrer"

	# State lives here whatever else happens; 0700 because it will hold the
	# database, the VAPID keypair and session material.
	mkdir -p "$HOME/.local/state/herdrer" "$HOME/.config/herdrer"
	chmod 0700 "$HOME/.local/state/herdrer" "$HOME/.config/herdrer"
	ok "state dir  $HOME/.local/state/herdrer (0700)"

	# --- next steps ----------------------------------------------------------

	printf '\n%snext%s\n' "$C_BOLD" "$C_OFF"

	case ":$PATH:" in
		*":$PREFIX/bin:"*) ;;
		*)
			warn "$PREFIX/bin is not on your PATH. Add this to your shell rc yourself —"
			warn "this script does not edit rc files:"
			# shellcheck disable=SC2016  # literal text for the user to paste into an rc file
			printf '\n      export PATH="%s/bin:$PATH"\n\n' "$PREFIX"
			;;
	esac

	cat <<NEXT
  herdrer --version                    confirm the install
  herdrer serve                        run it in the foreground to try it out

  For a real server, herdrer wants a systemd user unit, a reverse proxy that
  terminates TLS, and linger enabled. The repo's deploy/ and scripts/ directories
  hold a working example of all three:
      https://github.com/$REPO/tree/main/scripts

  Nothing has been started and no service has been installed. Starting herdrer
  mints a one-time enrollment token for the first passkey; that should happen
  when you are ready to scan it, not as a side effect of installing.

NEXT
}

main "$@"
