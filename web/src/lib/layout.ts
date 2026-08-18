import { useEffect, useState } from "react";

/**
 * Which of the two layouts we are in.
 *
 * Desktop and mobile are not one responsive layout here, they are two designs
 * that happen to share a codebase, and several of the differences are
 * behavioural rather than visual — the review queue does not interrupt on a
 * desktop because the rail is already on screen, and the terminal does not ask
 * you to take control because you have a real keyboard. Behaviour cannot be
 * expressed as an `lg:` class, so the breakpoint has to exist in JS as well as
 * in CSS, and it has to be the *same* breakpoint or the two halves of the
 * design disagree at some window width.
 *
 * The predicate is width alone, matching Tailwind's `lg`. Pointer type would be
 * a truer test of "has a keyboard", but then a narrow window on a laptop would
 * get the phone's chrome with the desktop's input model, which is a worse thing
 * to explain than "make the window wider".
 */
export const DESKTOP_MIN_WIDTH = 1024;
export const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;

export function isDesktopWidth(width: number): boolean {
  return width >= DESKTOP_MIN_WIDTH;
}

export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(DESKTOP_QUERY).matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setDesktop(mq.matches);
    // Between the initial state and this effect the window may have moved.
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return desktop;
}
