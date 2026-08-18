// Package auth owns every way a caller can prove who they are.
//
// There are exactly two principals, and they are not interchangeable:
//
//   - A *user* holds a passkey. A user may do anything herdrer can do,
//     including opening a shell.
//   - A *token* is an agent credential minted by a user. A token may submit
//     review items and read the answers to its own. It can never reach a
//     terminal, and no code path upgrades a token into a session.
//
// There is no third way in. There is no password, no recovery email, no
// "first request registers the admin", and no unauthenticated write anywhere
// in the API.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"

	"github.com/jclement/herdrer/internal/config"
	"github.com/jclement/herdrer/internal/store"
)

const (
	// ceremonyTTL bounds how long a WebAuthn challenge stays valid.
	ceremonyTTL = 5 * time.Minute
	// ticketTTL bounds a single-use WebSocket ticket. Short because its only
	// job is to survive the gap between an authenticated fetch and the upgrade.
	ticketTTL = 60 * time.Second
)

// Service performs authentication.
type Service struct {
	cfg   *config.Config
	st    *store.Store
	wa    *webauthn.WebAuthn
	nowFn func() time.Time

	mu      sync.Mutex
	tickets map[string]ticket
}

type ticket struct {
	sessionID string
	userID    string
	purpose   string
	expires   time.Time
}

