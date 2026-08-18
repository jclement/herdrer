import { useNavigate } from "@tanstack/react-router";
import { WifiOff } from "lucide-react";
import { describeError } from "../../lib/api";
import { useBootstrap, useHerdrState } from "../../lib/queries";
import { TERMINAL_PATH } from "../../components/AppShell";
import { ErrorState, SkeletonRows } from "../../components/ui";
import { HerdrTree } from "./HerdrTree";

/**
 * The agents board: herdr's own session tree, live.
 *
 * Built on `/api/v1/herdr/state` rather than the flat agent list, because the
 * flat list cannot answer the question you actually have on a phone — *where*
 * is this thing, and what else is in that workspace.
 *
 * `running:false` is data. It renders as its own state inside HerdrTree and
 * never as an error: a box that has just booted has no herdr server yet, and a
 * red box for the twenty seconds before herdrer starts one is a lie.
 */
export function AgentsPage() {
  const navigate = useNavigate();
  const { data, isPending, error, refetch, dataUpdatedAt } = useHerdrState();
  const boot = useBootstrap();
  const terminalEnabled = boot.data?.terminal_enabled !== false;

  if (isPending) return <SkeletonRows rows={5} />;
  if (!data) {
    return (
      <ErrorState
        message={error ? describeError(error) : "The box sent nothing back."}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <div>
      {/* A stale tree beats a blank screen; say how stale rather than hiding it. */}
      {error && (
        <div className="flex items-start gap-2 border-b border-warn/40 bg-warn-weak px-3 py-2 text-xs text-warn">
          <WifiOff className="mt-0.5 w-4 h-4 shrink-0" />
          <span className="min-w-0 break-words">
            Showing the tree as of {new Date(dataUpdatedAt).toLocaleTimeString()} —{" "}
            {describeError(error)}
          </span>
        </div>
      )}

      <HerdrTree
        state={data}
        terminalEnabled={terminalEnabled}
        onOpenTerminal={(pane) => void navigate({ to: TERMINAL_PATH, search: { pane: pane?.id } })}
      />
    </div>
  );
}
