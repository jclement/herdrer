package review

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	html2 "html"
	"strings"

	"github.com/microcosm-cc/bluemonday"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	ghtml "github.com/yuin/goldmark/renderer/html"
)

// Renderer turns agent-authored markdown into HTML that is safe to display.
//
// Every byte handled here is hostile input. A review document is written by an
// agent, and an agent can be prompt-injected by anything it read on the way to
// writing it — a web page, a dependency's README, a commit message. The threat
// is not a rude diagram; it is script running on herdrer's own origin, where a
// session cookie can open a shell.
//
// Three layers, in order:
//
//  1. goldmark parses with raw HTML *disabled*, so `<script>` in the source is
//     escaped text, not a node.
//  2. bluemonday sanitises the output against an allowlist, catching anything
//     the first layer let through.
//  3. the result is served as a standalone document that the SPA loads in an
//     iframe sandboxed *without* allow-same-origin, so even a total failure of
//     layers 1 and 2 executes in an opaque origin with no cookies, no storage,
//     no parent DOM, and `connect-src 'none'`.
//
// Layer 3 is the one that actually holds. The others reduce how often it is
// tested.
type Renderer struct {
	md     goldmark.Markdown
	policy *bluemonday.Policy
}

// NewRenderer builds the pipeline.
func NewRenderer() *Renderer {
	md := goldmark.New(
		goldmark.WithExtensions(extension.GFM, extension.Strikethrough, extension.Table),
		goldmark.WithRendererOptions(
			// Deliberately NOT html.WithUnsafe(). Raw HTML in the source is
			// escaped and displayed, never parsed.
			ghtml.WithXHTML(),
		),
	)

	p := bluemonday.UGCPolicy()
	p.AllowAttrs("class").Matching(bluemonday.SpaceSeparatedTokens).OnElements("pre", "code", "span", "div", "table")
	p.AllowAttrs("id").Matching(bluemonday.SpaceSeparatedTokens).OnElements("h1", "h2", "h3", "h4", "h5", "h6")
	p.AllowElements("figure", "figcaption")
	// Images are allowed by UGCPolicy but must not phone home; the document
	// CSP restricts img-src to data: and blob: so a remote src cannot load,
	// and a remote src is also a tracking pixel telling an attacker the human
	// opened the item. Strip them at the source too.
	p.AllowURLSchemes("data")
	p.RequireNoFollowOnLinks(true)
	p.RequireNoReferrerOnLinks(true)
	p.AddTargetBlankToFullyQualifiedLinks(true)

	return &Renderer{md: md, policy: p}
}

// Fragment renders markdown to sanitised HTML with no surrounding document.
func (r *Renderer) Fragment(src string) (string, error) {
	var buf bytes.Buffer
	if err := r.md.Convert([]byte(src), &buf); err != nil {
		return "", fmt.Errorf("render markdown: %w", err)
	}
	return r.policy.Sanitize(buf.String()), nil
}

// Section is one renderable piece of a review item.
type Section struct {
	Kind     string // markdown | mermaid | code | diff
	Title    string
	Language string
	Content  string

	// ID is the attachment id. It is emitted as id="a-<ID>" so the SPA can
	// deep-link one attachment and show it as its own card, rather than
	// framing the whole document for every diagram.
	ID string
}