// New builds the service and configures the relying party.
//
// UserVerification is set to Required: a passkey that authenticates with
// presence alone (a tapped key with no biometric or PIN) is not enough to open
// a shell, so we ask the platform for verification on every ceremony.
func New(cfg *config.Config, st *store.Store) (*Service, error) {
	wa, err := webauthn.New(&webauthn.Config{
		RPID:          cfg.RPID(),
		RPDisplayName: "herdrer",
		RPOrigins:     []string{cfg.Origin},
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		},
		Timeouts: webauthn.TimeoutsConfig{
			Registration: webauthn.TimeoutConfig{Enforce: true, Timeout: ceremonyTTL, TimeoutUVD: ceremonyTTL},
			Login:        webauthn.TimeoutConfig{Enforce: true, Timeout: ceremonyTTL, TimeoutUVD: ceremonyTTL},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("configure webauthn: %w", err)
	}
	return &Service{cfg: cfg, st: st, wa: wa, nowFn: time.Now, tickets: map[string]ticket{}}, nil
}

// --- cookie names -------------------------------------------------------------

// The __Host- prefix is load-bearing here. herdrer may be deployed on a
// hostname that shares a registrable domain with other services; the prefix
// forbids a Domain attribute, so a sibling host cannot set or overwrite our
// session cookie on the parent domain. It requires Secure and Path=/, which is
// why the plain names are only ever used for loopback development.
func (s *Service) sessionCookieName() string {
	if s.cfg.Secure() {
		return "__Host-herdrer_session"
	}
	return "herdrer_session"
}

func (s *Service) ceremonyCookieName() string {
	if s.cfg.Secure() {
		return "__Host-herdrer_ceremony"
	}
	return "herdrer_ceremony"
}

// --- registration -------------------------------------------------------------

// ceremonyBlob is what we persist between the two halves of a ceremony. The
// enrollment code rides along so that the permit is consumed only when a
// credential actually lands, and cannot be replayed by a caller who abandons
// the ceremony.
type ceremonyBlob struct {
	Session        webauthn.SessionData `json:"session"`
	EnrollmentCode string               `json:"enrollment_code,omitempty"`
	Handle         string               `json:"handle,omitempty"`
	DisplayName    string               `json:"display_name,omitempty"`
}

// BeginRegistration starts a passkey registration. It requires a valid, unused
// enrollment permit; without one the call fails identically to a bad code, so
// probing tells an attacker nothing.
func (s *Service) BeginRegistration(ctx context.Context, w http.ResponseWriter, code, handle, displayName string) (*protocol.CredentialCreation, error) {
	open, err := s.st.HasOpenEnrollment(ctx)
	if err != nil {
		return nil, err
	}
	if !open || strings.TrimSpace(code) == "" {
		return nil, ErrEnrollmentRequired
	}

	handle = strings.TrimSpace(handle)
	if handle == "" {
		handle = "jeff"
	}
	if displayName = strings.TrimSpace(displayName); displayName == "" {
		displayName = handle
	}

	// Registering a second passkey for an existing user is the normal case
	// after the first device; a brand-new handle creates a user.
	u, err := s.st.GetUserByHandle(ctx, handle)
	if err != nil && err != store.ErrNotFound {
		return nil, err
	}
	var wu *waUser
	if err == store.ErrNotFound {
		wu = &waUser{id: uuid.NewString(), handle: handle, display: displayName}
	} else {
		creds, err := s.credentialsFor(ctx, u.ID)
		if err != nil {
			return nil, err
		}
		wu = &waUser{id: u.ID, handle: u.Handle, display: u.DisplayName, creds: creds}
	}

	opts, sessionData, err := s.wa.BeginRegistration(wu,
		webauthn.WithExclusions(wu.excludeList()),
	)
	if err != nil {
		return nil, fmt.Errorf("begin registration: %w", err)
	}

	blob, _ := json.Marshal(ceremonyBlob{
		Session: *sessionData, EnrollmentCode: code, Handle: handle, DisplayName: displayName,
	})
	id := randomToken(24)
	if err := s.st.PutCeremony(ctx, id, "register", wu.id, blob, ceremonyTTL); err != nil {
		return nil, err
	}
	s.setCeremonyCookie(w, id)
	return opts, nil
}

// FinishRegistration completes registration, consuming the enrollment permit
// and issuing a session in one go.
func (s *Service) FinishRegistration(ctx context.Context, w http.ResponseWriter, r *http.Request) (*store.User, error) {
	cid, err := r.Cookie(s.ceremonyCookieName())
	if err != nil {
		return nil, ErrCeremonyMissing
	}
	s.clearCeremonyCookie(w)

	userID, raw, err := s.st.TakeCeremony(ctx, cid.Value, "register")
	if err != nil {
		return nil, ErrCeremonyMissing
	}
	var blob ceremonyBlob
	if err := json.Unmarshal(raw, &blob); err != nil {
		return nil, ErrCeremonyMissing
	}

	u, err := s.st.GetUser(ctx, userID)
	existing := err == nil
	if err != nil && err != store.ErrNotFound {
		return nil, err
	}

	var wu *waUser
	if existing {
		creds, err := s.credentialsFor(ctx, u.ID)
		if err != nil {
			return nil, err
		}
		wu = &waUser{id: u.ID, handle: u.Handle, display: u.DisplayName, creds: creds}
	} else {
		wu = &waUser{id: userID, handle: blob.Handle, display: blob.DisplayName}
	}

	cred, err := s.wa.FinishRegistration(wu, blob.Session, r)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrVerification, err)
	}

	// The permit is spent only now, when a real authenticator has produced a
	// real credential. Consuming is atomic, so two concurrent registrations
	// racing on one code cannot both succeed.
	if err := s.st.ConsumeEnrollment(ctx, blob.EnrollmentCode, userID); err != nil {
		return nil, ErrEnrollmentRequired
	}

	now := s.nowFn()
	if !existing {
		u = &store.User{ID: userID, Handle: blob.Handle, DisplayName: blob.DisplayName,
			Role: "admin", CreatedAt: now}
		if err := s.st.CreateUser(ctx, u); err != nil {
			return nil, err
		}
	}

	transports := make([]string, 0, len(cred.Transport))
	for _, t := range cred.Transport {
		transports = append(transports, string(t))
	}
	sc := &store.Credential{
		ID: uuid.NewString(), UserID: u.ID, CredID: cred.ID, PublicKey: cred.PublicKey,
		AttestationType: cred.AttestationType, AAGUID: cred.Authenticator.AAGUID,
		SignCount:      cred.Authenticator.SignCount,
		BackupEligible: cred.Flags.BackupEligible, BackupState: cred.Flags.BackupState,
		Transports: strings.Join(transports, ","),
		Name:       deviceName(r.UserAgent()), CreatedAt: now,
	}
	if err := s.st.AddCredential(ctx, sc); err != nil {
		return nil, err
	}

	if _, err := s.IssueSession(ctx, w, r, u.ID, sc.ID); err != nil {
		return nil, err
	}
	s.st.Audit(ctx, store.AuditEntry{
		Actor: "user:" + u.ID, Kind: "auth.register", Subject: sc.ID,
		IP: clientIP(r), UserAgent: r.UserAgent(),
		Detail: map[string]any{"handle": u.Handle, "device": sc.Name},
	})
	return u, nil
}

