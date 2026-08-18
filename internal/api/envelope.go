// Package api is the HTTP surface. It is deliberately split into two route
// trees that never share middleware: one for humans holding a passkey session,
// one for agents holding a bearer token. See router.go.
package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// Error codes, per house style.
const (
	CodeValidation   = "VALIDATION_ERROR"
	CodeUnauthorized = "UNAUTHORIZED"
	CodeForbidden    = "FORBIDDEN"
	CodeNotFound     = "NOT_FOUND"
	CodeConflict     = "CONFLICT"
	CodeRateLimited  = "RATE_LIMITED"
	CodeInternal     = "INTERNAL_ERROR"
	// CodeStepUpRequired tells the client to run a fresh passkey assertion and
	// retry. It is distinct from FORBIDDEN because it is recoverable: the SPA
	// prompts, the user touches the sensor, the retry succeeds.
	CodeStepUpRequired = "STEP_UP_REQUIRED"
)

type errBody struct {
	Message string `json:"message"`
	Code    string `json:"code"`
}

// Meta accompanies list responses.
type Meta struct {
	Total   int `json:"total"`
	Page    int `json:"page"`
	PerPage int `json:"per_page"`
}

// WriteJSON emits {"data": …}.
func WriteJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if data == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(map[string]any{"data": data}); err != nil {
		slog.Error("write json", "err", err)
	}
}

// WriteList emits {"data": […], "meta": {…}}.
func WriteList(w http.ResponseWriter, status int, data any, meta Meta) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(map[string]any{"data": data, "meta": meta}); err != nil {
		slog.Error("write list", "err", err)
	}
}

// WriteError emits {"error": {message, code}}.
//
// Messages are written for a human reading a phone, not for a debugger: they
// never contain a stack trace, a SQL fragment, a file path, or any hint about
// which of several checks failed.
func WriteError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": errBody{Message: msg, Code: code}})
}

// Unauthorized is the single response for every failed authentication, whatever
// the underlying cause. A caller must not be able to tell a missing cookie from
// an expired one, or an unknown token from a revoked one.
func Unauthorized(w http.ResponseWriter) {
	WriteError(w, http.StatusUnauthorized, CodeUnauthorized, "authentication required")
}

// Forbidden is returned when a valid principal lacks the privilege.
func Forbidden(w http.ResponseWriter, msg string) {
	if msg == "" {
		msg = "not permitted"
	}
	WriteError(w, http.StatusForbidden, CodeForbidden, msg)
}

// Internal logs the real error and returns a blank one.
func Internal(w http.ResponseWriter, err error, where string) {
	slog.Error("internal error", "where", where, "err", err)
	WriteError(w, http.StatusInternalServerError, CodeInternal, "something went wrong")
}

// DecodeJSON reads a bounded JSON body, rejecting unknown fields so a typo in
// an agent's request surfaces as an error rather than a silently ignored field.
func DecodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	const maxBody = 4 << 20 // 4 MiB: review documents carry diffs
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		WriteError(w, http.StatusBadRequest, CodeValidation, "request body is not valid JSON for this endpoint")
		return false
	}
	return true
}
