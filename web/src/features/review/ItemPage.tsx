import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Link2, Monitor, Terminal, Trash2 } from "lucide-react";
import { ApiError, describeError } from "../../lib/api";
import { useDismissReview, useReview } from "../../lib/queries";
import { scrollMemory } from "../../lib/storage";
import { ErrorState, SkeletonRows, cx } from "../../components/ui";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/toast";
import { ReviewBody } from "./ReviewBody";
import { ActionBar } from "./ActionBar";
import { useAnswering } from "./useAnswering";
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
  const [moreOpen, setMoreOpen] = useState(false);
  const restored = useRef(false);

  const answering = useAnswering(id, item, {
    // `?a=recommended` pre-selects; it never sends. A notification cannot answer.
    preselectRecommended: search.a === "recommended",
    onConflict: () => void refetch(),
  });

  // Coming back from the diagram viewer or the terminal must not land at the top.
  useEffect(() => {
    if (!item || restored.current) return;
    restored.current = true;
    const y = scrollMemory.read(id);
    if (y > 0) window.scrollTo(0, y);
  }, [item, id]);

  useEffect(() => {
    const onScroll = () => scrollMemory.write(id, window.scrollY);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
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
    <div className="pb-40">
      <ReviewBody item={item} selected={answering.selected} onSelect={answering.setSelected} />

      {!answerable && (
        <div className="px-3 pb-4">
          <Link to="/inbox" className="text-xs text-accent underline">
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
        />
      )}

      <Sheet open={moreOpen} title="More" onClose={() => setMoreOpen(false)}>
        <div className="divide-y divide-border">
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
              void navigate({ to: "/" });
            }}
          />
          <SheetAction
            icon={<Monitor className="w-4 h-4" />}
            label="Needs a real screen"
            detail="Keeps the item open and leaves your note. Nothing is sent."
            onClick={() => {
              answering.setNote(
                answering.note.trim() === ""
                  ? "Seen on a phone — I'll answer this properly at a keyboard. Park it, don't guess."
                  : answering.note,
              );
              setMoreOpen(false);
              toast.show("Note staged. Send it when you're ready.");
            }}
          />
          <SheetAction
            icon={<Trash2 className="w-4 h-4 text-danger" />}
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
      className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-hover"
    >
      <span className="mt-0.5 shrink-0 text-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cx("block text-sm", danger ? "text-danger" : "text-heading")}>
          {label}
        </span>
        {detail && <span className="mt-0.5 block text-xs text-muted">{detail}</span>}
      </span>
    </button>
  );
}
