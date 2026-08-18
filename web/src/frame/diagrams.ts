/**
 * Diagram plumbing for the review-document iframe.
 *
 * This module deliberately does not import mermaid. The renderer is injected,
 * so the parts that decide what counts as diagram source, and what happens when
 * a diagram will not parse, are testable without dragging a three-megabyte
 * parser into the test run — and the failure path gets exercised by a test
 * rather than by hope.
 *
 * Everything here runs inside the sandboxed frame: an opaque origin with no
 * cookies, no storage and no parent DOM. That containment is the reason running
 * mermaid — which has a live CVE against its bundled DOMPurify — is tolerable
 * at all, so none of this may ever be lifted into the parent document.
 */

/** What the Go renderer emits for a mermaid section, and what we replace. */
export const DIAGRAM_SELECTOR = "pre.mermaid";

/** The one message shape the parent frame validates and accepts. */
export const HEIGHT_MESSAGE = "herdrer:height";

/** Widest a diagram may be zoomed, as a multiple of its natural width. */
const MAX_SCALE = 6;
const MIN_SCALE = 0.25;

/**
 * Reads the diagram source out of one `<pre class="mermaid">`.
 *
 * The server escapes the agent's text into the element, so `textContent` is the
 * source verbatim. Two normalisations earn their keep: agents write CRLF, and
 * agents indent a whole diagram when it came out of a list item or a quote —
 * mermaid tolerates neither gracefully, and both are trivially undone.
 */
export function diagramSource(el: Element): string {
  const lines = (el.textContent ?? "").replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();

  let indent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim() === "") continue;
    indent = Math.min(indent, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(indent) || indent <= 0) return lines.join("\n");
  return lines.map((line) => line.slice(indent)).join("\n");
}

/** Renders one diagram to standalone SVG markup, or rejects. */
export type DiagramRenderer = (id: string, source: string) => Promise<string>;

export interface RenderSummary {
  total: number;
  rendered: number;
  failed: number;
}

export interface RenderOptions {
  /** Called after each diagram settles, so the frame can re-report its height. */
  onChange?: () => void;
}

/**
 * Renders every diagram in `root`, in order.
 *
 * Sequential on purpose: mermaid keeps global state between `parse` and
 * `render`, so overlapping calls interleave badly. Each diagram is isolated —
 * one that throws leaves its own `<pre>` in place with the source still
 * readable and never stops the ones after it.
 */
export async function renderDiagrams(
  root: ParentNode,
  render: DiagramRenderer,
  options: RenderOptions = {},
): Promise<RenderSummary> {
  const targets = Array.from(root.querySelectorAll(DIAGRAM_SELECTOR));
  const summary: RenderSummary = { total: targets.length, rendered: 0, failed: 0 };

  for (let i = 0; i < targets.length; i++) {
    const pre = targets[i]!;
    const source = diagramSource(pre);
    if (source === "") {
      summary.failed++;
      degrade(pre, "The diagram is empty.");
      continue;
    }

    let svg: unknown;
    try {
      svg = await render(diagramID(i), source);
    } catch (err) {
      summary.failed++;
      degrade(pre, describe(err));
      continue;
    }

    if (typeof svg !== "string" || svg.trim() === "") {
      summary.failed++;
      degrade(pre, "The renderer produced no diagram.");
      continue;
    }

    try {
      pre.replaceWith(buildFigure(pre, svg, options.onChange));
      summary.rendered++;
    } catch (err) {
      // The <pre> is still in the document here: replaceWith either happened or
      // it did not, and buildFigure throws before it is called.
      summary.failed++;
      degrade(pre, describe(err));
    }
  }

  options.onChange?.();
  return summary;
}

/**
 * Leaves the source visible and says why.
 *
 * A diagram that will not parse is usually a diagram whose source the reader
 * now wants to read. Blanking it, or letting the exception escape and take the
 * rest of the document with it, are both worse than showing the text the agent
 * wrote with a line of explanation above it.
 */
