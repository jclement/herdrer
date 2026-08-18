package auth

// Scopes an agent token may carry.
//
// The set is short on purpose, and there is no terminal scope. A token cannot
// request shell access because no scope exists that would grant it: the
// terminal routes require a session, and sessions are only ever created by a
// WebAuthn assertion.
const (
	// ScopeReviewWrite lets an agent submit review items and read the answers
	// to items it submitted.
	ScopeReviewWrite = "review:write"
	// ScopeReviewRead lets an agent list its own open items.
	ScopeReviewRead = "review:read"
	// ScopeTaskClaim lets an idle agent claim tasks the human queued.
	ScopeTaskClaim = "task:claim"
	// ScopeAgentsRead lets a token read agent status — no keystrokes, no shell.
	ScopeAgentsRead = "agents:read"
)

// AllScopes is the complete set, for validation and for the settings UI.
var AllScopes = []string{ScopeReviewWrite, ScopeReviewRead, ScopeTaskClaim, ScopeAgentsRead}

func validScope(s string) bool {
	for _, v := range AllScopes {
		if v == s {
			return true
		}
	}
	return false
}
