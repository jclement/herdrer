import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, TerminalSquare } from "lucide-react";
import { describeError } from "../../lib/api";
import { useFocusAgent, useTask, useTaskAction, useTaskTail } from "../../lib/queries";
import { absoluteTime, markdownPreview, shortAge } from "../../lib/format";
import type { ReviewItem, TaskDetail, TaskEvent } from "../../lib/types";
import { TERMINAL_PATH } from "../../components/AppShell";
import { Button, Chip, ErrorState, SectionHeader, SkeletonRows, cx } from "../../components/ui";
import { useToast } from "../../components/toast";
import { taskTone } from "./TasksPage";

/**
 * One task as a page: header facts, the actions its state allows, the
 * timeline, the result, and — last and collapsed — the terminal capture,
 * badged as what it is: evidence, not a verified result.
 */
export function TaskPage() {
  const { id } = useParams({ from: "/tasks/$id" });
  const { data, isPending, error, refetch } = useTask(id);
  const now = Date.now();

  if (isPending) return <SkeletonRows rows={6} />;
  if (error || !data) {
    return (
      <ErrorState
        message={error ? describeError(error) : "The box sent nothing back."}
        onRetry={() => void refetch()}
      />
    );
  }
  return <TaskBody task={data} now={now} />;
}

function TaskBody({ task, now }: { task: TaskDetail; now: number }) {
  const timeline = useMemo(() => mergeTimeline(task), [task]);

  return (
    <div className="space-y-4 px-3 py-3">
      <header>
        <h1 className="text-base font-semibold text-heading">{task.title}</h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Chip tone={taskTone(task.status)} className="font-medium">
            {task.status}
          </Chip>
          <Chip>{task.kind}</Chip>
          {task.repo !== "" && <Chip>{task.repo}</Chip>}
          {task.branch !== "" && <Chip>{task.branch}</Chip>}
          {task.claimed_by && <Chip tone="info">{task.claimed_by}</Chip>}
          {task.attempt > 0 && <Chip tone="warn">attempt {task.attempt + 1}</Chip>}
          <span className="text-[11px] text-muted">filed {shortAge(task.created_at, now)} ago</span>
        </div>
        {task.worktree !== "" && (
          <div className="mt-1 truncate font-mono text-[11px] text-muted" title={task.worktree}>
            {task.worktree}
          </div>
        )}
      </header>

      <TaskActions task={task} />

      {task.body_md.trim() !== "" && (
        <section className="rounded-md border border-border bg-surface-2 p-3">
          <div className="whitespace-pre-wrap break-words text-sm">{task.body_md}</div>
        </section>
      )}

      {task.result && (
        <section>
          <SectionHeader title="Result" />
          <div className="whitespace-pre-wrap break-words rounded-md border border-ok/30 bg-ok-weak p-3 text-sm">
            {task.result}
          </div>
        </section>
      )}

      <section>
        <SectionHeader title={`Timeline · ${timeline.length}`} />
        <ol className="space-y-0">
          {timeline.map((entry, i) => (
            <li key={i} className="flex gap-2 border-b border-border/60 py-2 last:border-b-0">
              {entry.kind === "event" ? (
                <EventRow event={entry.event} now={now} />
              ) : (
                <ItemCard item={entry.item} now={now} />
              )}
            </li>
          ))}
        </ol>
      </section>

      {task.has_tail && <TailSection id={task.id} />}
    </div>
  );
}

