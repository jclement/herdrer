/** Time and text formatting. Short forms — a phone row has ~6 characters for age. */

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "4m", "3h", "2d". Seconds are noise on an inbox row. */
export function shortDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < MIN) return `${s}s`;
  if (s < HOUR) return `${Math.floor(s / MIN)}m`;
  if (s < DAY) return `${Math.floor(s / HOUR)}h`;
  return `${Math.floor(s / DAY)}d`;
}

export function ageSeconds(iso: string | null | undefined, now = Date.now()): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return (now - t) / 1000;
}

/** "waiting 3h" style age from an RFC3339 timestamp. */
export function shortAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  return shortDuration(ageSeconds(iso, now));
}

/** Negative means it already expired. */
export function secondsUntil(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (t - now) / 1000;
}

export function expiringSoon(iso: string | null | undefined, now = Date.now()): boolean {
  const s = secondsUntil(iso, now);
  return s !== null && s > 0 && s <= HOUR;
}

export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** First non-empty, non-heading line of a markdown body — the inbox preview. */
export function markdownPreview(md: string | undefined | null, max = 120): string {
  if (!md) return "";
  let inFence = false;
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line === "" || line.startsWith("#") || line.startsWith("---") || line.startsWith(">")) {
      continue;
    }
    return truncate(line.replace(/[*_`]/g, ""), max);
  }
  return "";
}
