import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Bell, ChevronRight, Inbox, Layers } from "lucide-react";
import { useReviews } from "../../lib/queries";
import {
  ANSWER_COOLDOWN_MS,
  INPUT_HOT_MS,
  pendingQueue,
  planQueue,
  sortQueue,
  nextWakeAt,
  type QueueCtx,
} from "../../lib/reviewQueue";
import { shortAge } from "../../lib/format";
import { useVisualViewport } from "../../lib/viewport";
import { Chip, EmptyState, cx } from "../../components/ui";
import { Sheet } from "../../components/Sheet";
import { ReviewSheet } from "./ReviewSheet";

/**
 * The overlay host.
 *
 * Review is no longer a place you go; it is something that happens on top of
 * wherever you are. This provider owns that: it watches the open items, decides
 * — via lib/reviewQueue.ts, which is pure and tested — whether an arrival may
 * take the screen, and renders whichever of the three surfaces applies.
 *
 *   sheet  the full document, over everything
 *   peek   a strip under the header that never takes focus
 *   stack  the list, when you go looking for something you deferred
 *
 * It sits above the router outlet so an item can rise over the terminal, the
 * agents board or settings alike, and stays out of the way on the two routes
 * that are already review surfaces.
 */

export interface ReviewQueueApi {
  /** Every open item — the badge. */
  open: number;
  /** Open items other than the one on screen. */
  waiting: number;
  /** The item currently presented as a sheet, if any. */
  sheetId: string | null;
  peekId: string | null;
  /** The terminal reports whether the human has taken control. */
  setInteractive: (interactive: boolean) => void;
  /** The terminal reports a keystroke. Cheap: this is called per character. */
  noteInput: () => void;
  /** Open one item deliberately. Always honoured. */
  openItem: (id: string) => void;
  /** Dismiss without answering — a defer, not a decision. */
  defer: (id: string) => void;
  openStack: () => void;
}

const noop = () => {};

const Ctx = createContext<ReviewQueueApi>({
  open: 0,
  waiting: 0,
  sheetId: null,
  peekId: null,
  setInteractive: noop,
  noteInput: noop,
  openItem: noop,
  defer: noop,
  openStack: noop,
});

export function useReviewQueue(): ReviewQueueApi {
  return useContext(Ctx);
}

/** Only the two timing fields matter to nextWakeAt; the rest is filler. */
const EMPTY_CTX: QueueCtx = {
  interactive: false,
  inputHot: false,
  suppressed: false,
  pinned: null,
  deferred: [],
  cooldownUntil: 0,
};

/** Routes that already show reviews: an overlay there would be a duplicate. */
function isSuppressed(pathname: string): boolean {
  return pathname.startsWith("/r/") || pathname === "/inbox";
}

