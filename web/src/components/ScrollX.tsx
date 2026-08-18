import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cx } from "./ui";

/**
 * A horizontal scroller that admits it is one.
 *
 * The app had thirteen `.scroll-x` sites and most of them also carried
 * `.no-scrollbar`, which removes the last affordance a phone has: no bar, no
 * fade, no chevron, no ellipsis. A strip that scrolls but looks clipped is
 * strictly worse than one that clips, because nobody tries to drag it — the
 * metadata chip row's expiry countdown was invisible on every phone for exactly
 * this reason, and the action bar's option strip was hiding the option the page
 * was arguing for.
 *
 * Most of those became `flex-wrap`, which is the better answer whenever the
 * content is chips or controls. This is for the few where wrapping is genuinely
 * wrong — the terminal's modifier key bar is twenty-two 44px keys, and three
 * rows of them would eat the terminal it exists to type into. It measures the
 * overflow and fades the edge that has more behind it, so the affordance is
 * present exactly when there is something to reach and absent when there is
 * not.
 *
 * `edge` names the colour the fade resolves to; it has to match whatever the
 * scroller is sitting on or the gradient reads as a smudge.
 */
export function ScrollX({
  children,
  className,
  edge = "var(--color-surface-2)",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  /** CSS colour of the ground behind the scroller. */
  edge?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children" | "className">) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    // One pixel of slack: sub-pixel layout rounding otherwise leaves a fade on
    // a strip that fits exactly.
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft < max - 1;
    setMore((p) => (p.start === start && p.end === end ? p : { start, end }));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [measure, children]);

  return (
    <div className="relative min-w-0">
      <div
        {...rest}
        ref={ref}
        onScroll={measure}
        className={cx("scroll-x no-scrollbar", className)}
      >
        {children}
      </div>
      <Fade side="left" show={more.start} edge={edge} />
      <Fade side="right" show={more.end} edge={edge} />
    </div>
  );
}

function Fade({ side, show, edge }: { side: "left" | "right"; show: boolean; edge: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        "pointer-events-none absolute inset-y-0 w-8 transition-opacity duration-150",
        side === "left" ? "left-0" : "right-0",
        show ? "opacity-100" : "opacity-0",
      )}
      style={{
        backgroundImage: `linear-gradient(to ${side === "left" ? "right" : "left"}, ${edge}, transparent)`,
      }}
    />
  );
}
