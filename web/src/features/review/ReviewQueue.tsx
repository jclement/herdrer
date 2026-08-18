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
import type { QueueItem } from "../../lib/reviewQueue";
import { shortAge } from "../../lib/format";
import { useIsDesktop } from "../../lib/layout";
import { isTerminalPath } from "../../components/AppShell";
import { useVisualViewport } from "../../lib/viewport";
import { parked } from "../../lib/storage";
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
 * It sits above the router outlet on every route, because `items`, `open` and
 * `openItem` are the whole app's view of the queue — the desktop rail is fed
 * from here too. But the *overlays* are scoped to one surface: the phone's
 * terminal. Everywhere else an arriving item is a row appearing in a list you
 * are already looking at, which is what the inbox-as-home means. See
 * lib/reviewQueue.ts for the argument.
 *
 * The one overlay that fires anywhere is the sheet a human explicitly opened —
 * reused verbatim as the modal a desktop rail row opens. One queue, one
 * document component, two presentations.
 */

export interface ReviewQueueApi {
  /** Every open item — the badge. */
  open: number;
  /**
   * Every open item, in queue order, for a surface that shows the whole list
   * rather than one of it: the desktop rail. The overlays use `sheetId` and
   * `peekId` instead — those are the queue's *decision*, and this is its data.
   */
  items: QueueItem[];
  /** Dismissed without answering, this session. Still listed, no longer competing. */
  deferred: string[];
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
  items: [],
  deferred: [],
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

/** Only `terminal` and the two timing fields matter to nextWakeAt; the rest is filler. */
const EMPTY_CTX: QueueCtx = {
  terminal: false,
  interactive: false,
  inputHot: false,
  pinned: null,
  deferred: [],
  cooldownUntil: 0,
  quietSince: null,
};

export function ReviewQueueProvider({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const desktop = useIsDesktop();
  const reviews = useReviews("all");

  /**
   * The one gate. Overlays exist on the phone's terminal and nowhere else:
   * a desktop has the rail, and a phone anywhere else has the list.
   */
  const terminal = !desktop && isTerminalPath(path, desktop);

  // Seeded from localStorage: a defer that a reload forgets is a defer that lied.
  const [deferred, setDeferred] = useState<string[]>(() => parked.read());
  /** Answered or dismissed here, before the list refetch catches up. */
  const [settled, setSettled] = useState<string[]>([]);
  const [pinned, setPinned] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  /** Set whenever the human disposes of an item; cleared when they go looking. */
  const [quietSince, setQuietSince] = useState<number | null>(null);
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
    terminal,
    interactive,
    inputHot: hot,
    pinned,
    deferred,
    cooldownUntil,
    quietSince,
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
    // Off the terminal nothing raises itself, so there is no transition to wait
    // for. Clearing `hot` on the way out matters — a window dragged wide, or a
    // tap on the Inbox tab, while the human was typing would otherwise leave it
    // stuck true, and stuck-true is exactly "no question may take the screen"
    // once they come back.
    if (!terminal) {
      setHot(false);
      return;
    }
    let timer = 0;
    const wakeIn = (now: number) => {
      const wake = nextWakeAt(
        { ...EMPTY_CTX, terminal, cooldownUntil },
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
  }, [hot, cooldownUntil, terminal]);

  const noteInput = useCallback(() => {
    lastInputRef.current = Date.now();
    // Only the phone's terminal consults the hot window, and this is called once
    // per character — so do not put React to work deciding it has nothing to do.
    if (!terminal) return;
    // setState with the same value is a no-op, so this is safe per keystroke.
    setHot(true);
  }, [terminal]);

  /*
   * Arriving at the terminal is not the same as being at it when something
   * arrives.
   *
   * Rule 8 already knows how to say "the things that were waiting a moment ago
   * do not get to raise themselves again" — it is the anti-stampede rule, and
   * `quietSince` is how it is spelled. Entering the terminal wants exactly that
   * sentence. With the inbox as home you saw the queue, you read the titles,
   * and you tapped Terminal anyway; covering the terminal with the item you
   * just walked past is the app arguing with the human. Anything that arrives
   * *after* you get there is a new event and still interrupts, which is the
   * only part of this that was ever load-bearing.
   */
  useEffect(() => {
    if (terminal) setQuietSince(Date.now());
  }, [terminal]);

  /*
   * A pin is "open this, here". Going somewhere else closes it.
   *
   * Rule 1 honours an explicit open on every surface, which is what makes the
   * desktop rail work — but that means a pin left behind by a rail click would
   * follow the human onto /agents and float a sheet over it. It never used to,
   * because the review routes suppressed every overlay; that suppression is
   * gone, so the pin has to be cleared where it is actually stale.
   */
  useEffect(() => {
    setPinned(null);
    setStackOpen(false);
  }, [path]);

  const setInteractive = useCallback((next: boolean) => setInteractiveState(next), []);

  // Going looking is the opposite of being interrupted: it lifts the quiet.
  const openItem = useCallback((id: string) => {
    setDeferred((d) => {
      const next = d.filter((x) => x !== id);
      parked.write(next);
      return next;
    });
    setPinned(id);
    setQuietSince(null);
    setStackOpen(false);
  }, []);

  /*
   * Closing a modal you opened yourself is not deferring.
   *
   * On a phone, dismissing is a decision — the item was put in front of you and
   * you put it down, so it stops competing for the screen. On a desktop you
   * clicked a row in a rail that is still sitting there; closing it again means
   * nothing more than "not this one", and marking it deferred would only put a
   * misleading chip on a row you can see.
   */
  const unpin = useCallback((id: string) => {
    setPinned((p) => (p === id ? null : p));
  }, []);

  const defer = useCallback((id: string) => {
    setDeferred((d) => {
      if (d.includes(id)) return d;
      const next = [...d, id];
      parked.write(next);
      return next;
    });
    setPinned((p) => (p === id ? null : p));
    setQuietSince(Date.now());
  }, []);

  const settle = useCallback((id: string) => {
    setSettled((s) => (s.includes(id) ? s : [...s, id]));
    setPinned((p) => (p === id ? null : p));
    setCooldownUntil(Date.now() + ANSWER_COOLDOWN_MS);
    setQuietSince(Date.now());
  }, []);

  const ordered = useMemo(() => sortQueue(pending), [pending]);

  const api = useMemo<ReviewQueueApi>(
    () => ({
      open: plan.open,
      items: ordered,
      deferred,
      waiting: plan.waiting,
      sheetId: plan.sheet,
      peekId: plan.peek,
      setInteractive,
      noteInput,
      openItem,
      defer,
      openStack: () => setStackOpen(true),
    }),
    [
      plan.open,
      plan.waiting,
      plan.sheet,
      plan.peek,
      ordered,
      deferred,
      setInteractive,
      noteInput,
      openItem,
      defer,
    ],
  );
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
          onClose={() => (desktop ? unpin(plan.sheet!) : defer(plan.sheet!))}
          onAnswered={() => settle(plan.sheet!)}
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
                className="flex min-h-14 w-full items-start gap-2 px-3 py-3 text-left transition-colors hover:bg-hover"
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
            className="inline-flex min-h-11 items-center gap-1 text-xs text-accent"
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
          "drop mx-auto flex w-full max-w-2xl items-center gap-2 rounded-lg border bg-surface-2/95 py-1.5 pl-2 pr-1.5 shadow-2xl backdrop-blur-sm",
          blocking ? "border-danger/60" : "border-border",
        )}
      >
        <Bell
          className={cx("w-4 h-4 shrink-0", blocking ? "breathe text-danger" : "text-accent")}
        />
        <button onClick={onOpen} className="min-h-11 min-w-0 flex-1 py-1 text-left">
          <div className="truncate text-xs font-medium text-heading">{title}</div>
          <div className="text-[11px] text-muted">
            {blocking ? "blocking · " : ""}
            {waiting > 0 ? `${waiting} more waiting` : "tap to read it"}
          </div>
        </button>
        <button
          onClick={onOpen}
          className="h-11 shrink-0 rounded-md border border-accent bg-accent-weak px-3 text-xs font-medium text-accent transition-colors active:scale-[0.98]"
        >
          Read
        </button>
        <button
          onClick={onLater}
          className="h-11 shrink-0 rounded-md px-2.5 text-xs text-muted transition-colors hover:bg-hover"
        >
          Later
        </button>
      </div>
    </div>
  );
}
