import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "./ui";

/**
 * A full-screen sheet on mobile, a centred panel from `sm:` up. Used for
 * secondary input (the note, defer, cancel) — never as the primary answer
 * surface, which has to be visible without being summoned.
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
  footer,
  className,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center sm:justify-center">
      <div
        className="fade absolute inset-0 bg-scrim"
        onClick={onClose}
        aria-hidden
        data-testid="sheet-scrim"
      />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          "rise relative flex max-h-[92vh] w-full flex-col border-t border-border bg-surface shadow-2xl",
          "rounded-t-xl sm:max-w-lg sm:rounded-xl sm:border",
          className,
        )}
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        {/* A drag handle is the only affordance a phone user looks for on a
            sheet, and it costs six pixels. */}
        <div className="flex shrink-0 justify-center pt-2 sm:hidden" aria-hidden>
          <span className="h-1 w-9 rounded-full bg-border" />
        </div>
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border pl-3 pr-1">
          <span className="min-w-0 truncate text-sm font-semibold text-heading">{title}</span>
          <button
            aria-label="Close"
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-heading"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="shrink-0 border-t border-border p-3">{footer}</div>}
      </div>
    </div>
  );
}
