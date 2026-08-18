import { useEffect, useRef, useState } from "react";
import { useResolvedTheme } from "../../lib/theme";

/**
 * Agent-authored markdown is hostile input, and the agent that wrote it may
 * itself have been prompt-injected. So the rendered document never touches this
 * document: the server sanitizes it, and we show it in an iframe sandboxed with
 * `allow-scripts` and *deliberately without* `allow-same-origin`, which lands it
 * in an opaque origin with no access to our cookies, storage or DOM. Mermaid and
 * highlighting run in there, where they can't reach anything.
 *
 * The frame reports its height by postMessage. We validate the sender is that
 * frame, that the origin is the opaque "null", and that the payload is the
 * shape we expect, before believing a pixel of it.
 *
 * The one thing that sandbox costs us is styling: the document cannot read our
 * `.dark` class, our custom properties, or our localStorage, and left alone it
 * follows `prefers-color-scheme` — the *operating system*. Our theme has three
 * states and the OS has two, so the two disagree constantly: an OS in light
 * mode with the app toggled to dark rendered a white page inside a dark app,
 * which is the "it's a white background" everyone reported. `?theme=` is the
 * whole fix, and it is a query parameter rather than a message because the
 * palette has to be right in the *first* paint, not one round trip later.
 */
const MAX_HEIGHT = 20000;

/** What an unsized frame occupies while it decides how tall it is. */
const INITIAL_HEIGHT = 240;

export interface DocumentFrameProps {
  /** Same-origin URL of the server-rendered document. */
  src: string;
  title: string;
  /** Clamp for the inline (non-fullscreen) presentation. */
  maxHeight?: number;
  className?: string;
}

/**
 * Add `theme` to a render URL, keeping any fragment behind it.
 *
 * Exported for the test: the fragment is how an attachment card anchors the
 * document at its own section, and a naive `src + "?theme=..."` would land the
 * parameter inside the fragment and be silently ignored by the server.
 */
export function withTheme(src: string, theme: "light" | "dark"): string {
  const url = new URL(src, window.location.origin);
  url.searchParams.set("theme", theme);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function DocumentFrame({ src, title, maxHeight, className }: DocumentFrameProps) {
  const theme = useResolvedTheme();
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const [failed, setFailed] = useState(false);
  const themed = withTheme(src, theme);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const frame = ref.current;
      if (!frame || ev.source !== frame.contentWindow) return;
      // A sandboxed frame without allow-same-origin always reports "null".
      if (ev.origin !== "null" && ev.origin !== window.location.origin) return;
      const data = ev.data as unknown;
      if (typeof data !== "object" || data === null) return;
      const msg = data as { type?: unknown; height?: unknown };
      if (msg.type !== "herdrer:height") return;
      const h = Number(msg.height);
      if (!Number.isFinite(h) || h <= 0) return;
      setHeight(Math.min(Math.ceil(h), MAX_HEIGHT));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /*
   * Toggling the theme reloads the frame, and the reloaded document posts its
   * height again a moment later. We deliberately keep the old height across
   * that gap rather than resetting: the two renders are the same document in
   * two palettes, so the height is right, and collapsing to 240px and springing
   * back is a worse answer to a theme toggle than doing nothing visible at all.
   */

  if (failed) {
    return (
      <div className="m-3 rounded-md border border-border bg-surface-2 p-3 text-xs text-muted">
        The rendered document didn't load. The raw markdown is below.
      </div>
    );
  }

  return (
    <iframe
      ref={ref}
      title={title}
      src={themed}
      // No allow-same-origin: that is the whole point.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setFailed(true)}
      className={className ?? "w-full border-0 bg-surface"}
      style={{ height: maxHeight ? Math.min(height, maxHeight) : height }}
    />
  );
}

export function renderURL(id: string, fragment?: string): string {
  const base = `/api/v1/review/${encodeURIComponent(id)}/render`;
  return fragment ? `${base}#${encodeURIComponent(fragment)}` : base;
}
