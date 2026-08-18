// Package review owns the Human Review subsystem: the documents agents submit,
// the answers humans give, and the blocking call that connects the two.
package review

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/jclement/herdrer/internal/store"
)

// Item kinds.
const (
	KindConfirm = "confirm"
	KindChoice  = "choice"
	KindAck     = "ack"
	KindManual  = "manual"
	KindReview  = "review"
)

// Urgency levels.
const (
	UrgencyLow      = "low"
	UrgencyNormal   = "normal"
	UrgencyBlocking = "blocking"
)

// Notifier is how the review service wakes a human. Implemented by the notify
// package; kept as an interface so review does not depend on push transport.
type Notifier interface {
	NotifyReview(ctx context.Context, userID string, it *store.ReviewItem)
}

// Broadcaster publishes realtime events to connected browsers.
type Broadcaster interface {
	Publish(userID string, event any)
}

// Service is the review subsystem.
type Service struct {
	st       *store.Store
	render   *Renderer
	notifier Notifier
	bus      Broadcaster

	maxOpen      int
	defaultHours int
	maxHours     int

	// waiters lets a long-poll block on a specific item without polling the
	// database. Each waiter is closed exactly once, by whichever transition
	// resolves the item.
	mu      sync.Mutex
	waiters map[string][]chan struct{}
}

// New builds the service.
func New(st *store.Store, notifier Notifier, bus Broadcaster, maxOpen, defaultHours, maxHours int) *Service {
	return &Service{
		st: st, render: NewRenderer(), notifier: notifier, bus: bus,
		maxOpen: maxOpen, defaultHours: defaultHours, maxHours: maxHours,
		waiters: map[string][]chan struct{}{},
	}
}

// Renderer exposes the HTML pipeline for the render endpoint.
func (s *Service) Renderer() *Renderer { return s.render }

// CreateRequest is what an agent posts.
type CreateRequest struct {
	Title          string             `json:"title"`
	BodyMD         string             `json:"body_md"`
	Kind           string             `json:"kind"`
	Options        []store.Option     `json:"options"`
	Recommend      string             `json:"recommend"`
	Attachments    []store.Attachment `json:"attachments"`
	Context        map[string]any     `json:"context"`
	Urgency        string             `json:"urgency"`
	ExpiresInHours int                `json:"expires_in_hours"`
}

// Create validates and stores a review item, then wakes the human.
func (s *Service) Create(ctx context.Context, userID, tokenID string, req CreateRequest) (*store.ReviewItem, error) {
	if err := s.validate(&req); err != nil {
		return nil, err
	}

	// Backpressure. An agent that has already left a pile of unanswered
	// questions gets refused rather than burying the human deeper — the
	// expensive resource here is attention, and the whole point of the design
	// is to spend it rarely and well.
	if tokenID != "" {
		open, err := s.st.CountOpenForToken(ctx, tokenID)
		if err != nil {
			return nil, err
		}
		if open >= s.maxOpen {
			return nil, fmt.Errorf("%w: this agent already has %d open items; answer or cancel some first",
				ErrBackpressure, open)
		}
	}

	hours := req.ExpiresInHours
	if hours <= 0 {
		hours = s.defaultHours
	}
	if hours > s.maxHours {
		hours = s.maxHours
	}

	now := time.Now()
	it := &store.ReviewItem{
		ID:     "rv_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16],
		UserID: userID, Direction: "ask", Kind: req.Kind, Title: req.Title,
		BodyMD: req.BodyMD, Options: req.Options, Context: req.Context,
		Urgency: req.Urgency, Status: store.StatusOpen,
		CreatedAt: now, ExpiresAt: now.Add(time.Duration(hours) * time.Hour),
	}
	if tokenID != "" {
		it.TokenID = &tokenID
	}
	if req.Recommend != "" {
		it.Recommend = &req.Recommend
	}
	for i := range req.Attachments {
		a := req.Attachments[i]
		a.ID = "at_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16]
		it.Attachments = append(it.Attachments, a)
	}

	if err := s.st.CreateReviewItem(ctx, it); err != nil {
		return nil, err
	}

	if s.notifier != nil {
		go s.notifier.NotifyReview(context.WithoutCancel(ctx), userID, it)
	}
	s.publish(userID, map[string]any{"type": "review.created", "id": it.ID, "urgency": it.Urgency})
	return it, nil
}

