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

/**
 * What Send would submit, or null if Send must stay disabled.
 *
 * This is the guard behind the worst bug the redesign had to fix: the action
 * bar used to hold its options in a horizontal scroller with the scrollbar
 * suppressed, so on a 375px phone you could commit an irreversible answer while
 * the app showed you a button reading `Dep`. The scroller is gone — the bar now
 * renders every option, full width, unclipped — and this function is the
 * invariant that keeps it that way: Send only ever sends a value the bar is
 * currently displaying. A selection that is not one of the item's options
 * (a stale key from a refetch, a URL parameter naming an option the agent
 * withdrew) is not sendable, it is a disabled button.
 */
export function sendableValue(
  item: ReviewItem,
  selected: string | null,
  note: string,
): string | null {
  if (isFreeText(item)) {
    const text = note.trim();
    return text === "" ? null : text;
  }
  if (selected === null) return null;
  return answerOptions(item).some((o) => o.key === selected) ? selected : null;
}
