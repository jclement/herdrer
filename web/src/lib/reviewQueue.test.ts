import { describe, expect, it } from "vitest";
import type { ReviewItem, Urgency } from "./types";
import {
  ANSWER_COOLDOWN_MS,
  INPUT_HOT_MS,
  canAutoRaise,
  canPeek,
  compareQueue,
  nextWakeAt,
  pendingQueue,
  planQueue,
  sortQueue,
  toQueueItem,
  type QueueCtx,
  type QueueItem,
} from "./reviewQueue";

const T0 = Date.parse("2026-08-17T12:00:00Z");

function item(id: string, urgency: Urgency, ageMinutes = 0, provisional = false): QueueItem {
  return {
    id,
    title: id,
    urgency,
    created_at: new Date(T0 - ageMinutes * 60_000).toISOString(),
    provisional,
  };
}

function ctx(over: Partial<QueueCtx> = {}): QueueCtx {
  return {
    interactive: false,
    inputHot: false,
    suppressed: false,
    pinned: null,
    deferred: [],
    cooldownUntil: 0,
    quietSince: null,
    ...over,
  };
}

describe("queue ordering", () => {
  it("puts the most urgent first and the oldest first inside a band", () => {
    const items = [
      item("low-old", "low", 60),
      item("normal-new", "normal", 1),
      item("normal-old", "normal", 30),
      item("blocking", "blocking", 0),
    ];
    expect(sortQueue(items).map((i) => i.id)).toEqual([
      "blocking",
      "normal-old",
      "normal-new",
      "low-old",
    ]);
  });

  it("ranks a real document above a synthesized pane row at equal urgency", () => {
    const doc = item("doc", "blocking", 1);
    const pane = item("pane", "blocking", 90, true);
    expect(compareQueue(doc, pane)).toBeLessThan(0);
  });

  it("survives a timestamp the server never sent", () => {
    const a = { ...item("a", "normal"), created_at: "" };
    const b = item("b", "normal", 5);
    expect(() => sortQueue([a, b])).not.toThrow();
  });

  it("counts only open items — an answered one has stopped competing", () => {
    const rows = [
      { id: "a", status: "open", urgency: "normal", title: "a", created_at: "" },
      { id: "b", status: "answered", urgency: "blocking", title: "b", created_at: "" },
      { id: "c", status: "expired", urgency: "blocking", title: "c", created_at: "" },
    ] as ReviewItem[];
    expect(pendingQueue(rows).map((i) => i.id)).toEqual(["a"]);
  });

  it("marks a herdr-sourced row provisional", () => {
    const row = { id: "x", status: "open", urgency: "blocking", source: "herdr" } as ReviewItem;
    expect(toQueueItem(row).provisional).toBe(true);
  });
});

describe("what may take the screen", () => {
  it("never raises a low-urgency item, and hides it entirely while you type", () => {
    const low = item("low", "low");
    expect(canAutoRaise(low, ctx())).toBe(false);
    expect(canPeek(low, ctx({ interactive: false }))).toBe(true);
    expect(canPeek(low, ctx({ interactive: true }))).toBe(false);
  });

  it("raises a normal item only when the terminal is not under control", () => {
    const normal = item("n", "normal");
    expect(canAutoRaise(normal, ctx({ interactive: false }))).toBe(true);
    expect(canAutoRaise(normal, ctx({ interactive: true }))).toBe(false);
    expect(canPeek(normal, ctx({ interactive: true }))).toBe(true);
  });

  it("lets a blocking item interrupt a session you are holding but not typing in", () => {
    const blocking = item("b", "blocking");
    expect(canAutoRaise(blocking, ctx({ interactive: true, inputHot: false }))).toBe(true);
  });

  it("refuses to raise anything while a key is still in flight", () => {
    for (const urgency of ["low", "normal", "blocking"] as Urgency[]) {
      expect(canAutoRaise(item("x", urgency), ctx({ inputHot: true }))).toBe(false);
    }
  });

  it("never raises a synthesized pane row — there is no document to read", () => {
    expect(canAutoRaise(item("p", "blocking", 0, true), ctx())).toBe(false);
  });

  it("stays out of the way on a route that is already a review surface", () => {
    const blocking = item("b", "blocking");
    expect(canAutoRaise(blocking, ctx({ suppressed: true }))).toBe(false);
    expect(canPeek(blocking, ctx({ suppressed: true }))).toBe(false);
  });
});

