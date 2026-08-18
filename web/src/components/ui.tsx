import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "default" | "ghost" | "danger";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium " +
  "transition-colors disabled:opacity-50 disabled:pointer-events-none select-none";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  default: "border border-border bg-surface-2 text-heading hover:bg-hover",
  ghost: "text-body hover:bg-hover",
  danger: "border border-danger text-danger hover:bg-danger hover:text-white",
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

export function Chip({
  children,
  tone = "default",
  className,
  title,
}: {
  children: ReactNode;
  tone?: "default" | "ok" | "warn" | "danger" | "info";
  className?: string;
  title?: string;
}) {
  const tones: Record<string, string> = {
    default: "border-border text-muted",
    ok: "border-ok/40 text-ok",
    warn: "border-warn/40 text-warn",
    danger: "border-danger/40 text-danger",
    info: "border-info/40 text-info",
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
    <Chip tone={tone as "default" | "ok" | "warn" | "danger"}>
      <span className={cx("w-1.5 h-1.5 rounded-full", dot[tone])} aria-hidden />
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

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="px-3 py-3">
          <div className="h-3 w-2/3 rounded bg-hover" />
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
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <div className="text-sm font-medium text-heading">{title}</div>
      {message && <div className="max-w-xs text-xs text-muted">{message}</div>}
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
    <div className="m-3 rounded border border-danger/40 bg-danger/5 px-3 py-3">
      <div className="text-sm font-medium text-danger">{title}</div>
      <div className="mt-1 text-xs text-body">{message}</div>
      {onRetry && (
        <Button size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function SectionHeader({
  title,
  right,
  className,
}: {
  title: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex items-center justify-between gap-2 border-b border-border bg-surface-2 px-3 py-1.5",
        className,
      )}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</div>
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
  "w-full rounded border border-border bg-surface px-2 py-2 text-sm text-heading " +
  "placeholder:text-muted focus:border-accent";