// ErrBackpressure means the agent has too many open items.
var ErrBackpressure = fmt.Errorf("too many open items")

// ErrValidation means the submission was malformed.
var ErrValidation = fmt.Errorf("validation")

func (s *Service) validate(req *CreateRequest) error {
	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" {
		return fmt.Errorf("%w: title is required", ErrValidation)
	}
	if len(req.Title) > 300 {
		return fmt.Errorf("%w: title must be 300 characters or fewer", ErrValidation)
	}
	if req.Kind == "" {
		req.Kind = KindConfirm
	}
	switch req.Kind {
	case KindConfirm, KindChoice, KindAck, KindManual, KindReview:
	default:
		return fmt.Errorf("%w: kind must be confirm, choice, ack, manual or review", ErrValidation)
	}
	switch req.Urgency {
	case "":
		req.Urgency = UrgencyNormal
	case UrgencyLow, UrgencyNormal, UrgencyBlocking:
	default:
		return fmt.Errorf("%w: urgency must be low, normal or blocking", ErrValidation)
	}

	if req.Kind == KindChoice {
		if len(req.Options) < 2 {
			return fmt.Errorf("%w: a choice needs at least two options", ErrValidation)
		}
		if len(req.Options) > 6 {
			return fmt.Errorf("%w: more than six options is a menu, not a decision", ErrValidation)
		}
		seen := map[string]bool{}
		for _, o := range req.Options {
			if strings.TrimSpace(o.Key) == "" || strings.TrimSpace(o.Label) == "" {
				return fmt.Errorf("%w: every option needs a key and a label", ErrValidation)
			}
			if seen[o.Key] {
				return fmt.Errorf("%w: duplicate option key %q", ErrValidation, o.Key)
			}
			seen[o.Key] = true
		}
		if req.Recommend == "" || !seen[req.Recommend] {
			// Presenting options with no opinion offloads the thinking onto the
			// expensive model. Refuse it.
			return fmt.Errorf("%w: recommend is required for a choice and must name one of the options", ErrValidation)
		}
	}
	if req.Kind == KindConfirm {
		switch req.Recommend {
		case "yes", "no":
		default:
			return fmt.Errorf("%w: recommend is required for a confirm and must be \"yes\" or \"no\"", ErrValidation)
		}
	}

	for i, a := range req.Attachments {
		switch a.Kind {
		case "diff", "code", "markdown", "mermaid":
		default:
			return fmt.Errorf("%w: attachment %d kind must be diff, code, markdown or mermaid", ErrValidation, i)
		}
		if len(a.Content) > 512*1024 {
			return fmt.Errorf("%w: attachment %d is over 512 KiB; link to it instead", ErrValidation, i)
		}
	}
	if len(req.BodyMD) > 512*1024 {
		return fmt.Errorf("%w: body_md is over 512 KiB", ErrValidation)
	}
	return nil
}

// Answer records a human decision and releases anything waiting on it.
func (s *Service) Answer(ctx context.Context, id, userID, value, note string) (*store.ReviewItem, error) {
	it, err := s.st.GetReviewItem(ctx, id)
	if err != nil {
		return nil, err
	}
	if it.UserID != userID {
		return nil, store.ErrNotFound
	}
	if err := s.validateAnswer(it, value); err != nil {
		return nil, err
	}
	out, err := s.st.AnswerReviewItem(ctx, id, userID, value, note)
	if err != nil {
		return nil, err
	}
	s.wake(id)
	s.publish(userID, map[string]any{"type": "review.answered", "id": id})
	return out, nil
}

