import { describe, expect, it } from "vitest";
import { bandOf, groupInbox, sortInbox } from "./inbox";
import type { ReviewItem, Urgency } from "./types";

const NOW = Date.parse("2026-08-17T12:00:00Z");

function item(over: Partial<ReviewItem> & { id: string }): ReviewItem {
  return {
    title: over.id,
    kind: "confirm",
    urgency: "normal" as Urgency,
    status: "open",
    body_md: "",
    created_at: new Date(NOW - 60_000).toISOString(),
    ...over,
  } as ReviewItem;
}

describe("bandOf", () => {
  it("puts blocking items and blocked panes in band 1", () => {
    expect(bandOf(item({ id: "a", urgency: "blocking" }))).toBe(1);
    expect(bandOf(item({ id: "b", source: "herdr" }))).toBe(1);
  });

  it("puts everything else open in band 2 and dead items in band 3", () => {
    expect(bandOf(item({ id: "c" }))).toBe(2);
    expect(bandOf(item({ id: "d", status: "expired" }))).toBe(3);
    expect(bandOf(item({ id: "e", status: "cancelled" }))).toBe(3);
  });
});

describe("sortInbox", () => {
  it("orders by band, then structured before raw, then age", () => {
    const items = [
      item({ id: "young-normal", created_at: new Date(NOW - 60_000).toISOString() }),
      item({ id: "old-normal", created_at: new Date(NOW - 7_200_000).toISOString() }),
      item({
        id: "raw-blocked",
        source: "herdr",
        created_at: new Date(NOW - 600_000).toISOString(),
      }),
      item({
        id: "blocking",
        urgency: "blocking",
        created_at: new Date(NOW - 30_000).toISOString(),
      }),
      item({ id: "expired", status: "expired" }),
    ];
    expect(sortInbox(items, NOW).map((i) => i.id)).toEqual([
      "blocking",
      "raw-blocked",
      "old-normal",
      "young-normal",
      "expired",
    ]);
  });

  it("floats an item that is about to expire to the top of its band", () => {
    const items = [
      item({ id: "older", created_at: new Date(NOW - 7_200_000).toISOString() }),
      item({
        id: "expiring",
        created_at: new Date(NOW - 60_000).toISOString(),
        expires_at: new Date(NOW + 10 * 60_000).toISOString(),
      }),
    ];
    expect(sortInbox(items, NOW)[0]?.id).toBe("expiring");
  });
});

describe("groupInbox", () => {
  it("keeps answered items for 24h and excludes raw blocked panes from the count", () => {
    const groups = groupInbox(
      [
        item({ id: "open" }),
        item({ id: "raw", source: "herdr" }),
        item({
          id: "recent",
          status: "answered",
          answered_at: new Date(NOW - 3600_000).toISOString(),
          answer_value: "yes",
        }),
        item({
          id: "ancient",
          status: "answered",
          answered_at: new Date(NOW - 48 * 3600_000).toISOString(),
        }),
      ],
      NOW,
    );
    expect(groups.answered.map((i) => i.id)).toEqual(["recent"]);
    expect(groups.actionable).toBe(1);
  });
});
