/**
 * The mermaid bundle for the review-document iframe.
 *
 * The Go renderer emits diagram sources as `<pre class="mermaid">` and then, at
 * the end of the body, a nonced bootstrap script injects this file as a script
 * element. Three constraints from that frame's CSP shape this build, and they
 * are worth stating because breaking any one of them fails silently:
 *
 *   1. `connect-src 'none'` — nothing here may fetch. The bundle has to arrive
 *      as a script element, which is why the bootstrap injects one.
 *   2. The frame is sandboxed without `allow-same-origin`, so it lives in an
 *      opaque origin. A *module* script is fetched in CORS mode and would need
 *      `Access-Control-Allow-Origin` on the asset; a classic script is a no-cors
 *      request and just works. So this is built as a single classic IIFE with
 *      every dynamic import inlined — see vite.frame.config.ts.
 *   3. `'strict-dynamic'` is what lets the nonced bootstrap inject this at all;
 *      `'self'` matches nothing in an opaque origin, so there is no other way in.
 *
 * Mermaid runs here and only here. It carries CVE-2025-54881 (prototype
 * pollution in its bundled DOMPurify, RCE downstream); the opaque origin is
 * what makes that survivable. Never import this module from the SPA.
 */
import mermaid from "mermaid";
import { DIAGRAM_SELECTOR, injectCSS, postHeight, renderDiagrams } from "./diagrams";

function isDark(doc: Document): boolean {
  return doc.documentElement.getAttribute("data-theme") === "dark";
}

async function run(): Promise<void> {
  const doc = document;
  if (!doc.querySelector(DIAGRAM_SELECTOR)) return;

  injectCSS(doc);
  mermaid.initialize({
    // We drive rendering ourselves so a failure is ours to catch.
    startOnLoad: false,
    // strict: no HTML labels, no click bindings, text sanitised by mermaid.
    // Belt on top of the braces the opaque origin already provides.
    securityLevel: "strict",
    theme: isDark(doc) ? "dark" : "default",
    darkMode: isDark(doc),
    fontFamily: '-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif',
    // Diagrams get an intrinsic width we can scale against.
    flowchart: { useMaxWidth: true },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
  });

  const report = () => postHeight(doc, window.parent);

  await renderDiagrams(
    doc,
    async (id, source) => {
      // parse first, with errors suppressed: mermaid.render on bad source can
      // leave an error diagram behind in the DOM, and we would rather show the
      // author's own text than mermaid's apology.
      const parsed = await mermaid.parse(source, { suppressErrors: true });
      if (!parsed) throw new Error("The diagram source is not valid mermaid.");
      const { svg } = await mermaid.render(id, source);
      return svg;
    },
    { onChange: report },
  );

  report();
  // Fonts settle after layout; one more measurement costs nothing.
  if (doc.fonts?.ready) void doc.fonts.ready.then(report).catch(() => {});
}

function start(): void {
  run().catch(() => {
    // renderDiagrams already degraded each diagram it could not draw. Anything
    // reaching here is mermaid failing to initialise at all, in which case
    // every <pre> is still on screen with its source — the honest fallback.
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
