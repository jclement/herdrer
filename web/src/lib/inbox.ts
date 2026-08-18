import type { ReviewItem } from "./types";
import { ageSeconds, expiringSoon } from "./format";

/**
 * Inbox ordering. The sort key is "what is costing the most right now", which is
 * neither pure age nor pure urgency: three bands, age within each.
 *
 *  1 Blocked — something is provably stopped (urgency `blocking`, or a Herdr pane
 *    sitting at a prompt). Structured review items always sort above raw blocked
 *    panes, so an agent that writes a proper document gets answered first.
 *  2 Waiting — every other open item. Real, but nothing is stopped.
 *  3 Stale   — expired or cancelled. Nobody is waiting; collapsed by default.
 */
export type Band = 1 | 2 | 3;

export const BAND_LABEL: Record<Band, string> = {
  1: "Blocked",
  2: "Waiting",
  3: "Stale",
};

export function isProvisional(item: ReviewItem): boolean {
  return item.source === "herdr";
}

export function bandOf(item: ReviewItem): Band {
  if (item.status === "expired" || item.status === "cancelled") return 3;
  if (item.urgency === "blocking" || isProvisional(item)) return 1;
  return 2;
}

/** Oldest first within a band; expiring-soon floats to the top of its band. */
export function compareItems(a: ReviewItem, b: ReviewItem, now = Date.now()): number {
  const bandDelta = bandOf(a) - bandOf(b);
  if (bandDelta !== 0) return bandDelta;

  const structural = Number(isProvisional(a)) - Number(isProvisional(b));
  if (structural !== 0) return structural;

  const expiry = Number(expiringSoon(b.expires_at, now)) - Number(expiringSoon(a.expires_at, now));
  if (expiry !== 0) return expiry;

  return ageSeconds(b.created_at, now) - ageSeconds(a.created_at, now);
}

export function sortInbox(items: ReviewItem[], now = Date.now()): ReviewItem[] {
  return [...items].sort((a, b) => compareItems(a, b, now));
}

export interface InboxGroups {
  bands: { band: Band; items: ReviewItem[] }[];
  answered: ReviewItem[];
  /** Items in bands 1 and 2 — what the badge counts. */
  actionable: number;
}

/** Answered items stay visible for 24h so a tap visibly registered. */
export function groupInbox(items: ReviewItem[], now = Date.now()): InboxGroups {
  const open: ReviewItem[] = [];
  const answered: ReviewItem[] = [];
  for (const item of items) {
    if (item.status === "answered") {
      if (ageSeconds(item.answered_at ?? item.created_at, now) < 24 * 3600) answered.push(item);
    } else {
      open.push(item);
    }
  }

  const sorted = sortInbox(open, now);
  const bands: { band: Band; items: ReviewItem[] }[] = [];
  for (const band of [1, 2, 3] as Band[]) {
    const inBand = sorted.filter((i) => bandOf(i) === band);
    if (inBand.length > 0) bands.push({ band, items: inBand });
  }

  answered.sort(
    (a, b) => ageSeconds(a.answered_at, now) - ageSeconds(b.answered_at, now), // newest first
  );

  return {
    bands,
    answered,
    actionable: sorted.filter((i) => bandOf(i) !== 3 && !isProvisional(i)).length,
  };
}
