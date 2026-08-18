package api

import (
	"net/http"
)

// routes builds the mux.
//
// The application has exactly three trees, and the split is the primary
// authorisation control in the system:
//
//	/api/v1/auth/…     open, rate limited, and the ONLY unauthenticated writes
//	                   in the process. Every one of them is a step in a
//	                   WebAuthn ceremony.
//	/api/v1/…          human tree. requireSession. A passkey assertion is the
//	                   only way in. The terminal lives here and nowhere else.
//	/api/v1/agent/…    agent tree. requireToken with an explicit scope. No
//	                   handler under this prefix can reach a PTY, and no code
//	                   path converts a token into a session.
//
// A route registered under the wrong prefix is a privilege escalation, so the
// prefixes are asserted in routes_test.go rather than left to review.
func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	// --- unauthenticated: the ceremony, and nothing else ---------------------
	open := func(pattern string, h http.HandlerFunc, l *limiter) {
		mux.Handle(pattern, chain(h, s.rateLimit(l)))
	}
	open("POST /api/v1/auth/login/begin", s.handleLoginBegin, s.loginLimit)
	open("POST /api/v1/auth/login/finish", s.handleLoginFinish, s.loginLimit)
	open("POST /api/v1/auth/register/begin", s.handleRegisterBegin, s.enrollLimit)
	open("POST /api/v1/auth/register/finish", s.handleRegisterFinish, s.enrollLimit)
	mux.HandleFunc("GET /api/v1/auth/state", s.handleAuthState)
	mux.HandleFunc("GET /api/v1/health", s.handleHealth)

	// --- human tree: passkey session required --------------------------------
	human := func(pattern string, h http.HandlerFunc) {
		mux.Handle(pattern, chain(h, s.requireSession))
	}
	human("POST /api/v1/auth/logout", s.handleLogout)
	human("GET /api/v1/me", s.handleMe)
	human("GET /api/v1/bootstrap", s.handleBootstrap)

	// passkeys and sessions
	human("POST /api/v1/auth/stepup/begin", s.handleStepUpBegin)
	human("POST /api/v1/auth/stepup/finish", s.handleStepUpFinish)

	human("GET /api/v1/credentials", s.handleListCredentials)
	human("POST /api/v1/credentials/{id}/terminal", s.handleSetCredentialTerminal)
	human("DELETE /api/v1/credentials/{id}", s.handleDeleteCredential)
	human("POST /api/v1/credentials/enroll", s.handleCreateEnrollment)
	human("GET /api/v1/sessions", s.handleListSessions)
	human("DELETE /api/v1/sessions/{id}", s.handleRevokeSession)
	human("POST /api/v1/sessions/revoke-all", s.handleRevokeAllSessions)

	// agent tokens are minted by a human, never by an agent
	human("GET /api/v1/tokens", s.handleListTokens)
	human("POST /api/v1/tokens", s.handleCreateToken)
	human("DELETE /api/v1/tokens/{id}", s.handleRevokeToken)

	// the review inbox
	human("GET /api/v1/review", s.handleListReview)
	human("GET /api/v1/review/{id}", s.handleGetReview)
	human("POST /api/v1/review/{id}/answer", s.handleAnswerReview)
	human("DELETE /api/v1/review/{id}", s.handleDismissReview)
	human("GET /api/v1/review/{id}/render", s.handleRenderReview)

	// the reverse channel: a human queues work for an idle agent
	human("GET /api/v1/tasks", s.handleListTasks)
	human("POST /api/v1/tasks", s.handleCreateTask)

	// notifications
	human("GET /api/v1/push/key", s.handlePushKey)
	human("POST /api/v1/push/subscribe", s.handlePushSubscribe)
	human("POST /api/v1/push/test", s.handlePushTest)

	// audit
	human("GET /api/v1/audit", s.handleAudit)

	// the terminal. A ticket is minted by an authenticated same-origin fetch
	// and redeemed once, seconds later, on the upgrade.
	human("GET /api/v1/agents", s.handleListAgents)
	human("POST /api/v1/terminal/ticket", s.handleTerminalTicket)
	human("POST /api/v1/stream/ticket", s.handleStreamTicket)

	// --- websockets ----------------------------------------------------------
	// Upgrades authenticate on the ticket, check Origin themselves, and are
	// registered outside the session middleware because an upgrade is not a
	// normal request. Both handlers refuse a bearer token unconditionally.
	mux.HandleFunc("GET /ws/terminal", s.handleTerminalSocket)
	mux.HandleFunc("GET /ws/stream", s.handleStreamSocket)

	// --- agent tree: bearer token required, scoped ---------------------------
	agent := func(pattern string, h http.HandlerFunc, scope string) {
		mux.Handle(pattern, chain(h, s.rateLimit(s.agentLimit), s.requireToken(scope)))
	}
	agent("POST /api/v1/agent/review", s.handleAgentCreateReview, "review:write")
	agent("GET /api/v1/agent/review/{id}", s.handleAgentGetReview, "review:read")
	agent("DELETE /api/v1/agent/review/{id}", s.handleAgentCancelReview, "review:write")
	agent("GET /api/v1/agent/review", s.handleAgentListReview, "review:read")
	agent("GET /api/v1/agent/tasks/claim", s.handleAgentClaimTask, "task:claim")
	agent("POST /api/v1/agent/tasks/{id}/complete", s.handleAgentCompleteTask, "task:claim")

	// --- static: the SPA and the vended agent skill --------------------------
	mux.HandleFunc("GET /onboard/skill.md", s.handleSkillMarkdown)
	mux.Handle("/", s.spaHandler())

	return chain(mux, s.securityHeaders, s.requireSameOrigin)
}
