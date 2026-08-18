import type { ReviewItem, ReviewOption } from "../../lib/types";

/**
 * The answer vocabulary, straight from the contract: option keys for `choice`,
 * yes/no for `confirm`, `ack` for `ack`, free text for `manual`.
 *
 * `review` is the one kind the contract does not pin down. When the agent
 * supplied options we treat it as a choice; when it did not, the honest answer
 * is an acknowledgement plus a note — and the note is what the agent must read.
 */
export function answerOptions(item: ReviewItem): ReviewOption[] {
  const supplied = item.options ?? [];
  switch (item.kind) {
    case "confirm":
      return supplied.length > 0
        ? supplied
        : [
            { key: "yes", label: "Yes" },
            { key: "no", label: "No" },
          ];
    case "choice":
      return supplied;
    case "ack":
      return [{ key: "ack", label: "Got it" }];
    case "manual":
      return [];
    case "review":
      return supplied.length > 0 ? supplied : [{ key: "ack", label: "Seen" }];
    default:
      return supplied;
  }
}

export function isFreeText(item: ReviewItem): boolean {
  return item.kind === "manual";
}

/** An expired item drops `recommend` entirely, so there is nothing to preselect. */
export function recommendedKey(item: ReviewItem): string | null {
  if (item.status !== "open") return null;
  const rec = item.recommend;
  if (!rec) return null;
  return answerOptions(item).some((o) => o.key === rec) ? rec : null;
}

export function optionLabel(item: ReviewItem, key: string | null): string {
  if (!key) return "";
  const opt = answerOptions(item).find((o) => o.key === key);
  return opt ? opt.label : key;
}

export function isAnswerable(item: ReviewItem): boolean {
  return item.status === "open";
}

/** Why an item can't be answered, in words that say what happened. */
export function unanswerableReason(item: ReviewItem): string {
  switch (item.status) {
    case "answered":
      return "Answered already.";
    case "expired":
      return "This expired before it was answered. A timeout is not a yes — the agent was told nothing.";
    case "cancelled":
      return "The agent cancelled this. Nothing is waiting on you.";
    default:
      return "";
  }
}
