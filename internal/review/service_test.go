package review

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jclement/herdrer/internal/store"
)

// newTestService returns a service, its store, the user id, and a real agent
// token id — the token row has to exist because review_items.token_id is a
// foreign key, which is itself the guarantee that an item always traces back to
// a credential someone can revoke.
func newTestService(t *testing.T) (*Service, *store.Store, string, string) {
	t.Helper()
	dir := t.TempDir()
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	u := &store.User{ID: "u1", Handle: "jeff", DisplayName: "Jeff", Role: "admin", CreatedAt: time.Now()}
	if err := st.CreateUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	tok := &store.APIToken{
		ID: "tok1", UserID: u.ID, Name: "test-agent", TokenPrefix: "sk_testtok",
		Scopes: []string{"review:write"}, CreatedAt: time.Now(),
	}
	if err := st.CreateAPIToken(ctx, tok, "hash-not-a-real-token"); err != nil {
		t.Fatal(err)
	}
	return New(st, nil, nil, 5, 24, 168), st, u.ID, tok.ID
}

// TestChoiceRequiresRecommendation enforces the rule that an agent must have an
// opinion. Presenting options with no recommendation offloads the thinking onto
// the human, which is the resource the whole subsystem exists to conserve.
func TestChoiceRequiresRecommendation(t *testing.T) {
	svc, _, uid, tokID := newTestService(t)
	_, err := svc.Create(context.Background(), uid, tokID, CreateRequest{
		Title: "A or B?", Kind: KindChoice,
		Options: []store.Option{{Key: "A", Label: "one"}, {Key: "B", Label: "two"}},
	})
	if err == nil || !strings.Contains(err.Error(), "recommend") {
		t.Fatalf("want a recommend error, got %v", err)
	}

	_, err = svc.Create(context.Background(), uid, tokID, CreateRequest{
		Title: "A or B?", Kind: KindChoice, Recommend: "C",
		Options: []store.Option{{Key: "A", Label: "one"}, {Key: "B", Label: "two"}},
	})
	if err == nil {
		t.Fatal("a recommendation naming a non-existent option was accepted")
	}
}

// TestBackpressure proves a chatty agent gets refused rather than burying the
// human deeper.
func TestBackpressure(t *testing.T) {
	svc, _, uid, tokID := newTestService(t)
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		if _, err := svc.Create(ctx, uid, tokID, CreateRequest{
			Title: "q", Kind: KindConfirm, Recommend: "yes",
		}); err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
	}
	if _, err := svc.Create(ctx, uid, tokID, CreateRequest{
		Title: "one too many", Kind: KindConfirm, Recommend: "yes",
	}); err == nil {
		t.Fatal("the sixth open item was accepted despite the cap")
	}
}

