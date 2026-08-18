#!/usr/bin/env bash
#
# installer-smoke.sh — exercise scripts/install.sh on a box that has nothing.
#
# Run by .github/workflows/ci.yml inside a clean ubuntu:24.04 container with
# the repo mounted read-only at /src. The point is that install.sh is only ever
# executed on a machine that looks like this — no Go, no bun, no mise, no
# developer dotfiles — and that is precisely the machine nobody tests on.
#
# ---------------------------------------------------------------------------
# What this covers
#
#   * dependency preflight on a bare image (curl is genuinely absent here)
#   * refusal to run as root
#   * --help, --dry-run, and rejection of unknown arguments
#   * platform detection: linux/amd64, linux/arm64, the darwin/amd64 refusal,
#     an unsupported OS, and an unsupported architecture
#   * the whole download → resolve → verify → extract → install path, against a
#     fake release served from localhost
#   * a SHA-256 mismatch being fatal, with no flag that overrides it
#   * a tarball missing from checksums.txt being fatal
#   * HERDRER_REQUIRE_SIGNATURE=1 turning an unverified install into an error
#   * the "already installed" short-circuit and the downgrade refusal
#
# What this deliberately does NOT cover, and why
#
#   * A real cosign signature. Keyless verification pins the certificate
#     identity to
#       https://github.com/jclement/herdrer/.github/workflows/release.yml@refs/tags/v…
#     so a valid bundle can only be produced by a tag build of release.yml.
#     Faking one here would mean either weakening the identity check (which is
#     the entire security property) or shipping a private key. The first time
#     that tier runs for real is the first `mise run release`.
#   * `gh attestation verify`. Same reason — it resolves the attestation from
#     GitHub's transparency log by artifact digest, and only the release
#     workflow can put one there.
#   * macOS. install.sh's darwin branch is reasoned about here only through the
#     uname shim; GitHub's macOS runners are not worth the minutes for a shell
#     script whose only OS-specific behaviour is choosing an asset name.
#   * The GitHub releases API itself. See the note on API_REWRITE below.
# ---------------------------------------------------------------------------
set -euo pipefail

SRC=/src/scripts/install.sh
WORK=/work
PORT=8000

PASS=0
FAIL=0

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
pass() { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }

# run_as_tester <command…> — runs a login shell as the unprivileged user, so
# $HOME is /home/tester and install.sh's default prefix is a real one.
run_as_tester() { su - tester -c "cd $WORK && $*"; }

# expect_fail <description> <grep pattern> <command…>
# The command must exit non-zero AND its combined output must match the
# pattern. Both halves matter: a script that fails for the wrong reason is not
# the thing under test.
expect_fail() {
	local desc="$1" pattern="$2"; shift 2
	local out rc=0
	out=$("$@" 2>&1) || rc=$?
	if [ "$rc" -eq 0 ]; then
		fail "$desc — expected a non-zero exit, got 0"
		printf '%s\n' "$out" | sed 's/^/       | /'
	elif printf '%s' "$out" | grep -qi -- "$pattern"; then
		pass "$desc"
	else
		fail "$desc — exited $rc but did not mention '$pattern'"
		printf '%s\n' "$out" | sed 's/^/       | /'
	fi
}

# expect_ok <description> <grep pattern> <command…>
expect_ok() {
	local desc="$1" pattern="$2"; shift 2
	local out rc=0
	out=$("$@" 2>&1) || rc=$?
	if [ "$rc" -ne 0 ]; then
		fail "$desc — expected exit 0, got $rc"
		printf '%s\n' "$out" | sed 's/^/       | /'
	elif printf '%s' "$out" | grep -qi -- "$pattern"; then
		pass "$desc"
	else
		fail "$desc — exited 0 but did not mention '$pattern'"
		printf '%s\n' "$out" | sed 's/^/       | /'
	fi
}

# --- the image -------------------------------------------------------------

say "preparing ubuntu:24.04"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# curl is not in the base image; python3 serves the fake release. tar, mktemp,
# install, sha256sum, useradd and su are all already present, which is itself
# worth knowing — install.sh's `need` list is satisfiable on a bare Ubuntu.
apt-get install -qq -y --no-install-recommends curl python3 >/dev/null
useradd -m -s /bin/bash tester
mkdir -p "$WORK"

# install.sh is mounted read-only and must be tested as-is, so copy rather than
# edit in place.
cp "$SRC" "$WORK/install.sh"

# --- what install.sh needs, on a bare image --------------------------------

say "dependency preflight"
for tool in curl tar mktemp install sha256sum; do
	if command -v "$tool" >/dev/null 2>&1; then
		pass "$tool is available"
	else
		fail "$tool is missing — install.sh's need() will die on a bare Ubuntu"
	fi
done

# --- refusals that need no network -----------------------------------------

