package api

import (
	"io"
	"io/fs"
	"net/http"
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
			// Hashed asset filenames are immutable; index.html must not be,
			// or a deploy leaves phones on the previous build indefinitely.
			if strings.HasPrefix(p, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			files.ServeHTTP(w, r)
			return
		}
		// Client-side routing: unknown paths fall through to the app shell,
		// except API and socket paths, which must 404 honestly.
		if strings.HasPrefix(p, "api/") || strings.HasPrefix(p, "ws/") {
			WriteError(w, http.StatusNotFound, CodeNotFound, "no such endpoint")
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

const placeholderHTML = `<!doctype html><meta charset="utf-8">
<title>herdrer</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui;max-width:34rem;margin:12vh auto;padding:0 1.5rem;
background:#0d1117;color:#e6edf3}code{background:#161b22;padding:.15em .4em;border-radius:4px}
h1{font-size:1.2rem}</style>
<h1>herdrer is running, but no web build is embedded.</h1>
<p>The API is live. Build the SPA and redeploy:</p>
<p><code>mise run web:build &amp;&amp; mise run deploy</code></p>`
