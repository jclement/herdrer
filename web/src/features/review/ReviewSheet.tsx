import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ChevronRight,
  Clock,
  ExternalLink,
  Layers,
  Link2,
  MoreHorizontal,
  Trash2,
  X,
} from "lucide-react";
import type { ReviewItem } from "../../lib/types";
import { describeError } from "../../lib/api";
import { useDismissReview, useReview } from "../../lib/queries";
import { scrollMemory } from "../../lib/storage";
import { useVisualViewport } from "../../lib/viewport";
import { Button, Chip, ErrorState, SkeletonRows, Spinner, cx } from "../../components/ui";
import { useToast } from "../../components/toast";
import { ReviewBody } from "./ReviewBody";
import { ActionBar } from "./ActionBar";
import { useAnswering } from "./useAnswering";
import { isAnswerable } from "./answer";

/** How long an auto-raised sheet refuses taps, so an in-flight thumb cannot answer. */
export const ARM_DELAY_MS = 400;

/**
 * The full review document, over the terminal.
 *
 * Three things make this readable on a phone rather than a toast with a title:
 *
 *   - It is the *whole* document — the server-rendered markdown with mermaid and
 *     syntax highlighting, the real diff, the code listings — not a summary.
 *   - It owns the visual viewport. The container is sized to `visualViewport`
 *     rather than `100vh`, so the sheet ends where the keyboard begins and the
 *     action bar is the last row of a flex column instead of a second element
 *     racing the first one down the screen.
 *   - Its body is the only scroller. The sandboxed iframe inside is sized to the
 *     height it posts, so it has nothing to scroll internally and a drag started
 *     over the document is handled here. `overscroll-contain` stops that drag
 *     chaining out to Safari's rubber band and the terminal underneath.
 *
 * When the sheet was raised by the queue rather than by a tap, the answer
 * controls are inert for ARM_DELAY_MS. A thumb already travelling toward the
 * terminal must not land on "Yes, drop the table".
 */
