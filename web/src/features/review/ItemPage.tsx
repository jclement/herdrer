import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { TERMINAL_PATH } from "../../components/AppShell";
import { Link2, Terminal, Trash2 } from "lucide-react";
import { ApiError, describeError } from "../../lib/api";
import { useDismissReview, useReview } from "../../lib/queries";
import { scrollMemory } from "../../lib/storage";
import { ErrorState, SkeletonRows, cx } from "../../components/ui";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/toast";
import { ReviewBody } from "./ReviewBody";
import { ActionBar } from "./ActionBar";
import { useAnswering } from "./useAnswering";
import { useReviewQueue } from "./ReviewQueue";
import { isAnswerable } from "./answer";

/**
 * A review item as a whole page.
 *
 * The overlay is the everyday surface now — a question arrives over the
 * terminal and is answered without going anywhere. This page is what a link
 * resolves to: a push notification tap, a copied URL, a row in the inbox. It
 * survives because a deep link has to land somewhere, and because reading a
 * long document with the browser's own scroll is still the better experience
 * when you are not mid-command.
 */
export function ItemPage() {
  const { id } = useParams({ from: "/r/$id" });
  const search = useSearch({ from: "/r/$id" }) as { a?: string };
  const navigate = useNavigate();
  const toast = useToast();

  const { data: item, isPending, error, refetch } = useReview(id);
  const dismiss = useDismissReview();
  const queue = useReviewQueue();
  const [moreOpen, setMoreOpen] = useState(false);
  // Measured, not guessed: the bar is an option row taller per option and ~60px
  // taller again with the note open.
  const [barHeight, setBarHeight] = useState(176);
  const restored = useRef(false);

  const answering = useAnswering(id, item, {
    // `?a=recommended` pre-selects; it never sends. A notification cannot answer.
    preselectRecommended: search.a === "recommended",
    onConflict: () => void refetch(),
  });

  /*
   * Coming back from the diagram viewer or the terminal must not land at the top.
   *
   * The restore waits for the page to be tall enough to hold the saved offset.
   * The document is a sandboxed iframe that starts 240px tall and only reaches
   * its real height once it has posted one — several seconds later on a phone
   * with diagrams in it — so restoring the moment `item` resolves means the
   * browser clamps the scroll to a short page and the restore lands wrong on
   * every item that has a document. Which is all of them.
   */
  useEffect(() => {
    if (!item || restored.current) return;
    const y = scrollMemory.read(id);
    if (y <= 0) {
      restored.current = true;
      return;
    }
    let frame = 0;
    const deadline = Date.now() + 8000;
    const attempt = () => {
      if (restored.current) return;
      const room = document.documentElement.scrollHeight - window.innerHeight;
      if (room >= y) {
        restored.current = true;
        window.scrollTo(0, y);
        return;
      }
      if (Date.now() > deadline) {
        restored.current = true;
        window.scrollTo(0, Math.max(0, room));
        return;
      }
      frame = window.requestAnimationFrame(attempt);
    };
    frame = window.requestAnimationFrame(attempt);
    return () => window.cancelAnimationFrame(frame);
  }, [item, id]);

  // `scrollMemory.remember` coalesces to one write per frame: the naive version
  // called sessionStorage.setItem synchronously on every scroll event, which on
  // iOS momentum scrolling is ~60 synchronous writes a second.
  useEffect(() => {
    const onScroll = () => scrollMemory.remember(id, window.scrollY);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      scrollMemory.flush();
    };
  }, [id]);

  if (isPending) return <SkeletonRows rows={6} />;
  if (error || !item) {
    return (
      <ErrorState
        title={
          error instanceof ApiError && error.status === 404 ? "No such item" : "Couldn't load it"
        }
        message={error ? describeError(error) : "The server sent nothing back."}
        onRetry={() => void refetch()}
      />
    );
  }

  const answerable = isAnswerable(item);

  return (
    <div style={{ paddingBottom: answerable ? barHeight + 24 : 24 }}>
      <ReviewBody item={item} selected={answering.selected} onSelect={answering.setSelected} />

      {!answerable && (
        <div className="px-3 pb-4">
          <Link
            to="/inbox"
            className="inline-flex min-h-11 items-center text-xs text-accent underline underline-offset-2"
          >
            Back to the inbox
          </Link>
        </div>
      )}

      {answerable && (
        <ActionBar
          item={item}
          selected={answering.selected}
          onSelect={answering.setSelected}
          note={answering.note}
          onNoteChange={answering.setNote}
          onSubmit={answering.submit}
          submitting={answering.submitting}
          onMore={() => setMoreOpen(true)}
          onHeight={setBarHeight}
          onPark={() => {
            queue.defer(item.id);
            toast.show("Parked. Nothing was sent — it is still waiting for you.");
            void navigate({ to: "/inbox" });
          }}
        />
      )}

      <Sheet open={moreOpen} title="More" onClose={() => setMoreOpen(false)}>
        {/*
          Order is a safety property here. Copy-link and open-terminal are the
          two anyone reaches for; Dismiss cancels the item and tells the agent
          nothing was decided, so it sits last, behind a confirm, furthest from
          where a thumb lands when the sheet rises. "Park it" is not in here at
          all any more — deferring is the second most likely correct outcome on
          a phone and it does not belong two taps behind an unlabelled glyph,
          sharing a menu with the one destructive action.
        */}
        <div className="divide-y divide-border pb-2">
          <SheetAction
            icon={<Link2 className="w-4 h-4" />}
            label="Copy link to this item"
            onClick={() => {
              void navigator.clipboard
                .writeText(new URL(`/r/${item.id}`, window.location.origin).toString())
                .then(() => toast.show("Link copied."))
                .catch(() => toast.show("Clipboard said no.", { tone: "danger" }));
              setMoreOpen(false);
            }}
          />
          <SheetAction
            icon={<Terminal className="w-4 h-4" />}
            label="Open the terminal"
            detail={
              item.context?.worker
                ? `${item.context.worker} is in the shared herdr session.`
                : undefined
            }
            onClick={() => {
              setMoreOpen(false);
              // The terminal's own URL, not `/` — `/` is the inbox on a phone,
              // which is the screen this action is being taken from.
              void navigate({ to: TERMINAL_PATH });
            }}
          />
          <SheetAction
            icon={<Trash2 className="w-4 h-4" />}
            label="Dismiss this item"
            detail="Cancels it. The agent is told nothing was decided."
            danger
            onClick={() => {
              if (!window.confirm("Dismiss this item? The agent gets no answer.")) return;
              dismiss.mutate(item.id, {
                onSuccess: () => {
                  toast.show("Dismissed.");
                  setMoreOpen(false);
                  void navigate({ to: "/inbox" });
                },
                onError: (err) => toast.show(describeError(err), { tone: "danger" }),
              });
            }}
          />
        </div>
      </Sheet>
    </div>
  );
}

function SheetAction({
  icon,
  label,
  detail,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  detail?: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex min-h-14 w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-hover",
        danger && "hover:bg-danger-weak",
      )}
    >
      <span className={cx("mt-0.5 shrink-0", danger ? "text-danger" : "text-muted")}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cx("block text-sm", danger ? "text-danger" : "text-heading")}>
          {label}
        </span>
        {detail && <span className="mt-0.5 block text-xs text-muted">{detail}</span>}
      </span>
    </button>
  );
}
