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

export const scrollMemory = {
  read: (id: string): number => {
    const v = safeGet(globalThis.sessionStorage, scrollKey(id));
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : 0;
  },
  write: (id: string, y: number) => safeSet(globalThis.sessionStorage, scrollKey(id), String(y)),
};

/** One-shot UI flags: the install nudge, the "wrap diffs" preference, etc. */
export const flags = {
  read: (name: string): string | null => safeGet(globalThis.localStorage, flagKey(name)),
  write: (name: string, value: string) => safeSet(globalThis.localStorage, flagKey(name), value),
  clear: (name: string) => safeRemove(globalThis.localStorage, flagKey(name)),
};