export function ReviewQueueProvider({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const reviews = useReviews("all");

  const [deferred, setDeferred] = useState<string[]>([]);
  /** Answered or dismissed here, before the list refetch catches up. */
  const [settled, setSettled] = useState<string[]>([]);
  const [pinned, setPinned] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [interactive, setInteractiveState] = useState(false);
  const [stackOpen, setStackOpen] = useState(false);
  const [hot, setHot] = useState(false);
  const lastInputRef = useRef(0);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const pending = useMemo(
    () => pendingQueue(reviews.data).filter((i) => !settled.includes(i.id)),
    [reviews.data, settled],
  );

  const ctx: QueueCtx = {
    interactive,
    inputHot: hot,
    suppressed: isSuppressed(path),
    pinned,
    deferred,
    cooldownUntil,
  };

  const now = Date.now();
  const plan = planQueue(pending, ctx, now);

  /*
   * "Blocking promotes itself once you stop typing" is a transition with no
   * event behind it — nothing arrives, time simply passes — so the plan has to
   * be recomputed on a timer or that promotion never happens.
   *
   * The loop reschedules itself rather than firing once, because a keystroke at
   * t+2s moves the target: a single timeout armed at t would fire early, find
   * the human still typing, and then never arm again.
   */
  useEffect(() => {
    let timer = 0;
    const wakeIn = (now: number) => {
      const wake = nextWakeAt(
        { ...EMPTY_CTX, cooldownUntil },
        hot ? lastInputRef.current : 0,
        now,
      );
      return wake === null ? null : Math.max(16, wake - now);
    };

    const step = () => {
      const now = Date.now();
      if (now - lastInputRef.current >= INPUT_HOT_MS) setHot(false);
      tick();
      const delay = wakeIn(now);
      if (delay !== null) timer = window.setTimeout(step, delay);
    };

    const delay = wakeIn(Date.now());
    if (delay === null) return;
    timer = window.setTimeout(step, delay);
    return () => window.clearTimeout(timer);
  }, [hot, cooldownUntil]);

  const noteInput = useCallback(() => {
    lastInputRef.current = Date.now();
    // setState with the same value is a no-op, so this is safe per keystroke.
    setHot(true);
  }, []);

  const setInteractive = useCallback((next: boolean) => setInteractiveState(next), []);

  const openItem = useCallback((id: string) => {
    setDeferred((d) => d.filter((x) => x !== id));
    setPinned(id);
    setStackOpen(false);
  }, []);

  const defer = useCallback((id: string) => {
    setDeferred((d) => (d.includes(id) ? d : [...d, id]));
    setPinned((p) => (p === id ? null : p));
  }, []);

  const settle = useCallback((id: string) => {
    setSettled((s) => (s.includes(id) ? s : [...s, id]));
    setPinned((p) => (p === id ? null : p));
    setCooldownUntil(Date.now() + ANSWER_COOLDOWN_MS);
  }, []);

  const api = useMemo<ReviewQueueApi>(
    () => ({
      open: plan.open,
      waiting: plan.waiting,
      sheetId: plan.sheet,
      peekId: plan.peek,
      setInteractive,
      noteInput,
      openItem,
      defer,
      openStack: () => setStackOpen(true),
    }),
    [plan.open, plan.waiting, plan.sheet, plan.peek, setInteractive, noteInput, openItem, defer],
  );

  const ordered = useMemo(() => sortQueue(pending), [pending]);
  const peekItem = ordered.find((i) => i.id === plan.peek);

  return (
    <Ctx.Provider value={api}>
      {children}

      {plan.peek !== null && peekItem && (
        <PeekStrip
          title={peekItem.title}
          urgency={peekItem.urgency}
          waiting={plan.waiting}
          onOpen={() => openItem(peekItem.id)}
          onLater={() => defer(peekItem.id)}
        />
      )}

      {plan.sheet !== null && (
        <ReviewSheet
          key={plan.sheet}
          id={plan.sheet}
          waiting={plan.waiting}
          // Raised by the queue rather than by a tap: hold the controls inert
          // for a moment so a thumb already in flight cannot answer.
          armed={pinned === plan.sheet}
          onClose={() => defer(plan.sheet!)}
          onAnswered={() => settle(plan.sheet!)}
          onNext={plan.waiting > 0 ? () => defer(plan.sheet!) : undefined}
        />
      )}

      <Sheet open={stackOpen} title="Waiting on you" onClose={() => setStackOpen(false)}>
        {ordered.length === 0 ? (
          <EmptyState
            icon={<Inbox className="w-6 h-6" />}
            title="Nothing waiting."
            message="Every question has been answered. The agents are on their own for now."
          />
        ) : (
          <div className="divide-y divide-border">
            {ordered.map((i) => (
              <button
                key={i.id}
                onClick={() => openItem(i.id)}
                className="flex w-full items-start gap-2 px-3 py-3 text-left hover:bg-hover"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-heading">{i.title}</div>
                  <div className="mt-1 flex items-center gap-1">
                    {i.urgency === "blocking" && <Chip tone="danger">blocking</Chip>}
                    {i.provisional && <Chip tone="warn">TUI prompt</Chip>}
                    {deferred.includes(i.id) && <Chip>deferred</Chip>}
                    <span className="font-mono text-[11px] text-muted">
                      {shortAge(i.created_at)}
                    </span>
                  </div>
                </div>
                <ChevronRight className="mt-1 w-4 h-4 shrink-0 text-muted" />
              </button>
            ))}
          </div>
        )}
        <div className="border-t border-border px-3 py-3">
          <Link
            to="/inbox"
            onClick={() => setStackOpen(false)}
            className="inline-flex items-center gap-1 text-xs text-accent"
          >
            <Layers className="w-3.5 h-3.5" />
            Open the full inbox — answered, expired and all
          </Link>
        </div>
      </Sheet>
    </Ctx.Provider>
  );
}

/**
 * The strip that says "something is waiting" without taking anything from you.
 *
 * It sits *below* the header rather than above the key bar on purpose. The
 * bottom of a phone screen is where the thumb lives and where every button on
 * the terminal already is; putting an interrupt there is how you get a
 * mis-tapped answer. Up here it is visible, reachable, and nowhere near
 * anything you were about to press.
 */
function PeekStrip({
  title,
  urgency,
  waiting,
  onOpen,
  onLater,
}: {
  title: string;
  urgency: string;
  waiting: number;
  onOpen: () => void;
  onLater: () => void;
}) {
  const vv = useVisualViewport();
  const blocking = urgency === "blocking";

  return (
    <div
      className="fixed inset-x-0 z-30 px-2"
      style={{ top: `calc(${vv.offsetTop}px + env(safe-area-inset-top, 0px) + 2.5rem)` }}
      role="status"
      aria-live="polite"
    >
      <div
        className={cx(
          "mx-auto flex w-full max-w-2xl items-center gap-2 rounded border bg-surface-2 px-2 py-1.5 shadow-lg",
          blocking ? "border-danger/60" : "border-border",
        )}
      >
        <Bell className={cx("w-4 h-4 shrink-0", blocking ? "text-danger" : "text-accent")} />
        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="truncate text-xs font-medium text-heading">{title}</div>
          <div className="text-[11px] text-muted">
            {blocking ? "blocking · " : ""}
            {waiting > 0 ? `${waiting} more waiting` : "tap to read it"}
          </div>
        </button>
        <button
          onClick={onOpen}
          className="h-9 shrink-0 rounded border border-accent px-2 text-xs font-medium text-accent"
        >
          Read
        </button>
        <button onClick={onLater} className="h-9 shrink-0 px-2 text-xs text-muted">
          Later
        </button>
      </div>
    </div>
  );
}
