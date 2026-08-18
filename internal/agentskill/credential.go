package agentskill

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/jclement/herdrer/internal/auth"
	"github.com/jclement/herdrer/internal/store"
)

// TokenName is the name herdrer gives the credential it provisions for the
// agents running on this box.
const TokenName = "local-agents"

// EnsureCredential makes sure the agents on this box have a token and know the
// URL, provisioning one if they do not.
//
// The skill is useless without a credential, and asking a human to mint one and
// paste it into a dotfile is exactly the step that never happens — so herdrer
// does it. The token it issues carries review scopes only: it can raise a
// question and read the answer, and there is no scope that would let it reach a
// shell.
//
// Self-healing by design: delete the env file and restart, and a fresh token is
// issued and the old one revoked. That is also the recovery path if the file
// ever leaks.
func EnsureCredential(ctx context.Context, st *store.Store, a *auth.Service, home, origin string) error {
	users, err := st.ListUsers(ctx)
	if err != nil {
		return err
	}
	if len(users) == 0 {
		// Nothing to attach a token to yet. This is the ordinary state of a box
		// whose owner has not registered a passkey; it will resolve on the next
		// start after enrollment.
		return nil
	}
	owner := users[0]

	path := filepath.Join(home, ".config", "herdrer", "agent.env")
	_, statErr := os.Stat(path)
	haveFile := statErr == nil

	_, tokErr := st.LiveAPITokenByName(ctx, owner.ID, TokenName)
	haveToken := tokErr == nil
	if tokErr != nil && !errors.Is(tokErr, store.ErrNotFound) {
		return tokErr
	}

	if haveFile && haveToken {
		return nil
	}

	// Either half is missing, so the pair is not trustworthy: revoke whatever
	// is there and issue a matched set. A token whose plaintext nothing holds
	// is only a liability.
	if haveToken {
		if t, err := st.LiveAPITokenByName(ctx, owner.ID, TokenName); err == nil {
			_ = st.RevokeAPIToken(ctx, owner.ID, t.ID)
			slog.Info("revoked an agent token with no matching credential file", "id", t.ID)
		}
	}

	_, secret, err := a.MintToken(ctx, owner.ID, TokenName, []string{
		auth.ScopeReviewWrite, auth.ScopeReviewRead, auth.ScopeTaskClaim,
	}, 0)
	if err != nil {
		return fmt.Errorf("mint agent token: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	body := fmt.Sprintf(`# Credential the coding agents on this box use to reach herdrer.
#
# Written and maintained by herdrer itself — delete this file and restart to
# rotate the token; the old one is revoked automatically.
#
# Scoped to review only. It can raise a question and read the answer. It cannot
# open a terminal, mint another token, or read anything another agent submitted.
export HERDRER_URL=%s
export HERDRER_TOKEN=%s
`, origin, secret)

	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	slog.Info("provisioned an agent credential", "path", path, "owner", owner.Handle)

	// Make sure an interactive shell actually picks it up, or the token exists
	// and no agent ever sees it.
	return ensureBashrcSources(home, path)
}

// ensureBashrcSources adds the one line that puts the credential into every
// pane Herdr spawns. Appends once, and never rewrites the file.
func ensureBashrcSources(home, envPath string) error {
	rc := filepath.Join(home, ".bashrc")
	cur, err := os.ReadFile(rc)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if strings.Contains(string(cur), ".config/herdrer/agent.env") {
		return nil
	}
	f, err := os.OpenFile(rc, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = fmt.Fprintf(f, `
# herdrer — the review inbox agents escalate to. Kept in its own 0600 file so
# the token is not sitting in a world-readable dotfile.
[ -f "%s" ] && . "%s"
`, envPath, envPath)
	return err
}
