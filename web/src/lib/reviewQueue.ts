import type { ReviewItem, Urgency } from "./types";

/**
 * When a review may take the screen, and when it may only clear its throat.
 *
 * The terminal is the page now, and the terminal is a live PTY with a human's
 * fingers in it. That makes an arriving question a genuine hazard rather than a
 * layout problem: a sheet that mounts and takes focus mid-word eats the rest of
 * the word, and — much worse — the characters that were already in flight land
 * somewhere nobody chose. A `y` meant for a shell prompt is not a `y` you want
 * arriving at a confirm dialog, in either direction.
 *
 * So there are two presentations, not one:
 *
 *   peek   a slim strip in the chrome above the key bar. It never takes focus,
 *          never covers the terminal's text, and never moves anything the thumb
 *          is aiming at. This is what an arrival does while you are typing.
 *   sheet  the full document, over everything, focus moved into it. This only
 *          happens when it cannot cost you a keystroke.
 *
 * The rules, in the order they are argued:
 *
 *   1. An explicit open always wins. If the human tapped the badge, the peek,
 *      or a row in the stack, they asked for it — mid-keystroke or not.
 *   2. Nothing auto-raises while input is *hot* (a key went to the PTY inside
 *      INPUT_HOT_MS). Not even `blocking`. Blocking earns the right to
 *      interrupt, and it does — it just interrupts as a peek until the typing
 *      stops, and promotes itself the moment it does.
 *   3. `normal` waits until you are not holding the terminal at all. Taking
 *      control is a statement that you are mid-task.
 *   4. `low` never raises and never peeks while you hold the terminal. It is a
 *      number on a badge until you go looking. That is what "low" means.
 *   5. One at a time. The rest are a count, not a stack of sheets.
 *   6. Dismissing is deferring, not answering: a deferred item stops competing
 *      for the screen for the rest of the session, and stays in the list. Coming
 *      back to something later is the workflow, not an edge case.
 *   7. After an answer nothing auto-raises for ANSWER_COOLDOWN_MS, so a batch of
 *      three does not feel like being interrogated.
 *
 * A synthesized `herdr` row (a TUI pane sitting at its own prompt) never raises
 * anything: it carries no document, so a sheet for it would be an empty sheet.
 * It counts, it lists, it does not interrupt.
 *
 * Everything here is pure so the policy can be argued with in a test rather
 * than discovered on a phone.
 */

export const URGENCY_RANK: Record<Urgency, number> = { blocking: 0, normal: 1, low: 2 };

/** How long after a keystroke the terminal still counts as being typed into. */
export const INPUT_HOT_MS = 3000;

/** How long after an answer nothing may raise itself. */
export const ANSWER_COOLDOWN_MS = 2000;

export interface QueueItem {
  id: string;
  title: string;
  urgency: Urgency;
  created_at: string;
  /** A herdr-synthesized blocked-pane row rather than an agent's document. */
  provisional: boolean;
}

export interface QueueCtx {
  /** The human has taken control of the terminal. */
  interactive: boolean;
  /** A key reached the PTY within INPUT_HOT_MS. */
  inputHot: boolean;
  /** The route already is a review surface — the inbox, or an item page. */
  suppressed: boolean;
  /** Explicitly opened by the human; outranks every other rule. */
  pinned: string | null;
  /** Dismissed without answering, this session. */
  deferred: readonly string[];
  /** No auto-raise before this epoch-ms. */
  cooldownUntil: number;
}

export interface QueuePlan {
  /** The item to show as a full sheet, or null. */
  sheet: string | null;
  /** The item to announce in the peek strip, or null. */
  peek: string | null;
  /** Open items other than whichever one is on screen. */
  waiting: number;
  /** Every open item — what the badge counts. */
  open: number;
}

export function toQueueItem(item: ReviewItem): QueueItem {
  return {
    id: item.id,
    title: item.title,
    urgency: item.urgency,
    created_at: item.created_at,
    provisional: item.source === "herdr",
  };
}

/** Open means open: answered, expired and cancelled items never compete. */
export function isPending(item: ReviewItem): boolean {
  return item.status === "open";
}

export function pendingQueue(items: readonly ReviewItem[] | undefined): QueueItem[] {
  return (items ?? []).filter(isPending).map(toQueueItem);
}

function createdAt(item: QueueItem): number {
  const t = Date.parse(item.created_at);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Most urgent first; a real document ahead of a synthesized pane row at equal
 * urgency; oldest first inside that. Oldest-first because the thing that has
 * been waiting longest is the thing costing the most wall-clock.
 */
export function compareQueue(a: QueueItem, b: QueueItem): number {
  const urgency = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
  if (urgency !== 0) return urgency;
  const structural = Number(a.provisional) - Number(b.provisional);
  if (structural !== 0) return structural;
  return createdAt(a) - createdAt(b);
}

export function sortQueue(items: readonly QueueItem[]): QueueItem[] {
  return [...items].sort(compareQueue);
}

/** Rule 2/3/4: may this item take the whole screen on its own initiative? */
export function canAutoRaise(item: QueueItem, ctx: QueueCtx): boolean {
  if (ctx.suppressed) return false;
  if (item.provisional) return false;
  if (ctx.deferred.includes(item.id)) return false;
  if (ctx.inputHot) return false;
  switch (item.urgency) {
    case "low":
      return false;
    case "blocking":
      return true;
    default:
      return !ctx.interactive;
  }
}

/** May this item announce itself in the strip? Cheaper than a sheet, so: mostly. */
export function canPeek(item: QueueItem, ctx: QueueCtx): boolean {
  if (ctx.suppressed) return false;
  if (ctx.deferred.includes(item.id)) return false;
  if (item.urgency === "low") return !ctx.interactive;
  return true;
}

export function planQueue(items: readonly QueueItem[], ctx: QueueCtx, now: number): QueuePlan {
  const ordered = sortQueue(items);
  const open = ordered.length;

  // 1 — an explicit open outranks everything, including a hot keyboard.
  if (ctx.pinned !== null && ordered.some((i) => i.id === ctx.pinned)) {
    return { sheet: ctx.pinned, peek: null, waiting: open - 1, open };
  }

  const candidate = ordered.find((i) => !ctx.deferred.includes(i.id));
  if (!candidate) return { sheet: null, peek: null, waiting: open, open };

  const cooling = now < ctx.cooldownUntil;
  if (!cooling && canAutoRaise(candidate, ctx)) {
    return { sheet: candidate.id, peek: null, waiting: open - 1, open };
  }
  if (canPeek(candidate, ctx)) {
    return { sheet: null, peek: candidate.id, waiting: open - 1, open };
  }
  return { sheet: null, peek: null, waiting: open, open };
}

/**
 * When the plan could change on its own — the hot window lapsing, or the
 * cooldown ending. Null when only new data can change anything.
 *
 * The caller needs this because "blocking promotes itself once you stop typing"
 * is a transition with no event behind it: nothing arrives, time simply passes.
 */
export function nextWakeAt(ctx: QueueCtx, lastInputAt: number, now: number): number | null {
  const candidates: number[] = [];
  const hotUntil = lastInputAt + INPUT_HOT_MS;
  if (hotUntil > now) candidates.push(hotUntil);
  if (ctx.cooldownUntil > now) candidates.push(ctx.cooldownUntil);
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}
