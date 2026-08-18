// Package notify wakes a human. Web Push is the primary transport, sent
// directly from this binary — there is no relay, so nothing but the browser
// vendor's push service sits between herdrer and the phone, and the payload it
// carries is end-to-end encrypted to the subscription's keys.
package notify

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"github.com/jclement/herdrer/internal/store"
)

// Service sends notifications.
type Service struct {
	st       *store.Store
	origin   string
	vapidPub string
	vapidPrv string
	subject  string
	ntfyURL  string
}

type vapidFile struct {
	Public  string `json:"public_key"`
	Private string `json:"private_key"`
}

// New loads or generates the VAPID keypair.
//
// The keypair is identity, not a secret to be rotated casually: regenerating it
// invalidates every existing push subscription, so it is written once to the
// state directory at 0600 and reused thereafter.
func New(st *store.Store, statePath, origin, pub, prv, subject, ntfyURL string) (*Service, error) {
	if pub == "" || prv == "" {
		var err error
		pub, prv, err = loadOrCreateVAPID(statePath)
		if err != nil {
			return nil, err
		}
	}
	if subject == "" {
		subject = origin
	}
	return &Service{st: st, origin: origin, vapidPub: pub, vapidPrv: prv,
		subject: subject, ntfyURL: ntfyURL}, nil
}

func loadOrCreateVAPID(path string) (pub, prv string, err error) {
	if b, err := os.ReadFile(path); err == nil {
		var f vapidFile
		if json.Unmarshal(b, &f) == nil && f.Public != "" && f.Private != "" {
			return f.Public, f.Private, nil
		}
	}
	prv, pub, err = webpush.GenerateVAPIDKeys()
	if err != nil {
		return "", "", fmt.Errorf("generate VAPID keys: %w", err)
	}
	b, _ := json.MarshalIndent(vapidFile{Public: pub, Private: prv}, "", "  ")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", "", err
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return "", "", fmt.Errorf("write VAPID keys: %w", err)
	}
	slog.Info("generated VAPID keypair", "path", path)
	return pub, prv, nil
}

// PublicKey is handed to the browser to create a subscription.
func (s *Service) PublicKey() string { return s.vapidPub }

// Payload is what the service worker receives.
type Payload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag,omitempty"`
	Kind  string `json:"kind,omitempty"`
}

// NotifyReview pushes a newly submitted review item.
//
// The body carries the actual question. herdr-web argued for contentless
// pushes, but that was to keep plaintext away from an untrusted relay; there is
// no relay here, and a Web Push payload is encrypted to keys only the
// subscribed browser holds. A notification that says "an agent needs you" and
// nothing else is one the human has to unlock a phone to triage, which defeats
// the point.
func (s *Service) NotifyReview(ctx context.Context, userID string, it *store.ReviewItem) {
	title := "Needs you"
	if it.Urgency == "blocking" {
		title = "Blocking"
	}
	body := it.Title
	if repo, ok := it.Context["repo"].(string); ok && repo != "" {
		body = repo + " — " + it.Title
	}
	s.Send(ctx, userID, Payload{
		Title: title, Body: body,
		URL: strings.TrimRight(s.origin, "/") + "/r/" + it.ID,
		Tag: it.ID, Kind: "review",
	})
}

// Send delivers a payload to every live subscription for a user.
func (s *Service) Send(ctx context.Context, userID string, p Payload) {
	subs, err := s.st.ListPushSubs(ctx, userID)
	if err != nil {
		slog.Error("list push subscriptions", "err", err)
		return
	}
	// Say so when there is nothing to send to. Silence here was
	// indistinguishable from a successful send, which is the state you are in
	// when someone reports "notifications do not work" — and on iOS the
	// overwhelmingly likely cause is that no subscription exists at all,
	// because Safari only grants one to a PWA installed to the home screen.
	if len(subs) == 0 {
		slog.Warn("push: nothing to deliver to — no subscriptions for this user",
			"user", userID, "title", p.Title)
		return
	}
	body, _ := json.Marshal(p)

	for _, sub := range subs {
		ws := &webpush.Subscription{
			Endpoint: sub.Endpoint,
			Keys:     webpush.Keys{P256dh: sub.P256dh, Auth: sub.Auth},
		}
		resp, err := webpush.SendNotificationWithContext(ctx, body, ws, &webpush.Options{
			Subscriber:      s.subject,
			VAPIDPublicKey:  s.vapidPub,
			VAPIDPrivateKey: s.vapidPrv,
			TTL:             86400,
			Urgency:         webpush.UrgencyHigh,
		})
		if err != nil {
			slog.Warn("push failed", "endpoint", truncEndpoint(sub.Endpoint),
				"ua", truncUA(sub.UserAgent), "err", err)
			_ = s.st.RecordPushAttempt(ctx, sub.ID, 0, err.Error())
			continue
		}
		// 404 and 410 mean the subscription is gone for good — the browser
		// uninstalled the PWA or the push service expired it. Anything else is
		// transient and the subscription is left alone.
		switch {
		case resp.StatusCode == http.StatusNotFound, resp.StatusCode == http.StatusGone:
			slog.Info("push subscription expired, removing",
				"endpoint", truncEndpoint(sub.Endpoint), "ua", truncUA(sub.UserAgent))
			_ = s.st.DeletePushSub(ctx, sub.ID)
		case resp.StatusCode >= 300:
			// Read a little of the body: push services explain themselves
			// there, and the status alone rarely says which of several
			// things went wrong.
			detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
			slog.Warn("push rejected", "status", resp.StatusCode,
				"endpoint", truncEndpoint(sub.Endpoint), "ua", truncUA(sub.UserAgent),
				"detail", strings.TrimSpace(string(detail)))
			_ = s.st.RecordPushAttempt(ctx, sub.ID, resp.StatusCode, strings.TrimSpace(string(detail)))
			_ = s.st.MarkPushFailed(ctx, sub.ID)
		default:
			// Log success too. A send path that is quiet when it works and
			// quiet when it is never called cannot be debugged from a phone.
			slog.Info("push delivered", "status", resp.StatusCode,
				"endpoint", truncEndpoint(sub.Endpoint), "ua", truncUA(sub.UserAgent),
				"title", p.Title)
			_ = s.st.RecordPushAttempt(ctx, sub.ID, resp.StatusCode, "")
		}
		resp.Body.Close()
	}

	if s.ntfyURL != "" && p.Kind == "review" {
		s.sendNtfy(ctx, p)
	}
}

// sendNtfy is the escalation path — a second channel for when the phone is not
// carrying the PWA, or web push has silently rotted, which it does.
func (s *Service) sendNtfy(ctx context.Context, p Payload) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.ntfyURL, strings.NewReader(p.Body))
	if err != nil {
		return
	}
	req.Header.Set("Title", p.Title)
	req.Header.Set("Click", p.URL)
	req.Header.Set("Priority", "high")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		slog.Warn("ntfy failed", "err", err)
		return
	}
	resp.Body.Close()
}

// truncUA keeps the log readable while still identifying the device, which is
// usually the answer: a Mac subscription and a missing iPhone one look very
// different and mean very different things.
func truncUA(ua string) string {
	if i := strings.Index(ua, ")"); i > 0 {
		return ua[:i+1]
	}
	if len(ua) > 48 {
		return ua[:48]
	}
	return ua
}

func truncEndpoint(e string) string {
	if len(e) > 60 {
		return e[:60] + "…"
	}
	return e
}
