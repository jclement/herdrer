package api

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jclement/herdrer/internal/auth"
	"github.com/jclement/herdrer/internal/store"
)

type ctxKey int

const (
	ctxUser ctxKey = iota
	ctxSession
	ctxToken
)

// UserFrom returns the authenticated human, or nil.
func UserFrom(ctx context.Context) *store.User {
	u, _ := ctx.Value(ctxUser).(*store.User)
	return u
}

// SessionFrom returns the live session, or nil.
func SessionFrom(ctx context.Context) *store.Session {
	s, _ := ctx.Value(ctxSession).(*store.Session)
	return s
}

// TokenFrom returns the authenticated agent token, or nil.
func TokenFrom(ctx context.Context) *store.APIToken {
	t, _ := ctx.Value(ctxToken).(*store.APIToken)
	return t
}

// securityHeaders sets the headers that apply to every response.
//
// The CSP is restrictive by default and is *not* relaxed for the review
// renderer: agent-authored markdown is rendered inside a sandboxed iframe with
// its own, tighter policy, so the application policy never has to make room
// for it.
func (s *Server) securityHeaders(next http.Handler) http.Handler {
	csp := strings.Join([]string{
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		"connect-src 'self'",
		// The renderer iframe is same-origin-served but sandboxed without
		// allow-same-origin, so it lands in an opaque origin.
		"frame-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	}, "; ")

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=(), usb=()")
		if s.cfg.Secure() {
			h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
		}
		next.ServeHTTP(w, r)
	})
}

