package api

import (
	"net/http"

	"github.com/jclement/herdrer/internal/agentskill"
)

// handleSkillMarkdown vends the agent skill.
//
// The service serves the document that teaches an agent to use it, so the
// instructions can never drift from the deployment they describe. It is
// unauthenticated on purpose: it is documentation, it contains no data, and an
// agent needs to fetch it before it has a token.
func (s *Server) handleSkillMarkdown(w http.ResponseWriter, r *http.Request) {
	doc := agentskill.Render(s.cfg.Origin)
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write([]byte(doc))
}
