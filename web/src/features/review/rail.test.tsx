// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, act } from "@testing-library/react";
import type { QueueItem } from "../../lib/reviewQueue";
import { DESKTOP_MIN_WIDTH, isDesktopWidth, useIsDesktop } from "../../lib/layout";
import { ReviewRail } from "./ReviewRail";

// The rail's footer is a router Link and nothing here is about routing.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode; to?: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

afterEach(cleanup);

function item(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "rv_1",
    title: "Nullable column plus backfill, or required with a default?",
    urgency: "normal",
    created_at: new Date().toISOString(),
    provisional: false,
    ...over,
  };
}

/**
 * The desktop layout in one component: the whole queue, permanently, beside the
 * terminal. Nothing here is an overlay, which is the point — see
 * lib/reviewQueue.ts for the phone's rules and why a desktop needs none of them.
 */
describe("ReviewRail", () => {
  it("lists every open item with its count, not one of them", () => {
    render(
      <ReviewRail
        items={[item({ id: "a", title: "first" }), item({ id: "b", title: "second" })]}
        deferred={[]}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("opens the document when a row is clicked — the only way in on a desktop", () => {
    const onOpen = vi.fn();
    render(<ReviewRail items={[item({ id: "rv_9" })]} deferred={[]} onOpen={onOpen} />);
    fireEvent.click(screen.getByText(/Nullable column/));
    expect(onOpen).toHaveBeenCalledWith("rv_9");
  });

  it("marks what is blocking, what is a TUI prompt, and what was put off", () => {
    render(
      <ReviewRail
        items={[
          item({ id: "a", urgency: "blocking" }),
          item({ id: "b", provisional: true }),
          item({ id: "c" }),
        ]}
        deferred={["c"]}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("blocking")).toBeTruthy();
    expect(screen.getByText("TUI prompt")).toBeTruthy();
    expect(screen.getByText("later")).toBeTruthy();
  });

  it("says so plainly when nothing is waiting, rather than showing an empty box", () => {
    render(<ReviewRail items={[]} deferred={[]} onOpen={vi.fn()} />);
    expect(screen.getByText(/Nothing waiting/i)).toBeTruthy();
    expect(screen.getByText("0")).toBeTruthy();
  });

  it("still offers the full inbox — the rail is open items only", () => {
    render(<ReviewRail items={[]} deferred={[]} onOpen={vi.fn()} />);
    expect(screen.getByText(/answered, expired and all/i)).toBeTruthy();
  });
});

/** One media query decides both layouts, so it is worth pinning down. */
describe("useIsDesktop", () => {
  function mockMatchMedia(matches: boolean) {
    const listeners = new Set<() => void>();
    const mql = {
      matches,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
    vi.stubGlobal("matchMedia", () => mql);
    return {
      set(next: boolean) {
        mql.matches = next;
        act(() => listeners.forEach((fn) => fn()));
      },
    };
  }

  function Probe() {
    return <span>{useIsDesktop() ? "desktop" : "mobile"}</span>;
  }

  afterEach(() => vi.unstubAllGlobals());

  it("agrees with Tailwind's lg breakpoint at the boundary", () => {
    expect(DESKTOP_MIN_WIDTH).toBe(1024);
    expect(isDesktopWidth(1023)).toBe(false);
    expect(isDesktopWidth(1024)).toBe(true);
  });

  it("reports the phone layout on a narrow window", () => {
    mockMatchMedia(false);
    render(<Probe />);
    expect(screen.getByText("mobile")).toBeTruthy();
  });

  it("follows a window being dragged across the breakpoint, both ways", () => {
    const mq = mockMatchMedia(false);
    render(<Probe />);
    mq.set(true);
    expect(screen.getByText("desktop")).toBeTruthy();
    mq.set(false);
    expect(screen.getByText("mobile")).toBeTruthy();
  });
});
