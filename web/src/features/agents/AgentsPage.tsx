import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { Bot, Terminal } from "lucide-react";
import { describeError } from "../../lib/api";
import { useAgents, useBootstrap } from "../../lib/queries";
import { shortDuration } from "../../lib/format";
import {
  EmptyState,
  ErrorState,
  SectionHeader,
  SkeletonRows,
  StatusPill,
} from "../../components/ui";
import type { AgentRow } from "../../lib/types";

/** Blocked first — a stopped worker is the only thing here that costs wall-clock. */
function rank(a: AgentRow): number {
  const s = a.status.toLowerCase();
  if (s === "blocked") return 0;
  if (s === "working" || s === "running") return 1;
  return 2;
}

export function AgentsPage() {
  const { data, isPending, error, refetch } = useAgents();
  const boot = useBootstrap();
  const terminalEnabled = boot.data?.terminal_enabled !== false;

  const agents = useMemo(
    () => [...(data ?? [])].sort((a, b) => rank(a) - rank(b) || b.elapsed - a.elapsed),
    [data],
  );

  if (isPending) return <SkeletonRows rows={4} />;
  if (error && !data) {
    return <ErrorState message={describeError(error)} onRetry={() => void refetch()} />;
  }
  if (agents.length === 0) {
    return (
      <EmptyState
        icon={<Bot className="w-6 h-6" />}
        title="No agents on the board."
        message="Nothing is running on the box right now, which is either restful or suspicious."
      />
    );
  }

  return (
    <div>
      <SectionHeader title={`Agents · ${agents.length}`} />
      <div className="divide-y divide-border">
        {agents.map((agent) => (
          <div key={agent.pane_id || agent.name} className="flex items-center gap-2 px-3 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-heading">{agent.name}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                <span className="truncate font-mono">{agent.workspace}</span>
                {agent.kind && <span className="shrink-0">· {agent.kind}</span>}
              </div>
            </div>
            <StatusPill status={agent.status} />
            <div className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted">
              {shortDuration(agent.elapsed)}
            </div>
            {terminalEnabled && (
              <Link
                to="/agents/$name/term"
                params={{ name: agent.name }}
                aria-label={`Open a terminal on ${agent.name}`}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded border border-border text-muted"
              >
                <Terminal className="w-4 h-4" />
              </Link>
            )}
          </div>
        ))}
      </div>
      {!terminalEnabled && (
        <div className="px-3 py-3 text-xs text-muted">
          The terminal is disabled on this box, so these are read-only.
        </div>
      )}
    </div>
  );
}