describe("planQueue", () => {
  it("shows one item and counts the rest behind it", () => {
    const plan = planQueue(
      [item("a", "blocking"), item("b", "normal"), item("c", "normal")],
      ctx(),
      T0,
    );
    expect(plan.sheet).toBe("a");
    expect(plan.peek).toBeNull();
    expect(plan.waiting).toBe(2);
    expect(plan.open).toBe(3);
  });

  it("peeks rather than raises while a key is in flight, then promotes when typing stops", () => {
    const items = [item("b", "blocking")];
    const typing = planQueue(items, ctx({ interactive: true, inputHot: true }), T0);
    expect(typing.sheet).toBeNull();
    expect(typing.peek).toBe("b");

    const quiet = planQueue(items, ctx({ interactive: true, inputHot: false }), T0);
    expect(quiet.sheet).toBe("b");
  });

  it("keeps a low-urgency arrival to the badge while the terminal is held", () => {
    const plan = planQueue([item("l", "low")], ctx({ interactive: true }), T0);
    expect(plan.sheet).toBeNull();
    expect(plan.peek).toBeNull();
    expect(plan.open).toBe(1);
    expect(plan.waiting).toBe(1);
  });

  it("honours an explicit open even mid-keystroke, and even for a deferred item", () => {
    const plan = planQueue(
      [item("a", "blocking"), item("b", "low", 5)],
      ctx({ inputHot: true, interactive: true, pinned: "b", deferred: ["b"] }),
      T0,
    );
    expect(plan.sheet).toBe("b");
    expect(plan.waiting).toBe(1);
  });

  it("shows no overlay at all on a review surface, even one the human pinned", () => {
    const plan = planQueue([item("a", "blocking")], ctx({ suppressed: true, pinned: "a" }), T0);
    expect(plan.sheet).toBeNull();
    expect(plan.peek).toBeNull();
    expect(plan.open).toBe(1);
  });

  it("ignores a pin for an item that is no longer open", () => {
    const plan = planQueue([item("a", "normal")], ctx({ pinned: "gone" }), T0);
    expect(plan.sheet).toBe("a");
  });

  it("skips a deferred item and offers the next one instead", () => {
    const plan = planQueue(
      [item("a", "blocking"), item("b", "normal")],
      ctx({ deferred: ["a"] }),
      T0,
    );
    expect(plan.sheet).toBe("b");
    // The deferred item has not gone anywhere: it is still open and still counted.
    expect(plan.open).toBe(2);
  });

  it("shows nothing at all when every open item has been deferred", () => {
    const plan = planQueue([item("a", "blocking")], ctx({ deferred: ["a"] }), T0);
    expect(plan.sheet).toBeNull();
    expect(plan.peek).toBeNull();
    expect(plan.waiting).toBe(1);
  });

  it("does not interrogate: the next item only peeks during the post-answer cooldown", () => {
    const items = [item("next", "blocking")];
    const cooling = planQueue(items, ctx({ cooldownUntil: T0 + ANSWER_COOLDOWN_MS }), T0);
    expect(cooling.sheet).toBeNull();
    expect(cooling.peek).toBe("next");
  });

  it("raises again once the cooldown has passed", () => {
    const items = [item("a", "blocking")];
    const plan = planQueue(items, ctx({ cooldownUntil: T0 }), T0 + 1);
    expect(plan.sheet).toBe("a");
  });

  it("shows nothing when nothing is open", () => {
    expect(planQueue([], ctx(), T0)).toEqual({ sheet: null, peek: null, waiting: 0, open: 0 });
  });
});

describe("not stampeding", () => {
  it("stops re-raising things that were already waiting once you dispose of one", () => {
    const items = [item("a", "blocking", 10), item("b", "blocking", 5)];
    // A was answered or put off at T0; both were already waiting before that.
    const after = planQueue(items, ctx({ deferred: ["a"], quietSince: T0 }), T0 + 10_000);
    expect(after.sheet).toBeNull();
    expect(after.peek).toBe("b");
    expect(after.waiting).toBe(1);
  });

  it("still lets something that arrives afterwards interrupt", () => {
    const fresh: QueueItem = {
      id: "fresh",
      title: "fresh",
      urgency: "blocking",
      created_at: new Date(T0 + 60_000).toISOString(),
      provisional: false,
    };
    const plan = planQueue(
      [item("old", "blocking", 5), fresh],
      ctx({ quietSince: T0 }),
      T0 + 61_000,
    );
    expect(plan.sheet).toBe("fresh");
  });

  it("lifts the quiet when the human goes looking", () => {
    const items = [item("b", "blocking", 5)];
    expect(planQueue(items, ctx({ quietSince: T0 }), T0).sheet).toBeNull();
    expect(planQueue(items, ctx({ quietSince: null, pinned: "b" }), T0).sheet).toBe("b");
  });
});

describe("nextWakeAt", () => {
  it("wakes when the hot window lapses, because nothing else will", () => {
    expect(nextWakeAt(ctx(), T0, T0 + 100)).toBe(T0 + INPUT_HOT_MS);
  });

  it("takes whichever timer fires first", () => {
    const c = ctx({ cooldownUntil: T0 + 500 });
    expect(nextWakeAt(c, T0, T0 + 100)).toBe(T0 + 500);
  });

  it("returns null when only new data could change the plan", () => {
    expect(nextWakeAt(ctx(), T0 - INPUT_HOT_MS * 2, T0)).toBeNull();
  });
});
