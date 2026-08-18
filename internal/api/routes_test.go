package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jclement/herdrer/internal/auth"
	"github.com/jclement/herdrer/internal/config"
	"github.com/jclement/herdrer/internal/notify"
	"github.com/jclement/herdrer/internal/paste"
	"github.com/jclement/herdrer/internal/review"
	"github.com/jclement/herdrer/internal/store"
	"github.com/jclement/herdrer/internal/terminal"
)

const testOrigin = "https://herdrer.example.net"

func newTestServer(t *testing.T) (*Server, *store.Store, *store.User) {
	t.Helper()
	dir := t.TempDir()
	cfg := &config.Config{
		Domain: "herdrer.example.net", Origin: testOrigin, Addr: "127.0.0.1:0",
		StateDir: dir, DBPath: filepath.Join(dir, "test.db"),
		VAPIDPath:  filepath.Join(dir, "vapid.json"),
		SessionTTL: time.Hour, EnrollTTL: 15 * time.Minute,
		StepUpWindow: auth.DefaultStepUpWindow,
		LongpollMax:  5 * time.Second, MaxOpenItems: 25,
		DefaultExpiryHours: 24, MaxExpiryHours: 168,
		TerminalEnabled: true, TLSMode: config.TLSOff,
	}
	ctx := context.Background()
	st, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	a, err := auth.New(cfg, st)
	if err != nil {
		t.Fatalf("auth: %v", err)
	}
	nt, err := notify.New(st, cfg.VAPIDPath, cfg.Origin, "", "", "", "")
	if err != nil {
		t.Fatalf("notify: %v", err)
	}
	bus := NewBus()
	rv := review.New(st, nil, bus, 25, 24, 168)
	tm := terminal.New(true, dir)
	ptys := terminal.NewManager(ctx, tm, 2)
	pastes, err := paste.New(dir)
	if err != nil {
		t.Fatalf("paste store: %v", err)
	}
	assets, err := review.NewAssetStore(dir)
	if err != nil {
		t.Fatalf("asset store: %v", err)
	}

	u := &store.User{ID: "user-1", Handle: "jeff", DisplayName: "Jeff", Role: "admin", CreatedAt: time.Now()}
	if err := st.CreateUser(ctx, u); err != nil {
		t.Fatalf("create user: %v", err)
	}
	return NewServer(cfg, st, a, rv, tm, ptys, nt, bus, pastes, assets, "test"), st, u
}

// newTestServerNoUser returns a server on a box that has never been enrolled,
// which is the state the registration ceremony actually runs against.
func newTestServerNoUser(t *testing.T) (*Server, *store.Store, *store.User) {
	t.Helper()
	s, st, _ := newTestServer(t)
	if _, err := st.DB().ExecContext(context.Background(), `DELETE FROM users`); err != nil {
		t.Fatal(err)
	}
	return s, st, nil
}

// route is one endpoint and the principal it must demand.
type route struct {
	method string
	path   string
	// principal is who is allowed: "session", "token", or "open".
	principal string
}

