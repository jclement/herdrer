package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/jclement/herdrer/internal/auth"
	"github.com/jclement/herdrer/internal/store"
)

// beginResponse unwraps {"data": {"publicKey": {...}}}.
type beginResponse struct {
	Data struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
			RP        struct {
				ID string `json:"id"`
			} `json:"rp"`
			User struct {
				ID string `json:"id"`
			} `json:"user"`
		} `json:"publicKey"`
	} `json:"data"`
}

// TestRegisterAndLoginCeremony drives a real WebAuthn registration and login
// through the actual handlers with a software authenticator.
//
// This is the path that could not be tested before, and it is precisely where
// the first production failure appeared.
func TestRegisterAndLoginCeremony(t *testing.T) {
	s, st, _ := newTestServerNoUser(t)
	ctx := context.Background()

	code := auth.NewEnrollmentCode()
	if _, err := st.CreateEnrollment(ctx, uuid.NewString(), store.HashToken(code), "test", time.Hour); err != nil {
		t.Fatal(err)
	}

	authn := newVirtualAuthenticator(t)

	// --- register/begin -------------------------------------------------------
	body := `{"code":"` + code + `","handle":"jeff","display_name":"Jeff"}`
	r := httptest.NewRequest("POST", "/api/v1/auth/register/begin", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", testOrigin)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("register/begin: %d %s", w.Code, w.Body.String())
	}
	var begin beginResponse
	if err := json.Unmarshal(w.Body.Bytes(), &begin); err != nil {
		t.Fatal(err)
	}
	pk := begin.Data.PublicKey
	if pk.Challenge == "" {
		t.Fatalf("no challenge in %s", w.Body.String())
	}
	if pk.RP.ID != "herdrer.example.net" {
		t.Fatalf("rp.id = %q, want the configured RPID", pk.RP.ID)
	}

	ceremonyCookies := w.Result().Cookies()

	// --- register/finish ------------------------------------------------------
	regBody := authn.Register(t, pk.Challenge, pk.RP.ID, testOrigin)
	r2 := httptest.NewRequest("POST", "/api/v1/auth/register/finish", strings.NewReader(string(regBody)))
	r2.Header.Set("Content-Type", "application/json")
	r2.Header.Set("Origin", testOrigin)
	for _, c := range ceremonyCookies {
		r2.AddCookie(c)
	}
	w2 := httptest.NewRecorder()
	s.ServeHTTP(w2, r2)
	if w2.Code != http.StatusOK {
		t.Fatalf("register/finish: %d %s", w2.Code, w2.Body.String())
	}

	// A session must have been issued, and the enrollment consumed.
	var sessionCookie *http.Cookie
	for _, c := range w2.Result().Cookies() {
		if strings.Contains(c.Name, "herdrer_session") && c.Value != "" {
			sessionCookie = c
		}
	}
	if sessionCookie == nil {
		t.Fatal("registration issued no session cookie")
	}
	if open, _ := st.HasOpenEnrollment(ctx); open {
		t.Error("the enrollment code was not consumed by a successful registration")
	}
	if n, _ := st.CountUsers(ctx); n != 1 {
		t.Fatalf("user count = %d, want 1", n)
	}

	// The new session works.
	r3 := httptest.NewRequest("GET", "/api/v1/me", nil)
	r3.AddCookie(sessionCookie)
	w3 := httptest.NewRecorder()
	s.ServeHTTP(w3, r3)
	if w3.Code != http.StatusOK {
		t.Fatalf("/me with the new session: %d %s", w3.Code, w3.Body.String())
	}

	// --- login/begin + finish, discoverable -----------------------------------
	r4 := httptest.NewRequest("POST", "/api/v1/auth/login/begin", strings.NewReader("{}"))
	r4.Header.Set("Content-Type", "application/json")
	r4.Header.Set("Origin", testOrigin)
	w4 := httptest.NewRecorder()
	s.ServeHTTP(w4, r4)
	if w4.Code != http.StatusOK {
		t.Fatalf("login/begin: %d %s", w4.Code, w4.Body.String())
	}
	var lbegin beginResponse
	json.Unmarshal(w4.Body.Bytes(), &lbegin)

	users, _ := st.ListUsers(ctx)
	assertBody := authn.Assert(t, lbegin.Data.PublicKey.Challenge, "herdrer.example.net",
		testOrigin, []byte(users[0].ID))

	r5 := httptest.NewRequest("POST", "/api/v1/auth/login/finish", strings.NewReader(string(assertBody)))
	r5.Header.Set("Content-Type", "application/json")
	r5.Header.Set("Origin", testOrigin)
	for _, c := range w4.Result().Cookies() {
		r5.AddCookie(c)
	}
	w5 := httptest.NewRecorder()
	s.ServeHTTP(w5, r5)
	if w5.Code != http.StatusOK {
		t.Fatalf("login/finish: %d %s", w5.Code, w5.Body.String())
	}
}