function degrade(pre: Element, message: string): void {
  pre.classList.add("mermaid-unrendered");
  const doc = pre.ownerDocument;
  if (!doc || !pre.parentNode) return;

  const text = `Diagram not rendered — showing source. ${message}`;
  const prev = pre.previousElementSibling;
  if (prev && prev.classList.contains("mermaid-error")) {
    prev.textContent = text;
    return;
  }
  const note = doc.createElement("p");
  note.className = "mermaid-error";
  // textContent, not innerHTML: mermaid's parse errors quote the agent's source
  // back at us, and that source is hostile input.
  note.textContent = text;
  pre.parentNode.insertBefore(note, pre);
}

/** A one-line, bounded rendition of whatever was thrown. */
function describe(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat === "") return "The renderer failed.";
  return flat.length > 180 ? `${flat.slice(0, 179)}…` : flat;
}

function diagramID(index: number): string {
  return `herdrer-diagram-${index}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Wraps rendered SVG in a viewport that fits a phone and zooms on tap.
 *
 * Fit is the default: the SVG scales down to the column width, capped at its
 * natural size so a small diagram is not blown up. Tapping switches to a pan
 * viewport where the SVG keeps its real pixel size and the box scrolls — which
 * is the only way a twelve-node flowchart is legible on a 375px screen.
 */
function buildFigure(pre: Element, svg: string, onChange?: () => void): HTMLElement {
  const doc = pre.ownerDocument;
  if (!doc) throw new Error("the diagram is not attached to a document");

  const figure = doc.createElement("div");
  figure.className = "mermaid-figure";

  const viewport = doc.createElement("div");
  viewport.className = "mermaid-viewport";
  viewport.innerHTML = svg;

  const el = viewport.querySelector("svg");
  if (!el) throw new Error("the renderer produced no <svg>");

  const natural = naturalWidth(el);
  el.removeAttribute("width");
  el.removeAttribute("height");
  el.style.height = "auto";
  el.style.display = "block";
  figure.style.setProperty("--mmd-natural", `${natural}px`);

  let mode: "fit" | "pan" = "fit";
  let scale = 1;

  const tools = doc.createElement("div");
  tools.className = "mermaid-tools";
  const out = doc.createElement("button");
  const label = doc.createElement("span");
  const into = doc.createElement("button");
  const fit = doc.createElement("button");

  const apply = () => {
    figure.dataset.zoom = mode;
    if (mode === "pan") {
      el.style.width = `${Math.round(natural * scale)}px`;
      el.style.maxWidth = "none";
      label.textContent = `${Math.round(scale * 100)}%`;
    } else {
      el.style.width = "100%";
      el.style.maxWidth = "100%";
      label.textContent = "fit";
    }
    fit.disabled = mode === "fit";
    onChange?.();
  };

  const zoom = (factor: number) => {
    const next = mode === "fit" ? factor : scale * factor;
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    mode = "pan";
    apply();
  };

  button(out, "−", "Zoom out", () => zoom(1 / 1.4));
  label.className = "mermaid-zoom-label";
  button(into, "+", "Zoom in", () => zoom(1.4));
  button(fit, "Fit", "Fit the diagram to the width of the page", () => {
    mode = "fit";
    scale = 1;
    apply();
  });
  tools.append(out, label, into, fit);

  // A tap anywhere on a fitted diagram zooms it. Only while fitted: once the
  // viewport scrolls, a tap is how you finish a drag.
  viewport.addEventListener("click", () => {
    if (mode === "fit") zoom(1);
  });

  figure.append(viewport, tools);
  apply();
  return figure;
}

function button(el: HTMLButtonElement, text: string, label: string, onClick: () => void): void {
  el.type = "button";
  el.textContent = text;
  el.setAttribute("aria-label", label);
  el.title = label;
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
}

/** The width the diagram was laid out at, from the viewBox mermaid emits. */
function naturalWidth(el: SVGElement): number {
  const box = el.getAttribute("viewBox");
  if (box) {
    const parts = box.trim().split(/[\s,]+/);
    const w = Number(parts[2]);
    if (Number.isFinite(w) && w > 0) return Math.ceil(w);
  }
  const attr = Number.parseFloat(el.getAttribute("width") ?? "");
  if (Number.isFinite(attr) && attr > 0) return Math.ceil(attr);
  return 800;
}

/**
 * Tells the parent how tall the document is now.
 *
 * Inserting SVG changes the height after the parent's first measurement, so
 * this runs again once diagrams land and after every zoom change. The shape is
 * the one the parent already validates; nothing else is ever sent.
 */
export function postHeight(doc: Document, target: Window | null): void {
  if (!target) return;
  const h = Math.ceil(doc.documentElement.getBoundingClientRect().height);
  if (!Number.isFinite(h) || h <= 0) return;
  target.postMessage({ type: HEIGHT_MESSAGE, height: h }, "*");
}

/**
 * Styles for the rendered diagrams, reusing the document's theme variables.
 *
 * This runs *inside* the sandboxed review document, which is a different
 * document with a different stylesheet — the server's. So the colours come from
 * that document's own custom properties (`--border`, `--code-bg`, `--muted`,
 * `--del`) and this file only supplies the fallback for when one is missing.
 *
 * Those fallbacks used to be light literals, and that was a real dark-mode leak
 * rather than a theoretical one: a `background:var(--code-bg,#f6f8fa)` renders a
 * pale grey panel in the middle of a dark document the moment the host page
 * does not happen to define that variable. A fallback has to be as theme-aware
 * as the thing it is standing in for, so the fallbacks are themselves
 * variables, resolved by the same three-state rule the host document uses:
 * `prefers-color-scheme` by default, an explicit `data-theme` winning over it
 * in both directions.
 */
export const FRAME_CSS = `
:root{--mmd-border:#d0d7de;--mmd-code-bg:#f6f8fa;--mmd-muted:#656d76;--mmd-del:#cf222e}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
--mmd-border:#30363d;--mmd-code-bg:#161b22;--mmd-muted:#8b949e;--mmd-del:#f85149}}
:root[data-theme=dark]{--mmd-border:#30363d;--mmd-code-bg:#161b22;--mmd-muted:#8b949e;--mmd-del:#f85149}
.mermaid-figure{margin:0 0 1em}
.mermaid-viewport{overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.mermaid-figure[data-zoom=fit] .mermaid-viewport{max-width:var(--mmd-natural,100%);overflow:hidden;cursor:zoom-in}
.mermaid-figure[data-zoom=pan] .mermaid-viewport{overflow:auto;max-height:60vh;min-height:120px;
border:1px solid var(--border,var(--mmd-border));border-radius:6px;background:var(--code-bg,var(--mmd-code-bg))}
.mermaid-figure svg{display:block;height:auto}
.mermaid-figure[data-zoom=pan] svg{max-width:none}
.mermaid-tools{display:flex;gap:.3em;align-items:center;margin-top:.3em;
font-size:.7rem;color:var(--muted,var(--mmd-muted))}
.mermaid-tools button{font:inherit;color:inherit;background:var(--code-bg,var(--mmd-code-bg));
border:1px solid var(--border,var(--mmd-border));border-radius:5px;padding:.2em .5em;
min-width:2.2em;min-height:1.9em;line-height:1;cursor:pointer}
.mermaid-tools button[disabled]{opacity:.45;cursor:default}
.mermaid-zoom-label{min-width:3em;text-align:center;font-variant-numeric:tabular-nums}
.mermaid-error{font-size:.75rem;line-height:1.4;color:var(--del,var(--mmd-del));margin:0 0 .3em}
pre.mermaid-unrendered{border-color:var(--del,var(--mmd-del))}
`;

/** Adds FRAME_CSS to the document. Inline styles are what the CSP permits. */
export function injectCSS(doc: Document): void {
  const style = doc.createElement("style");
  style.textContent = FRAME_CSS;
  doc.head.append(style);
}
