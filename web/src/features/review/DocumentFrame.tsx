import { useEffect, useRef, useState } from "react";

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
 */
const MAX_HEIGHT = 20000;

export interface DocumentFrameProps {
  /** Same-origin URL of the server-rendered document. */
  src: string;
  title: string;
  /** Clamp for the inline (non-fullscreen) presentation. */
  maxHeight?: number;
  className?: string;
}

export function DocumentFrame({ src, title, maxHeight, className }: DocumentFrameProps) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(240);
  const [failed, setFailed] = useState(false);

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

  if (failed) {
    return (
      <div className="m-3 rounded border border-border bg-surface-2 p-3 text-xs text-muted">
        The rendered document didn't load. The raw markdown is below.
      </div>
    );
  }

  return (
    <iframe
      ref={ref}
      title={title}
      src={src}
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