/** The verbs a state allows. Anything not offered here is not possible. */
function TaskActions({ task }: { task: TaskDetail }) {
  const act = useTaskAction(task.id);
  const focus = useFocusAgent();
  const navigate = useNavigate();
  const toast = useToast();

  const run = (action: "ready" | "cancel" | "retry" | "close") =>
    act.mutate(
      { action },
      { onError: (err) => toast.show(describeError(err), { tone: "danger" }) },
    );

  const openTerminal = () => {
    // Focus is an explicit action, never a side effect of rendering: this
    // button is exactly the moment the human means "show me that pane".
    if (task.claimed_by) focus.mutate(task.claimed_by);
    void navigate({ to: TERMINAL_PATH });
  };

  const openItem = task.items.find((it) => it.status === "open");

  const buttons: React.ReactNode[] = [];
  if (task.status === "inbox") {
    buttons.push(
      <Button key="ready" variant="primary" loading={act.isPending} onClick={() => run("ready")}>
        Mark ready
      </Button>,
    );
  }
  if ((task.status === "doing" || task.status === "blocked") && task.claimed_by) {
    buttons.push(
      <Button key="term" onClick={openTerminal}>
        <TerminalSquare className="w-4 h-4" />
        Open terminal
      </Button>,
    );
  }
  if (openItem) {
    buttons.push(
      <Button
        key="answer"
        variant="primary"
        onClick={() => void navigate({ to: "/r/$id", params: { id: openItem.id } })}
      >
        Answer the open question
      </Button>,
    );
  }
  if (task.status === "review") {
    buttons.push(
      <Button key="close" loading={act.isPending} onClick={() => run("close")}>
        Close as done
      </Button>,
    );
  }
  if (task.status === "failed" || task.status === "review") {
    buttons.push(
      <Button key="retry" loading={act.isPending} onClick={() => run("retry")}>
        Retry
      </Button>,
    );
  }
  if (!["done", "failed", "cancelled"].includes(task.status)) {
    buttons.push(
      <Button key="cancel" variant="danger" loading={act.isPending} onClick={() => run("cancel")}>
        Cancel
      </Button>,
    );
  }
  if (buttons.length === 0) return null;
  return <div className="flex flex-wrap gap-2">{buttons}</div>;
}

type TimelineEntry =
  | { kind: "event"; at: number; event: TaskEvent }
  | { kind: "item"; at: number; item: ReviewItem };

function mergeTimeline(task: TaskDetail): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...task.events.map((e): TimelineEntry => ({ kind: "event", at: Date.parse(e.at), event: e })),
    ...task.items.map((it): TimelineEntry => ({
      kind: "item",
      at: Date.parse(it.created_at),
      item: it,
    })),
  ];
  return entries.sort((a, b) => a.at - b.at);
}

function EventRow({ event, now }: { event: TaskEvent; now: number }) {
  return (
    <div className="min-w-0 flex-1 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-heading">{event.kind.replaceAll("_", " ")}</span>
        <span className="text-[11px] text-muted">
          {event.actor} · {shortAge(event.at, now)} ago
        </span>
      </div>
      {event.detail !== "" && (
        <div className="mt-0.5 whitespace-pre-wrap break-words text-xs text-body">
          {event.detail}
        </div>
      )}
    </div>
  );
}

/** A linked review item, inline: an open one links into the answer flow. */
function ItemCard({ item, now }: { item: ReviewItem; now: number }) {
  const open = item.status === "open";
  return (
    <Link
      to="/r/$id"
      params={{ id: item.id }}
      className={cx(
        "min-w-0 flex-1 rounded-md border p-2 transition-colors hover:bg-hover",
        open ? "border-warn/40 bg-warn-weak" : "border-border bg-surface-2",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={open ? "warn" : item.status === "answered" ? "ok" : "default"}>
          {item.kind} · {item.status}
        </Chip>
        <span className="text-[11px] text-muted">{shortAge(item.created_at, now)} ago</span>
      </div>
      <div className="mt-1 truncate text-sm font-medium text-heading">{item.title}</div>
      {item.answer_note && (
        <div className="mt-0.5 text-xs text-body">note: {markdownPreview(item.answer_note)}</div>
      )}
      {open && <div className="mt-1 text-xs font-medium text-warn">Tap to answer</div>}
    </Link>
  );
}

/**
 * The captured terminal tail: collapsed by default, monospace, and labelled.
 * It is what the pane showed, not what the worker concluded — evidence for a
 * human, kept out of search and out of the way.
 */
function TailSection({ id }: { id: string }) {
  const [openTail, setOpenTail] = useState(false);
  const tail = useTaskTail(id, openTail);

  return (
    <section>
      <SectionHeader
        title={
          <button
            className="-my-1.5 flex min-h-9 items-center gap-1 py-1.5"
            onClick={() => setOpenTail((v) => !v)}
            aria-expanded={openTail}
          >
            {openTail ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
            Terminal capture · unverified
          </button>
        }
      />
      {openTail && (
        <div className="rounded-md border border-border bg-surface-2 p-2">
          {tail.isPending && <div className="p-2 text-xs text-muted">loading…</div>}
          {tail.data && (
            <>
              {tail.data.tail_at && (
                <div className="px-1 pb-1 text-[11px] text-muted">
                  captured {absoluteTime(tail.data.tail_at)}
                </div>
              )}
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words p-1 font-mono text-[11px] leading-4">
                {tail.data.tail ?? "(empty)"}
              </pre>
            </>
          )}
        </div>
      )}
    </section>
  );
}
