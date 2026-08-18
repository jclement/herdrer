// Package config loads herdrer's settings from the environment and refuses to
// start on combinations that would be unsafe in production.
package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// TLSMode selects how the HTTPS listener obtains its certificate.
type TLSMode string

const (
	// TLSAutocert obtains and renews a certificate from Let's Encrypt.
	TLSAutocert TLSMode = "autocert"
	// TLSFile reads a certificate and key from disk.
	TLSFile TLSMode = "file"
	// TLSOff serves plain HTTP. Only legitimate on loopback or behind a
	// terminating proxy on a private network.
	TLSOff TLSMode = "off"
)

// Config is the fully resolved configuration for one herdrer process.
type Config struct {
	Domain string
	Origin string

	Addr string

	TLSMode   TLSMode
	TLSCert   string
	TLSKey    string
	ACMEEmail string
	StateDir  string
	DBPath    string
	ACMECache string
	VAPIDPath string

	SessionTTL   time.Duration
	EnrollTTL    time.Duration
	StepUpWindow time.Duration
	SuppressAuth bool

	HerdrConfigDir  string
	TerminalEnabled bool

	VAPIDPublic  string
	VAPIDPrivate string
	VAPIDSubject string
	NtfyURL      string

	LongpollMax        time.Duration
	MaxOpenItems       int
	DefaultExpiryHours int
	MaxExpiryHours     int
}

// Load reads configuration from the environment, applies defaults, and
// validates it. It returns an error rather than logging and continuing: a
// misconfigured auth boundary must stop the process, not degrade it.
func Load() (*Config, error) {
	// Applied before anything is read, and never overriding a value already
	// in the environment, so a hand-run CLI command and the systemd service
	// resolve to the same configuration.
	if p := defaultEnvFile(); p != "" {
		loadEnvFile(p)
	}

	c := &Config{
		Domain:          env("HERDRER_DOMAIN", "localhost"),
		Addr:            env("HERDRER_ADDR", ":443"),
		TLSMode:         TLSMode(env("HERDRER_TLS_MODE", string(TLSAutocert))),
		TLSCert:         env("HERDRER_TLS_CERT", ""),
		TLSKey:          env("HERDRER_TLS_KEY", ""),
		ACMEEmail:       env("HERDRER_ACME_EMAIL", ""),
		StateDir:        env("HERDRER_STATE_DIR", defaultStateDir()),
		SuppressAuth:    envBool("SUPPRESS_AUTH", false),
		HerdrConfigDir:  env("HERDRER_HERDR_CONFIG_DIR", ""),
		TerminalEnabled: envBool("HERDRER_TERMINAL_ENABLED", true),
		VAPIDPublic:     env("HERDRER_VAPID_PUBLIC_KEY", ""),
		VAPIDPrivate:    env("HERDRER_VAPID_PRIVATE_KEY", ""),
		VAPIDSubject:    env("HERDRER_VAPID_SUBJECT", ""),
		NtfyURL:         env("HERDRER_NTFY_URL", ""),
	}

	c.SessionTTL = time.Duration(envInt("HERDRER_SESSION_TTL_DAYS", 30)) * 24 * time.Hour
	c.EnrollTTL = time.Duration(envInt("HERDRER_ENROLL_TTL_MINUTES", 15)) * time.Minute
	// 12 hours, not minutes. The point of step-up is that a stolen *cookie*
	// cannot open a shell without an authenticator the thief does not have —
	// and an attacker who never had the passkey can never satisfy it, whatever
	// the window. A short window therefore buys very little and costs a
	// re-prompt every few minutes of ordinary work, which reads as "my session
	// keeps dying" and trains you to tap through it.
	c.StepUpWindow = time.Duration(envInt("HERDRER_STEPUP_WINDOW_HOURS", 12)) * time.Hour
	c.LongpollMax = time.Duration(envInt("HERDRER_LONGPOLL_MAX_SECONDS", 300)) * time.Second
	c.MaxOpenItems = envInt("HERDRER_MAX_OPEN_ITEMS", 50)
	c.DefaultExpiryHours = envInt("HERDRER_DEFAULT_EXPIRY_HOURS", 24)
	c.MaxExpiryHours = envInt("HERDRER_MAX_EXPIRY_HOURS", 168)

	// The origin defaults to something consistent with the TLS mode so that a
	// minimal configuration (domain only) still produces a working RP origin.
	c.Origin = env("HERDRER_ORIGIN", defaultOrigin(c))

	c.DBPath = filepath.Join(c.StateDir, "herdrer.db")
	c.ACMECache = filepath.Join(c.StateDir, "acme")
	c.VAPIDPath = filepath.Join(c.StateDir, "vapid.json")

	if err := c.validate(); err != nil {
		return nil, err
	}
	return c, nil
}