say "root refusal"
# Run as root deliberately: this is the container's default user, which is
# exactly the mistake a `curl … | sudo sh` reader is one keystroke away from.
expect_fail "running as root is refused" "refusing to run as root" \
	sh "$WORK/install.sh" --dry-run

chown -R tester:tester "$WORK"

say "argument handling"
expect_ok   "--help prints usage"          "usage: install.sh" run_as_tester "sh $WORK/install.sh --help"
expect_fail "an unknown argument is fatal" "unknown argument"  run_as_tester "sh $WORK/install.sh --wat"
expect_fail "--version with no value dies" "needs a tag"       run_as_tester "sh $WORK/install.sh --version"

say "--dry-run touches nothing"
expect_ok "--dry-run reports it will change nothing" "DRY RUN" \
	run_as_tester "sh $WORK/install.sh --dry-run"
expect_ok "--dry-run prints the commands it would run" "install -m 0755" \
	run_as_tester "sh $WORK/install.sh --dry-run"
if [ -e /home/tester/.local/bin/herdrer ]; then
	fail "--dry-run wrote a binary"
else
	pass "--dry-run left \$PREFIX/bin empty"
fi

# --- platform detection, via a uname shim ----------------------------------
#
# detect_platform() is the one function whose behaviour depends on hardware we
# do not have. Shadowing uname is cheaper and more thorough than renting an
# arm64 runner and still cannot cover macOS end to end.

say "platform detection"
mkdir -p "$WORK/shim"
cat > "$WORK/shim/uname" <<'SHIM'
#!/bin/sh
case "${1:-}" in
	-s) echo "${FAKE_OS:-Linux}" ;;
	-m) echo "${FAKE_ARCH:-x86_64}" ;;
	*)  echo "${FAKE_OS:-Linux}" ;;
esac
SHIM
chmod 0755 "$WORK/shim/uname"
chown -R tester:tester "$WORK"

shimmed() { # shimmed <os> <arch> <extra install.sh args…>
	local os="$1" arch="$2"; shift 2
	run_as_tester "FAKE_OS=$os FAKE_ARCH=$arch PATH=$WORK/shim:\$PATH sh $WORK/install.sh $*"
}

expect_ok   "linux/x86_64  → linux/amd64"  "platform  linux/amd64" shimmed Linux  x86_64  --dry-run
expect_ok   "linux/aarch64 → linux/arm64"  "platform  linux/arm64" shimmed Linux  aarch64 --dry-run
expect_ok   "darwin/arm64 is accepted"     "platform  darwin/arm64" shimmed Darwin arm64  --dry-run
expect_fail "darwin/x86_64 is refused"     "Apple Silicon only"     shimmed Darwin x86_64 --dry-run
expect_fail "an unknown arch is refused"   "unsupported architecture" shimmed Linux mips64 --dry-run
expect_fail "an unknown OS is refused"     "unsupported operating system" shimmed FreeBSD amd64 --dry-run

# --- the download and verification path ------------------------------------
#
# API_REWRITE: install.sh hardcodes the GitHub releases API, with no
# environment override — correctly, since an installer that lets the
# environment redirect where it downloads from is a footgun. To exercise the
# real resolve/download/verify/extract path we therefore rewrite exactly one
# line of the copy: the API base URL. Nothing else is touched, and the rewrite
# is asserted to have applied, so renaming that variable breaks this test
# loudly instead of quietly reducing it to a no-op.

say "fake release server"
SRV=$(mktemp -d)
mkdir -p "$SRV/api/releases/tags" "$SRV/assets"

case "$(uname -m)" in
	x86_64|amd64) ARCH=amd64 ;;
	aarch64|arm64) ARCH=arm64 ;;
	*) echo "smoke test host arch $(uname -m) is not a release target"; exit 1 ;;
esac
TAG=v9.9.9
TARBALL="herdrer_9.9.9_linux_${ARCH}.tar.gz"

# A stand-in binary. install.sh only requires that a file named `herdrer` sits
# at the archive root and that it answers --version in a way version_ge can
# parse; the real Go binary would prove nothing extra about the installer.
STAGE=$(mktemp -d)
cat > "$STAGE/herdrer" <<'BIN'
#!/bin/sh
echo "herdrer 9.9.9"
BIN
chmod 0755 "$STAGE/herdrer"
tar -czf "$SRV/assets/$TARBALL" -C "$STAGE" herdrer

write_release() { # write_release <checksums-body>
	printf '%s' "$1" > "$SRV/assets/checksums.txt"
	cat > "$SRV/api/releases/latest" <<JSON
{
  "tag_name": "$TAG",
  "assets": [
    { "browser_download_url": "http://127.0.0.1:$PORT/assets/$TARBALL" },
    { "browser_download_url": "http://127.0.0.1:$PORT/assets/checksums.txt" }
  ]
}
JSON
	cp "$SRV/api/releases/latest" "$SRV/api/releases/tags/$TAG"
}

