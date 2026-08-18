/**
 * One overlay stack for the whole app.
 *
 * Three surfaces used to lock the page scroll independently — the `Sheet`, the
 * fullscreen document viewer, and the terminal route — each by saving
 * `document.body.style.overflow` on the way in and writing it back on the way
 * out. Save-and-restore composes only if the opens and closes nest perfectly,
 * and they do not: open a sheet, open the fullscreen viewer from inside it,
 * close the sheet first, and the viewer's teardown restores the *locked* value
 * as if it were the original. The page is then permanently unscrollable with no
 * recovery short of a reload, on a phone, while a question is waiting.
 *
 * So: a counter, not a stack of saved strings. The first lock records what was
 * there; the last unlock puts it back. Anything in between only moves the
 * count, and an unlock is idempotent so a double-teardown cannot drive it
 * negative.
 *
 * The Escape key gets the same treatment for the same reason. Each surface used
 * to register its own `document` keydown listener, so one Escape with the
 * viewer open inside a sheet closed both of them. Here only the top of the
 * stack is called.
 */

interface Saved {
  body: string;
  html: string;
}

let locks = 0;
let saved: Saved | null = null;

/** True while at least one overlay holds the lock. Exported for the test. */
export function scrollLocked(): boolean {
  return locks > 0;
}

/**
 * Hold the page still. Returns the release, which is safe to call twice —
 * React's strict mode and an unmount-during-close both do exactly that.
 */
export function lockScroll(): () => void {
  const body = document.body;
  const html = document.documentElement;
  if (locks === 0) {
    saved = { body: body.style.overflow, html: html.style.overflow };
    body.style.overflow = "hidden";
    html.style.overflow = "hidden";
  }
  locks += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks -= 1;
    if (locks > 0) return;
    locks = 0;
    body.style.overflow = saved?.body ?? "";
    html.style.overflow = saved?.html ?? "";
    saved = null;
  };
}

type EscapeHandler = () => void;

const escapes: EscapeHandler[] = [];
let keyListener: ((e: KeyboardEvent) => void) | null = null;

/**
 * Register an Escape handler. Only the most recently pushed one fires, so a
 * viewer opened over a sheet closes the viewer and leaves the sheet standing.
 */
export function pushEscape(handler: EscapeHandler): () => void {
  escapes.push(handler);
  if (keyListener === null) {
    keyListener = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const top = escapes[escapes.length - 1];
      if (top) top();
    };
    document.addEventListener("keydown", keyListener);
  }

  let popped = false;
  return () => {
    if (popped) return;
    popped = true;
    const i = escapes.lastIndexOf(handler);
    if (i >= 0) escapes.splice(i, 1);
    if (escapes.length === 0 && keyListener !== null) {
      document.removeEventListener("keydown", keyListener);
      keyListener = null;
    }
  };
}

/** Test-only: forget everything. Never called by the app. */
export function resetOverlays(): void {
  locks = 0;
  saved = null;
  escapes.length = 0;
  if (keyListener !== null) {
    document.removeEventListener("keydown", keyListener);
    keyListener = null;
  }
}
