package review

import (
	"context"
	"fmt"
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

// TestSyntaxHighlightingCoversTheLanguagesWeCareAbout is a direct answer to
// "does the inbox actually highlight code", asserted rather than assumed.
//
// It covers both routes an agent can send code by: a fenced block inside
// body_md, and a code attachment. They go through different code paths
// (goldmark's extension vs the attachment path), so both are checked.
func TestSyntaxHighlightingCoversTheLanguagesWeCareAbout(t *testing.T) {
	r := NewRenderer()
	samples := map[string]string{
		"csharp":     "public class Foo { public int Bar => 1; }",
		"go":         "func main() { fmt.Println(\"hi\") }",
		"typescript": "const x: number = 1; export default x;",
		"javascript": "const x = 1; export default x;",
		"elixir":     "defmodule Foo do\n  def bar, do: :ok\nend",
		"bash":       "set -euo pipefail\necho \"$HOME\"",
		"diff":       "--- a/x\n+++ b/x\n-old\n+new",
	}

	for lang, src := range samples {
		// Route 1: a code attachment.
		out, ok := highlight(src, lang, false)
		if !ok {
			t.Errorf("%s: attachment was not highlighted", lang)
		}
		if !strings.Contains(out, "<span") {
			t.Errorf("%s: highlighted output has no spans:\n%s", lang, out)
		}

		// Route 2: a fenced block in body_md, which must survive sanitisation.
		frag, err := r.Fragment("```" + lang + "\n" + src + "\n```\n")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(frag, "<span") || !strings.Contains(frag, "class=") {
			t.Errorf("%s: fenced code lost its highlighting to the sanitiser:\n%s", lang, frag)
		}
	}
}

// TestHighlightAliasesAuthorsActuallyType keeps the common short forms working.
func TestHighlightAliasesAuthorsActuallyType(t *testing.T) {
	for _, lang := range []string{"cs", "c#", "ts", "tsx", "js", "ex", "exs", "sh", "shell", "yml", "golang"} {
		if lexerFor(lang) == nil {
			t.Errorf("no lexer resolved for %q, which authors do type", lang)
		}
	}
	// And an unknown language degrades to readable text rather than an error.
	out, ok := highlight("some text", "klingon", false)
	if ok {
		t.Error("an unknown language reported itself highlighted")
	}
	if !strings.Contains(out, "some text") {
		t.Error("an unknown language lost the source")
	}
}

// TestHighlightEscapesHostileSource checks the highlighter cannot be used to
// smuggle markup: the source is agent-authored and may be adversarial.
func TestHighlightEscapesHostileSource(t *testing.T) {
	hostile := `</code></pre><script>fetch('/api/v1/tokens')</script><pre><code>`
	for _, lang := range []string{"go", "bash", "typescript", ""} {
		out, _ := highlight(hostile, lang, false)
		if strings.Contains(strings.ToLower(out), "<script") {
			t.Fatalf("lang=%q: highlighter emitted a live script tag:\n%s", lang, out)
		}
	}
}

// TestDocumentCarriesTheHighlightStylesheet — classed spans with no stylesheet
// are invisible highlighting, which looks exactly like the feature not working.
func TestDocumentCarriesTheHighlightStylesheet(t *testing.T) {
	r := NewRenderer()
	for _, dark := range []bool{false, true} {
		doc, err := r.Document("t", []Section{
			{Kind: "code", Language: "go", Content: "func main() {}", ID: "at_1"},
		}, dark)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(doc, ".chroma") {
			t.Errorf("dark=%v: document has no chroma stylesheet", dark)
		}
	}
	// One stylesheet now carries both palettes, so the dark half must be
	// scoped rather than simply absent — otherwise code is unstyled in dark.
	css := highlightCSS()
	if !strings.Contains(css, `:root[data-theme="dark"] .chroma`) {
		t.Error("no scoped dark rules; highlighted code would be unstyled in dark mode")
	}
	if !strings.Contains(css, "@media (prefers-color-scheme: dark)") {
		t.Error("no platform-preference rules")
	}
}

// TestFileDiffIsComputedServerSide is the point of the feature: the agent sends
// whole files and herdrer decides what the diff looks like. An agent choosing
// which hunks to show is an agent deciding what the human is allowed to notice.
func TestFileDiffIsComputedServerSide(t *testing.T) {
	svc, st, uid, tokID := newTestService(t)
	ctx := context.Background()

	before := "package main\n\nfunc main() {\n\tprintln(\"old\")\n}\n"
	after := "package main\n\nfunc main() {\n\tprintln(\"new\")\n}\n"

	it, err := svc.Create(ctx, uid, tokID, CreateRequest{
		Title: "rename", Kind: KindConfirm, Recommend: "yes",
		Attachments: []store.Attachment{{
			Kind: "filediff", Title: "main.go", Before: before, After: after,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := st.GetReviewItem(ctx, it.ID)
	if err != nil {
		t.Fatal(err)
	}
	a := got.Attachments[0]

	if !strings.Contains(a.Content, `-	println("old")`) || !strings.Contains(a.Content, `+	println("new")`) {
		t.Fatalf("unified diff missing the change:\n%s", a.Content)
	}
	if a.Language != "diff" {
		t.Errorf("language = %q, want diff", a.Language)
	}
	// The originals survive, so the reader can expand past the hunks.
	if a.Before != before || a.After != after {
		t.Error("the before/after originals were not kept")
	}
	// And the title carries the shape of the change.
	if !strings.Contains(a.Title, "+1") || !strings.Contains(a.Title, "1") {
		t.Errorf("title lacks a diffstat: %q", a.Title)
	}
}

// TestFileDiffDefaultsToTheWholeFile checks that context is not silently
// truncated, which would defeat "so you can see a full diff when you need it".
func TestFileDiffDefaultsToTheWholeFile(t *testing.T) {
	var before strings.Builder
	for i := 0; i < 200; i++ {
		fmt.Fprintf(&before, "line %d\n", i)
	}
	after := strings.Replace(before.String(), "line 100\n", "line 100 CHANGED\n", 1)

	unified, err := buildFileDiff("big.txt", before.String(), after, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Full context means the untouched top and bottom of the file are present.
	for _, must := range []string{"line 0", "line 199", "+line 100 CHANGED"} {
		if !strings.Contains(unified, must) {
			t.Errorf("full-context diff is missing %q", must)
		}
	}

	// An explicit context narrows it, for an agent that wants to.
	narrow, err := buildFileDiff("big.txt", before.String(), after, 2)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(narrow, "line 0\n") {
		t.Error("context=2 still included the whole file")
	}
}

// TestIdenticalFilesSaySo — an empty diff box reads as a rendering bug.
func TestIdenticalFilesSaySo(t *testing.T) {
	svc, st, uid, tokID := newTestService(t)
	ctx := context.Background()
	it, err := svc.Create(ctx, uid, tokID, CreateRequest{
		Title: "no change", Kind: KindAck,
		Attachments: []store.Attachment{{
			Kind: "filediff", Title: "same.go", Before: "a\n", After: "a\n",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := st.GetReviewItem(ctx, it.ID)
	if !strings.Contains(got.Attachments[0].Content, "identical") {
		t.Errorf("identical files rendered as %q", got.Attachments[0].Content)
	}
}

// TestCRLFDoesNotDiffAsEveryLine catches the classic false diff from a file
// that came off a Windows checkout.
func TestCRLFDoesNotDiffAsEveryLine(t *testing.T) {
	unified, err := buildFileDiff("x.txt", "a\r\nb\r\nc\r\n", "a\nb\nc\n", 0)
	if err != nil {
		t.Fatal(err)
	}
	if unified != "" {
		t.Errorf("line endings alone produced a diff:\n%s", unified)
	}
}

// TestImageAttachmentNeedsAnAsset keeps a dangling reference from rendering as
// a blank space, which reads as a bug rather than as missing evidence.
func TestImageAttachmentNeedsAnAsset(t *testing.T) {
	svc, _, uid, tokID := newTestService(t)
	_, err := svc.Create(context.Background(), uid, tokID, CreateRequest{
		Title: "look at this", Kind: KindAck,
		Attachments: []store.Attachment{{Kind: "image", Title: "screenshot"}},
	})
	if err == nil || !strings.Contains(err.Error(), "asset_id") {
		t.Fatalf("an image with no asset_id was accepted: %v", err)
	}
}

// TestImageRendersInlineAndMissingIsExplicit covers both halves of the render.
func TestImageRendersInlineAndMissingIsExplicit(t *testing.T) {
	r := NewRenderer()

	withImage, err := r.Document("t", []Section{{
		Kind: "image", ID: "at_1", Title: "the failure",
		ImageSrc: "data:image/png;base64,iVBORw0KGgo=",
	}}, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(withImage, `<img src="data:image/png;base64,`) {
		t.Error("image was not inlined as a data URI")
	}
	if !strings.Contains(withImage, "the failure") {
		t.Error("caption lost")
	}

	missing, err := r.Document("t", []Section{{Kind: "image", ID: "at_2", Title: "gone"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(missing, "could not be loaded") {
		t.Error("a missing image rendered silently; the reader cannot tell evidence is absent")
	}
}

// TestDocumentIsDarkWithoutBeingToldTo is the regression for a white review
// document inside a dark app.
//
// The renderer used to bake the palette from a ?theme= query parameter and
// default to light, so any caller that forgot the parameter got a white page.
// A document that is only correct when someone else remembers a query
// parameter is a document that will be wrong.
func TestDocumentIsDarkWithoutBeingToldTo(t *testing.T) {
	r := NewRenderer()
	doc, err := r.Document("t", []Section{{Kind: "markdown", Content: "# hi"}}, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(doc, "prefers-color-scheme: dark") {
		t.Error("the document cannot follow the platform theme on its own")
	}
	// Check the html tag, not the stylesheet: a :root[data-theme="light"] rule
	// is required so an explicit light choice wins, but the *element* must
	// carry no theme unless one was asked for.
	htmlTag := doc[strings.Index(doc, "<html") : strings.Index(doc, ">")+1]
	if strings.Contains(htmlTag, "data-theme") {
		t.Errorf("the document hardcodes a theme (%s), losing the platform preference", htmlTag)
	}
	// An explicit dark request must still win.
	dark, err := r.Document("t", []Section{{Kind: "markdown", Content: "# hi"}}, true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(dark, `data-theme="dark"`) {
		t.Error("an explicit dark request was not honoured")
	}
	// Both highlight palettes must ship, or code is unstyled in one of them.
	for _, want := range []string{`:root[data-theme="dark"] .chroma`, `@media (prefers-color-scheme: dark)`} {
		if !strings.Contains(doc, want) {
			t.Errorf("stylesheet missing %q", want)
		}
	}
}
