import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ClipboardList, Plus, WifiOff } from "lucide-react";
import { describeError } from "../../lib/api";
import { useAgents, useTasks } from "../../lib/queries";
import { shortAge } from "../../lib/format";
import type { AgentRow, Task, TaskStatus } from "../../lib/types";
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  SectionHeader,
  SkeletonRows,
  StatusPill,
  cx,
} from "../../components/ui";
import { NewTaskSheet } from "./NewTaskSheet";

/**
 * The board: what I've delegated, in two stacks.
 *
 * Active on top — dispatching, doing, blocked, review — because those are the
 * rows that can want something from you. The queue (ready, then inbox) below,
 * and recent terminals last, collapsed into their chips. `/` stays the pure
 * "what needs me" inbox; a task never appears there as itself, only through
 * its review items.
 */
export function TasksPage() {
  const { data, isPending, error, refetch, dataUpdatedAt } = useTasks();
  const agents = useAgents();
  const [composing, setComposing] = useState(false);

  const now = Date.now();
  const groups = useMemo(() => groupTasks(data ?? []), [data]);
  const agentByName = useMemo(() => {
    const m = new Map<string, AgentRow>();
    for (const a of agents.data ?? []) m.set(a.name, a);
    return m;
  }, [agents.data]);

  return (
    <div>
      {error && data && (
        <div className="flex items-start gap-2 border-b border-warn/40 bg-warn-weak px-3 py-2 text-xs text-warn">
          <WifiOff className="mt-0.5 w-4 h-4 shrink-0" />
          <span className="min-w-0 break-words">
            Showing what was here at {new Date(dataUpdatedAt).toLocaleTimeString()} —{" "}
            {describeError(error)}
          </span>
        </div>
      )}

      {isPending && <SkeletonRows rows={5} />}
      {error && !data && (
        <ErrorState message={describeError(error)} onRetry={() => void refetch()} />
      )}

      {data && data.length === 0 && (
        <EmptyState
          icon={<ClipboardList className="w-6 h-6" />}
          title="Nothing delegated."
          message="File a task and a Claude Code worker picks it up in its own worktree."
          action={
            <Button variant="primary" onClick={() => setComposing(true)}>
              <Plus className="w-4 h-4" />
              New task
            </Button>
          }
        />
      )}

      {groups.active.length > 0 && (
        <section>
          <SectionHeader sticky title={`Active · ${groups.active.length}`} />
          <div className="divide-y divide-border">
            {groups.active.map((t) => (
              <TaskRow key={t.id} task={t} now={now} agent={agentFor(t, agentByName)} />
            ))}
          </div>
        </section>
      )}

      {groups.queue.length > 0 && (
        <section>
          <SectionHeader sticky title={`Queue · ${groups.queue.length}`} />
          <div className="divide-y divide-border">
            {groups.queue.map((t) => (
              <TaskRow key={t.id} task={t} now={now} />
            ))}
          </div>
        </section>
      )}

      {groups.recent.length > 0 && (
        <section>
          <SectionHeader sticky title={`Recently finished · ${groups.recent.length}`} />
          <div className="divide-y divide-border">
            {groups.recent.map((t) => (
              <TaskRow key={t.id} task={t} now={now} />
            ))}
          </div>
        </section>
      )}

      <button
        onClick={() => setComposing(true)}
        aria-label="New task"
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

function agentFor(t: Task, byName: Map<string, AgentRow>): AgentRow | undefined {
  return t.claimed_by ? byName.get(t.claimed_by) : undefined;
}

const ACTIVE: TaskStatus[] = ["dispatching", "doing", "blocked", "review"];
const QUEUE: TaskStatus[] = ["ready", "inbox"];

function groupTasks(tasks: Task[]): { active: Task[]; queue: Task[]; recent: Task[] } {
  const byBucket = (statuses: TaskStatus[]) =>
    statuses.flatMap((st) => tasks.filter((t) => t.status === st));
  return {
    active: byBucket(ACTIVE),
    queue: byBucket(QUEUE),
    recent: tasks.filter((t) => !ACTIVE.includes(t.status) && !QUEUE.includes(t.status)),
  };
}

/** Chip tone for a task's own lifecycle state. */
export function taskTone(status: TaskStatus): "default" | "ok" | "warn" | "danger" | "info" | "accent" {
  switch (status) {
    case "doing":
    case "dispatching":
      return "ok";
    case "blocked":
    case "review":
      return "warn";
    case "failed":
      return "danger";
    case "ready":
      return "info";
    case "done":
      return "accent";
    default:
      return "default";
  }
}

/** What a row's age should count from: the age of the situation, not the row. */
function ageBasis(t: Task): string {
  if (t.status === "dispatching" && t.dispatched_at) return t.dispatched_at;
  if (t.status === "done" || t.status === "failed" || t.status === "cancelled") {
    return t.finished_at ?? t.updated_at;
  }
  return t.updated_at;
}

function TaskRow({ task, now, agent }: { task: Task; now: number; agent?: AgentRow }) {
  return (
    <Link
      to="/tasks/$id"
      params={{ id: task.id }}
      className="flex min-h-14 items-center gap-3 px-3 py-2 transition-colors hover:bg-hover"
    >
      <div className="min-w-0 flex-1">
        <div
          className={cx(
            "truncate text-sm",
            task.status === "done" || task.status === "cancelled"
              ? "text-muted"
              : "font-medium text-heading",
          )}
        >
          {task.title}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          {task.repo !== "" && <Chip>{task.repo}</Chip>}
          <Chip tone={taskTone(task.status)} className="font-medium">
            {task.status}
          </Chip>
          {/* The worker's live Herdr status beside the task's own state:
              "blocked" on the agent means it is waiting at a TUI prompt,
              which the task state alone cannot say. */}
          {agent && <StatusPill status={agent.status} />}
          {task.attempt > 0 && <Chip tone="warn">attempt {task.attempt + 1}</Chip>}
          <span>{shortAge(ageBasis(task), now)}</span>
        </div>
      </div>
    </Link>
  );
}