// everyRoute mirrors routes(). A new endpoint must be added here, which is the
// point: the list is the checklist a reviewer reads, and the test below proves
// the checklist matches reality.
var everyRoute = []route{
	{"GET", "/api/v1/auth/state", "open"},
	{"GET", "/api/v1/health", "open"},
	{"POST", "/api/v1/auth/login/begin", "open"},
	{"POST", "/api/v1/auth/login/finish", "open"},
	{"POST", "/api/v1/auth/register/begin", "open"},
	{"POST", "/api/v1/auth/register/finish", "open"},

	{"POST", "/api/v1/auth/logout", "session"},
	{"GET", "/api/v1/me", "session"},
	{"GET", "/api/v1/bootstrap", "session"},
	{"POST", "/api/v1/auth/stepup/begin", "session"},
	{"POST", "/api/v1/auth/stepup/finish", "session"},
	{"GET", "/api/v1/credentials", "session"},
	{"POST", "/api/v1/credentials/abc/terminal", "session"},
	{"DELETE", "/api/v1/credentials/abc", "session"},
	{"POST", "/api/v1/credentials/enroll", "session"},
	{"GET", "/api/v1/sessions", "session"},
	{"DELETE", "/api/v1/sessions/abc", "session"},
	{"POST", "/api/v1/sessions/revoke-all", "session"},
	{"GET", "/api/v1/tokens", "session"},
	{"POST", "/api/v1/tokens", "session"},
	{"DELETE", "/api/v1/tokens/abc", "session"},
	{"GET", "/api/v1/review", "session"},
	{"GET", "/api/v1/review/abc", "session"},
	{"POST", "/api/v1/review/abc/answer", "session"},
	{"DELETE", "/api/v1/review/abc", "session"},
	{"GET", "/api/v1/review/abc/render", "session"},
	{"GET", "/api/v1/tasks", "session"},
	{"POST", "/api/v1/tasks", "session"},
	{"GET", "/api/v1/push/key", "session"},
	{"GET", "/api/v1/push/subscriptions", "session"},
	{"POST", "/api/v1/push/subscribe", "session"},
	{"POST", "/api/v1/push/test", "session"},
	{"GET", "/api/v1/audit", "session"},
	{"GET", "/api/v1/agents", "session"},
	{"GET", "/api/v1/herdr/state", "session"},
	{"POST", "/api/v1/herdr/focus", "session"},
	{"POST", "/api/v1/terminal/ticket", "session"},
	{"POST", "/api/v1/paste", "session"},
	{"POST", "/api/v1/stream/ticket", "session"},

	{"POST", "/api/v1/agent/review", "token"},
	{"POST", "/api/v1/agent/assets", "token"},
	{"GET", "/api/v1/agent/review", "token"},
	{"GET", "/api/v1/agent/review/abc", "token"},
	{"DELETE", "/api/v1/agent/review/abc", "token"},
	{"GET", "/api/v1/agent/tasks/claim", "token"},
	{"POST", "/api/v1/agent/tasks/abc/complete", "token"},
}

func req(method, path string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader("{}"))
	r.Header.Set("Content-Type", "application/json")
	if method != http.MethodGet && method != http.MethodHead {
		r.Header.Set("Origin", testOrigin)
	}
	return r
}

// TestEveryRouteRefusesAnonymous is the load-bearing test in this package.
//
// It asserts that nothing outside the auth ceremony answers an unauthenticated
// caller. A route accidentally registered on the wrong tree is a privilege
// escalation, and this is what catches it.
func TestEveryRouteRefusesAnonymous(t *testing.T) {
	s, _, _ := newTestServer(t)
	for _, rt := range everyRoute {
		if rt.principal == "open" {
			continue
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, req(rt.method, rt.path))
		if w.Code != http.StatusUnauthorized && w.Code != http.StatusForbidden {
			t.Errorf("%s %s: anonymous got %d, want 401 or 403", rt.method, rt.path, w.Code)
		}
	}
}

// TestAgentTokenCannotReachHumanRoutes proves the privilege boundary that the
// whole design rests on: an agent credential must not open a terminal, read
// the audit log, mint another token, or answer its own question.
func TestAgentTokenCannotReachHumanRoutes(t *testing.T) {
	s, st, u := newTestServer(t)
	ctx := context.Background()

	_, secret, err := s.auth.MintToken(ctx, u.ID, "test-agent", []string{
		auth.ScopeReviewWrite, auth.ScopeReviewRead, auth.ScopeTaskClaim, auth.ScopeAgentsRead,
	}, 0)
	if err != nil {
		t.Fatalf("mint token: %v", err)
	}
	_ = st

	for _, rt := range everyRoute {
		if rt.principal != "session" {
			continue
		}
		r := req(rt.method, rt.path)
		r.Header.Set("Authorization", "Bearer "+secret)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized && w.Code != http.StatusForbidden {
			t.Errorf("%s %s: agent token got %d, want 401 or 403 — a token must never "+
				"reach a human route", rt.method, rt.path, w.Code)
		}
	}
}

