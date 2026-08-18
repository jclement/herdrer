import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Bot,
  ChevronLeft,
  Inbox,
  Monitor,
  Moon,
  Settings,
  Sun,
  TerminalSquare,
} from "lucide-react";
import { useTheme } from "../lib/theme";
import { taglineForDate } from "../lib/taglines";
import { cx } from "./ui";

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;

export function Header({
  title,
  back,
  right,
}: {
  title?: ReactNode;
  back?: { to: string; label: string };
  right?: ReactNode;
}) {
  return (
    <header
      className="sticky top-0 z-30 bg-chrome text-chrome-fg"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div className="flex h-10 items-center gap-2 px-2">
        {back ? (
          // Standalone web apps have no browser back button; every leaf carries its own.
          <Link
            to={back.to}
            className="-ml-1 flex h-9 w-9 items-center justify-center rounded hover:bg-white/10"
            aria-label={back.label}
          >
            <ChevronLeft className="w-4 h-4" />
          </Link>
        ) : (
          <Link to="/" className="px-1 text-sm font-semibold tracking-tight">
            herdrer
          </Link>
        )}

        <div className="min-w-0 flex-1 truncate text-sm font-medium">{title}</div>

        <HeaderNav />

        {right}

        <ThemeToggle />
      </div>
    </header>
  );
}

/**
 * The top menu — the desktop's navigation, where the phone has a bottom bar.
 *
 * Exported because the terminal route builds its own header rather than using
 * the one above (it owns the whole viewport and cannot afford a sticky element
 * it did not size), and two copies of the app's navigation is how the two
 * copies end up listing different things.
 */
export function HeaderNav({ className }: { className?: string }) {
  return (
    <nav className={cx("hidden items-center gap-1 lg:flex", className)}>
      <HeaderTab to="/" label="Terminal" exact />
      <HeaderTab to="/agents" label="Agents" />
      <HeaderTab to="/inbox" label="Inbox" />
      <HeaderTab to="/settings" label="Settings" />
    </nav>
  );
}

/** System → Light → Dark → System, in the dark header, in both themes. */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, cycle } = useTheme();
  const ThemeIcon = THEME_ICON[theme];
  return (
    <button
      onClick={cycle}
      aria-label={`Theme: ${theme}. Click to change.`}
      title={`Theme: ${theme}`}
      className={cx(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded text-chrome-muted",
        "hover:bg-white/10 hover:text-chrome-fg",
        className,
      )}
    >
      <ThemeIcon className="w-4 h-4" />
    </button>
  );
}

function HeaderTab({ to, label, exact }: { to: string; label: string; exact?: boolean }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: !!exact }}
      className="rounded px-2 py-1 text-xs text-chrome-muted hover:bg-white/10 hover:text-chrome-fg"
      activeProps={{ className: "bg-white/10 text-chrome-fg" }}
    >
      {label}
    </Link>
  );
}

/**
 * Four destinations, and the first one is herdr itself.
 *
 * `embedded` drops the fixed positioning so the terminal route can put the nav
 * inside its own flex column: that route owns the whole viewport and computes
 * the PTY's height from what is left, so a `position: fixed` bar would sit on
 * top of the bottom two rows of the shell rather than beside them.
 */
export function BottomNav({
  reviewBadge,
  agentBadge,
  warnMore,
  embedded,
}: {
  reviewBadge: number;
  agentBadge: number;
  warnMore?: boolean;
  embedded?: boolean;
}) {
  return (
    <nav
      className={cx(
        "border-t border-border bg-surface-2",
        embedded ? "shrink-0" : "fixed inset-x-0 bottom-0 z-30 lg:hidden",
      )}
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="grid grid-cols-4">
        <NavTab to="/" exact icon={<TerminalSquare className="w-4 h-4" />} label="Terminal" />
        <NavTab to="/agents" icon={<Bot className="w-4 h-4" />} label="Agents" badge={agentBadge} />
        <NavTab
          to="/inbox"
          icon={<Inbox className="w-4 h-4" />}
          label="Inbox"
          badge={reviewBadge}
        />
        <NavTab
          to="/settings"
          icon={<Settings className="w-4 h-4" />}
          label="More"
          dot={warnMore}
        />
      </div>
    </nav>
  );
}

function NavTab({
  to,
  icon,
  label,
  badge,
  dot,
  exact,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  badge?: number;
  dot?: boolean;
  exact?: boolean;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: !!exact }}
      className="relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] text-muted"
      activeProps={{ className: "text-accent" }}
    >
      <span className="relative">
        {icon}
        {badge !== undefined && badge > 0 && (
          <span className="absolute -right-2.5 -top-2 min-w-4 rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
        {dot && <span className="absolute -right-1.5 -top-1 h-2 w-2 rounded-full bg-warn" />}
      </span>
      {label}
    </Link>
  );
}

export function Footer({ version, host }: { version?: string; host?: string }) {
  const year = new Date().getFullYear();
  return (
    <footer className="px-3 py-4 text-center text-xs text-muted">
      <div>{taglineForDate()}</div>
      <div className="mt-1">
        (C) {year} Jeff Clement, {version ? `v${version}` : "DEV"}
        {host ? ` · ${host}` : ""}
      </div>
    </footer>
  );
}

/** Page body with room for the fixed bottom nav and the home indicator. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main
      className={cx(
        "mx-auto w-full max-w-3xl px-0 lg:px-4",
        // Room for the fixed bottom nav — which only exists below `lg`.
        "pb-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] lg:pb-6",
        className,
      )}
    >
      {children}
    </main>
  );
}