func (s *Service) validateAnswer(it *store.ReviewItem, value string) error {
	switch it.Kind {
	case KindConfirm:
		if value != "yes" && value != "no" {
			return fmt.Errorf("%w: answer must be yes or no", ErrValidation)
		}
	case KindChoice:
		for _, o := range it.Options {
			if o.Key == value {
				return nil
			}
		}
		return fmt.Errorf("%w: answer must name one of the options", ErrValidation)
	case KindAck:
		if value != "ack" {
			return fmt.Errorf("%w: answer must be ack", ErrValidation)
		}
	}
	return nil
}

// Cancel withdraws an item.
func (s *Service) Cancel(ctx context.Context, id string, tokenID, userID *string) error {
	if err := s.st.CancelReviewItem(ctx, id, tokenID, userID); err != nil {
		return err
	}
	s.wake(id)
	return nil
}

// --- long-poll -----------------------------------------------------------------

// Wait blocks until the item leaves the open state, the context ends, or the
// timeout elapses. It returns the item as it stands when it returns.
//
// This is the call that turns "ask a human" into an ordinary blocking function
// for an agent. It is a loop the agent runs, not a promise the server makes:
// on timeout the item comes back still open and the agent re-issues.
func (s *Service) Wait(ctx context.Context, id string, timeout time.Duration, heartbeat func()) (*store.ReviewItem, error) {
	it, err := s.st.GetReviewItem(ctx, id)
	if err != nil {
		return nil, err
	}
	if it.Status != store.StatusOpen {
		return it, nil
	}

	ch := s.subscribe(id)
	defer s.unsubscribe(id, ch)

	// Re-read after subscribing to close the race where the item was answered
	// between the first read and the subscription.
	if it, err = s.st.GetReviewItem(ctx, id); err != nil || it.Status != store.StatusOpen {
		return it, err
	}

	deadline := time.After(timeout)
	tick := time.NewTicker(20 * time.Second)
	defer tick.Stop()

	for {
		select {
		case <-ctx.Done():
			return s.st.GetReviewItem(context.WithoutCancel(ctx), id)
		case <-deadline:
			return s.st.GetReviewItem(ctx, id)
		case <-tick.C:
			// A whitespace heartbeat keeps reverse proxies and phone radios
			// from tearing the connection down mid-wait.
			if heartbeat != nil {
				heartbeat()
			}
		case <-ch:
			return s.st.GetReviewItem(ctx, id)
		}
	}
}

func (s *Service) subscribe(id string) chan struct{} {
	ch := make(chan struct{})
	s.mu.Lock()
	s.waiters[id] = append(s.waiters[id], ch)
	s.mu.Unlock()
	return ch
}

func (s *Service) unsubscribe(id string, ch chan struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.waiters[id]
	for i, c := range list {
		if c == ch {
			s.waiters[id] = append(list[:i], list[i+1:]...)
			break
		}
	}
	if len(s.waiters[id]) == 0 {
		delete(s.waiters, id)
	}
}

func (s *Service) wake(id string) {
	s.mu.Lock()
	list := s.waiters[id]
	delete(s.waiters, id)
	s.mu.Unlock()
	for _, ch := range list {
		close(ch)
	}
}

func (s *Service) publish(userID string, ev any) {
	if s.bus != nil {
		s.bus.Publish(userID, ev)
	}
}

// --- expiry --------------------------------------------------------------------

// StartSweeper expires elapsed items on a timer.
//
// Expiry is a swept event rather than a value computed at read time, because a
// status nobody writes is a status nobody can be woken for: an agent blocked in
// Wait would sit past its own deadline waiting for a transition that only
// happens when someone happens to look.
func (s *Service) StartSweeper(ctx context.Context) {
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				ids, err := s.st.SweepExpired(ctx)
				if err != nil {
					slog.Error("expiry sweep failed", "err", err)
					continue
				}
				for _, id := range ids {
					slog.Info("review item expired", "id", id)
					s.wake(id)
				}
				if err := s.st.PurgeExpired(ctx); err != nil {
					slog.Error("purge failed", "err", err)
				}
			}
		}
	}()
}
