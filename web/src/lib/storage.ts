/**
 * iOS kills standalone web apps under memory pressure and relaunches at
 * start_url. Anything typed and not saved is gone, and landing at the top of a
 * long review after visiting the diagram viewer is the most enraging phone bug
 * there is. So: drafts in localStorage, scroll positions in sessionStorage.
 */

function safeGet(store: Storage | undefined, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(store: Storage | undefined, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    /* quota or private mode — the draft simply doesn't survive a reload */
  }
}

function safeRemove(store: Storage | undefined, key: string): void {
  try {
    store?.removeItem(key);
  } catch {
    /* ignore */
  }
}

const draftKey = (id: string) => `herdrer.draft.${id}`;
const PARKED_KEY = "herdrer.parked";
const scrollKey = (id: string) => `herdrer.scroll.${id}`;
const flagKey = (name: string) => `herdrer.flag.${name}`;

export const drafts = {
  read: (id: string) => safeGet(globalThis.localStorage, draftKey(id)) ?? "",
  write: (id: string, note: string) => {
    if (note.trim() === "") safeRemove(globalThis.localStorage, draftKey(id));
    else safeSet(globalThis.localStorage, draftKey(id), note);
  },
  clear: (id: string) => safeRemove(globalThis.localStorage, draftKey(id)),
};

/**
 * Scroll positions.
 *
 * `write` is the immediate form. `remember` is the one a scroll handler wants:
 * `setItem` is synchronous, iOS momentum scrolling fires ~60 events a second,
 * and only the last value of a burst matters — so the pending write is
 * coalesced into one animation frame. `flush` writes it out now, for unmount
 * and for `pagehide`, where there may be no next frame.
 */
let pendingScroll: { key: string; y: number } | null = null;
let scrollFrame = 0;

export const scrollMemory = {
  read: (id: string): number => {
    const v = safeGet(globalThis.sessionStorage, scrollKey(id));
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : 0;
  },
  write: (id: string, y: number) => safeSet(globalThis.sessionStorage, scrollKey(id), String(y)),
  remember: (id: string, y: number) => {
    pendingScroll = { key: scrollKey(id), y };
    if (scrollFrame !== 0) return;
    const schedule = globalThis.requestAnimationFrame;
    if (typeof schedule !== "function") {
      scrollMemory.flush();
      return;
    }
    scrollFrame = schedule(() => {
      scrollFrame = 0;
      scrollMemory.flush();
    });
  },
  flush: () => {
    const p = pendingScroll;
    pendingScroll = null;
    if (p) safeSet(globalThis.sessionStorage, p.key, String(p.y));
  },
};

/**
 * Items put down without answering.
 *
 * This used to be React state in the queue provider, which made "Later" mean
 * "hide this until the next reload" — and iOS reaps a backgrounded web app
 * without warning, so the next reload is rarely far away. A defer the app
 * forgets is a defer that lied. localStorage, keyed by id, is the honest
 * version; the agent is told nothing either way, which is exactly what
 * parking means.
 */
export const parked = {
  read: (): string[] => {
    const raw = safeGet(globalThis.localStorage, PARKED_KEY);
    if (raw === null) return [];
    try {
      const v: unknown = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  },
  write: (ids: readonly string[]) => {
    // Unbounded growth is a real risk here: ids are never revisited once the
    // item leaves the queue, so keep only the most recent few hundred.
    const keep = ids.slice(-200);
    safeSet(globalThis.localStorage, PARKED_KEY, JSON.stringify(keep));
  },
};

/** One-shot UI flags: the install nudge, the "wrap diffs" preference, etc. */
export const flags = {
  read: (name: string): string | null => safeGet(globalThis.localStorage, flagKey(name)),
  write: (name: string, value: string) => safeSet(globalThis.localStorage, flagKey(name), value),
  clear: (name: string) => safeRemove(globalThis.localStorage, flagKey(name)),
};
