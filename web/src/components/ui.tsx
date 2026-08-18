import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "default" | "ghost" | "danger";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium " +
  "transition-[background-color,border-color,color,box-shadow] duration-150 " +
  "disabled:opacity-50 disabled:pointer-events-none select-none active:scale-[0.98]";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg shadow-sm hover:brightness-110 active:brightness-95",
  default: "border border-border bg-surface-2 text-heading hover:bg-hover hover:border-muted/50",
  ghost: "text-body hover:bg-hover",
  // The fill is the token pair, never a bare white: in dark mode the danger hue
  // is a light red, and white on it lands around 2.5:1.
  danger: "border border-danger/60 text-danger hover:bg-danger hover:text-danger-fg",
};

export function Button({
  variant = "default",
  size = "md",
  loading = false,
  className,
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  // 44px tap targets on anything a thumb reaches for; `sm` is desktop-only chrome.
  const sizing =
    size === "sm" ? "h-8 px-2 text-xs" : size === "lg" ? "h-11 px-4" : "h-9 px-3 min-h-9";
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(BUTTON_BASE, BUTTON_VARIANT[variant], sizing, className)}
    >
      {loading && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

/**
 * A chip is a fact, not a button.
 *
 * Tinted ground plus a matching border rather than an outline alone: a hairline
 * outline vanishes in a row of six chips under a thumb, and the tint is what
 * lets `blocking` be seen without reading it. Every value here comes from the
 * `-weak` token pair, so the tint is a tint in both themes rather than a pale
 * wash that turns into a grey box at night.
 */
export function Chip({
  children,
  tone = "default",
  className,
  title,
}: {
  children: ReactNode;
  tone?: "default" | "ok" | "warn" | "danger" | "info" | "accent";
  className?: string;
  title?: string;
}) {
  const tones: Record<string, string> = {
    default: "border-border bg-surface-2 text-muted",
    ok: "border-ok/30 bg-ok-weak text-ok",
    warn: "border-warn/30 bg-warn-weak text-warn",
    danger: "border-danger/30 bg-danger-weak text-danger",
    info: "border-info/30 bg-info-weak text-info",
    accent: "border-accent/30 bg-accent-weak text-accent",
  };
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] leading-4",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const s = status.toLowerCase();
  const tone =
    s === "blocked" || s === "error" || s === "failed"
      ? "danger"
      : s === "working" || s === "running" || s === "busy"
        ? "ok"
        : s === "idle" || s === "waiting"
          ? "warn"
          : "default";
  const dot: Record<string, string> = {
    danger: "bg-danger",
    ok: "bg-ok",
    warn: "bg-warn",
    default: "bg-muted",
  };
  return (
    <Chip tone={tone as "default" | "ok" | "warn" | "danger"} className="font-medium">
      <span
        className={cx(
          "w-1.5 h-1.5 rounded-full",
          dot[tone],
          // Only the one that means "someone is waiting on you" moves.
          tone === "danger" && "breathe",
        )}
        aria-hidden
      />
      {status}
    </Chip>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-4 text-xs text-muted">
      <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

/**
 * Loading rows shaped like the rows they stand in for.
 *
 * They breathe rather than sit still, because a static grey bar on a phone with
 * one bar of signal is indistinguishable from a screen that has given up. The
 * widths vary per row for the same reason a real list does.
 */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  const widths = ["w-2/3", "w-1/2", "w-4/5", "w-3/5", "w-3/4"];
  return (
    <div className="divide-y divide-border" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="breathe px-3 py-3" style={{ animationDelay: `${i * 90}ms` }}>
          <div className={cx("h-3 rounded bg-hover", widths[i % widths.length])} />
          <div className="mt-2 h-2.5 w-1/3 rounded bg-hover" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon?: ReactNode;
  title: string;
  message?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="fade flex flex-col items-center gap-2 px-6 py-12 text-center">
      {icon && (
        // The icon gets a ground so an empty screen reads as a designed state
        // rather than as a page that failed to finish loading.
        <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-surface-2 text-muted">
          {icon}
        </div>
      )}
      <div className="text-sm font-medium text-heading">{title}</div>
      {message && <div className="max-w-xs text-xs leading-relaxed text-muted">{message}</div>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = "That didn't work",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="m-3 rounded-md border border-danger/40 bg-danger-weak px-3 py-3">
      <div className="text-sm font-medium text-danger">{title}</div>
      <div className="mt-1 text-xs break-words text-body">{message}</div>
      {onRetry && (
        <Button size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/**
 * The rule that separates one section from the next.
 *
 * `sticky` is opt-in rather than the default: it is right on a long scrolling
 * list, where knowing which band you are in matters more than the two rows it
 * covers, and wrong inside a sheet whose own header is already doing that job.
 * The offset accounts for the app header *and* the notch, because on a phone
 * the two are one thing.
 */
export function SectionHeader({
  title,
  right,
  className,
  sticky,
}: {
  title: ReactNode;
  right?: ReactNode;
  className?: string;
  sticky?: boolean;
}) {
  return (
    <div
      className={cx(
        "flex items-center justify-between gap-2 border-b border-border bg-surface-2 px-3 py-1.5",
        sticky && "sticky z-20",
        className,
      )}
      style={sticky ? { top: "calc(env(safe-area-inset-top, 0px) + 2.5rem)" } : undefined}
    >
      <div className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-muted">
        {title}
      </div>
      {right}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-heading">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-border bg-surface px-2 py-2 text-sm text-heading " +
  "placeholder:text-muted transition-colors focus:border-accent";