// --- login --------------------------------------------------------------------

// BeginLogin starts a discoverable (usernameless) assertion. The browser picks
// the credential, so no handle is sent and no user enumeration is possible.
func (s *Service) BeginLogin(ctx context.Context, w http.ResponseWriter) (*protocol.CredentialAssertion, error) {
	opts, sessionData, err := s.wa.BeginDiscoverableLogin()
	if err != nil {
		return nil, fmt.Errorf("begin login: %w", err)
	}
	blob, _ := json.Marshal(ceremonyBlob{Session: *sessionData})
	id := randomToken(24)
	if err := s.st.PutCeremony(ctx, id, "login", "", blob, ceremonyTTL); err != nil {
		return nil, err
	}
	s.setCeremonyCookie(w, id)
	return opts, nil
}

// FinishLogin verifies the assertion and issues a session.
func (s *Service) FinishLogin(ctx context.Context, w http.ResponseWriter, r *http.Request) (*store.User, error) {
	cid, err := r.Cookie(s.ceremonyCookieName())
	if err != nil {
		return nil, ErrCeremonyMissing
	}
	s.clearCeremonyCookie(w)

	_, raw, err := s.st.TakeCeremony(ctx, cid.Value, "login")
	if err != nil {
		return nil, ErrCeremonyMissing
	}
	var blob ceremonyBlob
	if err := json.Unmarshal(raw, &blob); err != nil {
		return nil, ErrCeremonyMissing
	}

	var matched *store.Credential
	cred, err := s.wa.FinishDiscoverableLogin(func(rawID, userHandle []byte) (webauthn.User, error) {
		u, err := s.st.GetUser(ctx, string(userHandle))
		if err != nil {
			return nil, fmt.Errorf("unknown user handle")
		}
		creds, err := s.credentialsFor(ctx, u.ID)
		if err != nil {
			return nil, err
		}
		return &waUser{id: u.ID, handle: u.Handle, display: u.DisplayName, creds: creds}, nil
	}, blob.Session, r)
	if err != nil {
		s.st.Audit(ctx, store.AuditEntry{
			Actor: "anon", Kind: "auth.login_failed", IP: clientIP(r),
			UserAgent: r.UserAgent(), Detail: map[string]any{"error": err.Error()},
		})
		return nil, fmt.Errorf("%w: %v", ErrVerification, err)
	}

	matched, err = s.st.CredentialByCredID(ctx, cred.ID)
	if err != nil {
		return nil, ErrVerification
	}

	// A signature counter that failed to advance means the authenticator may
	// have been cloned. Platform authenticators legitimately report 0 forever,
	// so this is recorded rather than fatal — but it is recorded.
	if cred.Authenticator.CloneWarning {
		s.st.Audit(ctx, store.AuditEntry{
			Actor: "user:" + matched.UserID, Kind: "auth.clone_warning", Subject: matched.ID,
			IP: clientIP(r), UserAgent: r.UserAgent(),
		})
	}
	_ = s.st.UpdateCredentialUse(ctx, matched.ID, cred.Authenticator.SignCount, cred.Flags.BackupState)

	u, err := s.st.GetUser(ctx, matched.UserID)
	if err != nil {
		return nil, ErrVerification
	}
	if _, err := s.IssueSession(ctx, w, r, u.ID, matched.ID); err != nil {
		return nil, err
	}
	_ = s.st.TouchUser(ctx, u.ID)
	s.st.Audit(ctx, store.AuditEntry{
		Actor: "user:" + u.ID, Kind: "auth.login", Subject: matched.ID,
		IP: clientIP(r), UserAgent: r.UserAgent(),
	})
	return u, nil
}

// --- sessions -----------------------------------------------------------------

