// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ScrollX } from "./ScrollX";

afterEach(cleanup);

/**
 * The house rule is "wrap, don't scroll", and almost every strip in the app now
 * does. This component is the exception's contract: where the content genuinely
 * has to stay on one line — the terminal's twenty-two-key modifier bar — the
 * scroller must at least *say* it is one, which the old `scroll-x no-scrollbar`
 * pair did not.
 */
describe("ScrollX", () => {
  it("keeps the content in one scrollable row", () => {
    render(
      <ScrollX className="flex items-center gap-1">
        <button>esc</button>
        <button>tab</button>
      </ScrollX>,
    );
    const scroller = screen.getByText("esc").parentElement as HTMLElement;
    expect(scroller.className).toMatch(/\bscroll-x\b/);
  });

  it("renders an affordance at each edge, hidden until there is more that way", () => {
    const { container } = render(
      <ScrollX>
        <span>only</span>
      </ScrollX>,
    );
    // jsdom reports no layout, so scrollWidth === clientWidth === 0: nothing to
    // reach in either direction, and both fades are transparent.
    const fades = container.querySelectorAll("[aria-hidden]");
    expect(fades.length).toBe(2);
    for (const f of Array.from(fades)) expect(f.className).toContain("opacity-0");
  });
});
