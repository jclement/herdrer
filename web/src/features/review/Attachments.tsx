import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Maximize2, Workflow, X } from "lucide-react";
import type { Attachment } from "../../lib/types";
import { DocumentFrame, renderURL } from "./DocumentFrame";
import { DiffView } from "./DiffView";
import { cx } from "../../components/ui";

/** Code is rendered as text, escaped by JSX. Never as HTML. */
export function CodeBlock({ attachment }: { attachment: Attachment }) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const lines = attachment.content.split("\n").length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(attachment.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* selection over a phone code block is unreliable, but the text is there */
    }
  };

  return (
    <div className="mx-3 overflow-hidden rounded border border-border">
      <div className="flex items-center gap-2 bg-surface-2 px-2 py-2">
        <button
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="w-4 h-4 shrink-0 text-muted" />
          ) : (
            <ChevronRight className="w-4 h-4 shrink-0 text-muted" />
          )}
          <span className="truncate text-xs font-medium text-heading">{attachment.title}</span>
        </button>
        <span className="shrink-0 font-mono text-[10px] text-muted">
          {attachment.language || "text"} · {lines}L
        </span>
        <button onClick={() => void copy()} aria-label="Copy" className="p-1 text-muted">
          {copied ? <Check className="w-4 h-4 text-ok" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      {open && (
        <pre
          className="scroll-x bg-surface px-2 py-2 font-mono text-[11px] leading-5 text-body"
          style={{ maxHeight: "60vh", overflowY: "auto" }}
        >
          {attachment.content}
        </pre>
      )}
    </div>
  );
}

export function DiffAttachment({ attachment }: { attachment: Attachment }) {
  return (
    <div className="border-y border-border py-1">
      <DiffView content={attachment.content} title={attachment.title} />
    </div>
  );
}

/**
 * Mermaid renders inside the sandboxed document, not here — so the card is the
 * handle, and the picture is the full-screen view of the rendered document
 * anchored at this attachment. The source is always one tap away, because agents
 * write broken mermaid regularly and a red box helps nobody.
 */
export function DiagramCard({ itemId, attachment }: { itemId: string; attachment: Attachment }) {
  const [full, setFull] = useState(false);
  const [source, setSource] = useState(false);

  return (
    <div className="mx-3 overflow-hidden rounded border border-border">
      <div className="flex items-center gap-2 bg-surface-2 px-2 py-2">
        <Workflow className="w-4 h-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-heading">
          {attachment.title || "Diagram"}
        </span>
        <button
          className="flex h-8 items-center gap-1 rounded border border-border px-2 text-[11px] text-accent"
          onClick={() => setFull(true)}
        >
          <Maximize2 className="w-3.5 h-3.5" />
          full screen
        </button>
      </div>

      <button
        className="block w-full bg-surface px-3 py-4 text-left"
        onClick={() => setFull(true)}
        aria-label={`Open ${attachment.title || "diagram"} full screen`}
      >
        <div className="pointer-events-none max-h-[40vh] overflow-hidden">
          <DocumentFrame
            src={renderURL(itemId, `a-${attachment.id}`)}
            title={attachment.title || "Diagram"}
            maxHeight={Math.round(window.innerHeight * 0.4)}
          />
        </div>
        <div className="mt-1 text-[11px] text-muted">Tap to open. Pinch to zoom in there.</div>
      </button>

      <button
        className="w-full border-t border-border px-2 py-1.5 text-left text-[11px] text-muted"
        onClick={() => setSource((v) => !v)}
        aria-expanded={source}
      >
        {source ? "hide source" : "show source"}
      </button>
      {source && (
        <pre className="scroll-x bg-surface-2 px-2 py-2 font-mono text-[11px] leading-5 text-body">
          {attachment.content}
        </pre>
      )}

      <FullscreenDocument
        open={full}
        onClose={() => setFull(false)}
        title={attachment.title || "Diagram"}
        src={renderURL(itemId, `a-${attachment.id}`)}
      />
    </div>
  );
}

/**
 * Full-viewport viewer. The page beneath is scroll-locked and the container
 * keeps `touch-action: pinch-zoom`, so the native gesture does the zooming —
 * hand-rolling pan/zoom over an iframe is worse than the platform's version.
 */
export function FullscreenDocument({
  open,
  onClose,
  title,
  src,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  src: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      <div
        className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <span className="truncate text-sm font-medium text-heading">{title}</span>
        <button aria-label="Close" onClick={onClose} className="p-2 text-muted">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div
        className={cx("min-h-0 flex-1 overflow-auto")}
        style={{ touchAction: "pinch-zoom", overscrollBehavior: "contain" }}
      >
        <DocumentFrame src={src} title={title} />
      </div>
    </div>
  );
}

export function AttachmentList({
  itemId,
  attachments,
}: {
  itemId: string;
  attachments: Attachment[];
}) {
  return (
    <div className="space-y-3">
      {attachments.map((a) => {
        if (a.kind === "diff") return <DiffAttachment key={a.id} attachment={a} />;
        if (a.kind === "mermaid") return <DiagramCard key={a.id} itemId={itemId} attachment={a} />;
        if (a.kind === "code") return <CodeBlock key={a.id} attachment={a} />;
        // Markdown attachments are part of the server-rendered document; showing
        // them again here would mean rendering agent markdown ourselves.
        return null;
      })}
    </div>
  );
}