// IssueSession mints a session cookie. The cookie carries 32 bytes of entropy;
// only its SHA-256 is stored, so a database copy cannot be replayed as a login.
func (s *Service) IssueSession(ctx context.Context, w http.ResponseWriter, r *http.Request, userID, credID string) (string, error) {
	secret := randomToken(32)
	now := s.nowFn()
	sess := &store.Session{
		ID: store.HashToken(secret), UserID: userID, UserAgent: truncate(r.UserAgent(), 400),
		IP: clientIP(r), CreatedAt: now, LastSeenAt: now, ExpiresAt: now.Add(s.cfg.SessionTTL),
	}
	if credID != "" {
		sess.CredentialID = &credID
	}
	if err := s.st.CreateSession(ctx, sess); err != nil {
		return "", err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     s.sessionCookieName(),
		Value:    secret,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.cfg.Secure(),
		// Strict, not Lax. Lax still sends the cookie on top-level navigations
		// from any same-site origin, and this deployment may share a
		// registrable domain with unrelated services.
		SameSite: http.SameSiteStrictMode,
		Expires:  sess.ExpiresAt,
		MaxAge:   int(s.cfg.SessionTTL.Seconds()),
	})
	return secret, nil
}

// SessionFromRequest resolves the session cookie to a live session and user.
func (s *Service) SessionFromRequest(ctx context.Context, r *http.Request) (*store.Session, *store.User, error) {
	c, err := r.Cookie(s.sessionCookieName())
	if err != nil || c.Value == "" {
		return nil, nil, ErrNoSession
	}
	sess, err := s.st.GetSession(ctx, store.HashToken(c.Value))
	if err != nil {
		return nil, nil, ErrNoSession
	}
	u, err := s.st.GetUser(ctx, sess.UserID)
	if err != nil {
		return nil, nil, ErrNoSession
	}
	// Slide the expiry at most once a minute to keep the write off the hot path.
	if s.nowFn().Sub(sess.LastSeenAt) > time.Minute {
		_ = s.st.RefreshSession(ctx, sess.ID, s.cfg.SessionTTL)
	}
	return sess, u, nil
}

// Logout revokes the current session and clears the cookie.
func (s *Service) Logout(ctx context.Context, w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(s.sessionCookieName()); err == nil && c.Value != "" {
		_ = s.st.RevokeSession(ctx, store.HashToken(c.Value))
	}
	http.SetCookie(w, &http.Cookie{
		Name: s.sessionCookieName(), Value: "", Path: "/", HttpOnly: true,
		Secure: s.cfg.Secure(), SameSite: http.SameSiteStrictMode, MaxAge: -1,
	})
}

// --- agent tokens -------------------------------------------------------------

// MintToken creates an agent token and returns the plaintext exactly once.
func (s *Service) MintToken(ctx context.Context, userID, name string, scopes []string, ttl time.Duration) (*store.APIToken, string, error) {
	if len(scopes) == 0 {
		scopes = []string{ScopeReviewWrite}
	}
	for _, sc := range scopes {
		if !validScope(sc) {
			return nil, "", fmt.Errorf("unknown scope %q", sc)
		}
	}
	raw := "sk_" + hex.EncodeToString(randomBytes(32))
	t := &store.APIToken{
		ID: uuid.NewString(), UserID: userID, Name: name,
		TokenPrefix: raw[:11], Scopes: scopes, CreatedAt: s.nowFn(),
	}
	if ttl > 0 {
		exp := s.nowFn().Add(ttl)
		t.ExpiresAt = &exp
	}
	if err := s.st.CreateAPIToken(ctx, t, store.HashToken(raw)); err != nil {
		return nil, "", err
	}
	return t, raw, nil
}

// TokenFromRequest resolves an Authorization: Bearer sk_… header.
func (s *Service) TokenFromRequest(ctx context.Context, r *http.Request) (*store.APIToken, error) {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return nil, ErrNoToken
	}
	raw := strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	if !strings.HasPrefix(raw, "sk_") {
		return nil, ErrNoToken
	}
	t, err := s.st.APITokenByHash(ctx, store.HashToken(raw))
	if err != nil {
		return nil, ErrNoToken
	}
	return t, nil
}

// --- websocket tickets --------------------------------------------------------

// MintTicket issues a single-use, short-lived ticket for a WebSocket upgrade.
//
// Cookies alone are a poor fit for an upgrade: SameSite behaviour on WebSocket
// handshakes has varied across browsers, and the terminal socket is the highest
// value endpoint in the application. A ticket that must be fetched by an
// already-authenticated same-origin request, then presented once within a
// minute, means a cross-site handshake cannot succeed even if a cookie leaks
// into it.
func (s *Service) MintTicket(sessionID, userID, purpose string) string {
	tok := randomToken(24)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reapTicketsLocked()
	s.tickets[tok] = ticket{sessionID: sessionID, userID: userID, purpose: purpose,
		expires: s.nowFn().Add(ticketTTL)}
	return tok
}

