import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Clock, ExternalLink, Link2, Trash2, X } from "lucide-react";
import type { ReviewItem } from "../../lib/types";
import { describeError } from "../../lib/api";
import { useDismissReview, useReview } from "../../lib/queries";
import { scrollMemory } from "../../lib/storage";
import { pushEscape } from "../../lib/overlay";
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
 *
 * There is exactly one bar at the bottom, as on the page. There used to be a
 * second — "3 more waiting — show the next one" — occupying the easiest strip
 * on the device, and it was wired to *defer*: overshoot the Send row by ten
 * pixels and the item you were reading was silently postponed and replaced by
 * a different question. The waiting count lives in the header, once, where it
 * is a fact rather than a trap.
 */
export function ReviewSheet({
  id,
  waiting,
  armed,
  onClose,
  onAnswered,
}: {
  id: string;
  /** How many other open items are behind this one. */
  waiting: number;
  /** False when the queue raised it; the answer controls arm shortly after. */
  armed: boolean;
  /** Dismiss without answering — a defer, not a decision. */
  onClose: () => void;
  onAnswered: () => void;
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
  // Top of the overlay stack only: Escape with the fullscreen document open
  // inside this sheet must close the document, not both.
  useEffect(() => pushEscape(onClose), [onClose]);

  // Deferring and coming back is a real workflow, so the scroll position is too.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !item || restored.current) return;
    restored.current = true;
    const y = scrollMemory.read(`sheet.${id}`);
    if (y > 0) el.scrollTop = y;
  }, [item, id]);

  // The last frame of a scroll may never arrive if the sheet closes first.
  useEffect(() => () => scrollMemory.flush(), []);

  const answerable = item ? isAnswerable(item) : false;

  return (
    <div
      className="fixed inset-x-0 z-40 flex flex-col"
      /*
       * The notch inset lives here, on the container, rather than on any row
       * inside the panel: this element is pinned to the top of the visual
       * viewport, has no fixed height of its own, and is the only thing that
       * knows how far down the sheet may start. Without it the header row —
       * and with it the only way out of the sheet — renders under the status
       * bar on a notched iPhone in standalone. Every other top-anchored
       * surface in the app already does this; the primary answering surface
       * was the one that did not. The strip it leaves above the panel shows
       * the scrim, which is also the first thing on a phone that has ever made
       * this read as a sheet rather than as a second full-screen app.
       */
      style={{
        top: vv.offsetTop,
        height: vv.height,
        paddingTop: "env(safe-area-inset-top, 0px)",
      }}
      role="dialog"
      aria-modal="true"
      aria-label={item?.title ?? "Review"}
    >
      <div
        className="fade absolute inset-0 bg-scrim"
        onClick={onClose}
        aria-hidden
        data-testid="review-sheet-scrim"
      />
      {/* Full-bleed on a phone, a centred panel above `sm`, and wider again on
          a desktop — where this is the meatprompt modal the rail opens and a
          diff has room to be read rather than scrolled sideways. */}
      <div className="rise relative mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col border-t border-border bg-surface shadow-2xl sm:my-4 sm:rounded-xl sm:border lg:my-8 lg:max-w-4xl">
        <SheetHeader item={item} waiting={waiting} onClose={onClose} />

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
          onScroll={(e) => scrollMemory.remember(`sheet.${id}`, e.currentTarget.scrollTop)}
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
            onPark={() => {
              toast.show("Parked. Nothing was sent — it is still waiting for you.");
              onClose();
            }}
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
      </div>
    </div>
  );
}

/**
 * The escape sits top-left, where the page's back chevron is.
 *
 * The page and the sheet show the same document; when they disagree on where
 * the way out is, the reader has to work out which shell they are in before
 * they can leave it — and the two shells are reached by routes they do not
 * choose (a push tap lands on the page, the queue raises the sheet). One rule:
 * out is top-left, secondary actions are in the bar at the bottom.
 */
function SheetHeader({
  item,
  waiting,
  onClose,
}: {
  item: ReviewItem | undefined;
  waiting: number;
  onClose: () => void;
}) {
  return (
    <div className="shrink-0 border-b border-border bg-surface-2">
      <div className="flex h-12 items-center gap-1.5 pl-1 pr-3">
        <button
          aria-label="Later"
          onClick={onClose}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-heading"
        >
          <X className="w-4 h-4" />
        </button>
        {/* One `blocking` mark per surface. The body carries the rail; this is
            what survives once the title has scrolled away. */}
        {item?.urgency === "blocking" ? (
          <Chip tone="danger">blocking</Chip>
        ) : item ? null : (
          <Spinner label="" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-heading">Review</span>
        {waiting > 0 && (
          <span className="whitespace-nowrap text-[11px] text-muted">
            <Clock className="mr-0.5 inline w-3 h-3" />
            {waiting} waiting
          </span>
        )}
      </div>
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
  onDismiss,
}: {
  item: ReviewItem;
  onCopy: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="drop flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface-2 px-2 py-1.5">
      <StripButton icon={<Link2 className="w-3.5 h-3.5" />} label="Copy link" onClick={onCopy} />
      <StripButton
        icon={<ExternalLink className="w-3.5 h-3.5" />}
        label="Full page"
        to={`/r/${item.id}`}
      />
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
    "flex h-10 shrink-0 items-center gap-1 whitespace-nowrap rounded border px-2.5 text-[11px]",
    "transition-colors",
    danger
      ? "border-danger/40 text-danger hover:bg-danger-weak"
      : "border-border bg-surface text-body hover:bg-hover",
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
