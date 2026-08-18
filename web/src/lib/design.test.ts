import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evidenceSections, diffStat, groupOf, hasUnifiedDiff, jumpLabel } from "./attachments";
import type { Attachment } from "./types";

const SRC = new URL("..", import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(tsx?|css|html)$/.test(name)) out.push(path);
  }
  return out;
}

const SOURCES = walk(SRC).filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"));

/**
 * The dark-mode regression guard.
 *
 * Every colour in this app comes from a semantic token that swaps on `.dark`.
 * The failure that produced this file was not a missing token — it was a
 * handful of literals that looked harmless in the light theme and turned the
 * screen white in the dark one: `bg-white` on a card, `text-white` on a badge,
 * a `#fff` in a style attribute. Each one is invisible in review and obvious
 * on a phone at midnight.
 *
 * So the rule is mechanical: no literal colour outside styles.css, which is the
 * one file allowed to know what a hex is. If a new surface needs a shade that
 * does not exist yet, the fix is a new token with both halves defined, not a
 * literal here.
 */
describe("no hardcoded light-mode colours", () => {
  // Tailwind's own palette is a light-mode palette: a `-100` is light in both
  // themes, which is the whole problem.
  const PALETTE =
    /\b(?:bg|text|border|divide|ring|from|to|via)-(?:gray|slate|zinc|neutral|stone|red|green|blue|amber|yellow|emerald|sky|indigo)-\d{2,3}\b/;

  // A hex or rgb() literal anywhere but the stylesheet.
  const LITERAL = /(#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d)/;

  it("uses no Tailwind palette colour anywhere", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const text = readFileSync(file, "utf8");
      for (const [n, line] of text.split("\n").entries()) {
        const hit = PALETTE.exec(line);
        if (hit) offenders.push(`${file}:${n + 1}: ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses no bare white or black", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const text = readFileSync(file, "utf8");
      for (const [n, line] of text.split("\n").entries()) {
        for (const bad of ["bg-white", "text-white", "bg-black", "text-black"]) {
          // `bg-white/10` was the sneakiest of these: a translucent white that
          // is correct on the dark header and wrong on everything else.
          if (new RegExp(`\\b${bad}(?:/\\d+)?\\b`).test(line)) {
            offenders.push(`${file}:${n + 1}: ${bad}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /*
   * Two files hold colour literals on purpose, and both say why in their own
   * comments. Neither is a Tailwind class, which is what the rule is really
   * about — a literal reachable from a `className` is the one that turns a
   * screen white.
   *
   *   styles.css      the token definitions themselves. Somebody has to be
   *                   allowed to know what a hex is.
   *   termTheme.ts    xterm's fallback palette, for a paint that beats the
   *                   stylesheet in. Every value is dark, in both themes.
   *   frame/diagrams  a stylesheet for a *different* document — the sandboxed
   *                   review render, which cannot see our tokens. It carries a
   *                   full light and dark pair; the test below enforces that.
   */
  const LITERALS_ALLOWED = ["styles.css", "lib/termTheme.ts", "frame/diagrams.ts"];

  it("keeps every colour literal inside styles.css", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      if (LITERALS_ALLOWED.some((a) => file.endsWith(a))) continue;
      const text = readFileSync(file, "utf8");
      for (const [n, line] of text.split("\n").entries()) {
        // A fragment identifier is not a colour, and neither is a comment.
        if (/^\s*[*/]/.test(line)) continue;
        const hit = LITERAL.exec(line);
        if (hit) offenders.push(`${file}:${n + 1}: ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("defines both halves of every semantic token", () => {
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    const dark = css.slice(css.indexOf("\n.dark {"));
    const light = css.slice(0, css.indexOf("\n.dark {"));

    const names = new Set<string>();
    for (const m of light.matchAll(/(--color-[a-z0-9-]+):/g)) if (m[1]) names.add(m[1]);

    // The chrome is deliberately identical in both themes — a dark header and a
    // dark terminal are the design, not an oversight — so those are exempt.
    const exempt = (n: string) => n.startsWith("--color-chrome");

    const missing = [...names].filter((n) => !exempt(n) && !dark.includes(`${n}:`));
    expect(missing).toEqual([]);
  });

  it("gives the sandboxed frame's CSS a dark half too", () => {
    // The frame renders inside the server's document and falls back to these
    // when that document does not define a variable. A light-only fallback is a
    // pale grey panel in the middle of a dark review — which is exactly the bug
    // this pass was opened for.
    const css = readFileSync(join(SRC, "frame/diagrams.ts"), "utf8");
    expect(css).toMatch(/@media \(prefers-color-scheme:dark\)/);
    expect(css).toMatch(/:root\[data-theme=dark\]/);
    expect(css).toMatch(/:root:not\(\[data-theme=light\]\)/);
  });

  it("declares color-scheme in both themes", () => {
    // Without this the browser paints the canvas, the scrollbars, the form
    // controls and an unloaded iframe from the *light* palette regardless of
    // what the stylesheet says — which is what a phone shows in the rubber band
    // at the end of a scroll.
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    expect(css).toMatch(/color-scheme:\s*light/);
    expect(css).toMatch(/color-scheme:\s*dark/);
    // And the canvas itself has to be painted, since body's background stops
    // propagating the moment html has one.
    expect(css).toMatch(/html\s*\{[^}]*background-color:\s*var\(--color-surface\)/);
  });
});

/** The attachment kinds that land after this build shipped. */
describe("evidence grouping", () => {
  const at = (over: Partial<Attachment>): Attachment => ({
    id: "at_1",
    kind: "code",
    title: "t",
    content: "x",
    ...over,
  });

  it("files a filediff beside a plain diff — one Changes section, not two", () => {
    const sections = evidenceSections([
      at({ id: "a", kind: "diff" }),
      at({ id: "b", kind: "filediff" }),
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.group).toBe("changes");
    expect(sections[0]?.label).toBe("Changes · 2");
  });

  it("gives images their own section", () => {
    const sections = evidenceSections([at({ id: "i", kind: "image", asset_id: "as_1" })]);
    expect(sections.map((s) => s.group)).toEqual(["images"]);
    expect(sections[0]?.label).toBe("Image · 1");
  });

  it("names a kind it has never heard of rather than dropping it", () => {
    const sections = evidenceSections([at({ id: "x", kind: "hologram" })]);
    expect(sections.map((s) => s.group)).toEqual(["other"]);
    expect(sections[0]?.label).toBe("Attachment · 1");
    expect(groupOf("hologram")).toBe("other");
  });

  it("never shows markdown twice — it is already the document", () => {
    expect(groupOf("markdown")).toBeNull();
    expect(evidenceSections([at({ kind: "markdown" })])).toEqual([]);
  });

  it("orders the sections: what changed, then the pictures, then the source", () => {
    const sections = evidenceSections([
      at({ id: "c", kind: "code" }),
      at({ id: "i", kind: "image" }),
      at({ id: "m", kind: "mermaid" }),
      at({ id: "d", kind: "filediff" }),
    ]);
    expect(sections.map((s) => s.group)).toEqual(["changes", "diagrams", "images", "code"]);
  });

  it("labels the jump chips in the plural the section actually is", () => {
    const [one] = evidenceSections([at({ kind: "diff" })]);
    expect(one && jumpLabel(one)).toBe("1 change");
    const [two] = evidenceSections([at({ id: "a", kind: "diff" }), at({ id: "b", kind: "diff" })]);
    expect(two && jumpLabel(two)).toBe("2 changes");
  });

  it("prefers the server's +n −n and falls back to counting the diff", () => {
    expect(diffStat(at({ adds: 12, dels: 3, content: "" }))).toEqual({ adds: 12, dels: 3 });
    expect(diffStat(at({ content: "--- a\n+++ b\n@@\n+one\n+two\n-gone\n ctx" }))).toEqual({
      adds: 2,
      dels: 1,
    });
    expect(diffStat(at({ content: "" }))).toBeNull();
  });

  it("knows when a filediff has no computed diff to render", () => {
    expect(hasUnifiedDiff(at({ kind: "filediff", content: "@@ -1 +1 @@" }))).toBe(true);
    expect(
      hasUnifiedDiff(at({ kind: "filediff", content: undefined, before: "a", after: "b" })),
    ).toBe(false);
  });
});

/**
 * The notch rule.
 *
 * `env(safe-area-inset-top)` as padding on an element that also has a fixed
 * height is a border-box arithmetic bug, not a style choice: a `h-11` bar with a
 * 59px inset has a content box of *zero*, so its own buttons render below the
 * bar they belong to, over whatever is underneath. It looks perfect in a desktop
 * browser and in the simulator without a notch, and it is broken on every
 * iPhone since the X — which is the only place the code runs.
 *
 * The fix is always the same shape: inset on a wrapper, height on the row
 * inside it. This scan is here because the bug is invisible in review and the
 * pattern is easy to reintroduce.
 */
describe("safe-area insets never share an element with a fixed height", () => {
  const TSX = SOURCES.filter((p) => p.endsWith(".tsx"));

  it("puts the inset on a wrapper, not on the bar it pads", () => {
    const offenders: string[] = [];
    for (const file of TSX) {
      const text = readFileSync(file, "utf8");
      let at = text.indexOf("safe-area-inset-top");
      while (at !== -1) {
        // Walk back to the opening `<` of the element this style belongs to,
        // and look at everything between it and here.
        const open = text.lastIndexOf("<", at);
        const element = text.slice(open, at);
        if (/\bclassName=[^]*?\bh-\d/.test(element)) {
          const line = text.slice(0, at).split("\n").length;
          offenders.push(`${file}:${line}`);
        }
        at = text.indexOf("safe-area-inset-top", at + 1);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the bottom inset on everything anchored to the bottom edge", () => {
    // The fixed bottom nav, the compose button above it, the toast stack above
    // that, and the action bar that owns the bottom of a review. A phone with a
    // home indicator puts a 34px bar over all four.
    for (const [file, needle] of [
      ["components/AppShell.tsx", "safe-area-inset-bottom"],
      ["components/toast.tsx", "safe-area-inset-bottom"],
      ["features/review/InboxPage.tsx", "safe-area-inset-bottom"],
      ["features/review/ActionBar.tsx", "safe-area-inset-bottom"],
    ] as const) {
      expect(readFileSync(join(SRC, file), "utf8")).toContain(needle);
    }
  });
});