export function ReviewSheet({
  id,
  waiting,
  armed,
  onClose,
  onAnswered,
  onNext,
}: {
  id: string;
  /** How many other open items are behind this one. */
  waiting: number;
  /** False when the queue raised it; the answer controls arm shortly after. */
  armed: boolean;
  /** Dismiss without answering — a defer, not a decision. */
  onClose: () => void;
  onAnswered: () => void;
  /** Show the next waiting item, if the human asks for it. */
  onNext?: () => void;
}) {
  const vv = useVisualViewport();
  const toast = useToast();
  const { data: item, isPending, error, refetch } = useReview(id);
  const dismiss = useDismissReview();
  const [live, setLive] = useState(armed);
  const [moreOpen, setMoreOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const restored = useRef(false);

  const answering = useAnswering(id, item, { onAnswered, onConflict: () => void refetch() });

  useEffect(() => {
    if (armed) {
      setLive(true);
      return;
    }
    setLive(false);
    const t = window.setTimeout(() => setLive(true), ARM_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [armed, id]);

  // Escape closes. A hardware keyboard is rare here but a Bluetooth one is not.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Deferring and coming back is a real workflow, so the scroll position is too.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !item || restored.current) return;
    restored.current = true;
    const y = scrollMemory.read(`sheet.${id}`);
    if (y > 0) el.scrollTop = y;
  }, [item, id]);

  const answerable = item ? isAnswerable(item) : false;

  return (
    <div
      className="fixed inset-x-0 z-40 flex flex-col"
      style={{ top: vv.offsetTop, height: vv.height }}
      role="dialog"
      aria-modal="true"
      aria-label={item?.title ?? "Review"}
    >
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden
        data-testid="review-sheet-scrim"
      />
      <div className="relative mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col border-t border-border bg-surface sm:my-4 sm:rounded sm:border">
        <SheetHeader
          item={item}
          waiting={waiting}
          onClose={onClose}
          onMore={() => setMoreOpen((v) => !v)}
          moreOpen={moreOpen}
        />

        {moreOpen && item && (
          <MoreStrip
            item={item}
            onCopy={() => {
              void navigator.clipboard
                .writeText(new URL(`/r/${item.id}`, window.location.origin).toString())
                .then(() => toast.show("Link copied."))
                .catch(() => toast.show("Clipboard said no.", { tone: "danger" }));
              setMoreOpen(false);
            }}
            onPark={() => {
              answering.setNote(
                answering.note.trim() === ""
                  ? "Seen on a phone — I'll answer this properly at a keyboard. Park it, don't guess."
                  : answering.note,
              );
              setMoreOpen(false);
              toast.show("Note staged. Send it when you're ready.");
            }}
            onDismiss={() => {
              if (!window.confirm("Dismiss this item? The agent gets no answer.")) return;
              dismiss.mutate(item.id, {
                onSuccess: () => {
                  toast.show("Dismissed.");
                  setMoreOpen(false);
                  onAnswered();
                },
                onError: (err) => toast.show(describeError(err), { tone: "danger" }),
              });
            }}
          />
        )}

        <div
          ref={bodyRef}
          className="min-h-0 flex-1 overflow-y-auto"
          style={{ overscrollBehavior: "contain" }}
          onScroll={(e) => scrollMemory.write(`sheet.${id}`, e.currentTarget.scrollTop)}
        >
          {isPending && <SkeletonRows rows={5} />}
          {error && !item && (
            <ErrorState message={describeError(error)} onRetry={() => void refetch()} />
          )}
          {item && (
            <ReviewBody
              item={item}
              selected={answering.selected}
              onSelect={answering.setSelected}
              inSheet
            />
          )}
        </div>

        {item && answerable && (
          <ActionBar
            item={item}
            selected={answering.selected}
            onSelect={answering.setSelected}
            note={answering.note}
            onNoteChange={answering.setNote}
            onSubmit={answering.submit}
            submitting={answering.submitting}
            onMore={() => setMoreOpen((v) => !v)}
            anchored={false}
            disabled={!live}
          />
        )}

        {item && !answerable && (
          <div
            className="shrink-0 border-t border-border bg-surface-2 px-3 py-2"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)" }}
          >
            <Button size="lg" className="w-full" onClick={onAnswered}>
              Close
            </Button>
          </div>
        )}

        {waiting > 0 && onNext && (
          <button
            onClick={onNext}
            className="shrink-0 border-t border-border bg-surface-2 px-3 py-2 text-left text-[11px] text-accent"
          >
            <span className="inline-flex items-center gap-1">
              <Layers className="w-3.5 h-3.5" />
              {waiting} more waiting — show the next one
              <ChevronRight className="w-3.5 h-3.5" />
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function SheetHeader({
  item,
  waiting,
  onClose,
  onMore,
  moreOpen,
}: {
  item: ReviewItem | undefined;
  waiting: number;
  onClose: () => void;
  onMore: () => void;
  moreOpen: boolean;
}) {
  return (
    <div
      className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface-2 px-2"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {item?.urgency === "blocking" ? (
          <Chip tone="danger">blocking</Chip>
        ) : item ? (
          <Chip>{item.urgency}</Chip>
        ) : (
          <Spinner label="" />
        )}
        {waiting > 0 && (
          <span className="whitespace-nowrap text-[11px] text-muted">
            <Clock className="mr-0.5 inline w-3 h-3" />
            {waiting} waiting
          </span>
        )}
      </span>
      <button
        aria-label="More actions"
        aria-expanded={moreOpen}
        onClick={onMore}
        className="flex h-11 w-11 items-center justify-center text-muted"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      <button
        aria-label="Later"
        onClick={onClose}
        className="flex h-11 w-11 items-center justify-center text-muted"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/**
 * The secondary actions, inline rather than in a nested sheet.
 *
 * A sheet raised over a sheet is a phone UI that has lost the plot: two scrims,
 * two Escape targets, and no way to tell which one a back-swipe closes.
 */
function MoreStrip({
  item,
  onCopy,
  onPark,
  onDismiss,
}: {
  item: ReviewItem;
  onCopy: () => void;
  onPark: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="scroll-x no-scrollbar flex shrink-0 items-center gap-2 border-b border-border bg-surface-2 px-2 py-1.5">
      <StripButton icon={<Link2 className="w-3.5 h-3.5" />} label="Copy link" onClick={onCopy} />
      <StripButton
        icon={<ExternalLink className="w-3.5 h-3.5" />}
        label="Full page"
        to={`/r/${item.id}`}
      />
      <StripButton icon={<Clock className="w-3.5 h-3.5" />} label="Needs a screen" onClick={onPark} />
      <StripButton
        icon={<Trash2 className="w-3.5 h-3.5" />}
        label="Dismiss"
        onClick={onDismiss}
        danger
      />
    </div>
  );
}

function StripButton({
  icon,
  label,
  onClick,
  to,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  to?: string;
  danger?: boolean;
}) {
  const className = cx(
    "flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-[11px]",
    danger ? "text-danger" : "text-body",
  );
  if (to) {
    return (
      <Link to={to} className={className}>
        {icon}
        {label}
      </Link>
    );
  }
  return (
    <button onClick={onClick} className={className}>
      {icon}
      {label}
    </button>
  );
}