// TestSessionCannotUseAgentRoutes checks the boundary in the other direction,
// so the two trees stay genuinely disjoint rather than merely differently
// spelled.
func TestSessionCannotUseAgentRoutes(t *testing.T) {
	s, _, u := newTestServer(t)
	cookie := loginAs(t, s, u)

	for _, rt := range everyRoute {
		if rt.principal != "token" {
			continue
		}
		r := req(rt.method, rt.path)
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: session cookie got %d, want 401 — agent routes take tokens only",
				rt.method, rt.path, w.Code)
		}
	}
}

// TestCrossOriginWriteIsRejected covers the case that matters most on a shared
// registrable domain: a sibling host is same-site, so SameSite alone would let
// its requests through. The exact-origin check must not.
func TestCrossOriginWriteIsRejected(t *testing.T) {
	s, _, u := newTestServer(t)
	cookie := loginAs(t, s, u)

	for _, origin := range []string{
		"https://evil.example.net",
		"https://sibling.example.net", // a sibling: same site, different host
		"http://herdrer.example.net",  // right host, wrong scheme
		"https://herdrer.example.net.evil.com",
		"", // absent Origin
	} {
		r := httptest.NewRequest("POST", "/api/v1/tasks", strings.NewReader(`{"body":"x"}`))
		r.Header.Set("Content-Type", "application/json")
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Errorf("origin %q: got %d, want 403", origin, w.Code)
		}
	}
}

// TestSecurityHeaders checks the headers every response carries.
func TestSecurityHeaders(t *testing.T) {
	s, _, _ := newTestServer(t)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/health", nil))

	want := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "strict-origin-when-cross-origin",
	}
	for k, v := range want {
		if got := w.Header().Get(k); got != v {
			t.Errorf("header %s = %q, want %q", k, got, v)
		}
	}
	csp := w.Header().Get("Content-Security-Policy")
	for _, must := range []string{"default-src 'self'", "object-src 'none'", "frame-ancestors 'none'"} {
		if !strings.Contains(csp, must) {
			t.Errorf("CSP %q missing %q", csp, must)
		}
	}
}

// TestHealthLeaksNothing checks that the one unauthenticated informational
// endpoint does not name the running version to an anonymous scanner.
func TestHealthLeaksNothing(t *testing.T) {
	s, _, _ := newTestServer(t)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/health", nil))
	if strings.Contains(w.Body.String(), "test") {
		t.Errorf("health response leaks version: %s", w.Body.String())
	}
}

// loginAs mints a session directly, bypassing the WebAuthn ceremony, which
// cannot be driven from a unit test without an authenticator.
func loginAs(t *testing.T, s *Server, u *store.User) *http.Cookie {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	secret, err := s.auth.IssueSession(context.Background(), w, r, u.ID, "")
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	return &http.Cookie{Name: "__Host-herdrer_session", Value: secret}
}