// requireSameOrigin rejects any state-changing request that did not originate
// from herdrer's own origin.
//
// This is the CSRF control, and it is an exact string match against the single
// configured origin — not a suffix match, not a registrable-domain match.
// herdrer may share a registrable domain with unrelated services, which makes
// "same-site" far too generous a test: a sibling host is same-site but is not
// us.
func (s *Server) requireSameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		// Bearer-authenticated agents are not browsers and carry no ambient
		// credential, so CSRF does not apply to them; they are identified by a
		// header an attacker's page cannot set cross-origin anyway.
		if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			next.ServeHTTP(w, r)
			return
		}
		if !s.originOK(r.Header.Get("Origin")) {
			s.audit(r, "security.csrf_blocked", "", map[string]any{
				"origin": r.Header.Get("Origin"), "path": r.URL.Path,
			})
			Forbidden(w, "cross-origin request rejected")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// originOK reports whether an Origin header exactly matches ours. An absent
// Origin is rejected: every browser that can run this SPA sends one on
// state-changing fetches, so a missing header is a client we do not serve.
func (s *Server) originOK(origin string) bool {
	if origin == "" {
		return false
	}
	if origin == s.cfg.Origin {
		return true
	}
	// Tolerate a trailing-slash or default-port spelling difference, but
	// nothing else — scheme and host must match exactly.
	a, err1 := url.Parse(origin)
	b, err2 := url.Parse(s.cfg.Origin)
	if err1 != nil || err2 != nil {
		return false
	}
	return a.Scheme == b.Scheme && a.Hostname() == b.Hostname() && portOf(a) == portOf(b)
}

func portOf(u *url.URL) string {
	if p := u.Port(); p != "" {
		return p
	}
	if u.Scheme == "https" {
		return "443"
	}
	return "80"
}

// devUserID is the well-known developer identity used under SUPPRESS_AUTH.
// All-zero so it is unmistakable in a database or an audit log.
const devUserID = "00000000-0000-0000-0000-000000000000"

// requireSession gates the human route tree. Nothing reaches a handler behind
// this middleware without a live session backed by a passkey assertion.
func (s *Server) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.SuppressAuth {
			// Second gate, independent of the first. config.Load already
			// refuses to start with SUPPRESS_AUTH on a non-loopback listener,
			// but the whole point of this branch is that it disables every
			// other check — so it re-verifies the peer here rather than
			// trusting that startup validation was correct. Two independent
			// conditions have to be wrong before this opens a shell.
			if !isLoopbackPeer(r) {
				slog.Error("SUPPRESS_AUTH request from a non-loopback peer, refusing",
					"remote", r.RemoteAddr)
				Unauthorized(w)
				return
			}
			u, err := s.devUser(r.Context())
			if err != nil {
				Internal(w, err, "dev user")
				return
			}
			ctx := context.WithValue(r.Context(), ctxUser, u)
			ctx = context.WithValue(ctx, ctxSession, &store.Session{
				ID: "dev-session", UserID: u.ID,
				// Stamped now, so step-up is satisfied and the terminal is
				// usable in development without an authenticator.
				SteppedUpAt: ptrTime(time.Now()), SteppedUpCred: "dev-credential",
			})
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		sess, u, err := s.auth.SessionFromRequest(r.Context(), r)
		if err != nil {
			Unauthorized(w)
			return
		}
		ctx := context.WithValue(r.Context(), ctxUser, u)
		ctx = context.WithValue(ctx, ctxSession, sess)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// requireToken gates the agent route tree. A session cookie is deliberately
// *not* accepted here: the two trees stay disjoint so that a bug in one cannot
// widen the other.
func (s *Server) requireToken(scope string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t, err := s.auth.TokenFromRequest(r.Context(), r)
			if err != nil {
				s.audit(r, "auth.token_rejected", "", nil)
				Unauthorized(w)
				return
			}
			if scope != "" && !t.HasScope(scope) {
				s.audit(r, "auth.scope_denied", t.ID, map[string]any{"want": scope})
				Forbidden(w, "token lacks the "+scope+" scope")
				return
			}
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				_ = s.st.TouchAPIToken(ctx, t.ID)
			}()
			ctx := context.WithValue(r.Context(), ctxToken, t)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// --- rate limiting -------------------------------------------------------------

type bucket struct {
	tokens float64
	last   time.Time
}

// limiter is a small per-key token bucket. It exists to blunt online guessing
// against the enrollment code and to stop an agent hammering the API, not to
// survive a distributed flood — that is the reverse proxy's job.
type limiter struct {
	mu       sync.Mutex
	buckets  map[string]*bucket
	rate     float64 // tokens per second
	capacity float64
}

func newLimiter(perMinute, burst float64) *limiter {
	return &limiter{buckets: map[string]*bucket{}, rate: perMinute / 60, capacity: burst}
}

// relax removes the limit on an existing limiter, in place.
//
// The middleware closes over the *limiter at construction, so reassigning the
// server's field has no effect — tests must mutate the object the closure
// already holds.
func (l *limiter) relax() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rate = 1e9
	l.capacity = 1e9
	l.buckets = map[string]*bucket{}
}

func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) > 10000 {
			l.buckets = map[string]*bucket{}
		}
		b = &bucket{tokens: l.capacity, last: now}
		l.buckets[key] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.capacity {
		b.tokens = l.capacity
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// rateLimit applies a bucket keyed on client IP.
func (s *Server) rateLimit(l *limiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !l.allow(clientIP(r)) {
				s.audit(r, "security.rate_limited", r.URL.Path, nil)
				w.Header().Set("Retry-After", "30")
				WriteError(w, http.StatusTooManyRequests, CodeRateLimited, "too many requests, slow down")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// chain applies middleware in the order given, outermost first.
func chain(h http.Handler, mw ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mw) - 1; i >= 0; i-- {
		h = mw[i](h)
	}
	return h
}

// isLoopbackPeer reports whether the request came from this machine.
//
// Deliberately reads RemoteAddr and never X-Forwarded-For: a header is
// attacker-controlled, and this is the one check standing between
// SUPPRESS_AUTH and an open shell.
func isLoopbackPeer(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func ptrTime(t time.Time) *time.Time { return &t }

// devUser fetches or creates the well-known development identity.
func (s *Server) devUser(ctx context.Context) (*store.User, error) {
	if u, err := s.st.GetUser(ctx, devUserID); err == nil {
		return u, nil
	}
	u := &store.User{
		ID: devUserID, Handle: "dev", DisplayName: "Developer",
		Role: "admin", CreatedAt: time.Now(),
	}
	if err := s.st.CreateUser(ctx, u); err != nil {
		// A concurrent request may have won the race; re-read before failing.
		if existing, gerr := s.st.GetUser(ctx, devUserID); gerr == nil {
			return existing, nil
		}
		return nil, err
	}
	return u, nil
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	h := r.RemoteAddr
	if i := strings.LastIndexByte(h, ':'); i > 0 {
		h = h[:i]
	}
	return h
}

func (s *Server) audit(r *http.Request, kind, subject string, detail map[string]any) {
	actor := "anon"
	if u := UserFrom(r.Context()); u != nil {
		actor = "user:" + u.ID
	} else if t := TokenFrom(r.Context()); t != nil {
		actor = "token:" + t.ID
	}
	s.st.Audit(r.Context(), store.AuditEntry{
		Actor: actor, Kind: kind, Subject: subject, IP: clientIP(r),
		UserAgent: r.UserAgent(), Detail: detail,
	})
}

var _ = auth.ScopeReviewWrite