// Document renders a complete standalone HTML document for the iframe.
//
// The document carries its own Content-Security-Policy in a meta tag. Because
// the iframe is sandboxed without allow-same-origin the document lives in an
// opaque origin, where `'self'` matches nothing — so scripts are admitted by
// nonce with 'strict-dynamic', which is origin-independent, and everything
// else is denied outright.
func (r *Renderer) Document(title string, sections []Section, dark bool) (string, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	n := base64.StdEncoding.EncodeToString(nonce)

	var body strings.Builder
	for _, s := range sections {
		switch s.Kind {
		case "mermaid":
			// The source is emitted as text inside a <pre>. If the diagram
			// renderer fails to load, the reader sees the diagram source
			// rather than a blank box — an honest degradation.
			body.WriteString(`<figure class="mermaid-wrap"` + anchor(s.ID) + `>`)
			if s.Title != "" {
				body.WriteString("<figcaption>" + html2.EscapeString(s.Title) + "</figcaption>")
			}
			body.WriteString(`<pre class="mermaid">` + html2.EscapeString(s.Content) + `</pre></figure>`)
		case "code", "diff":
			lang := s.Language
			if lang == "" && s.Kind == "diff" {
				lang = "diff"
			}
			body.WriteString(`<figure class="code-wrap"` + anchor(s.ID) + `>`)
			if s.Title != "" {
				body.WriteString("<figcaption>" + html2.EscapeString(s.Title) + "</figcaption>")
			}
			body.WriteString(`<pre class="code lang-` + html2.EscapeString(lang) + `"><code>` +
				html2.EscapeString(s.Content) + `</code></pre></figure>`)
		default:
			frag, err := r.Fragment(s.Content)
			if err != nil {
				return "", err
			}
			body.WriteString(`<section class="md"` + anchor(s.ID) + `>` + frag + `</section>`)
		}
	}

	theme := "light"
	if dark {
		theme = "dark"
	}

	doc := `<!doctype html><html lang="en" data-theme="` + theme + `"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-` + n + `' 'strict-dynamic'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>` + html2.EscapeString(title) + `</title>
<style>` + rendererCSS + `</style>
</head><body>` + body.String() + `
<script nonce="` + n + `">` + heightScript + `</script>
</body></html>`
	return doc, nil
}

// anchor emits the id attribute the SPA links to, when the section has one.
func anchor(id string) string {
	if id == "" {
		return ""
	}
	return ` id="a-` + html2.EscapeString(id) + `"`
}

// heightScript reports the rendered height to the parent so the SPA can size
// the iframe without a scrollbar inside a scrollbar. It sends only a number,
// and the parent validates the shape before using it.
const heightScript = `
(function(){
  function post(){
    var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    parent.postMessage({type:"herdrer:height", height:h}, "*");
  }
  new ResizeObserver(post).observe(document.documentElement);
  window.addEventListener("load", post);
  post();
})();
`

const rendererCSS = `
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--border:#d0d7de;--code-bg:#f6f8fa;
--add:#1a7f37;--add-bg:#e6ffec;--del:#cf222e;--del-bg:#ffebe9}
[data-theme=dark]{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--border:#30363d;--code-bg:#161b22;
--add:#3fb950;--add-bg:#0f2f18;--del:#f85149;--del-bg:#3a1416}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg)}
body{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;padding:2px 0 8px}
h1,h2,h3,h4{line-height:1.25;margin:1.2em 0 .5em;font-weight:600}
h1{font-size:1.3rem}h2{font-size:1.15rem}h3{font-size:1rem}
p,ul,ol,blockquote,table{margin:0 0 .8em}
ul,ol{padding-left:1.3em}
a{color:inherit;text-decoration:underline;text-underline-offset:2px}
blockquote{border-left:3px solid var(--border);padding-left:.8em;color:var(--muted);margin-left:0}
hr{border:0;border-top:1px solid var(--border);margin:1.2em 0}
figcaption{font-size:.75rem;color:var(--muted);margin-bottom:.25em;font-weight:500}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}
th,td{border:1px solid var(--border);padding:.25em .5em;text-align:left;font-size:.85em}
th{background:var(--code-bg)}
code{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em}
:not(pre)>code{background:var(--code-bg);padding:.1em .3em;border-radius:3px}
pre{background:var(--code-bg);border:1px solid var(--border);border-radius:6px;
padding:.6em .7em;overflow-x:auto;overscroll-behavior-x:contain;margin:0 0 .8em;
-webkit-overflow-scrolling:touch}
pre code{white-space:pre;display:block}
.lang-diff code{white-space:pre}
figure{margin:0 0 1em}
`