// TestAgentTokenWorksWithoutOriginHeader guards a real trap in the CSRF
// design.
//
// The origin check rejects state-changing requests that carry no Origin
// header, because every browser sends one. But an agent is curl, or a Go
// client, and sends none — so the check must exempt bearer-authenticated
// callers. Getting this wrong locks out exactly the clients the agent tree
// exists for, and it fails in production rather than in review.
func TestAgentTokenWorksWithoutOriginHeader(t *testing.T) {
	s, _, u := newTestServer(t)
	_, secret, err := s.auth.MintToken(context.Background(), u.ID, "curl", []string{auth.ScopeReviewWrite}, 0)
	if err != nil {
		t.Fatal(err)
	}

	body := `{"title":"Ship it?","kind":"confirm","recommend":"yes"}`
	r := httptest.NewRequest("POST", "/api/v1/agent/review", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+secret)
	// Deliberately no Origin header.
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)

	if w.Code != http.StatusCreated {
		t.Fatalf("agent create got %d, want 201; body: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"id":"rv_`) {
		t.Errorf("response missing an item id: %s", w.Body.String())
	}
}

// TestAgentCannotReadAnotherAgentsItem covers the IDOR that would otherwise let
// one compromised worker read every question on the box.
func TestAgentCannotReadAnotherAgentsItem(t *testing.T) {
	s, _, u := newTestServer(t)
	ctx := context.Background()
	_, secretA, _ := s.auth.MintToken(ctx, u.ID, "agent-a", []string{auth.ScopeReviewWrite, auth.ScopeReviewRead}, 0)
	_, secretB, _ := s.auth.MintToken(ctx, u.ID, "agent-b", []string{auth.ScopeReviewWrite, auth.ScopeReviewRead}, 0)

	r := httptest.NewRequest("POST", "/api/v1/agent/review",
		strings.NewReader(`{"title":"secret","kind":"confirm","recommend":"yes"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+secretA)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("setup create failed: %d %s", w.Code, w.Body.String())
	}
	id := extractID(t, w.Body.String())

	// Agent B, same owner, different token, must not see it.
	r2 := httptest.NewRequest("GET", "/api/v1/agent/review/"+id, nil)
	r2.Header.Set("Authorization", "Bearer "+secretB)
	w2 := httptest.NewRecorder()
	s.ServeHTTP(w2, r2)
	if w2.Code != http.StatusNotFound {
		t.Errorf("agent B read agent A's item: got %d, want 404", w2.Code)
	}
}

func extractID(t *testing.T, body string) string {
	t.Helper()
	i := strings.Index(body, `"id":"`)
	if i < 0 {
		t.Fatalf("no id in %s", body)
	}
	rest := body[i+6:]
	j := strings.IndexByte(rest, '"')
	return rest[:j]
}

// TestTerminalTicketRequiresStepUp is the test for the control that buys back
// what deleting the end-to-end crypto envelope cost.
//
// A fully valid session — the exact thing an attacker gets from a stolen
// cookie — must not be sufficient to open a shell. Only a fresh authenticator
// assertion is.
func TestTerminalTicketRequiresStepUp(t *testing.T) {
	s, st, u := newTestServer(t)
	cookie := loginAs(t, s, u)

	r := req("POST", "/api/v1/terminal/ticket")
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)

	if w.Code != http.StatusForbidden {
		t.Fatalf("terminal ticket with no step-up got %d, want 403", w.Code)
	}
	if !strings.Contains(w.Body.String(), "STEP_UP_REQUIRED") {
		t.Errorf("want a recoverable STEP_UP_REQUIRED code, got %s", w.Body.String())
	}
	_ = st
}

// TestTerminalTicketIssuedAfterStepUp proves the gate opens for the legitimate
// path, so the control above is not simply "terminal is broken".
func TestTerminalTicketIssuedAfterStepUp(t *testing.T) {
	s, st, u := newTestServer(t)
	ctx := context.Background()
	cookie, sessID := loginAsWithID(t, s, u)

	cred := &store.Credential{
		ID: "cred-1", UserID: u.ID, CredID: []byte("raw-1"), PublicKey: []byte("pk"),
		Name: "Laptop", CreatedAt: time.Now(), CanTerminal: true,
	}
	if err := st.AddCredential(ctx, cred); err != nil {
		t.Fatal(err)
	}
	if err := st.MarkSessionSteppedUp(ctx, sessID, cred.ID); err != nil {
		t.Fatal(err)
	}

	r := req("POST", "/api/v1/terminal/ticket")
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("terminal ticket after step-up got %d, want 201; body %s", w.Code, w.Body.String())
	}
}