// TestExpiryIsNotConsent is the most important test in the package.
//
// An item that nobody answered must come back expired with no answer, and the
// sweep must actually write that status rather than leaving it computed at read
// time — an agent blocked in Wait can only be released by a real transition.
func TestExpiryIsNotConsent(t *testing.T) {
	svc, st, uid, tokID := newTestService(t)
	ctx := context.Background()

	it, err := svc.Create(ctx, uid, tokID, CreateRequest{
		Title: "drop the column?", Kind: KindConfirm, Recommend: "yes",
	})
	if err != nil {
		t.Fatal(err)
	}
	// Backdate the expiry rather than waiting for it.
	if _, err := st.DB().ExecContext(ctx,
		`UPDATE review_items SET expires_at = ? WHERE id = ?`, time.Now().Add(-time.Minute).Unix(), it.ID); err != nil {
		t.Fatal(err)
	}

	ids, err := st.SweepExpired(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != it.ID {
		t.Fatalf("sweep returned %v, want [%s]", ids, it.ID)
	}

	got, err := st.GetReviewItem(ctx, it.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != store.StatusExpired {
		t.Fatalf("status = %q, want expired", got.Status)
	}
	if got.AnswerValue != nil {
		t.Fatalf("an expired item carries an answer: %v", *got.AnswerValue)
	}

	// And it can no longer be answered into a stale state.
	if _, err := svc.Answer(ctx, it.ID, uid, "yes", ""); err == nil {
		t.Fatal("an expired item accepted an answer")
	}
}

// TestAnswerIsExactlyOnce covers the double-tap on a flaky phone connection.
func TestAnswerIsExactlyOnce(t *testing.T) {
	svc, _, uid, tokID := newTestService(t)
	ctx := context.Background()
	it, err := svc.Create(ctx, uid, tokID, CreateRequest{
		Title: "ship it?", Kind: KindConfirm, Recommend: "yes",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Answer(ctx, it.ID, uid, "yes", "go"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Answer(ctx, it.ID, uid, "no", "wait"); err == nil {
		t.Fatal("a second answer overwrote the first")
	}
	got, _ := svc.st.GetReviewItem(ctx, it.ID)
	if got.AnswerValue == nil || *got.AnswerValue != "yes" {
		t.Fatalf("answer changed: %v", got.AnswerValue)
	}
}

// TestWaitReleasesOnAnswer proves the long-poll actually unblocks.
func TestWaitReleasesOnAnswer(t *testing.T) {
	svc, _, uid, tokID := newTestService(t)
	ctx := context.Background()
	it, err := svc.Create(ctx, uid, tokID, CreateRequest{
		Title: "go?", Kind: KindConfirm, Recommend: "yes",
	})
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan *store.ReviewItem, 1)
	go func() {
		out, err := svc.Wait(ctx, it.ID, 5*time.Second, nil)
		if err != nil {
			t.Error(err)
		}
		done <- out
	}()

	time.Sleep(50 * time.Millisecond)
	if _, err := svc.Answer(ctx, it.ID, uid, "no", "not yet"); err != nil {
		t.Fatal(err)
	}

	select {
	case out := <-done:
		if out.Status != store.StatusAnswered {
			t.Fatalf("Wait returned status %q", out.Status)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Wait did not return after the item was answered")
	}
}

// TestRendererEscapesHostileMarkdown checks the first two sanitisation layers.
// Layer three, the sandboxed iframe, is what actually holds — but these keep it
// from being tested in production.
func TestRendererEscapesHostileMarkdown(t *testing.T) {
	r := NewRenderer()
	hostile := "# hi\n\n<script>fetch('/api/v1/tokens')</script>\n\n" +
		"<img src=x onerror=alert(1)>\n\n" +
		"[click](javascript:alert(1))\n\n" +
		"<iframe src=\"https://evil.example\"></iframe>"

	out, err := r.Fragment(hostile)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"<script", "onerror", "javascript:", "<iframe"} {
		if strings.Contains(strings.ToLower(out), bad) {
			t.Errorf("sanitised output still contains %q:\n%s", bad, out)
		}
	}
}

// TestDocumentCarriesLockedDownCSP checks the policy the iframe relies on.
func TestDocumentCarriesLockedDownCSP(t *testing.T) {
	r := NewRenderer()
	doc, err := r.Document("t", []Section{{Kind: "markdown", Content: "hello"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, must := range []string{"default-src 'none'", "connect-src 'none'", "'strict-dynamic'"} {
		if !strings.Contains(doc, must) {
			t.Errorf("render document CSP missing %q", must)
		}
	}
	if strings.Contains(doc, "script-src 'self'") {
		t.Error("render document uses 'self', which matches nothing in an opaque origin")
	}
}

// TestDocumentMatchesSPAContract pins the two details the SPA depends on and
// that nothing else would catch: the height message shape it validates, and
// the per-attachment anchor it deep-links to. Both are cross-package contracts
// with no compiler between them.
func TestDocumentMatchesSPAContract(t *testing.T) {
	r := NewRenderer()
	doc, err := r.Document("t", []Section{
		{ID: "at_abc", Kind: "diff", Title: "migration", Content: "--- a\n+++ b\n"},
		{ID: "at_def", Kind: "mermaid", Content: "flowchart LR\n A-->B\n"},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(doc, `{type:"herdrer:height"`) {
		t.Error(`height message must be {type:"herdrer:height", height:n} — the SPA drops any other shape`)
	}
	for _, id := range []string{`id="a-at_abc"`, `id="a-at_def"`} {
		if !strings.Contains(doc, id) {
			t.Errorf("document missing anchor %s", id)
		}
	}
	// Self-contained: an opaque origin cannot resolve 'self', so any external
	// subresource would simply fail to load.
	for _, bad := range []string{"<link ", "src=\"http", "@import"} {
		if strings.Contains(doc, bad) {
			t.Errorf("document is not self-contained, found %q", bad)
		}
	}
}

// TestDocumentLoadsMermaidOnlyWhenNeeded pins the diagram bootstrap.
//
// The bundle is 3.2 MB, so a document with no diagram must not pull it. And the
// injection must stay a classic script: a module script is fetched in CORS mode,
// and the sandboxed frame's opaque origin sends `Origin: null`, so a module
// would need CORS headers the asset does not serve. That failure only shows up
// inside the sandbox, which is the worst place to debug it.
func TestDocumentLoadsMermaidOnlyWhenNeeded(t *testing.T) {
	r := NewRenderer()

	plain, err := r.Document("t", []Section{{Kind: "markdown", Content: "# hi"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plain, "mermaid-frame.js") {
		t.Error("a document with no diagram still loads the 3.2 MB mermaid bundle")
	}

	withDiagram, err := r.Document("t", []Section{
		{Kind: "mermaid", ID: "at_1", Content: "flowchart LR\n A-->B\n"},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(withDiagram, "/assets/mermaid-frame.js") {
		t.Error("a document with a diagram does not load the renderer")
	}
	if strings.Contains(withDiagram, `type="module"`) || strings.Contains(withDiagram, "s.type") {
		t.Error("the bundle must be injected as a classic script; a module is fetched in CORS mode")
	}
	// The diagram source must still be present, so a failed load degrades to
	// readable source rather than a blank box.
	if !strings.Contains(withDiagram, "flowchart LR") {
		t.Error("diagram source is not in the document; a failed load would show nothing")
	}
}
