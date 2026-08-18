// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lockScroll, pushEscape, resetOverlays, scrollLocked } from "./overlay";

beforeEach(() => {
  resetOverlays();
  document.body.style.overflow = "";
  document.documentElement.style.overflow = "";
});
afterEach(resetOverlays);

/**
 * Three surfaces used to lock the page independently, each saving and restoring
 * `document.body.style.overflow`. That composes only under perfect nesting, and
 * the app does not nest perfectly: the fullscreen document viewer is opened
 * from inside a sheet and the sheet can close first. The old code then wrote
 * back `"hidden"` as if it were the original value and the page was
 * unscrollable until a reload — on a phone, with a question waiting.
 */
describe("the scroll lock survives interleaved open and close", () => {
  it("restores exactly once, when the last holder lets go", () => {
    const a = lockScroll();
    expect(document.body.style.overflow).toBe("hidden");
    const b = lockScroll();
    expect(scrollLocked()).toBe(true);

    a(); // the sheet closes first — out of order
    expect(document.body.style.overflow).toBe("hidden");
    expect(scrollLocked()).toBe(true);

    b();
    expect(document.body.style.overflow).toBe("");
    expect(document.documentElement.style.overflow).toBe("");
    expect(scrollLocked()).toBe(false);
  });

  it("puts back whatever was there before the first lock", () => {
    document.body.style.overflow = "scroll";
    const a = lockScroll();
    const b = lockScroll();
    b();
    a();
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("cannot be driven negative by a double release", () => {
    const a = lockScroll();
    a();
    a();
    a();
    const b = lockScroll();
    expect(document.body.style.overflow).toBe("hidden");
    b();
    expect(document.body.style.overflow).toBe("");
    expect(scrollLocked()).toBe(false);
  });

  it("leaves the page scrollable after any interleaving of three overlays", () => {
    // Every order in which three overlays can be released.
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of orders) {
      const releases = [lockScroll(), lockScroll(), lockScroll()];
      for (const i of order) releases[i]?.();
      expect(document.body.style.overflow).toBe("");
      expect(scrollLocked()).toBe(false);
    }
  });
});

describe("Escape reaches the top of the stack only", () => {
  const escape = () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  it("closes the innermost overlay, not every open one", () => {
    const sheet = vi.fn();
    const viewer = vi.fn();
    const popSheet = pushEscape(sheet);
    const popViewer = pushEscape(viewer);

    escape();
    expect(viewer).toHaveBeenCalledTimes(1);
    expect(sheet).not.toHaveBeenCalled();

    popViewer();
    escape();
    expect(sheet).toHaveBeenCalledTimes(1);
    popSheet();
  });

  it("stops listening once nothing is open", () => {
    const handler = vi.fn();
    pushEscape(handler)();
    escape();
    expect(handler).not.toHaveBeenCalled();
  });
});
