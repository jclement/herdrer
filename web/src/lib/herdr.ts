import type { HerdrPane, HerdrState, HerdrTab, HerdrWorkspace } from "./types";

/**
 * Reading the herdr session tree.
 *
 * The tree arrives as workspace → tab → pane and is rendered in that order,
 * because the numbers on screen have to match the numbers in the TUI — a UI
 * that re-sorts workspace 3 above workspace 1 because something is blocked in
 * it is a UI you cannot navigate by.
 *
 * "Blocked first" is therefore a *separate* section built from the same data
 * rather than a different sort of it: what needs you is listed at the top, and
 * the tree below stays the shape herdr says it is.
 */

/** herdr's own vocabulary: idle | working | blocked | done | unknown. */
export type AgentStatus = string;

export function isBlocked(status: AgentStatus | undefined): boolean {
  return (status ?? "").toLowerCase() === "blocked";
}

export function isWorking(status: AgentStatus | undefined): boolean {
  return (status ?? "").toLowerCase() === "working";
}

/** A pane with the branch it hangs off, so a flat list can still say where it is. */
export interface PaneLocation {
  workspace: HerdrWorkspace;
  tab: HerdrTab;
  pane: HerdrPane;
}

export function workspaces(state: HerdrState | undefined): HerdrWorkspace[] {
  return state?.workspaces ?? [];
}

export function tabsOf(ws: HerdrWorkspace): HerdrTab[] {
  return ws.tabs ?? [];
}

export function panesOf(tab: HerdrTab): HerdrPane[] {
  return tab.panes ?? [];
}

/** Every pane in the tree, in tree order, each carrying its branch. */
export function flattenPanes(state: HerdrState | undefined): PaneLocation[] {
  const out: PaneLocation[] = [];
  for (const ws of workspaces(state)) {
    for (const tab of tabsOf(ws)) {
      for (const pane of panesOf(tab)) out.push({ workspace: ws, tab, pane });
    }
  }
  return out;
}

/**
 * Panes waiting on a human.
 *
 * A pane counts as blocked if herdr says so about the pane or about the agent
 * in it; the two can disagree briefly while a status settles, and in that
 * window the safe reading is "someone might be stuck", not "nothing to see".
 */
export function blockedPanes(state: HerdrState | undefined): PaneLocation[] {
  return flattenPanes(state).filter(
    (l) => isBlocked(l.pane.agent_status) || isBlocked(l.pane.agent?.status),
  );
}

export interface HerdrSummary {
  running: boolean;
  version: string | null;
  protocol: number | null;
  workspaces: number;
  tabs: number;
  panes: number;
  agents: number;
  /** The server's own count, falling back to what the tree shows. */
  blocked: number;
}

export function summarize(state: HerdrState | undefined): HerdrSummary {
  const ws = workspaces(state);
  const tabs = ws.reduce((n, w) => n + tabsOf(w).length, 0);
  const panes = flattenPanes(state).length;
  const agents = (state?.agents ?? []).length;
  return {
    running: state?.running === true,
    version: state?.version ? state.version : null,
    protocol: typeof state?.protocol === "number" ? state.protocol : null,
    workspaces: ws.length,
    tabs,
    panes,
    agents,
    blocked: typeof state?.blocked === "number" ? state.blocked : blockedPanes(state).length,
  };
}

/** "3 · release" or "3" — a workspace label is optional and usually empty. */
export function workspaceLabel(ws: HerdrWorkspace): string {
  return ws.label.trim() !== "" ? `${ws.number} · ${ws.label.trim()}` : String(ws.number);
}

export function tabLabel(tab: HerdrTab): string {
  return tab.label.trim() !== "" ? `${tab.number} · ${tab.label.trim()}` : String(tab.number);
}

/**
 * What to call a pane in one line.
 *
 * Agent name beats the terminal title beats the pane id: the name is what you
 * type at the CLI, and a title is whatever the last command decided to write.
 */
export function paneLabel(pane: HerdrPane): string {
  const name = pane.agent?.name?.trim();
  if (name) return name;
  const title = pane.title.trim();
  return title !== "" ? title : pane.id;
}

/** Shortens a path for a phone row: `~/Developer/be` from `/Users/x/Developer/be`. */
export function shortPath(cwd: string | undefined, home?: string): string {
  if (!cwd) return "";
  const h = home ?? guessHome(cwd);
  const path = h && cwd.startsWith(h) ? `~${cwd.slice(h.length)}` : cwd;
  const parts = path.split("/").filter((p) => p !== "");
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

function guessHome(cwd: string): string | null {
  const m = /^(\/(?:Users|home)\/[^/]+)/.exec(cwd);
  return m ? m[1]! : null;
}
