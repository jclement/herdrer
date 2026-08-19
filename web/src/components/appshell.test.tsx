// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { BottomNav, Header, TERMINAL_PATH, headerFor, isTerminalPath } from "./AppShell";

/*
 * The router is mocked down to the two things the shell asks of it: a link, and
 * the current pathname. Nothing here is about routing — it is about where the
 * navigation lands in the header, which is a layout fact and has to hold on
 * every route whatever the router thinks.
 */
let pathname = "/";
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: ReactNode; to?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname } }),
}));

function mockWidth(desktop: boolean) {
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    matches: desktop,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
}

beforeEach(() => {
  pathname = "/";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Every desktop route, and the routes the terminal answers to. */
const DESKTOP_ROUTES = ["/", TERMINAL_PATH, "/inbox", "/agents", "/settings", "/r/rv_1"];

/**
 * The regression this whole change is about.
 *
 * The terminal route used to build a second header of its own, with the
 * navigation beside the brand; every other route used the shared one, which put
 * the navigation on the far right behind a flexible page title. Measured in a
 * 1440px window that is x=64 on `/` and x=1143 everywhere else — a 1,079px jump
 * between screens, on the one element that is supposed to be the fixed point.
 *
 * jsdom has no layout, so "same x" is pinned the way it is actually caused:
 * the navigation is the same child index of the same row, on every route, and
 * everything before it is identical. Nothing that varies per route (a title, a
 * back chevron, a connection pill) may be laid down in front of it.
 */
describe("the desktop header sits still", () => {
  function row(): HTMLElement {
    const header = document.querySelector("header");
    expect(header).toBeTruthy();
    return header!.firstElementChild as HTMLElement;
  }

  function navIndex(): number {
    const kids = [...row().children];
    const nav = row().querySelector("nav");
    expect(nav).toBeTruthy();
    return kids.indexOf(nav!);
  }

  it("puts the brand and then the nav, in that order, at the head of every route", () => {
    mockWidth(true);
    const seen = new Set<string>();
    for (const path of DESKTOP_ROUTES) {
      pathname = path;
      const { title, back } = headerFor(path, true);
      render(<Header title={title} back={back} right={<button>per-screen</button>} />);

      const kids = [...row().children];
      expect(kids[0]?.textContent, `brand first on ${path}`).toBe("herdrer");
      expect(navIndex(), `nav second on ${path}`).toBe(1);
      seen.add(`${kids[0]?.textContent}|${navIndex()}`);
      cleanup();
    }
    // One arrangement across every route, not one per route.
    expect(seen.size).toBe(1);
  });

  it("gives a desktop route neither a page title nor a back chevron to push the nav sideways", () => {
    for (const path of DESKTOP_ROUTES) {
      expect(headerFor(path, true)).toEqual({});
    }
  });

  it("renders exactly one navigation, and it is not the phone's", () => {
    mockWidth(true);
    for (const path of DESKTOP_ROUTES) {
      pathname = path;
      render(<Header right={<span>controls</span>} />);
      expect(document.querySelectorAll("nav"), `one nav on ${path}`).toHaveLength(1);
      // The phone's bar is not merely hidden here — it is not built.
      expect(screen.queryByText("Terminal")).toBeTruthy();
      expect(document.querySelector("nav")?.className).not.toContain("fixed");
      cleanup();
    }
  });

  it("lists Terminal, Agents and Settings — the rail is the inbox on a desktop", () => {
    mockWidth(true);
    render(<Header />);
    const labels = [...document.querySelectorAll("nav a")].map((a) => a.textContent);
    expect(labels).toEqual(["Terminal", "Tasks", "Agents", "Settings"]);
  });

  it("lights Terminal at both URLs that mean the terminal", () => {
    mockWidth(true);
    for (const path of ["/", TERMINAL_PATH]) {
      pathname = path;
      render(<Header />);
      const active = [...document.querySelectorAll("nav a[data-active]")].map((a) => a.textContent);
      expect(active, `Terminal active at ${path}`).toEqual(["Terminal"]);
      cleanup();
    }
  });

  it("keeps the per-screen controls behind the nav rather than in a header of their own", () => {
    mockWidth(true);
    pathname = TERMINAL_PATH;
    render(<Header title={<span>sess</span>} right={<button>font</button>} />);
    const kids = [...row().children];
    expect(kids.indexOf(row().querySelector("nav")!)).toBeLessThan(
      kids.findIndex((k) => k.textContent === "font"),
    );
    expect(document.querySelectorAll("header")).toHaveLength(1);
  });
});

/** The phone is the other half of the same rule: one nav, and it is the bar. */
describe("the phone's chrome", () => {
  it("builds no desktop menu at all below the breakpoint", () => {
    mockWidth(false);
    pathname = "/inbox";
    render(<Header title="Inbox" />);
    expect(document.querySelectorAll("nav")).toHaveLength(0);
  });

  it("keeps the page title and the back chevron, because there is no nav to read them off", () => {
    expect(headerFor("/inbox", false).title).toBe("Inbox");
    expect(headerFor("/r/rv_1", false).back?.to).toBe("/inbox");
    expect(headerFor("/agents", false).title).toBe("Agents");
  });

  it("puts the inbox first, because the inbox is home on a phone", () => {
    mockWidth(false);
    render(<BottomNav reviewBadge={0} agentBadge={0} />);
    const labels = [...document.querySelectorAll("nav a")].map((a) => a.textContent);
    expect(labels).toEqual(["Inbox", "Tasks", "Terminal", "Agents", "Settings"]);
  });

  it("calls the last tab Settings, the same word the desktop menu uses", () => {
    mockWidth(false);
    render(<BottomNav reviewBadge={0} agentBadge={0} />);
    expect(screen.getByText("Settings")).toBeTruthy();
    expect(screen.queryByText("More")).toBeNull();
  });

  it("lights the Inbox tab at `/` and at `/inbox` — one screen, two ways in", () => {
    mockWidth(false);
    for (const path of ["/", "/inbox"]) {
      pathname = path;
      render(<BottomNav reviewBadge={0} agentBadge={0} />);
      const active = [...document.querySelectorAll("nav a[data-active]")].map((a) => a.textContent);
      expect(active, `Inbox active at ${path}`).toEqual(["Inbox"]);
      cleanup();
    }
  });

  it("sends the Terminal tab to the terminal's own URL, not to home", () => {
    mockWidth(false);
    render(<BottomNav reviewBadge={0} agentBadge={0} />);
    expect(screen.getByText("Terminal").closest("a")?.getAttribute("href")).toBe(TERMINAL_PATH);
  });
});

/**
 * `/` is home, and home is the terminal on a desktop and the inbox on a phone.
 * The shell asks this one predicate rather than testing the path twice.
 */
describe("which route is the terminal", () => {
  it("counts `/` as the terminal only when the window is wide", () => {
    expect(isTerminalPath("/", true)).toBe(true);
    expect(isTerminalPath("/", false)).toBe(false);
  });

  it("counts the terminal's own URL at either width", () => {
    expect(isTerminalPath(TERMINAL_PATH, true)).toBe(true);
    expect(isTerminalPath(TERMINAL_PATH, false)).toBe(true);
  });

  it("counts nothing else", () => {
    for (const path of ["/inbox", "/agents", "/settings", "/r/rv_1"]) {
      expect(isTerminalPath(path, true)).toBe(false);
      expect(isTerminalPath(path, false)).toBe(false);
    }
  });
});
