// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewItem } from "../../lib/types";
import { ActionBar } from "./ActionBar";
import { sendableValue } from "./answer";

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
  created_at: new Date().toISOString(),
};

function bar(props: Partial<React.ComponentProps<typeof ActionBar>> = {}) {
  return render(
    <ActionBar
      item={item}
      selected={null}
      onSelect={() => {}}
      note=""
      onNoteChange={() => {}}
      onSubmit={() => {}}
      submitting={false}
      onMore={() => {}}
      {...props}
    />,
  );
}

function sendButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /send/i }) as HTMLButtonElement;
}

afterEach(cleanup);

/**
 * The bug this file exists for: the option strip used to be a horizontal
 * scroller with `no-scrollbar`, so on a 375px phone it got ~160px for ~314px of
 * buttons and offered no affordance at all. Send stayed enabled while the
 * selected option's label was scrolled out of sight — and in the screenshot
 * that started this, the clipped one was the *recommended* option while the
 * irreversible one was the fully legible button next to it.
 */
describe("the answer controls are all visible or Send is off", () => {
  it("does not put the options in a horizontal scroller", () => {
    bar();
    const group = screen.getByTestId("answer-options");
    for (let el: HTMLElement | null = group; el; el = el.parentElement) {
      expect(el.className).not.toMatch(/\bscroll-x\b/);
      expect(el.className).not.toMatch(/\boverflow-x-auto\b/);
      if (el.tagName === "BODY") break;
    }
    // …and it wraps, which is the only way N options fit without one.
    expect(group.className).toMatch(/\bflex-wrap\b/);
  });

  it("renders every option, whole, as its own full-width row", () => {
    bar();
    const group = screen.getByTestId("answer-options");
    const buttons = within(group).getAllByRole("radio");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toContain("Drop it now");
    expect(buttons[1]?.textContent).toContain("Deprecate for one release");
    for (const b of buttons) {
      expect(b.className).toMatch(/\bbasis-full\b/);
      // No `truncate`, no `whitespace-nowrap`: a half-read option is the bug.
      expect(b.className).not.toMatch(/\btruncate\b/);
      expect(b.className).not.toMatch(/\bwhitespace-nowrap\b/);
    }
  });

  it("keeps Send disabled until something is selected", () => {
    bar();
    expect(sendButton().disabled).toBe(true);
  });

  it("enables Send only for a value the bar is showing", () => {
    const { rerender } = bar({ selected: "B" });
    expect(sendButton().disabled).toBe(false);
    expect(screen.getByText("Deprecate for one release")).toBeTruthy();

    // A key the item no longer offers — a stale selection surviving a refetch,
    // or `?a=` naming an option the agent withdrew. Nothing on screen says
    // "Z", so Send must not be able to send it.
    rerender(
      <ActionBar
        item={item}
        selected="Z"
        onSelect={() => {}}
        note=""
        onNoteChange={() => {}}
        onSubmit={() => {}}
        submitting={false}
        onMore={() => {}}
      />,
    );
    expect(sendButton().disabled).toBe(true);
  });

  it("names what Send will send when the keyboard has hidden the options", () => {
    bar({ selected: "B" });
    // Focusing the note collapses the option rows — the summary is then the
    // only thing standing between the reader and an unlabelled commit.
    fireEvent.click(screen.getByLabelText("Add a note"));
    fireEvent.focus(screen.getByRole("textbox"));
    expect(screen.getByText(/Sending: Deprecate for one release/)).toBeTruthy();
  });

  it("agrees with the pure guard behind it", () => {
    expect(sendableValue(item, null, "")).toBeNull();
    expect(sendableValue(item, "Z", "")).toBeNull();
    expect(sendableValue(item, "A", "")).toBe("A");
    const free = { ...item, kind: "manual" as const, options: null };
    expect(sendableValue(free, null, "   ")).toBeNull();
    expect(sendableValue(free, null, " ship it ")).toBe("ship it");
  });
});

/**
 * "I can't decide this on a phone" used to be a menu item that pushed the
 * string *"Park it, don't guess."* into the note box. On a `choice` that could
 * not be sent at all — Send needed a selection — and if you supplied one to get
 * it sent, the agent received "do B" and "don't guess" together, with the
 * contract telling it the note outranks the button.
 */
describe("parking sends nothing", () => {
  it("is a labelled control in the bar, not a glyph in a menu", () => {
    const onPark = vi.fn();
    bar({ onPark });
    const park = screen.getByRole("button", { name: /park it/i });
    fireEvent.click(park);
    expect(onPark).toHaveBeenCalledTimes(1);
  });

  it("does not touch the note or the selection", () => {
    const onPark = vi.fn();
    const onNoteChange = vi.fn();
    const onSelect = vi.fn();
    const onSubmit = vi.fn();
    bar({ onPark, onNoteChange, onSelect, onSubmit });
    fireEvent.click(screen.getByRole("button", { name: /park it/i }));
    expect(onNoteChange).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("has no surface left that stages a refusal as a note", () => {
    for (const f of ["ItemPage.tsx", "ReviewSheet.tsx"]) {
      const text = readFileSync(join(process.cwd(), "src/features/review", f), "utf8");
      expect(text).not.toContain("don't guess");
      expect(text).not.toContain("Note staged");
    }
  });
});