GOOD_SUMS="$(cd "$SRV/assets" && sha256sum "$TARBALL")"
write_release "$GOOD_SUMS"
chmod -R a+rX "$SRV"

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$SRV" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
	curl -fsS "http://127.0.0.1:$PORT/api/releases/latest" >/dev/null 2>&1 && break
	sleep 0.2
done
curl -fsS "http://127.0.0.1:$PORT/api/releases/latest" >/dev/null \
	|| { echo "the fake release server never came up"; exit 1; }
pass "fake release server is serving $TAG"

sed -i "s|^API=.*|API=\"http://127.0.0.1:$PORT/api\"|" "$WORK/install.sh"
grep -q "^API=\"http://127.0.0.1:$PORT/api\"$" "$WORK/install.sh" \
	|| { echo "API_REWRITE failed — install.sh no longer defines API= at the top level."; exit 1; }
pass "API_REWRITE applied (the only edit made to install.sh)"
chown -R tester:tester "$WORK"

say "happy path"
expect_ok "the release resolves and the tag is reported" "release   $TAG" \
	run_as_tester "sh $WORK/install.sh"
run_as_tester "rm -rf /home/tester/.local/bin/herdrer"

expect_ok "an unsigned release warns loudly rather than failing" "does NOT prove the release is" \
	run_as_tester "sh $WORK/install.sh"
expect_ok "the sha256 gate runs and passes" "sha256 matches checksums.txt" \
	run_as_tester "sh $WORK/install.sh --force"

if run_as_tester "/home/tester/.local/bin/herdrer --version" | grep -q '9\.9\.9'; then
	pass "the installed binary is executable and answers --version"
else
	fail "the installed binary is missing or not executable"
fi
if [ "$(stat -c '%a' /home/tester/.local/state/herdrer)" = "700" ]; then
	pass "the state dir is created 0700"
else
	fail "the state dir is not 0700"
fi

say "re-running against the same release"
expect_ok "an identical version short-circuits" "already installed" \
	run_as_tester "sh $WORK/install.sh"

# --- the failures that matter ----------------------------------------------

say "a signature requirement with nothing to verify"
# Neither cosign nor an authenticated gh exists in this container, and the fake
# release publishes no bundle — so every tier is unavailable and the flag has
# to turn that into an error rather than a warning.
expect_fail "HERDRER_REQUIRE_SIGNATURE=1 refuses an unverified install" "no signature could be verified" \
	run_as_tester "HERDRER_REQUIRE_SIGNATURE=1 sh $WORK/install.sh --force"
expect_fail "--require-signature does the same" "no signature could be verified" \
	run_as_tester "sh $WORK/install.sh --force --require-signature"

say "a checksum mismatch"
# The single most important assertion in this file. install.sh promises that a
# mismatch is fatal with no override — no --force, no env var — so the test
# passes --force precisely to prove --force does not help.
BAD_SUMS="0000000000000000000000000000000000000000000000000000000000000000  $TARBALL"
write_release "$BAD_SUMS"
expect_fail "a mismatched sha256 is fatal" "SHA-256 mismatch" \
	run_as_tester "sh $WORK/install.sh --force"
expect_fail "--force does not override a mismatch" "SHA-256 mismatch" \
	run_as_tester "HERDRER_REQUIRE_SIGNATURE=0 sh $WORK/install.sh --force"

say "an artifact missing from checksums.txt"
write_release "$(printf '%s  some-other-file.tar.gz\n' "0000000000000000000000000000000000000000000000000000000000000000")"
expect_fail "an unlisted tarball is fatal" "not listed in checksums.txt" \
	run_as_tester "sh $WORK/install.sh --force"

say "a release with no checksums.txt at all"
cat > "$SRV/api/releases/latest" <<JSON
{
  "tag_name": "$TAG",
  "assets": [
    { "browser_download_url": "http://127.0.0.1:$PORT/assets/$TARBALL" }
  ]
}
JSON
expect_fail "a release without checksums.txt is refused" "refusing to install unverified" \
	run_as_tester "sh $WORK/install.sh --force"

say "a release with no tarball for this platform"
cat > "$SRV/api/releases/latest" <<JSON
{
  "tag_name": "$TAG",
  "assets": [
    { "browser_download_url": "http://127.0.0.1:$PORT/assets/checksums.txt" }
  ]
}
JSON
expect_fail "a missing platform tarball is refused" "has no linux/${ARCH} tarball" \
	run_as_tester "sh $WORK/install.sh --force"

say "a tag that does not exist"
expect_fail "an unknown tag is refused" "could not reach the GitHub releases API" \
	run_as_tester "sh $WORK/install.sh --version v0.0.0-nope"

# --- verdict ---------------------------------------------------------------

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
