package config

import (
	"os"
	"strings"
	"testing"
)

// TestSuppressAuthRefusesPublicInterface is the guard that stops the worst
// possible misconfiguration: an unauthenticated shell reachable from the
// internet because a dev flag leaked into a deployment.
func TestSuppressAuthRefusesPublicInterface(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
	}{
		{"public addr", map[string]string{
			"SUPPRESS_AUTH": "true", "HERDRER_ADDR": ":7799",
			"HERDRER_DOMAIN": "localhost", "HERDRER_ORIGIN": "http://localhost:7799",
			"HERDRER_TLS_MODE": "off",
		}},
		{"all interfaces", map[string]string{
			"SUPPRESS_AUTH": "true", "HERDRER_ADDR": "0.0.0.0:7799",
			"HERDRER_DOMAIN": "localhost", "HERDRER_ORIGIN": "http://localhost:7799",
			"HERDRER_TLS_MODE": "off",
		}},
		{"public origin", map[string]string{
			"SUPPRESS_AUTH": "true", "HERDRER_ADDR": "127.0.0.1:7799",
			"HERDRER_DOMAIN": "herdrer.example.net", "HERDRER_ORIGIN": "https://herdrer.example.net",
			"HERDRER_TLS_MODE": "off",
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			if _, err := Load(); err == nil {
				t.Fatal("Load succeeded; it must refuse to start")
			}
		})
	}
}

// TestSuppressAuthAllowedOnLoopback keeps local development frictionless.
func TestSuppressAuthAllowedOnLoopback(t *testing.T) {
	t.Setenv("SUPPRESS_AUTH", "true")
	t.Setenv("HERDRER_ADDR", "127.0.0.1:7799")
	t.Setenv("HERDRER_DOMAIN", "localhost")
	t.Setenv("HERDRER_ORIGIN", "http://localhost:7799")
	t.Setenv("HERDRER_TLS_MODE", "off")
	t.Setenv("HERDRER_STATE_DIR", t.TempDir())
	if _, err := Load(); err != nil {
		t.Fatalf("Load failed on loopback: %v", err)
	}
}

// TestPlainHTTPOriginRefusedForPublicHost catches the case where herdrer would
// hand out passkeys over an origin the browser does not consider secure.
func TestPlainHTTPOriginRefusedForPublicHost(t *testing.T) {
	t.Setenv("HERDRER_DOMAIN", "herdrer.example.net")
	t.Setenv("HERDRER_ORIGIN", "http://herdrer.example.net")
	t.Setenv("HERDRER_TLS_MODE", "off")
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("want an https error, got %v", err)
	}
}

// TestOriginMustMatchDomain catches a mismatch that would otherwise produce
// credentials that silently fail to verify.
func TestOriginMustMatchDomain(t *testing.T) {
	t.Setenv("HERDRER_DOMAIN", "herdrer.example.net")
	t.Setenv("HERDRER_ORIGIN", "https://other.example.net")
	t.Setenv("HERDRER_TLS_MODE", "off")
	if _, err := Load(); err == nil {
		t.Fatal("Load succeeded despite an origin/domain mismatch")
	}
}

// TestRPIDComesFromOrigin documents that the relying party id is derived, not
// configured separately — one fewer way to get WebAuthn subtly wrong.
func TestRPIDComesFromOrigin(t *testing.T) {
	t.Setenv("HERDRER_DOMAIN", "herdrer.example.net")
	t.Setenv("HERDRER_ORIGIN", "https://herdrer.example.net")
	t.Setenv("HERDRER_TLS_MODE", "off")
	t.Setenv("HERDRER_STATE_DIR", t.TempDir())
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RPID() != "herdrer.example.net" {
		t.Fatalf("RPID = %q", cfg.RPID())
	}
	if !cfg.Secure() {
		t.Fatal("Secure() should be true for an https origin")
	}
}

// TestEnvFileDoesNotOverrideEnvironment pins the precedence rule. The env file
// exists so a hand-run CLI command sees the service's configuration; it must
// never shadow a value the caller set explicitly.
func TestEnvFileDoesNotOverrideEnvironment(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/herdrer.env"
	body := "# comment\n\nHERDRER_DOMAIN=fromfile.example.net\n" +
		"export HERDRER_ORIGIN=\"https://fromfile.example.net\"\n" +
		"HERDRER_TLS_MODE=off\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	// The repo's own mise.toml exports HERDRER_DOMAIN/ORIGIN into any shell
	// run inside the checkout, so the ambient environment has to be cleared
	// or the file would (correctly) decline to override it.
	clearEnv(t, "HERDRER_DOMAIN", "HERDRER_ORIGIN", "HERDRER_ADDR", "HERDRER_TLS_MODE")
	t.Setenv("HERDRER_ENV_FILE", path)
	t.Setenv("HERDRER_STATE_DIR", dir)

	// Nothing set: the file supplies both.
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Domain != "fromfile.example.net" {
		t.Fatalf("domain = %q, want the file's value", cfg.Domain)
	}

	// Explicitly set: the environment wins.
	t.Setenv("HERDRER_DOMAIN", "explicit.example.net")
	t.Setenv("HERDRER_ORIGIN", "https://explicit.example.net")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Domain != "explicit.example.net" {
		t.Fatalf("domain = %q, want the explicit environment value", cfg.Domain)
	}
}

// clearEnv unsets variables for the duration of a test and restores them after,
// which t.Setenv cannot do.
func clearEnv(t *testing.T, keys ...string) {
	t.Helper()
	for _, k := range keys {
		if old, ok := os.LookupEnv(k); ok {
			key := k
			val := old
			t.Cleanup(func() { _ = os.Setenv(key, val) })
			if err := os.Unsetenv(k); err != nil {
				t.Fatal(err)
			}
		}
	}
}
