import { Link } from "@tanstack/react-router";
import { ChevronRight, Inbox, Layers, Terminal } from "lucide-react";
import type { QueueItem } from "../../lib/reviewQueue";
import { shortAge } from "../../lib/format";
import { Chip, cx } from "../../components/ui";

/**
 * The queue, permanently, beside the terminal.
 *
 * This is the desktop half of the review design, and the reason the desktop
 * needs none of the interruption policy the phone needs. On a phone the queue
 * can only exist by covering something, so it has to earn the screen; on a
 * 1400px window it just sits there, and you can see what three agents are
 * waiting on *while* you type at a fourth. That is the thing a phone
 * structurally cannot do, so it is the thing the desktop layout should be
 * built around.
 *
 * A row opens the same document as the phone's sheet — features/review/
 * ReviewSheet.tsx, over features/review/ReviewBody.tsx — as a modal. There is
 * no desktop copy of the document, deliberately: two renderings of a review
 * would drift, and the one that drifted would be the one you answer from.
 */
export function ReviewRail({
  items,
  deferred,
  onOpen,
}: {
  /** Every open item, already in queue order. */
  items: readonly QueueItem[];
  /** Dismissed this session — still listed, just no longer competing. */
  deferred: readonly string[];
  onOpen: (id: string) => void;
}) {
  return (
    <aside
      className="flex w-80 shrink-0 flex-col border-l border-border bg-surface-2"
      aria-label="Waiting on you"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Waiting on you
        </span>
        <span
          className={cx(
            "ml-auto rounded-full px-1.5 text-[11px] font-semibold leading-4 tabular-nums",
            items.length > 0 ? "bg-danger text-danger-fg" : "text-muted",
          )}
        >
          {items.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <Inbox className="mx-auto w-5 h-5 text-muted" aria-hidden />
            <div className="mt-2 text-xs font-medium text-heading">Nothing waiting.</div>
            <div className="mt-1 text-[11px] text-muted">
              Every question has been answered. The agents are on their own.
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((i) => (
              <li key={i.id}>
                <button
                  onClick={() => onOpen(i.id)}
                  className={cx(
                    "flex w-full items-start gap-2 border-l-2 py-2 pl-2.5 pr-3 text-left transition-colors hover:bg-hover",
                    // The rail is scanned, not read. The edge answers "is any
                    // of this on fire" before a single title is.
                    i.urgency === "blocking"
                      ? "border-l-danger bg-danger-weak/40"
                      : "border-l-transparent",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div
                      className={cx(
                        "line-clamp-2 text-xs leading-snug text-heading",
                        deferred.includes(i.id) && "text-muted",
                      )}
                    >
                      {i.title}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {i.urgency === "blocking" && <Chip tone="danger">blocking</Chip>}
                      {i.provisional && (
                        <Chip tone="warn">
                          <Terminal className="w-3 h-3" />
                          TUI prompt
                        </Chip>
                      )}
                      {deferred.includes(i.id) && <Chip>later</Chip>}
                      <span className="font-mono text-[11px] text-muted tabular-nums">
                        {shortAge(i.created_at)}
                      </span>
                    </div>
                  </div>
                  <ChevronRight className="mt-0.5 w-4 h-4 shrink-0 text-muted" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-3 py-2">
        <Link to="/inbox" className="inline-flex items-center gap-1 text-[11px] text-accent">
          <Layers className="w-3.5 h-3.5" />
          Full inbox — answered, expired and all
        </Link>
      </div>
    </aside>
  );
}
