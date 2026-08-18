import { Hourglass } from "lucide-react";
import { absoluteTime, secondsUntil, shortAge, shortDuration } from "../../lib/format";
import { cx } from "../../components/ui";

/** Under an hour, the deadline stops being background and starts being the point. */
const URGENT_SECONDS = 3600;

/**
 * How old it is, and how long is left.
 *
 * These two facts decide *answer now versus put it down*, and they were the two
 * the phone never showed: both lived at the end of a horizontal chip scroller
 * whose scrollbar was suppressed, so on a 375px screen `23h left` was simply
 * off the right edge of every item. They are one field now, rendered outside
 * any scroller, on every surface that lists or shows an item — the detail head,
 * the inbox row, and the desktop rail — so the same item reads the same way
 * wherever you meet it.
 *
 * A missing `expires_at` says so rather than rendering nothing: "no deadline"
 * is a materially different situation from "the deadline is off screen", and
 * the whole reason this component exists is that the reader could not tell
 * those apart.
 */
export function Timing({
  createdAt,
  expiresAt,
  now,
  className,
}: {
  createdAt: string | null | undefined;
  expiresAt?: string | null;
  now?: number;
  className?: string;
}) {
  const at = now ?? Date.now();
  const left = secondsUntil(expiresAt, at);
  const urgent = left !== null && left > 0 && left <= URGENT_SECONDS;

  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap font-mono text-[11px] tabular-nums",
        className,
      )}
    >
      <span className="text-muted" title={absoluteTime(createdAt)}>
        {shortAge(createdAt, at)} old
      </span>
      {left !== null && (
        <>
          <span className="text-muted" aria-hidden>
            ·
          </span>
          <span
            className={cx("inline-flex items-center gap-0.5", urgent ? "text-warn" : "text-muted")}
            title={absoluteTime(expiresAt)}
          >
            <Hourglass className="w-3 h-3" aria-hidden />
            {left > 0 ? `${shortDuration(left)} left` : "expired"}
          </span>
        </>
      )}
    </span>
  );
}
