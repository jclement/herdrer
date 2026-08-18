package api

import (
	"io"
	"io/fs"
	"net/http"
	"regexp"
	"strings"

	"github.com/jclement/herdrer/internal/webui"
)

// spaHandler serves the embedded single-page app.
//
// Static assets are served unauthenticated — they are the login screen and the
// JavaScript that draws it, and gating them would leave nothing to log in
// with. They contain no data: every byte of content in this application comes
// from the API, which is gated.
func (s *Server) spaHandler() http.Handler {
	sub, err := webui.FS()
	if err != nil || !webui.Present() {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(w, placeholderHTML)
		})
	}
	files := http.FileServer(http.FS(sub))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if f, err := sub.(fs.FS).Open(p); err == nil {
			f.Close()
			// Immutable caching is safe only for a filename that changes when
			// its content does. Vite hashes its asset names, so `assets/` is
			// nearly all safe — but not entirely: the mermaid bundle is emitted
			// at a *stable* path on purpose, because the Go renderer injects it
			// by name into the sandboxed document. Serving that one immutable
			// for a year means a fix to it never reaches a returning browser.
			if strings.HasPrefix(p, "assets/") && isContentHashed(p) {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			files.ServeHTTP(w, r)
			return
		}
		// Client-side routing: unknown paths fall through to the app shell so
		// that /r/<id> works on a cold load. Everything that is unambiguously
		// not a route must 404 honestly instead.
		//
		// The asset case is the one that bites. Serving index.html with a 200
		// for a missing /assets/*.js means a renamed or unbuilt bundle arrives
		// at the browser as HTML, and surfaces as "Unexpected token '<'" from
		// somewhere deep in a script — which is a genuinely hard bug to read
		// backwards. The sandboxed mermaid bundle is loaded by absolute path
		// from an opaque origin, where that diagnosis is harder still.
		if isNotARoute(p) {
			WriteError(w, http.StatusNotFound, CodeNotFound, "not found")
			return
		}
		index, err := fs.ReadFile(sub, "index.html")
		if err != nil {
			Internal(w, err, "read index")
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(index)
	})
}

// hashedAsset matches Vite's `name-HASH.ext` output, where the hash is what
// makes the filename safe to cache forever.
var hashedAsset = regexp.MustCompile(`-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$`)

// isContentHashed reports whether a filename changes when its content does.
func isContentHashed(p string) bool {
	return hashedAsset.MatchString(p)
}

// isNotARoute reports whether a path could never be a client-side route, and
// therefore deserves a 404 rather than the app shell.
func isNotARoute(p string) bool {
	switch {
	case strings.HasPrefix(p, "api/"), strings.HasPrefix(p, "ws/"),
		strings.HasPrefix(p, "assets/"), strings.HasPrefix(p, "icons/"):
		return true
	}
	// A path whose last segment carries a file extension is a missing asset,
	// not a route: the SPA's routes are all extensionless.
	last := p
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		last = p[i+1:]
	}
	return strings.Contains(last, ".")
}

const placeholderHTML = `<!doctype html><meta charset="utf-8">
<title>herdrer</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui;max-width:34rem;margin:12vh auto;padding:0 1.5rem;
background:#0d1117;color:#e6edf3}code{background:#161b22;padding:.15em .4em;border-radius:4px}
h1{font-size:1.2rem}</style>
<h1>herdrer is running, but no web build is embedded.</h1>
<p>The API is live. Build the SPA and redeploy:</p>
<p><code>mise run web:build &amp;&amp; mise run deploy</code></p>`
