import { describe, expect, it } from "vitest";
import { expiringSoon, markdownPreview, shortAge, shortDuration, truncate } from "./format";
import { taglineForDate } from "./taglines";

const NOW = Date.parse("2026-08-17T12:00:00Z");

describe("shortDuration", () => {
  it("uses the largest unit that fits", () => {
    expect(shortDuration(45)).toBe("45s");
    expect(shortDuration(90)).toBe("1m");
    expect(shortDuration(3 * 3600 + 20)).toBe("3h");
    expect(shortDuration(50 * 3600)).toBe("2d");
    expect(shortDuration(-5)).toBe("0s");
  });
});

describe("shortAge", () => {
  it("is empty for a missing timestamp and tolerant of nonsense", () => {
    expect(shortAge(null, NOW)).toBe("");
    expect(shortAge("not a date", NOW)).toBe("0s");
    expect(shortAge(new Date(NOW - 7_200_000).toISOString(), NOW)).toBe("2h");
  });
});

describe("expiringSoon", () => {
  it("is true only inside the last hour", () => {
    expect(expiringSoon(new Date(NOW + 30 * 60_000).toISOString(), NOW)).toBe(true);
    expect(expiringSoon(new Date(NOW + 3 * 3600_000).toISOString(), NOW)).toBe(false);
    expect(expiringSoon(new Date(NOW - 60_000).toISOString(), NOW)).toBe(false);
    expect(expiringSoon(null, NOW)).toBe(false);
  });
});

describe("markdownPreview", () => {
  it("skips headings and fences and strips emphasis", () => {
    const md = "# Title\n\n```go\nfoo()\n```\n\nThe **actual** first sentence.";
    expect(markdownPreview(md)).toBe("The actual first sentence.");
  });

  it("is empty rather than undefined for an empty body", () => {
    expect(markdownPreview("")).toBe("");
    expect(markdownPreview(null)).toBe("");
  });
});

describe("truncate", () => {
  it("adds an ellipsis only when it cuts", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("a much longer string", 10)).toBe("a much lo…");
  });
});

describe("taglineForDate", () => {
  it("is stable for a given day and varies across days", () => {
    const a = taglineForDate(new Date(2026, 7, 17, 1, 0, 0));
    const b = taglineForDate(new Date(2026, 7, 17, 23, 0, 0));
    expect(a).toBe(b);
    const days = new Set(
      Array.from({ length: 30 }, (_, i) => taglineForDate(new Date(2026, 7, i + 1))),
    );
    expect(days.size).toBeGreaterThan(3);
  });
});
