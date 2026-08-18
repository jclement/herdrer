import type { ITheme } from "@xterm/xterm";

/**
 * The terminal's colours, read out of the stylesheet at runtime.
 *
 * xterm draws to a canvas, so it cannot inherit anything: every colour it uses
 * has to be handed to it as a literal. The obvious way to do that is to write
 * sixteen hex strings into this file, and that is exactly what makes a terminal
 * stop following the theme toggle. So the values live in styles.css as
 * `--term-*` custom properties — see the comment there for why the terminal is
 * dark in *both* themes — and this module is only the bridge.
 *
 * The bridge matters for one reason: `term.options.theme = …` re-paints a live
 * terminal in place. Rebuilding the Terminal to change its colours would drop
 * the websocket and the scrollback, which is a very expensive way to change a
 * background.
 */

/** The token each ITheme field is read from. */
const TOKENS = {
  background: "--term-bg",
  foreground: "--term-fg",
  cursor: "--term-cursor",
  cursorAccent: "--term-cursor-fg",
  selectionBackground: "--term-selection",
  selectionInactiveBackground: "--term-selection-inactive",
  black: "--term-black",
  red: "--term-red",
  green: "--term-green",
  yellow: "--term-yellow",
  blue: "--term-blue",
  magenta: "--term-magenta",
  cyan: "--term-cyan",
  white: "--term-white",
  brightBlack: "--term-bright-black",
  brightRed: "--term-bright-red",
  brightGreen: "--term-bright-green",
  brightYellow: "--term-bright-yellow",
  brightBlue: "--term-bright-blue",
  brightMagenta: "--term-bright-magenta",
  brightCyan: "--term-bright-cyan",
  brightWhite: "--term-bright-white",
} as const satisfies Record<string, string>;

export type TermField = keyof typeof TOKENS;

/**
 * What the terminal looks like if the stylesheet is not there to be read —
 * a bare `render()` in a test, or a paint that beats the CSS in.
 *
 * These mirror the light-theme values in styles.css rather than inventing a
 * second palette, and every one of them is dark: a fallback that flashes white
 * is worse than no fallback, because a white flash on a terminal reads as a
 * crash.
 */
export const TERM_FALLBACK: Record<TermField, string> = {
  background: "#0b0f14",
  foreground: "#d7e0ea",
  cursor: "#4aa8ff",
  cursorAccent: "#06121e",
  selectionBackground: "#4aa8ff44",
  selectionInactiveBackground: "#4aa8ff22",
  black: "#12181f",
  red: "#f2666a",
  green: "#46c07a",
  yellow: "#e0a03a",
  blue: "#4aa8ff",
  magenta: "#c58af9",
  cyan: "#3fc7c7",
  white: "#c2ccd7",
  brightBlack: "#55636f",
  brightRed: "#ff8f92",
  brightGreen: "#7ede9f",
  brightYellow: "#f5c26b",
  brightBlue: "#82c4ff",
  brightMagenta: "#dcb0ff",
  brightCyan: "#7ee0e0",
  brightWhite: "#f2f7fb",
};

/** Looks a CSS custom property up by name. Injected so the mapping is testable. */
export type CssReader = (name: string) => string;

/** A reader over the live document — this is the one the app uses. */
export function cssReader(el: Element = document.documentElement): CssReader {
  const css = getComputedStyle(el);
  return (name) => css.getPropertyValue(name).trim();
}

/** A reader over a plain map, for tests and for the fallback path. */
export function mapReader(values: Readonly<Record<string, string>>): CssReader {
  return (name) => values[name] ?? "";
}

/**
 * The current palette as an xterm theme.
 *
 * A token that resolves to nothing falls back rather than being omitted:
 * omitting `background` leaves xterm on its own default, which is `#000000` and
 * therefore a black rectangle that does not match either of our themes.
 */
export function terminalTheme(read: CssReader): ITheme {
  const theme = {} as Record<TermField, string>;
  for (const [field, token] of Object.entries(TOKENS) as [TermField, string][]) {
    theme[field] = read(token) || TERM_FALLBACK[field];
  }
  return theme;
}

/** The font stack, from the same stylesheet, for the same reason. */
export function terminalFont(read: CssReader): string {
  return read("--font-mono") || "ui-monospace, Menlo, Consolas, monospace";
}
