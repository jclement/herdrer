package api

import (
	"net/http"

	"github.com/jclement/herdrer/internal/auth"
	"github.com/jclement/herdrer/internal/config"
	"github.com/jclement/herdrer/internal/notify"
	"github.com/jclement/herdrer/internal/paste"
	"github.com/jclement/herdrer/internal/review"
	"github.com/jclement/herdrer/internal/store"
	"github.com/jclement/herdrer/internal/tasks"
	"github.com/jclement/herdrer/internal/terminal"
)

// Server holds everything the HTTP layer needs.
type Server struct {
	cfg      *config.Config
	st       *store.Store
	auth     *auth.Service
	review   *review.Service
	terminal *terminal.Service
	notify   *notify.Service
	pastes   *paste.Store
	assets   *review.AssetStore
	ptys     *terminal.Manager
	bus      *Bus
	tasks    *tasks.Service
	version  string

	loginLimit  *limiter
	enrollLimit *limiter
	agentLimit  *limiter

	handler http.Handler
}

// NewServer wires the routes.
func NewServer(cfg *config.Config, st *store.Store, a *auth.Service, rv *review.Service,
	tm *terminal.Service, ptys *terminal.Manager, nt *notify.Service, bus *Bus,
	pastes *paste.Store, assets *review.AssetStore, tk *tasks.Service, version string) *Server {
	s := &Server{
		cfg: cfg, st: st, auth: a, review: rv, terminal: tm, ptys: ptys,
		notify: nt, bus: bus, pastes: pastes, assets: assets, tasks: tk, version: version,
		// Ten login attempts a minute is generous for a human and ruinous for
		// an online guesser; the enrollment code gets a tighter bucket because
		// it is the one secret that is short enough to be worth guessing.
		loginLimit:  newLimiter(30, 10),
		enrollLimit: newLimiter(6, 3),
		agentLimit:  newLimiter(600, 60),
	}
	s.handler = s.routes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}
