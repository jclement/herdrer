#!/bin/sh
#
# assert-spa-embedded.sh — fail the build if internal/webui/dist is not a real
# SPA build. Run as a GoReleaser before-hook, immediately after
# `mise run web:build`.
#
# Why this exists at all: internal/webui/embed.go does `//go:embed all:dist`.
# That directive errors on a *missing* directory but happily embeds an *empty*
# one — and .gitignore deliberately keeps a .keep placeholder in there so a
# fresh clone compiles before anyone has run a web build. So the failure mode
# is not a build error. It is a release that builds green, signs, publishes,
# deploys, and then serves a blank page to a phone on a train.
#
# DESIGN.md §11.13 names this assertion specifically as a thing CI must do.
set -eu

DIST=internal/webui/dist

# A Vite build always emits an index.html; the placeholder path emits nothing.
if [ ! -f "$DIST/index.html" ]; then
	echo "FATAL: $DIST/index.html is missing. The SPA did not build." >&2
	echo "       A binary built now would embed an empty FS and serve a blank page." >&2
	exit 1
fi

# Floor size. Catches a truncated or stub index.html — the real one is ~1.6 KB
# of preload links, the manifest, and the module script tag.
bytes=$(wc -c < "$DIST/index.html" | tr -d " ")
if [ "$bytes" -lt 512 ]; then
	echo "FATAL: $DIST/index.html is only $bytes bytes." >&2
	echo "       That is a placeholder, not a Vite build." >&2
	exit 1
fi

# And the bundle it loads. An index.html with no assets/ is a shell that will
# render nothing — the exact blank page this whole file exists to prevent.
if [ -z "$(ls -A "$DIST/assets" 2>/dev/null)" ]; then
	echo "FATAL: $DIST/assets is missing or empty." >&2
	echo "       index.html has no JS or CSS bundle to load." >&2
	exit 1
fi

assets=$(find "$DIST/assets" -type f | wc -l | tr -d ' ')
echo "SPA embedded: $DIST/index.html ($bytes bytes), $assets asset(s)"