// RPID is the WebAuthn relying party id — the registrable domain credentials
// are bound to. Deriving it from the origin rather than the domain means a
// mismatch between the two is caught by validate rather than silently
// producing credentials that will not verify.
func (c *Config) RPID() string {
	u, err := url.Parse(c.Origin)
	if err != nil {
		return c.Domain
	}
	return u.Hostname()
}

func (c *Config) validate() error {
	u, err := url.Parse(c.Origin)
	if err != nil || u.Host == "" {
		return fmt.Errorf("HERDRER_ORIGIN %q is not a valid absolute URL", c.Origin)
	}
	if u.Scheme != "https" && !isLoopbackHost(u.Hostname()) {
		return fmt.Errorf("HERDRER_ORIGIN %q must be https: WebAuthn only treats "+
			"loopback as a secure context, and a passkey issued over plain http "+
			"to a public host is not a credential worth having", c.Origin)
	}
	if u.Hostname() != c.Domain {
		return fmt.Errorf("HERDRER_ORIGIN host %q does not match HERDRER_DOMAIN %q; "+
			"WebAuthn binds credentials to one of these and would reject the other",
			u.Hostname(), c.Domain)
	}

	switch c.TLSMode {
	case TLSAutocert:
		if isLoopbackHost(c.Domain) {
			return fmt.Errorf("HERDRER_TLS_MODE=autocert cannot issue a certificate " +
				"for a loopback domain; set HERDRER_TLS_MODE=off for local development")
		}
	case TLSFile:
		if c.TLSCert == "" || c.TLSKey == "" {
			return fmt.Errorf("HERDRER_TLS_MODE=file requires HERDRER_TLS_CERT and HERDRER_TLS_KEY")
		}
	case TLSOff:
	default:
		return fmt.Errorf("HERDRER_TLS_MODE %q is not one of autocert, file, off", c.TLSMode)
	}

	// The one that matters. SUPPRESS_AUTH removes every authentication check in
	// the process; a build that reaches a non-loopback interface with it set is
	// an open shell on the internet.
	if c.SuppressAuth {
		if !isLoopbackAddr(c.Addr) {
			return fmt.Errorf("SUPPRESS_AUTH=true with HERDRER_ADDR=%q, which is not "+
				"loopback: refusing to start an unauthenticated shell on a reachable "+
				"interface", c.Addr)
		}
		if !isLoopbackHost(c.RPID()) {
			return fmt.Errorf("SUPPRESS_AUTH=true with a non-loopback origin %q: refusing", c.Origin)
		}
	}

	if c.MaxExpiryHours < c.DefaultExpiryHours {
		return fmt.Errorf("HERDRER_MAX_EXPIRY_HOURS (%d) is below HERDRER_DEFAULT_EXPIRY_HOURS (%d)",
			c.MaxExpiryHours, c.DefaultExpiryHours)
	}
	return nil
}

// Secure reports whether cookies should carry the Secure attribute. Loopback
// development over plain http is the only case where they should not.
func (c *Config) Secure() bool {
	return strings.HasPrefix(c.Origin, "https://")
}

func defaultOrigin(c *Config) string {
	if c.TLSMode == TLSOff {
		host := c.Domain
		if _, port, err := net.SplitHostPort(c.Addr); err == nil && port != "" && port != "80" {
			host = c.Domain + ":" + port
		}
		return "http://" + host
	}
	return "https://" + c.Domain
}

func defaultStateDir() string {
	if d := os.Getenv("XDG_STATE_HOME"); d != "" {
		return filepath.Join(d, "herdrer")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "./state"
	}
	return filepath.Join(home, ".local", "state", "herdrer")
}

func isLoopbackHost(h string) bool {
	return h == "localhost" || h == "127.0.0.1" || h == "::1" || h == "[::1]"
}

func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	return isLoopbackHost(host)
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envBool(k string, def bool) bool {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}
