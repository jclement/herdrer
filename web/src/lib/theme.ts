import { useCallback, useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";

const KEY = "herdrer.theme";

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* private mode */
  }
  return "system";
}

export function applyTheme(theme: Theme): void {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/**
 * What the app is *actually* painting right now — the three-state preference
 * collapsed to the two palettes that exist.
 *
 * The class on <html> is the single source of truth for this, because the
 * pre-paint script, `applyTheme`, and the system-change listener all funnel
 * through it. Reading the class rather than the preference is also what makes
 * "system" resolvable without duplicating the media query.
 */
export function resolvedTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * Track the resolved palette.
 *
 * Used by anything that has to hand the current theme to something outside
 * React's tree — chiefly the server-rendered review document, which lives in a
 * sandboxed iframe and therefore cannot read our class, our stylesheet or our
 * localStorage. Left to itself it follows the *operating system*, so a phone
 * set to light with the app toggled to dark renders a white document inside a
 * dark app. Telling it explicitly is the fix.
 *
 * A MutationObserver rather than a subscription to `useTheme`, because the
 * class moves for three different reasons (the toggle, the pre-paint script,
 * and the OS changing under a "system" preference) and only one of them is a
 * React state change.
 */
export function useResolvedTheme(): "light" | "dark" {
  const [resolved, setResolved] = useState<"light" | "dark">(resolvedTheme);

  useEffect(() => {
    const sync = () => setResolved(resolvedTheme());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return resolved;
}

/** Three-state toggle: System → Light → Dark → System. */
export function nextTheme(theme: Theme): Theme {
  return theme === "system" ? "light" : theme === "light" ? "dark" : "system";
}

export function useTheme(): { theme: Theme; cycle: () => void } {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* private mode: this session only */
    }
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const cycle = useCallback(() => setTheme((t) => nextTheme(t)), []);
  return { theme, cycle };
}
