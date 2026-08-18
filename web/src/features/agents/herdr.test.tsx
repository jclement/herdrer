// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import type { HerdrState } from "../../lib/types";
import { blockedPanes, flattenPanes, paneLabel, shortPath, summarize } from "../../lib/herdr";
import { HerdrTree } from "./HerdrTree";

// vitest does not run with `globals`, so testing-library never registered its
// own afterEach — without this every render stacks up in the same document and
// the second assertion in the file is against the first test's DOM.
afterEach(cleanup);

/** What the box sends before herdr is up. Not an error — an ordinary state. */
const stopped: HerdrState = {
  running: false,
  version: "",
  protocol: 0,
  blocked: 0,
  workspaces: [],
  agents: [],
};

const tree: HerdrState = {
  running: true,
  version: "0.8.0",
  protocol: 19,
  blocked: 1,
  workspaces: [
    {
      id: "w1",
      label: "",
      number: 1,
      focused: true,
      agent_status: "working",
      tab_count: 1,
      pane_count: 2,
      tabs: [
        {
          id: "w1:t1",
          workspace_id: "w1",
          label: "be",
          number: 1,
          focused: true,
          agent_status: "working",
          panes: [
            {
              id: "w1:p1",
              tab_id: "w1:t1",
              workspace_id: "w1",
              title: "vim internal/api/routes.go",
              cwd: "/Users/jsc/Developer/be",
              focused: true,
              agent_status: "working",
              agent: { name: "solver", kind: "claude", status: "working" },
            },
            {
              id: "w1:p2",
              tab_id: "w1:t1",
              workspace_id: "w1",
              title: "zsh",
              cwd: "/Users/jsc/Developer/be",
              focused: false,
              agent_status: "unknown",
            },
          ],
        },
      ],
    },
    {
      id: "w2",
      label: "release",
      number: 2,
      focused: false,
      agent_status: "blocked",
      tab_count: 1,
      pane_count: 1,
      tabs: [
        {
          id: "w2:t1",
          workspace_id: "w2",
          label: "",
          number: 1,
          focused: false,
          agent_status: "blocked",
          panes: [
            {
              id: "w2:p1",
              tab_id: "w2:t1",
              workspace_id: "w2",
              title: "claude",
              cwd: "/Users/jsc/Developer/herdrer",
              focused: false,
              agent_status: "blocked",
              agent: { name: "packager", kind: "claude", status: "blocked" },
            },
          ],
        },
      ],
    },
  ],
  agents: [
    { name: "solver", kind: "claude", status: "working" },
    { name: "packager", kind: "claude", status: "blocked" },
  ],
};

describe("reading the tree", () => {
  it("flattens every pane in tree order, carrying its branch", () => {
    const flat = flattenPanes(tree);
    expect(flat.map((l) => l.pane.id)).toEqual(["w1:p1", "w1:p2", "w2:p1"]);
    expect(flat[2]!.workspace.id).toBe("w2");
    expect(flat[2]!.tab.id).toBe("w2:t1");
  });

  it("finds the panes waiting on a human", () => {
    expect(blockedPanes(tree).map((l) => l.pane.id)).toEqual(["w2:p1"]);
  });

  it("counts the tree, preferring the server's own blocked number", () => {
    const s = summarize(tree);
    expect(s).toMatchObject({
      running: true,
      version: "0.8.0",
      protocol: 19,
      workspaces: 2,
      tabs: 2,
      panes: 3,
      agents: 2,
      blocked: 1,
    });
  });

  it("summarizes a stopped herdr without inventing anything", () => {
    expect(summarize(stopped)).toMatchObject({
      running: false,
      version: null,
      workspaces: 0,
      panes: 0,
      blocked: 0,
    });
  });

  it("survives a tree with tabs or panes omitted entirely", () => {
    const sparse: HerdrState = {
      running: true,
      workspaces: [
        {
          id: "w1",
          label: "",
          number: 1,
          focused: true,
          agent_status: "",
          tab_count: 0,
          pane_count: 0,
        },
      ],
    };
    expect(() => flattenPanes(sparse)).not.toThrow();
    expect(summarize(sparse).panes).toBe(0);
  });

  it("names a pane by its agent, then its title, then its id", () => {
    expect(paneLabel(tree.workspaces![0]!.tabs![0]!.panes![0]!)).toBe("solver");
    expect(paneLabel(tree.workspaces![0]!.tabs![0]!.panes![1]!)).toBe("zsh");
    expect(
      paneLabel({
        id: "w9:p9",
        tab_id: "w9:t1",
        workspace_id: "w9",
        title: "  ",
        cwd: "",
        focused: false,
        agent_status: "",
      }),
    ).toBe("w9:p9");
  });

  it("shortens a path to something that fits a phone row", () => {
    expect(shortPath("/Users/jsc/Developer/be")).toBe("~/Developer/be");
    expect(shortPath("/Users/jsc/Developer/be/internal/api")).toBe("…/internal/api");
    expect(shortPath(undefined)).toBe("");
  });
});

describe("HerdrTree", () => {
  it("renders a stopped herdr as an ordinary state, not a failure", () => {
    render(<HerdrTree state={stopped} />);
    expect(screen.getByText(/herdr isn't up yet/i)).toBeTruthy();
    expect(screen.getByText(/starts one at boot/i)).toBeTruthy();
    // Nothing here may read as a crash.
    expect(screen.queryByText(/didn't work/i)).toBeNull();
    expect(screen.queryByText(/error/i)).toBeNull();
  });

  it("renders the workspace → tab → pane tree with its status pills", () => {
    render(<HerdrTree state={tree} />);
    expect(screen.getByText(/workspace 1/)).toBeTruthy();
    expect(screen.getByText(/workspace 2 · release/)).toBeTruthy();
    expect(screen.getByText(/tab 1 · be/)).toBeTruthy();
    expect(screen.getAllByText("solver").length).toBeGreaterThan(0);
    expect(screen.getAllByText("blocked").length).toBeGreaterThan(0);
    expect(screen.getByText("v0.8.0")).toBeTruthy();
    expect(screen.getByText("p19")).toBeTruthy();
  });

  it("lists what needs a human above the tree", () => {
    render(<HerdrTree state={tree} />);
    expect(screen.getByText(/Needs you · 1/)).toBeTruthy();
    // The blocked pane appears twice: once in that section, once in its branch.
    expect(screen.getAllByText("packager")).toHaveLength(2);
  });

  it("says so plainly when herdr is up and has nothing in it", () => {
    render(<HerdrTree state={{ running: true, workspaces: [], agents: [] }} />);
    expect(screen.getByText(/up, and empty/i)).toBeTruthy();
  });

  it("hands the pane back when you ask for a terminal on it", () => {
    const onOpenTerminal = vi.fn();
    render(<HerdrTree state={tree} onOpenTerminal={onOpenTerminal} />);
    fireEvent.click(screen.getAllByLabelText("Open the terminal on solver")[0]!);
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    expect(onOpenTerminal.mock.calls[0]![0]).toMatchObject({ id: "w1:p1" });
  });

  it("offers no terminal at all when the box has it disabled", () => {
    render(<HerdrTree state={tree} terminalEnabled={false} onOpenTerminal={vi.fn()} />);
    expect(screen.queryByLabelText(/Open the terminal on/)).toBeNull();
    expect(screen.getByText(/read-only/i)).toBeTruthy();
  });
});