// TestReviewOnlyCredentialCannotOpenTerminal proves the per-credential flag is
// enforced, not decorative: a phone marked review-only stays review-only even
// holding a valid, freshly stepped-up session.
func TestReviewOnlyCredentialCannotOpenTerminal(t *testing.T) {
	s, st, u := newTestServer(t)
	ctx := context.Background()
	cookie, sessID := loginAsWithID(t, s, u)

	cred := &store.Credential{
		ID: "cred-phone", UserID: u.ID, CredID: []byte("raw-phone"), PublicKey: []byte("pk"),
		Name: "iPhone", CreatedAt: time.Now(), CanTerminal: false,
	}
	if err := st.AddCredential(ctx, cred); err != nil {
		t.Fatal(err)
	}
	if err := st.SetCredentialTerminal(ctx, u.ID, cred.ID, false); err != nil {
		t.Fatal(err)
	}
	if err := st.MarkSessionSteppedUp(ctx, sessID, cred.ID); err != nil {
		t.Fatal(err)
	}

	r := req("POST", "/api/v1/terminal/ticket")
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("review-only credential got %d, want 403; body %s", w.Code, w.Body.String())
	}
}

// TestStepUpExpires checks the window actually closes.
func TestStepUpExpires(t *testing.T) {
	s, st, u := newTestServer(t)
	ctx := context.Background()
	cookie, sessID := loginAsWithID(t, s, u)

	cred := &store.Credential{
		ID: "cred-old", UserID: u.ID, CredID: []byte("raw-old"), PublicKey: []byte("pk"),
		Name: "Laptop", CreatedAt: time.Now(), CanTerminal: true,
	}
	if err := st.AddCredential(ctx, cred); err != nil {
		t.Fatal(err)
	}
	if err := st.MarkSessionSteppedUp(ctx, sessID, cred.ID); err != nil {
		t.Fatal(err)
	}
	// Backdate the assertion past the window.
	stale := time.Now().Add(-2 * auth.DefaultStepUpWindow).Unix()
	if _, err := st.DB().ExecContext(ctx,
		`UPDATE sessions SET stepped_up_at = ? WHERE id = ?`, stale, sessID); err != nil {
		t.Fatal(err)
	}

	r := req("POST", "/api/v1/terminal/ticket")
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("stale step-up got %d, want 403", w.Code)
	}
}

// loginAsWithID is loginAs, also returning the session id so a test can stamp
// step-up state directly.
func loginAsWithID(t *testing.T, s *Server, u *store.User) (*http.Cookie, string) {
	t.Helper()
	c := loginAs(t, s, u)
	return c, store.HashToken(c.Value)
}

// TestMissingAssetIs404NotTheAppShell guards a failure mode that is very hard
// to diagnose from the symptom.
//
// If a missing /assets/*.js returns index.html with a 200, the browser tries to
// parse HTML as JavaScript and reports "Unexpected token '<'" from inside an
// unrelated script. For the mermaid bundle — loaded by absolute path inside an
// opaque-origin sandboxed frame — that diagnosis is worse still. A rename must
// fail as a 404.
func TestMissingAssetIs404NotTheAppShell(t *testing.T) {
	s, _, _ := newTestServer(t)
	for _, p := range []string{
		"/assets/does-not-exist.js",
		"/assets/mermaid-frame.js",
		"/icons/nope.png",
		"/favicon.ico",
		"/r/some-id/thing.js",
	} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest("GET", p, nil))
		if w.Code == http.StatusOK && strings.Contains(w.Header().Get("Content-Type"), "text/html") {
			t.Errorf("%s served the app shell with 200; a missing asset must 404", p)
		}
	}
}

// TestClientRoutesStillFallThrough is the other half: deep links must survive a
// cold load, or every push notification tap lands on a 404.
func TestClientRoutesStillFallThrough(t *testing.T) {
	for _, p := range []string{"/", "/r/rv_abc123", "/agents", "/settings/passkeys"} {
		if isNotARoute(strings.TrimPrefix(p, "/")) {
			t.Errorf("%s was classified as a missing asset; it is a client route", p)
		}
	}
}