// RedeemTicket consumes a ticket, returning the user it was minted for.
func (s *Service) RedeemTicket(tok, purpose string) (userID, sessionID string, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reapTicketsLocked()
	t, found := s.tickets[tok]
	if !found {
		return "", "", false
	}
	delete(s.tickets, tok)
	if s.nowFn().After(t.expires) || subtle.ConstantTimeCompare([]byte(t.purpose), []byte(purpose)) != 1 {
		return "", "", false
	}
	return t.userID, t.sessionID, true
}

// RevokeTicketsForSession drops any outstanding tickets belonging to a session
// that has just been revoked, so logging out closes the upgrade window too.
func (s *Service) RevokeTicketsForSession(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range s.tickets {
		if v.sessionID == sessionID {
			delete(s.tickets, k)
		}
	}
}

func (s *Service) reapTicketsLocked() {
	now := s.nowFn()
	for k, v := range s.tickets {
		if now.After(v.expires) {
			delete(s.tickets, k)
		}
	}
}

// --- helpers ------------------------------------------------------------------

func (s *Service) credentialsFor(ctx context.Context, userID string) ([]webauthn.Credential, error) {
	rows, err := s.st.ListCredentials(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]webauthn.Credential, 0, len(rows))
	for _, c := range rows {
		wc := webauthn.Credential{
			ID: c.CredID, PublicKey: c.PublicKey, AttestationType: c.AttestationType,
		}
		wc.Authenticator.AAGUID = c.AAGUID
		wc.Authenticator.SignCount = c.SignCount
		wc.Flags.BackupEligible = c.BackupEligible
		wc.Flags.BackupState = c.BackupState
		for _, t := range strings.Split(c.Transports, ",") {
			if t != "" {
				wc.Transport = append(wc.Transport, protocol.AuthenticatorTransport(t))
			}
		}
		out = append(out, wc)
	}
	return out, nil
}

func (s *Service) setCeremonyCookie(w http.ResponseWriter, id string) {
	http.SetCookie(w, &http.Cookie{
		Name: s.ceremonyCookieName(), Value: id, Path: "/", HttpOnly: true,
		Secure: s.cfg.Secure(), SameSite: http.SameSiteStrictMode, MaxAge: int(ceremonyTTL.Seconds()),
	})
}

func (s *Service) clearCeremonyCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: s.ceremonyCookieName(), Value: "", Path: "/", HttpOnly: true,
		Secure: s.cfg.Secure(), SameSite: http.SameSiteStrictMode, MaxAge: -1,
	})
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return b
}

func randomToken(n int) string {
	return base64.RawURLEncoding.EncodeToString(randomBytes(n))
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func clientIP(r *http.Request) string {
	// herdrer sits behind a loopback reverse proxy that sets this. A header
	// from a direct public connection is not trusted for anything but logging,
	// and is never used for an authorisation decision.
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	host := r.RemoteAddr
	if i := strings.LastIndexByte(host, ':'); i > 0 {
		host = host[:i]
	}
	return host
}

func deviceName(ua string) string {
	switch {
	case strings.Contains(ua, "iPhone"):
		return "iPhone"
	case strings.Contains(ua, "iPad"):
		return "iPad"
	case strings.Contains(ua, "Android"):
		return "Android"
	case strings.Contains(ua, "Macintosh"):
		return "Mac"
	case strings.Contains(ua, "Windows"):
		return "Windows"
	case strings.Contains(ua, "Linux"):
		return "Linux"
	}
	return "Passkey"
}

// NewEnrollmentCode returns a permit code.
//
// Six groups of four uppercase letters and digits, ambiguous characters
// removed. It is long enough that guessing it online is hopeless against the
// rate limiter, and shaped so it can be read off a server console and typed on
// a phone without transcription errors.
func NewEnrollmentCode() string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := randomBytes(24)
	out := make([]byte, 0, 29)
	for i, v := range b {
		if i > 0 && i%4 == 0 {
			out = append(out, '-')
		}
		out = append(out, alphabet[int(v)%len(alphabet)])
	}
	return string(out)
}

