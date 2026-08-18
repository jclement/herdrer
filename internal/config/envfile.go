package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// loadEnvFile applies KEY=VALUE lines from a file to the process environment,
// without overriding anything already set.
//
// This exists so that `herdrer enroll` run by hand on the box sees exactly the
// configuration the running service sees. The systemd unit gets its values
// from Environment= and EnvironmentFile=; a CLI invocation gets none of them,
// and would otherwise fall back to defaults — a localhost origin and autocert
// — and fail validation, or worse, quietly write an enrollment into a
// different database than the one the server reads.
//
// Precedence is deliberate: a value already in the environment wins, so an
// explicit `HERDRER_STATE_DIR=… herdrer enroll` still overrides the file.
func loadEnvFile(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		// Tolerate the shell-ism systemd also accepts.
		line = strings.TrimPrefix(line, "export ")
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
			v = v[1 : len(v)-1]
		}
		if k == "" {
			continue
		}
		if _, present := os.LookupEnv(k); !present {
			_ = os.Setenv(k, v)
		}
	}
}

// defaultEnvFile is where the deployed box keeps its configuration.
func defaultEnvFile() string {
	if p := os.Getenv("HERDRER_ENV_FILE"); p != "" {
		return p
	}
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, "herdrer", "herdrer.env")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "herdrer", "herdrer.env")
}
