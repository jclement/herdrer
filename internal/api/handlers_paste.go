package api

import (
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"

	"github.com/jclement/herdrer/internal/paste"
)

// multipartFile returns the uploaded file when the request is genuinely
// multipart, and nil otherwise.
//
// Calling r.FormFile unconditionally is a trap: for a non-multipart POST it
// falls through to ParseForm, which *consumes the entire body* trying to parse
// it as urlencoded pairs. A raw `--data-binary @image.png` upload then reaches
// the reader as nothing at all, and the failure surfaces as "that does not look
// like a PNG" — which sends you looking at the image instead of the parser.
func multipartFile(r *http.Request) (multipart.File, bool) {
	ct := r.Header.Get("Content-Type")
	mt, _, err := mime.ParseMediaType(ct)
	if err != nil || !strings.HasPrefix(mt, "multipart/") {
		return nil, false
	}
	file, _, err := r.FormFile("image")
	if err != nil {
		return nil, false
	}
	return file, true
}

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

	// A browser may send either the raw blob or a multipart form; accept both,
	// since which one you get depends on how the paste was constructed.
	var body io.Reader = r.Body
	if file, ok := multipartFile(r); ok {
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
