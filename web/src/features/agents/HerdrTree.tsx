import { Bot, Boxes, Columns2, Folder, PowerOff, Terminal } from "lucide-react";
import type { HerdrPane, HerdrState } from "../../lib/types";
import {
  blockedPanes,
  isBlocked,
  paneLabel,
  panesOf,
  shortPath,
  summarize,
  tabLabel,
  tabsOf,
  workspaceLabel,
  workspaces,
  type PaneLocation,
} from "../../lib/herdr";
import { Chip, EmptyState, SectionHeader, StatusPill, cx } from "../../components/ui";

/**
 * The herdr session tree, as a phone-sized board.
 *
 * Herdr's own model is workspace → tab → pane, and the numbers in this UI have
 * to be the numbers in the TUI or you cannot navigate between the two. So the
 * tree is rendered in herdr's order, and "blocked first" is a separate section
 * built from the same panes rather than a re-sort of them.
 *
 * Presentational on purpose: it takes a state and a callback, so the
 * `running:false` case and the tree shape can both be tested without a router,
 * a query client or a live box.
 */
export function HerdrTree({
  state,
  onOpenTerminal,
  terminalEnabled = true,
}: {
  state: HerdrState;
  /** Attach the browser terminal. Undefined when this box has no terminal. */
  onOpenTerminal?: (pane?: HerdrPane) => void;
  terminalEnabled?: boolean;
}) {
  const summary = summarize(state);

  if (!summary.running) {
    return (
      <EmptyState
        icon={<PowerOff className="w-6 h-6" />}
        title="herdr isn't up yet."
        message={
          <>
            There is no herdr server on the box right now, so there is no tree to show. herdrer
            starts one at boot, so this is usually a few seconds after a restart rather than
            something to fix.
          </>
        }
      />
    );
  }

  const blocked = blockedPanes(state);
  const tree = workspaces(state);

  return (
    <div>
      <SectionHeader
        title="herdr"
        right={
          <div className="flex items-center gap-1">
            {summary.version && <Chip title="herdr version">v{summary.version}</Chip>}
            {summary.protocol !== null && <Chip title="socket protocol">p{summary.protocol}</Chip>}
          </div>
        }
      />
      <div className="scroll-x no-scrollbar flex items-center gap-1 border-b border-border bg-surface-2 px-3 py-1.5">
        <Count icon={<Boxes className="w-3 h-3" />} n={summary.workspaces} label="workspaces" />
        <Count icon={<Columns2 className="w-3 h-3" />} n={summary.tabs} label="tabs" />
        <Count icon={<Terminal className="w-3 h-3" />} n={summary.panes} label="panes" />
        <Count icon={<Bot className="w-3 h-3" />} n={summary.agents} label="agents" />
        {summary.blocked > 0 && <Chip tone="danger">{summary.blocked} blocked</Chip>}
      </div>

      {blocked.length > 0 && (
        <section>
          <SectionHeader title={`Needs you · ${blocked.length}`} />
          <div className="divide-y divide-border">
            {blocked.map((l) => (
              <PaneRow
                key={`blocked-${l.pane.id}`}
                location={l}
                showWhere
                onOpenTerminal={terminalEnabled ? onOpenTerminal : undefined}
              />
            ))}
          </div>
        </section>
      )}

      {tree.length === 0 ? (
        <EmptyState
          icon={<Bot className="w-6 h-6" />}
          title="herdr is up, and empty."
          message="No workspaces yet. Open the terminal and start something."
        />
      ) : (
        tree.map((ws) => (
          <section key={ws.id}>
            <SectionHeader
              title={
                <span className="flex items-center gap-1.5">
                  <Boxes className="w-3.5 h-3.5" />
                  workspace {workspaceLabel(ws)}
                  {ws.focused && <span className="text-accent">· focused</span>}
                </span>
              }
              right={
                <span className="flex items-center gap-1">
                  <span className="font-mono text-[10px] text-muted">
                    {ws.tab_count}t · {ws.pane_count}p
                  </span>
                  <StatusPill status={ws.agent_status || "unknown"} />
                </span>
              }
            />
            {tabsOf(ws).map((tab) => (
              <div key={tab.id}>
                <div className="flex items-center gap-1.5 border-b border-border/60 bg-surface px-3 py-1 text-[11px] text-muted">
                  <Columns2 className="w-3 h-3 shrink-0" />
                  <span className="truncate">tab {tabLabel(tab)}</span>
                  {tab.focused && <span className="text-accent">· focused</span>}
                  <span className="ml-auto font-mono text-[10px]">{tab.id}</span>
                </div>
                <div className="divide-y divide-border">
                  {panesOf(tab).map((pane) => (
                    <PaneRow
                      key={pane.id}
                      location={{ workspace: ws, tab, pane }}
                      onOpenTerminal={terminalEnabled ? onOpenTerminal : undefined}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>
        ))
      )}

      {!terminalEnabled && (
        <div className="px-3 py-3 text-xs text-muted">
          The terminal is disabled on this box, so this board is read-only.
        </div>
      )}
    </div>
  );
}

function Count({ icon, n, label }: { icon: React.ReactNode; n: number; label: string }) {
  return (
    <Chip title={label}>
      {icon}
      <span className="font-mono tabular-nums">{n}</span>
      <span className="text-muted">{label}</span>
    </Chip>
  );
}

function PaneRow({
  location,
  showWhere,
  onOpenTerminal,
}: {
  location: PaneLocation;
  /** In the blocked section a pane has to say which branch it came from. */
  showWhere?: boolean;
  onOpenTerminal?: (pane: HerdrPane) => void;
}) {
  const { workspace, tab, pane } = location;
  const agent = pane.agent;
  const status = agent?.status || pane.agent_status || "unknown";
  const blocked = isBlocked(status);

  return (
    <div className={cx("flex items-start gap-2 px-3 py-2.5", blocked && "bg-danger/5")}>
      <div className="mt-0.5 shrink-0 text-muted">
        {agent ? <Bot className="w-4 h-4" /> : <Terminal className="w-4 h-4" />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-heading">{paneLabel(pane)}</span>
          {pane.focused && <span className="text-[10px] text-accent">focused</span>}
        </div>

        <div className="mt-0.5 flex items-center gap-1 overflow-x-auto no-scrollbar text-[11px] text-muted">
          <span className="shrink-0 font-mono">{pane.id}</span>
          {showWhere && (
            <span className="shrink-0">
              · ws {workspaceLabel(workspace)} · tab {tabLabel(tab)}
            </span>
          )}
          {agent?.kind && <span className="shrink-0">· {agent.kind}</span>}
          {pane.cwd && (
            <span className="flex shrink-0 items-center gap-0.5" title={pane.cwd}>
              · <Folder className="w-3 h-3" />
              <span className="font-mono">{shortPath(pane.cwd)}</span>
            </span>
          )}
        </div>

        {agent && pane.title && pane.title !== agent.name && (
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted">{pane.title}</div>
        )}
      </div>

      <StatusPill status={status} />

      {onOpenTerminal && (
        <button
          onClick={() => onOpenTerminal(pane)}
          aria-label={`Open the terminal on ${paneLabel(pane)}`}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded border border-border text-muted"
        >
          <Terminal className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
