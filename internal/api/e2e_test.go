package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jclement/herdrer/internal/auth"
	"github.com/jclement/herdrer/internal/store"
)

// TestFullReviewLoop exercises the product's central promise over real HTTP:
// an agent posts a question and blocks; a human answers on a phone; the agent's
// blocking call returns with the answer.
//
// Everything except the WebAuthn ceremony itself is the real path — real
// server, real bearer token, real long-poll held open across goroutines, real
// session cookie on the answering side.
func TestFullReviewLoop(t *testing.T) {
	s, st, u := newTestServer(t)
	ctx := context.Background()

	srv := httptest.NewServer(s)
	defer srv.Close()

	_, secret, err := s.auth.MintToken(ctx, u.ID, "worker", []string{
		auth.ScopeReviewWrite, auth.ScopeReviewRead,
	}, 0)
	if err != nil {
		t.Fatal(err)
	}
	cookie := loginAs(t, s, u)
	client := &http.Client{Timeout: 30 * time.Second}

	// --- the agent asks -------------------------------------------------------
	body := `{
		"title": "Drop the legacy column?",
		"kind": "choice",
		"body_md": "## What happens\n\nDropping it is irreversible.\n",
		"options": [
			{"key":"A","label":"Drop it","detail":"Irreversible."},
			{"key":"B","label":"Keep it","detail":"Dead weight, reversible."}
		],
		"recommend": "B",
		"attachments": [{"kind":"diff","title":"migration","content":"--- a\n+++ b\n"}],
		"context": {"repo":"be","branch":"feature/x"},
		"urgency": "blocking"
	}`
	req, _ := http.NewRequest("POST", srv.URL+"/api/v1/agent/review", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("create: %d %s", resp.StatusCode, b)
	}
	var created struct {
		Data struct {
			ID  string `json:"id"`
			URL string `json:"url"`
		} `json:"data"`
	}
	json.NewDecoder(resp.Body).Decode(&created)
	resp.Body.Close()
	id := created.Data.ID
	if id == "" {
		t.Fatal("no id returned")
	}

	// --- the agent blocks -----------------------------------------------------
	type pollResult struct {
		status, value, note string
		err                 error
	}
	done := make(chan pollResult, 1)
	go func() {
		r, _ := http.NewRequest("GET", srv.URL+"/api/v1/agent/review/"+id+"?wait=20", nil)
		r.Header.Set("Authorization", "Bearer "+secret)
		rp, err := client.Do(r)
		if err != nil {
			done <- pollResult{err: err}
			return
		}
		defer rp.Body.Close()
		var out struct {
			Data struct {
				Status      string  `json:"status"`
				AnswerValue *string `json:"answer_value"`
				AnswerNote  *string `json:"answer_note"`
			} `json:"data"`
		}
		if err := json.NewDecoder(rp.Body).Decode(&out); err != nil {
			done <- pollResult{err: err}
			return
		}
		res := pollResult{status: out.Data.Status}
		if out.Data.AnswerValue != nil {
			res.value = *out.Data.AnswerValue
		}
		if out.Data.AnswerNote != nil {
			res.note = *out.Data.AnswerNote
		}
		done <- res
	}()

	// --- it shows up in the human's inbox -------------------------------------
	waitFor(t, func() bool {
		r, _ := http.NewRequest("GET", srv.URL+"/api/v1/review", nil)
		r.AddCookie(cookie)
		rp, err := client.Do(r)
		if err != nil {
			return false
		}
		defer rp.Body.Close()
		b, _ := io.ReadAll(rp.Body)
		return strings.Contains(string(b), id)
	})

	// --- the human answers, overruling the recommendation ---------------------
	ans := `{"value":"A","note":"A, but back it up first"}`
	r, _ := http.NewRequest("POST", srv.URL+"/api/v1/review/"+id+"/answer", strings.NewReader(ans))
	r.AddCookie(cookie)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", testOrigin)
	rp, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	if rp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(rp.Body)
		t.Fatalf("answer: %d %s", rp.StatusCode, b)
	}
	rp.Body.Close()

	// --- the agent's blocking call returns ------------------------------------
	select {
	case res := <-done:
		if res.err != nil {
			t.Fatalf("long-poll: %v", res.err)
		}
		if res.status != store.StatusAnswered {
			t.Fatalf("status = %q, want answered", res.status)
		}
		if res.value != "A" {
			t.Errorf("value = %q, want A", res.value)
		}
		// The note outranks the button; an agent that ignores it has misread
		// the answer, so it must actually arrive.
		if !strings.Contains(res.note, "back it up first") {
			t.Errorf("note = %q, want the human's caveat", res.note)
		}
	case <-time.After(25 * time.Second):
		t.Fatal("the agent's long-poll never returned after the human answered")
	}

	// --- and the render endpoint produces a sandboxable document --------------
	r2, _ := http.NewRequest("GET", srv.URL+"/api/v1/review/"+id+"/render", nil)
	r2.AddCookie(cookie)
	rp2, err := client.Do(r2)
	if err != nil {
		t.Fatal(err)
	}
	defer rp2.Body.Close()
	doc, _ := io.ReadAll(rp2.Body)
	if rp2.Header.Get("Content-Type") != "text/html; charset=utf-8" {
		t.Errorf("render content-type = %q", rp2.Header.Get("Content-Type"))
	}
	for _, must := range []string{"default-src 'none'", "herdrer:height", "migration"} {
		if !strings.Contains(string(doc), must) {
			t.Errorf("rendered document missing %q", must)
		}
	}
	_ = st
}

// TestExpiredItemDropsRecommendationOverHTTP proves the most important
// semantic survives serialisation: an agent must not be able to read its own
// recommendation back out of a timeout and treat it as consent.
func TestExpiredItemDropsRecommendationOverHTTP(t *testing.T) {
	s, st, u := newTestServer(t)
	ctx := context.Background()
	srv := httptest.NewServer(s)
	defer srv.Close()

	_, secret, _ := s.auth.MintToken(ctx, u.ID, "worker",
		[]string{auth.ScopeReviewWrite, auth.ScopeReviewRead}, 0)

	req, _ := http.NewRequest("POST", srv.URL+"/api/v1/agent/review",
		strings.NewReader(`{"title":"go?","kind":"confirm","recommend":"yes"}`))
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		Data struct{ ID string } `json:"data"`
	}
	json.NewDecoder(resp.Body).Decode(&created)
	resp.Body.Close()

	if _, err := st.DB().ExecContext(ctx,
		`UPDATE review_items SET expires_at = ? WHERE id = ?`,
		time.Now().Add(-time.Hour).Unix(), created.Data.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SweepExpired(ctx); err != nil {
		t.Fatal(err)
	}

	r, _ := http.NewRequest("GET", srv.URL+"/api/v1/agent/review/"+created.Data.ID, nil)
	r.Header.Set("Authorization", "Bearer "+secret)
	rp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer rp.Body.Close()
	var out struct {
		Data map[string]any `json:"data"`
	}
	json.NewDecoder(rp.Body).Decode(&out)

	if out.Data["status"] != "expired" {
		t.Fatalf("status = %v, want expired", out.Data["status"])
	}
	if out.Data["answer_value"] != nil {
		t.Errorf("expired item carries an answer: %v", out.Data["answer_value"])
	}
	if out.Data["recommend"] != nil {
		t.Errorf("expired item still carries recommend=%v — an agent could read its "+
			"own suggestion back out of a timeout and act on it", out.Data["recommend"])
	}
	if _, ok := out.Data["expired_note"]; !ok {
		t.Error("expired item should carry an explicit note that a timeout is not consent")
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("condition never became true")
}
