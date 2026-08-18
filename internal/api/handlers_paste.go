package api

import (
	"errors"
	"net/http"

	"github.com/jclement/herdrer/internal/paste"
)

// handlePaste accepts an image from the browser and returns a path to type at
// an agent.
//
// The response is a path on the box, and the client injects it into the PTY as
// if it had been typed. That injection is why this handler is careful about
// what it writes: the path becomes part of a command line in front of an agent
// that may then act on it.
//
// It is safe by construction rather than by filtering. The directory is fixed,
// the basename is server-generated hex, and the extension comes from sniffing
// the bytes against a closed set — no part of the returned path originates with
// the caller, so there is no traversal to block and nothing to escape.
func (s *Server) handlePaste(w http.ResponseWriter, r *http.Request) {
	if !s.terminal.Enabled() {
		Forbidden(w, "the terminal is disabled on this server")
		return
	}
	if s.pastes == nil {
		Internal(w, errors.New("paste store not configured"), "paste")
		return
	}

	// Bound the body independently of the store's own limit, so an oversized
	// upload is refused at the socket rather than after being read.
	r.Body = http.MaxBytesReader(w, r.Body, paste.MaxBytes+1024)

	body := r.Body
	// A browser may send either the raw blob or a multipart form; accept both,
	// since which one you get depends on how the paste was constructed.
	if file, _, err := r.FormFile("image"); err == nil {
		defer file.Close()
		body = file
	}

	path, contentType, size, err := s.pastes.Save(body)
	if err != nil {
		if errors.Is(err, paste.ErrUnsupported) {
			WriteError(w, http.StatusBadRequest, CodeValidation,
				"that does not look like a PNG, JPEG, GIF or WebP")
			return
		}
		WriteError(w, http.StatusBadRequest, CodeValidation, "could not read the image")
		return
	}

	s.audit(r, "paste.saved", path, map[string]any{"type": contentType, "bytes": size})
	WriteJSON(w, http.StatusCreated, map[string]any{
		"path":         path,
		"content_type": contentType,
		"bytes":        size,
	})
}
