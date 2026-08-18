// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";
import type { ReviewItem } from "../../lib/types";
import { answerOptions, recommendedKey, unanswerableReason } from "./answer";
import { OptionCards } from "./OptionCards";
import { DiffView } from "./DiffView";
import { DocumentFrame, renderURL, withTheme } from "./DocumentFrame";

const base: ReviewItem = {
  id: "rv_test",
  title: "Nullable column plus backfill, or required with a default?",
  kind: "choice",
  urgency: "blocking",
  status: "open",
  body_md: "Because the table is 40M rows and the migration window is short.",
  options: [
    { key: "A", label: "Nullable + backfill", detail: "Two deploys, no downtime." },
    { key: "B", label: "Required with a default", detail: "One deploy, a long lock." },
  ],
  recommend: "A",
  created_at: new Date().toISOString(),
};

describe("answer vocabulary", () => {
  it("supplies yes/no for a confirm with no options", () => {
    const item = { ...base, kind: "confirm" as const, options: null };
    expect(answerOptions(item).map((o) => o.key)).toEqual(["yes", "no"]);
  });

  it("drops the recommendation on anything that is not open", () => {
    expect(recommendedKey(base)).toBe("A");
    expect(recommendedKey({ ...base, status: "expired", recommend: "A" })).toBeNull();
  });

  it("says plainly that a timeout is not consent", () => {
    expect(unanswerableReason({ ...base, status: "expired" })).toMatch(/not a yes/i);
  });
});

describe("OptionCards", () => {
  it("marks the recommendation and reports selection", () => {
    const onSelect = vi.fn();
    render(<OptionCards item={base} selected={null} onSelect={onSelect} />);
    expect(screen.getByText("recommended")).toBeTruthy();
    fireEvent.click(screen.getByText("Required with a default"));
    expect(onSelect).toHaveBeenCalledWith("B");
  });
});

describe("DiffView", () => {
  const diff = `diff --git a/a.go b/a.go
--- a/a.go
+++ b/a.go
@@ -1,3 +1,3 @@
 package main
-var x = 1
+var x = 2
`;

  it("renders the file header with its stat and the changed lines as text", () => {
    render(<DiffView content={diff} title="the change" />);
    expect(screen.getByText("a.go")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("var x = 2")).toBeTruthy();
  });
});

describe("DocumentFrame", () => {
  afterEach(() => {
    cleanup();
    document.documentElement.classList.remove("dark");
  });

  it("sandboxes agent-authored HTML without allow-same-origin", () => {
    const { container } = render(<DocumentFrame src="/api/v1/review/rv_test/render" title="doc" />);
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });

  it("ignores height messages that did not come from its own frame", () => {
    const { container } = render(<DocumentFrame src="/api/v1/review/rv_test/render" title="doc" />);
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    const before = frame.style.height;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "herdrer:height", height: 9999 },
        origin: "https://evil.example",
      }),
    );
    expect(frame.style.height).toBe(before);
  });
});

/**
 * The document is server-rendered into an opaque-origin iframe, so it cannot
 * read our `.dark` class, our custom properties or our localStorage. Left to
 * itself it follows `prefers-color-scheme` — the operating system — and our
 * theme has three states to the OS's two. A phone in light mode with the app
 * toggled to dark rendered a white page inside a dark app, which is the whole
 * reason this parameter exists.
 */
describe("the sandboxed document follows the app's theme, not the OS", () => {
  afterEach(() => {
    cleanup();
    document.documentElement.classList.remove("dark");
  });

  function src(): string {
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    return frame.getAttribute("src") ?? "";
  }

  it("asks for the light render when the app is light", () => {
    render(<DocumentFrame src={renderURL("rv_1")} title="doc" />);
    expect(src()).toContain("theme=light");
  });

  it("asks for the dark render when the app is dark", () => {
    document.documentElement.classList.add("dark");
    render(<DocumentFrame src={renderURL("rv_1")} title="doc" />);
    expect(src()).toContain("theme=dark");
  });

  it("re-renders the document when the theme is toggled under it", async () => {
    render(<DocumentFrame src={renderURL("rv_1")} title="doc" />);
    expect(src()).toContain("theme=light");
    await act(async () => {
      document.documentElement.classList.add("dark");
      // MutationObserver callbacks are a microtask, not synchronous.
      await Promise.resolve();
    });
    expect(src()).toContain("theme=dark");
  });

  it("keeps the attachment anchor behind the query, not inside it", () => {
    // `src + "?theme=dark"` on a URL that already has a fragment puts the
    // parameter inside the fragment, where the server never sees it.
    expect(withTheme(renderURL("rv_1", "a-at_9"), "dark")).toBe(
      "/api/v1/review/rv_1/render?theme=dark#a-at_9",
    );
  });

  it("still refuses same-origin access however it is themed", () => {
    document.documentElement.classList.add("dark");
    const { container } = render(<DocumentFrame src={renderURL("rv_1")} title="doc" />);
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("referrerPolicy") ?? frame?.getAttribute("referrerpolicy")).toBe(
      "no-referrer",
    );
  });
});
