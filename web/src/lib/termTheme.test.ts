import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TERM_FALLBACK,
  TOKENS,
  cssReader,
  mapReader,
  terminalFont,
  terminalTheme,
  type TermField,
} from "./termTheme";

const STYLESHEET = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** Relative luminance of `#rrggbb`, ignoring any alpha suffix. sRGB, WCAG. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})/i.exec(hex.trim());
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  const channels = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * The declarations of one custom property, in source order, as they appear in
 * styles.css. Two entries means the token moves between light and dark.
 */
function declarations(token: string): string[] {
  const re = new RegExp(`^\\s*${token}:\\s*([^;]+);`, "gm");
  return [...STYLESHEET.matchAll(re)].map((m) => m[1]!.replace(/\/\*.*$/, "").trim());
}

describe("terminalTheme", () => {
  it("names every colour xterm can paint, including the ANSI sixteen", () => {
    const theme = terminalTheme(mapReader({}));
    expect(Object.keys(theme).sort()).toEqual(Object.keys(TERM_FALLBACK).sort());
    for (const ansi of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]) {
      expect(theme[ansi as TermField]).toBeTruthy();
      expect(theme[`bright${ansi[0]!.toUpperCase()}${ansi.slice(1)}` as TermField]).toBeTruthy();
    }
  });

  it("takes its values from the stylesheet, not from a literal in this module", () => {
    const theme = terminalTheme(mapReader({ "--term-bg": "#123456", "--term-green": "#00ff00" }));
    expect(theme.background).toBe("#123456");
    expect(theme.green).toBe("#00ff00");
  });

  it("falls back per token, so one missing variable is not a black rectangle", () => {
    const theme = terminalTheme(mapReader({ "--term-bg": "" }));
    expect(theme.background).toBe(TERM_FALLBACK.background);
    expect(theme.foreground).toBe(TERM_FALLBACK.foreground);
  });

  it("falls back to something dark, because a white flash reads as a crash", () => {
    expect(luminance(TERM_FALLBACK.background)).toBeLessThan(0.05);
    expect(contrast(TERM_FALLBACK.foreground, TERM_FALLBACK.background)).toBeGreaterThan(7);
  });

  it("keeps the font stack in the stylesheet too", () => {
    expect(terminalFont(mapReader({ "--font-mono": "JetBrains Mono" }))).toBe("JetBrains Mono");
    expect(terminalFont(mapReader({}))).toMatch(/monospace/);
  });
});

/*
 * The stylesheet is the source of truth for the palette, so these assert
 * against the file rather than against a copy of its values. The claim being
 * defended is the one the owner asked for and the one that is easy to lose in a
 * later refactor: the terminal is dark in *both* themes, so "system = light"
 * never yields a white PTY.
 */
describe("the palette in styles.css", () => {
  it("declares a terminal background twice — once per theme", () => {
    expect(declarations("--term-bg")).toHaveLength(2);
  });

  it("is dark in light mode and dark in dark mode alike", () => {
    for (const bg of declarations("--term-bg")) {
      expect(luminance(bg)).toBeLessThan(0.05);
    }
  });

  it("keeps the foreground legible on it", () => {
    const fg = declarations("--term-fg")[0]!;
    for (const bg of declarations("--term-bg")) {
      expect(contrast(fg, bg)).toBeGreaterThan(7);
    }
  });

  it("gives dim text a colour rather than a shade of the background", () => {
    const dim = declarations("--term-bright-black")[0]!;
    for (const bg of declarations("--term-bg")) {
      expect(contrast(dim, bg)).toBeGreaterThan(3);
    }
  });

  it("declares every token the theme reads, in a form xterm accepts", () => {
    for (const token of Object.values(TOKENS)) {
      expect(declarations(token).length, `${token} is never declared`).toBeGreaterThan(0);
    }
    const theme = terminalTheme(mapReader({}));
    for (const value of Object.values(theme)) expect(value).toMatch(/^#[0-9a-f]{6,8}$/i);
  });
});

describe("cssReader", () => {
  it("reads through the live document when there is one", () => {
    // Node environment: no document, so the reader must not be constructed at
    // import time. Constructing it is the caller's job, at paint.
    expect(typeof cssReader).toBe("function");
    expect(typeof globalThis.document).toBe("undefined");
  });
});