// TestRegisterRejectsBadEnrollmentCode proves the gate that keeps a public box
// from being claimed by whoever finds it first.
func TestRegisterRejectsBadEnrollmentCode(t *testing.T) {
	s, st, _ := newTestServerNoUser(t)
	ctx := context.Background()
	if _, err := st.CreateEnrollment(ctx, uuid.NewString(),
		store.HashToken(auth.NewEnrollmentCode()), "test", time.Hour); err != nil {
		t.Fatal(err)
	}

	authn := newVirtualAuthenticator(t)
	body := `{"code":"WRON-GCOD-EWRO-NGCO-DEWR-ONGC","handle":"jeff"}`
	r := httptest.NewRequest("POST", "/api/v1/auth/register/begin", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", testOrigin)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		// begin does not validate the code (it cannot, without enumerating);
		// the rejection must come at finish.
		t.Fatalf("register/begin: %d", w.Code)
	}
	var begin beginResponse
	json.Unmarshal(w.Body.Bytes(), &begin)

	regBody := authn.Register(t, begin.Data.PublicKey.Challenge, begin.Data.PublicKey.RP.ID, testOrigin)
	r2 := httptest.NewRequest("POST", "/api/v1/auth/register/finish", strings.NewReader(string(regBody)))
	r2.Header.Set("Content-Type", "application/json")
	r2.Header.Set("Origin", testOrigin)
	for _, c := range w.Result().Cookies() {
		r2.AddCookie(c)
	}
	w2 := httptest.NewRecorder()
	s.ServeHTTP(w2, r2)
	if w2.Code != http.StatusForbidden {
		t.Fatalf("a wrong code was accepted: %d %s", w2.Code, w2.Body.String())
	}
	if n, _ := st.CountUsers(ctx); n != 0 {
		t.Fatal("a user was created despite a bad enrollment code")
	}
}

