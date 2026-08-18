// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReviewItem } from "../../lib/types";
import { ReviewBody } from "./ReviewBody";

const HOUR = 3600_000;

const item: ReviewItem = {
  id: "rv_test",
  title: "Drop the legacy tenant_id column?",
  kind: "choice",
  urgency: "blocking",
  status: "open",
  body_md: "",
  options: [
    { key: "A", label: "Drop it now", detail: "Irreversible. Frees 40GB." },
    { key: "B", label: "Deprecate for one release", detail: "Reversible." },
  ],
  recommend: "B",
  context: { worker: "be-2134", repo: "be", branch: "feature/2134_drop_tenant" },
  created_at: new Date(Date.now() - 3 * 60_000).toISOString(),
  expires_at: new Date(Date.now() + 23 * HOUR + 60_000).toISOString(),
};

function body() {
  return render(<ReviewBody item={item} selected={null} onSelect={() => {}} />);
}

afterEach(cleanup);

describe("the head of a review item", () => {
  it("puts the deadline on screen, outside any horizontal scroller", () => {
    const { container } = body();
    const left = screen.getByText(/23h left/);
    expect(left).toBeTruthy();
    for (let el: HTMLElement | null = left as HTMLElement; el; el = el.parentElement) {
      expect(el.className ?? "").not.toMatch(/\bscroll-x\b/);
      if (el.tagName === "BODY") break;
    }
    // And the age, which is the other half of "answer now or put it down".
    expect(screen.getByText(/3m old/)).toBeTruthy();
    // Nothing in the head scrolls sideways any more.
    expect(container.querySelectorAll(".scroll-x").length).toBe(0);
  });

  it("makes the question the loudest thing, above the document's own h1", () => {
    body();
    const h1 = screen.getByRole("heading", { level: 1 });
    // The server renders the document's h1 at 16px and h2/h3 at 15px
    // (internal/review/render.go). `text-xl` is 20px, in both shells.
    expect(h1.className).toMatch(/\btext-xl\b/);
    expect(h1.className).not.toMatch(/text-\[15px\]/);
    expect(h1.textContent).toContain("Drop the legacy tenant_id column?");
  });

  it("says the recommendation once, on the option it points at", () => {
    body();
    expect(screen.queryByText(/Recommended: B/)).toBeNull();
    expect(screen.getAllByText("recommended")).toHaveLength(1);
  });

  it("does not put API vocabulary on the screen", () => {
    const { container } = body();
    expect(container.textContent).not.toMatch(/\bchoice\b/);
    expect(container.textContent).not.toMatch(/\bconfirm\b/);
  });

  it("marks blocking with the rail, not a third chip", () => {
    const { container } = body();
    expect(container.querySelector(".border-l-danger")).toBeTruthy();
    expect(screen.queryByText("blocking")).toBeNull();
  });
});
