import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Image as ImageIcon,
  Maximize2,
  Paperclip,
  Workflow,
  X,
} from "lucide-react";
import type { Attachment } from "../../lib/types";
import { diffStat, hasUnifiedDiff } from "../../lib/attachments";
import { DocumentFrame, renderURL } from "./DocumentFrame";
import { DiffView } from "./DiffView";
import { cx } from "../../components/ui";

/** Code is rendered as text, escaped by JSX. Never as HTML. */
export function CodeBlock({ attachment }: { attachment: Attachment }) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const content = attachment.content ?? "";
  const lines = content === "" ? 0 : content.split("\n").length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* selection over a phone code block is unreliable, but the text is there */
    }
  };

  return (
    <div className="mx-3 overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-surface-2 pl-2 pr-1">
        <button
          className="flex min-h-11 min-w-0 flex-1 items-center gap-1 py-2 text-left"
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
        <span className="shrink-0 font-mono text-[10px] text-muted tabular-nums">
          {attachment.language || "text"} · {lines}L
        </span>
        <button
          onClick={() => void copy()}
          aria-label="Copy"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-heading"
        >
          {copied ? <Check className="w-4 h-4 text-ok" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      {open && (
        <pre
          className="scroll-x bg-surface px-2 py-2 font-mono text-[11px] leading-5 text-body"
          style={{ maxHeight: "60vh", overflowY: "auto" }}
        >
          {content}
        </pre>
      )}
    </div>
  );
}

/**
 * A change: either a plain `diff` the agent wrote, or a `filediff` the server
 * computed from the two whole files it was sent.
 *
 * They render identically here on purpose. `filediff` is the kind an agent
 * *should* send — it hands over both originals and lets herdrer do the diffing
 * with full file context, so the reader can expand past the hunks and the agent
 * does not get to choose which lines the human is allowed to notice — but by
 * the time it reaches this component it is a unified diff like any other, and a
 * second rendering path for it would be a second place for the diff to be
 * wrong.
 *
 * When a `filediff` arrives as `before`/`after` with nothing computed, that is
 * the server's render to do, not ours: the card points at the document rather
 * than running a diff algorithm on a phone to second-guess the one on the box.
 */
export function DiffAttachment({ itemId, attachment }: { itemId: string; attachment: Attachment }) {
  if (!hasUnifiedDiff(attachment)) {
    return (
      <FramedAttachment
        itemId={itemId}
        attachment={attachment}
        icon={<FileText className="w-4 h-4 shrink-0 text-muted" />}
        fallbackTitle="Change"
      />
    );
  }
  const stat = diffStat(attachment);
  return (
    <div className="border-y border-border py-1">
      <DiffView content={attachment.content ?? ""} title={attachment.title} stat={stat} />
    </div>
  );
}

/**
 * Anything whose picture lives inside the sandboxed document: a mermaid
 * diagram, an inlined image, or a kind this build has never seen.
 *
 * The card is the handle and the document is the picture. It cannot be
 * otherwise — mermaid runs in the frame where it can't reach anything, and an
 * image is inlined as a data URI in that same document because a subresource
 * fetched from an opaque origin is a worse problem than a bigger page. So the
 * card embeds the document anchored at this attachment, and a tap opens the
 * full-screen viewer where the platform's own pinch-zoom does the zooming.
 */
export function FramedAttachment({
  itemId,
  attachment,
  icon,
  fallbackTitle,
  /** Diagram sources are worth showing; an image has none. */
  showSource = false,
}: {
  itemId: string;
  attachment: Attachment;
  icon: React.ReactNode;
  fallbackTitle: string;
  showSource?: boolean;
}) {
  const [full, setFull] = useState(false);
  const [source, setSource] = useState(false);
  const title = attachment.title || fallbackTitle;
  const src = renderURL(itemId, `a-${attachment.id}`);
  const hasSource = showSource && !!attachment.content;

  return (
    <div className="mx-3 overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-surface-2 pl-2 pr-1 py-1">
        {icon}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-heading">{title}</span>
        <button
          className="flex h-10 shrink-0 items-center gap-1 rounded border border-border px-2 text-[11px] text-accent transition-colors hover:border-accent/60 hover:bg-hover"
          onClick={() => setFull(true)}
        >
          <Maximize2 className="w-3.5 h-3.5" />
          full screen
        </button>
      </div>

      <button
        className="block w-full bg-surface px-3 py-3 text-left transition-colors hover:bg-hover"
        onClick={() => setFull(true)}
        aria-label={`Open ${title} full screen`}
      >
        <div className="pointer-events-none max-h-[40vh] overflow-hidden">
          <DocumentFrame
            src={src}
            title={title}
            maxHeight={Math.round((typeof window === "undefined" ? 800 : window.innerHeight) * 0.4)}
          />
        </div>
        <div className="mt-1.5 text-[11px] text-muted">Tap to open. Pinch to zoom in there.</div>
      </button>

      {hasSource && (
        <>
          <button
            className="flex min-h-11 w-full items-center border-t border-border px-2 text-left text-[11px] text-muted transition-colors hover:bg-hover"
            onClick={() => setSource((v) => !v)}
            aria-expanded={source}
          >
            {source ? "hide source" : "show source"}
          </button>
          {source && (
            <pre className="scroll-x border-t border-border bg-surface-2 px-2 py-2 font-mono text-[11px] leading-5 text-body">
              {attachment.content}
            </pre>
          )}
        </>
      )}

      <FullscreenDocument open={full} onClose={() => setFull(false)} title={title} src={src} />
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
    <div className="fade fixed inset-0 z-50 flex flex-col bg-surface">
      {/*
        The inset goes on the outer element and the height on the inner row.
        Putting both on one element is the notch bug that eats a header: `h-11`
        is a border-box height, so a 59px `padding-top` leaves the content box
        at zero and the buttons render *below* the bar they belong to.
      */}
      <div
        className="shrink-0 border-b border-border bg-surface-2"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="flex h-12 items-center justify-between gap-2 pl-3 pr-1">
          <span className="min-w-0 truncate text-sm font-semibold text-heading">{title}</span>
          <button
            aria-label="Close"
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-heading"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div
        className={cx("min-h-0 flex-1 overflow-auto")}
        style={{
          touchAction: "pinch-zoom",
          overscrollBehavior: "contain",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
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
        switch (a.kind) {
          case "diff":
          case "filediff":
            return <DiffAttachment key={a.id} itemId={itemId} attachment={a} />;
          case "mermaid":
            return (
              <FramedAttachment
                key={a.id}
                itemId={itemId}
                attachment={a}
                icon={<Workflow className="w-4 h-4 shrink-0 text-muted" />}
                fallbackTitle="Diagram"
                showSource
              />
            );
          case "image":
            return (
              <FramedAttachment
                key={a.id}
                itemId={itemId}
                attachment={a}
                icon={<ImageIcon className="w-4 h-4 shrink-0 text-muted" />}
                fallbackTitle="Image"
              />
            );
          case "markdown":
            // Markdown attachments are part of the server-rendered document; showing
            // them again here would mean rendering agent markdown ourselves.
            return null;
          default:
            // A kind this build predates. It is already on screen inside the
            // document — the honest thing is a handle to it, not "unknown kind"
            // and not silence.
            return (
              <FramedAttachment
                key={a.id}
                itemId={itemId}
                attachment={a}
                icon={<Paperclip className="w-4 h-4 shrink-0 text-muted" />}
                fallbackTitle={a.kind}
              />
            );
        }
      })}
    </div>
  );
}