// TestRegisterRequiresUserVerification proves the server rejects a
// presence-only authenticator, since a shell is behind this credential.
func TestRegisterRequiresUserVerification(t *testing.T) {
	s, st, _ := newTestServerNoUser(t)
	ctx := context.Background()
	code := auth.NewEnrollmentCode()
	if _, err := st.CreateEnrollment(ctx, uuid.NewString(), store.HashToken(code), "test", time.Hour); err != nil {
		t.Fatal(err)
	}

	authn := newVirtualAuthenticator(t)
	authn.uv = false // presence only: a tapped key, no biometric or PIN

	r := httptest.NewRequest("POST", "/api/v1/auth/register/begin",
		strings.NewReader(`{"code":"`+code+`","handle":"jeff"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", testOrigin)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	var begin beginResponse
	json.Unmarshal(w.Body.Bytes(), &begin)

	regBody := authn.Register(t, begin.Data.PublicKey.Challenge, begin.Data.PublicKey.RP.ID, testOrigin)
	r2 := httptest.NewRequest("POST", "/api/v1/auth/register/finish", strings.NewReader(string(regBody)))
	r2.Header.Set("Content-Type", "application/json")
	r2.Header.Set("Origin", testOrigin)
	for _, c := range w.Result().Cookies() {
		r2.AddCookie(c)
	}
	w2 := httptest.NewRecorder()
	s.ServeHTTP(w2, r2)
	if w2.Code == http.StatusOK {
		t.Fatal("a presence-only authenticator was accepted; UV is required")
	}
	if n, _ := st.CountUsers(ctx); n != 0 {
		t.Fatal("a user was created without user verification")
	}
}

// TestConcurrentRegistrationsOnOneCode proves the permit is single-use under a
// race, not merely single-use when tried politely in sequence.
//
// This is the property that stops a public box being co-claimed by whoever is
// watching while the owner registers.
func TestConcurrentRegistrationsOnOneCode(t *testing.T) {
	s, st, _ := newTestServerNoUser(t)
	ctx := context.Background()
	code := auth.NewEnrollmentCode()
	if _, err := st.CreateEnrollment(ctx, uuid.NewString(), store.HashToken(code), "test", time.Hour); err != nil {
		t.Fatal(err)
	}

	// The enrollment limiter would reject most of these before they reached the
	// transaction, which is correct in production and useless here: the race is
	// what is under test, not the limiter (TestEnrollmentIsRateLimited covers
	// that). Relax it for this server only.
	s.enrollLimit.relax()

	const racers = 6
	type attempt struct {
		body    []byte
		cookies []*http.Cookie
	}
	attempts := make([]attempt, 0, racers)

	// Run every begin first so all six hold a valid ceremony on the same code.
	for i := 0; i < racers; i++ {
		a := newVirtualAuthenticator(t)
		r := httptest.NewRequest("POST", "/api/v1/auth/register/begin",
			strings.NewReader(`{"code":"`+code+`","handle":"jeff"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", testOrigin)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("begin %d: %d", i, w.Code)
		}
		var b beginResponse
		json.Unmarshal(w.Body.Bytes(), &b)
		attempts = append(attempts, attempt{
			body:    a.Register(t, b.Data.PublicKey.Challenge, b.Data.PublicKey.RP.ID, testOrigin),
			cookies: w.Result().Cookies(),
		})
	}

	results := make(chan int, racers)
	start := make(chan struct{})
	for _, at := range attempts {
		go func(at attempt) {
			<-start
			r := httptest.NewRequest("POST", "/api/v1/auth/register/finish", strings.NewReader(string(at.body)))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Origin", testOrigin)
			for _, c := range at.cookies {
				r.AddCookie(c)
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			results <- w.Code
		}(at)
	}
	close(start)

	ok := 0
	for i := 0; i < racers; i++ {
		if <-results == http.StatusOK {
			ok++
		}
	}
	if ok != 1 {
		t.Fatalf("%d of %d concurrent registrations succeeded, want exactly 1", ok, racers)
	}
	n, _ := st.CountUsers(ctx)
	if n != 1 {
		t.Fatalf("user count = %d, want 1", n)
	}
	creds, _ := st.AllCredentials(ctx)
	if len(creds) != 1 {
		t.Fatalf("credential count = %d, want 1", len(creds))
	}
}

// TestFailedRegistrationLeavesBoxClaimable is the anti-lockout property. A
// registration that fails must not leave a user behind, because a user with no
// credential makes the box report itself enrolled and stop offering
// registration — unrecoverable without shell access.
func TestFailedRegistrationLeavesBoxClaimable(t *testing.T) {
	s, st, _ := newTestServerNoUser(t)
	ctx := context.Background()
	if _, err := st.CreateEnrollment(ctx, uuid.NewString(),
		store.HashToken(auth.NewEnrollmentCode()), "test", time.Hour); err != nil {
		t.Fatal(err)
	}

	a := newVirtualAuthenticator(t)
	r := httptest.NewRequest("POST", "/api/v1/auth/register/begin",
		strings.NewReader(`{"code":"NOPE-NOPE-NOPE-NOPE-NOPE-NOPE","handle":"jeff"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", testOrigin)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	var b beginResponse
	json.Unmarshal(w.Body.Bytes(), &b)

	r2 := httptest.NewRequest("POST", "/api/v1/auth/register/finish",
		strings.NewReader(string(a.Register(t, b.Data.PublicKey.Challenge, b.Data.PublicKey.RP.ID, testOrigin))))
	r2.Header.Set("Content-Type", "application/json")
	r2.Header.Set("Origin", testOrigin)
	for _, c := range w.Result().Cookies() {
		r2.AddCookie(c)
	}
	w2 := httptest.NewRecorder()
	s.ServeHTTP(w2, r2)

	if n, _ := st.CountUsers(ctx); n != 0 {
		t.Fatalf("a failed registration left %d users; the box would report itself "+
			"enrolled and refuse further registration", n)
	}
	// And the box still advertises itself as unenrolled.
	w3 := httptest.NewRecorder()
	s.ServeHTTP(w3, httptest.NewRequest("GET", "/api/v1/auth/state", nil))
	if !strings.Contains(w3.Body.String(), `"enrolled":false`) {
		t.Errorf("auth/state after a failed registration: %s", w3.Body.String())
	}
}

// TestEnrollmentIsRateLimited keeps the online-guessing defence honest. The
// enrollment code is the one secret short enough to be worth guessing, so the
// bucket on that endpoint is load-bearing, not decorative.
func TestEnrollmentIsRateLimited(t *testing.T) {
	s, _, _ := newTestServerNoUser(t)
	limited := false
	for i := 0; i < 25; i++ {
		r := httptest.NewRequest("POST", "/api/v1/auth/register/begin",
			strings.NewReader(`{"code":"GUES-SGUE-SSGU-ESSG-UESS-GUES","handle":"x"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", testOrigin)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code == http.StatusTooManyRequests {
			if w.Header().Get("Retry-After") == "" {
				t.Error("429 without a Retry-After header")
			}
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("25 enrollment attempts were never rate limited")
	}
}
