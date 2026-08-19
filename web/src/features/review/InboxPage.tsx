import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Coffee, Plus, WifiOff } from "lucide-react";
import { describeError } from "../../lib/api";
import { useAgents, useReviews } from "../../lib/queries";
import { BAND_LABEL, groupInbox } from "../../lib/inbox";
import { taglineForDate } from "../../lib/taglines";
import {
  Button,
  EmptyState,
  ErrorState,
  SectionHeader,
  SkeletonRows,
} from "../../components/ui";
import { NewTaskSheet } from "../tasks/NewTaskSheet";
import { InboxRow } from "./InboxRow";
import { InstallNudge } from "./InstallNudge";

/**
 * The list, kept.
 *
 * Making review an overlay must not mean an item is only visible in the second
 * it happens to arrive. Everything open, deferred, answered or expired is here,
 * and this is where you come to find the thing you parked this morning.
 */
export function InboxPage() {
  const { data, isPending, error, refetch, isFetching, dataUpdatedAt } = useReviews("all");
  const agents = useAgents();
  const [showStale, setShowStale] = useState(false);
  const [showAnswered, setShowAnswered] = useState(false);
  const [composing, setComposing] = useState(false);

  const now = Date.now();
  const groups = useMemo(() => groupInbox(data ?? [], now), [data, now]);

  const working = agents.data?.filter((a) => a.status === "working").length ?? 0;
  const idle = (agents.data?.length ?? 0) - working;

  return (
    <div>
      {/* An error with cached rows is a staleness banner, not an error page. */}
      {error && data && (
        <div className="flex items-start gap-2 border-b border-warn/40 bg-warn-weak px-3 py-2 text-xs text-warn">
          <WifiOff className="mt-0.5 w-4 h-4 shrink-0" />
          <span className="min-w-0 break-words">
            Showing what was here at {new Date(dataUpdatedAt).toLocaleTimeString()} —{" "}
            {describeError(error)}
          </span>
        </div>
      )}

      <InstallNudge />

      {isPending && <SkeletonRows rows={5} />}
      {error && !data && (
        <ErrorState message={describeError(error)} onRetry={() => void refetch()} />
      )}

      {data && groups.bands.length === 0 && groups.answered.length === 0 && (
        <EmptyState
          icon={<Coffee className="w-6 h-6" />}
          title="Nothing waiting."
          message={
            agents.data
              ? `${working} agent${working === 1 ? "" : "s"} working, ${Math.max(0, idle)} idle. ${taglineForDate()}`
              : taglineForDate()
          }
          action={
            <Button variant="primary" onClick={() => setComposing(true)}>
              <Plus className="w-4 h-4" />
              Queue a task
            </Button>
          }
        />
      )}

      {groups.bands.map(({ band, items }) => {
        const collapsed = band === 3 && !showStale;
        return (
          <section key={band}>
            <SectionHeader
              sticky
              title={
                band === 3 ? (
                  <button
                    className="-my-1.5 flex min-h-9 items-center gap-1 py-1.5"
                    onClick={() => setShowStale((v) => !v)}
                    aria-expanded={!collapsed}
                  >
                    {collapsed ? (
                      <ChevronRight className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                    {BAND_LABEL[band]} · {items.length}
                  </button>
                ) : (
                  `${BAND_LABEL[band]} · ${items.length}`
                )
              }
            />
            {!collapsed && (
              <div className="divide-y divide-border">
                {items.map((item) => (
                  <InboxRow key={item.id} item={item} now={now} />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {groups.answered.length > 0 && (
        <section>
          <SectionHeader
            sticky
            title={
              <button
                className="-my-1.5 flex min-h-9 items-center gap-1 py-1.5"
                onClick={() => setShowAnswered((v) => !v)}
                aria-expanded={showAnswered}
              >
                {showAnswered ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
                Recently answered · {groups.answered.length}
              </button>
            }
          />
          {showAnswered && (
            <div className="divide-y divide-border">
              {groups.answered.map((item) => (
                <InboxRow key={item.id} item={item} now={now} />
              ))}
            </div>
          )}
        </section>
      )}

      {isFetching && !isPending && (
        <div className="breathe px-3 py-2 text-[11px] text-muted">refreshing…</div>
      )}

      {/* Compose a task — the reverse channel. Human session only. */}
      <button
        onClick={() => setComposing(true)}
        aria-label="Queue a task for an agent"
        className={
          "fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full " +
          "bg-accent text-accent-fg shadow-2xl ring-1 ring-accent/40 " +
          "transition-transform active:scale-95 lg:right-8 lg:h-12 lg:w-12"
        }
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 4.75rem)" }}
      >
        <Plus className="w-6 h-6 lg:w-5 lg:h-5" />
      </button>

      <NewTaskSheet open={composing} onClose={() => setComposing(false)} />
    </div>
  );
}