// --- step-up re-authentication ---------------------------------------------------

// StepUpWindow is how long a fresh assertion stays good for.
//
// Short on purpose. The point of step-up is that possession of a session
// cookie is not enough to open a shell; a long window would turn it back into
// exactly that.
const StepUpWindow = 5 * time.Minute

// BeginStepUp starts a re-authentication ceremony for an already-logged-in user.
func (s *Service) BeginStepUp(ctx context.Context, w http.ResponseWriter, userID string) (*protocol.CredentialAssertion, error) {
	creds, err := s.credentialsFor(ctx, userID)
	if err != nil {
		return nil, err
	}
	if len(creds) == 0 {
		return nil, ErrVerification
	}
	u, err := s.st.GetUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	wu := &waUser{id: u.ID, handle: u.Handle, display: u.DisplayName, creds: creds}

	// Scoped to this user's credentials rather than discoverable: we already
	// know who is asking, and narrowing the allow-list means another user's
	// authenticator cannot satisfy the challenge.
	opts, sessionData, err := s.wa.BeginLogin(wu)
	if err != nil {
		return nil, fmt.Errorf("begin step-up: %w", err)
	}
	blob, _ := json.Marshal(ceremonyBlob{Session: *sessionData})
	id := randomToken(24)
	if err := s.st.PutCeremony(ctx, id, "stepup", userID, blob, ceremonyTTL); err != nil {
		return nil, err
	}
	s.setCeremonyCookie(w, id)
	return opts, nil
}

// FinishStepUp verifies the assertion and stamps the session.
//
// It returns the credential that satisfied it, so the caller can check that
// credential's own permissions rather than the one the session was created
// with — tapping a laptop key to authorise a shell should consult the laptop
// key's permission, not the phone's.
func (s *Service) FinishStepUp(ctx context.Context, w http.ResponseWriter, r *http.Request,
	sess *store.Session, userID string) (*store.Credential, error) {

	cid, err := r.Cookie(s.ceremonyCookieName())
	if err != nil {
		return nil, ErrCeremonyMissing
	}
	s.clearCeremonyCookie(w)

	ceremonyUser, raw, err := s.st.TakeCeremony(ctx, cid.Value, "stepup")
	if err != nil {
		return nil, ErrCeremonyMissing
	}
	// The ceremony was issued to a specific user; a session that has since
	// changed hands must not be able to redeem it.
	if ceremonyUser != userID {
		return nil, ErrVerification
	}
	var blob ceremonyBlob
	if err := json.Unmarshal(raw, &blob); err != nil {
		return nil, ErrCeremonyMissing
	}

	creds, err := s.credentialsFor(ctx, userID)
	if err != nil {
		return nil, err
	}
	u, err := s.st.GetUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	wu := &waUser{id: u.ID, handle: u.Handle, display: u.DisplayName, creds: creds}

	cred, err := s.wa.FinishLogin(wu, blob.Session, r)
	if err != nil {
		s.st.Audit(ctx, store.AuditEntry{
			Actor: "user:" + userID, Kind: "auth.stepup_failed",
			IP: clientIP(r), UserAgent: r.UserAgent(),
		})
		return nil, fmt.Errorf("%w: %v", ErrVerification, err)
	}

	matched, err := s.st.CredentialByCredID(ctx, cred.ID)
	if err != nil || matched.UserID != userID {
		return nil, ErrVerification
	}
	_ = s.st.UpdateCredentialUse(ctx, matched.ID, cred.Authenticator.SignCount, cred.Flags.BackupState)
	if err := s.st.MarkSessionSteppedUp(ctx, sess.ID, matched.ID); err != nil {
		return nil, err
	}
	s.st.Audit(ctx, store.AuditEntry{
		Actor: "user:" + userID, Kind: "auth.stepup", Subject: matched.ID,
		IP: clientIP(r), UserAgent: r.UserAgent(),
	})
	return matched, nil
}

// SteppedUpRecently reports whether a session holds a fresh assertion.
func SteppedUpRecently(sess *store.Session) bool {
	return sess != nil && sess.SteppedUpAt != nil && time.Since(*sess.SteppedUpAt) <= StepUpWindow
}
