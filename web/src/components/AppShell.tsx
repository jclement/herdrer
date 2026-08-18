import type { ReactNode, Ref } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
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
import { useIsDesktop } from "../lib/layout";
import { taglineForDate } from "../lib/taglines";
import { cx } from "./ui";

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;

/**
 * The terminal's own URL — the one that means the terminal at any width.
 *
 * `/` cannot be that URL, because `/` is *home* and home is not the same screen
 * at both widths: the terminal on a desktop, where the queue is already a rail
 * down the right, and the inbox on a phone, where the queue is the product. A
 * tab in the phone's bottom bar still needs somewhere to point, and a desktop
 * window dragged narrow has to keep showing the screen it was showing, so the
 * terminal gets a name of its own. `/` renders it as well, when the window is
 * wide (see `isTerminalPath`).
 */
export const TERMINAL_PATH = "/terminal";

/**
 * Is this route the terminal — the one screen that owns the whole viewport?
 *
 * The breakpoint is an argument rather than a hook call because both callers
 * (the shell, to decide whether to draw any chrome at all, and the review
 * queue, to decide whether an arriving question may interrupt) already know it,
 * and two independent reads of the same media query is how the two halves of a
 * layout end up disagreeing at one window width.
 */
export function isTerminalPath(pathname: string, desktop: boolean): boolean {
  return pathname === TERMINAL_PATH || (desktop && pathname === "/");
}

/**
 * What the shared header says on a given route, at a given width.
 *
 * A desktop gets neither a title nor a back chevron, and both omissions are the
 * same reason: the navigation is sitting right there, permanently, with the
 * current route lit up. A left-hand "Inbox" beside a lit "Inbox" tab was the
 * word twice, and a chevron in front of the nav would push the nav sideways on
 * exactly the routes that have one — which is the bug this whole change is
 * about. A phone has no persistent nav to read either answer off, so it keeps
 * both.
 *
 * This lives here rather than in the router because it is header content, and
 * because a test can then drive every route's header without standing up a
 * router. `/` reaches this only on a phone — a desktop `/` is the terminal.
 */
export function headerFor(
  pathname: string,
  desktop: boolean,
): { title?: string; back?: { to: string; label: string } } {
  if (desktop) return {};
  if (pathname.startsWith("/r/")) {
    // Standalone web apps have no browser back button; every leaf carries one.
    return { title: "Review", back: { to: "/inbox", label: "Back to the inbox" } };
  }
  if (pathname === "/agents") return { title: "Agents" };
  if (pathname === "/settings") return { title: "Settings" };
  if (pathname === "/inbox" || pathname === "/") return { title: "Inbox" };
  return {};
}

/**
 * The one header. Every route, including the terminal.
 *
 * The order of the row is load-bearing: brand, navigation, title, per-screen
 * controls, theme. The navigation sits *beside the brand* and never anywhere
 * else, because the alternative was measured — the terminal route used to build
 * its own header with the nav at x=64 while every other route put it at x=1143,
 * and a menu that jumps 1,079px between screens is not a menu, it is a puzzle.
 *
 * `right` is the per-screen slot: the terminal's font size, image picker and
 * connection pill go there. A second header is not an option.
 */
export function Header({
  title,
  back,
  right,
  className,
  ref,
}: {
  title?: ReactNode;
  back?: { to: string; label: string };
  right?: ReactNode;
  className?: string;
  /** The terminal measures this element to size the PTY against the viewport. */
  ref?: Ref<HTMLElement>;
}) {
  const desktop = useIsDesktop();

  return (
    <header
      ref={ref}
      className={cx(
        "sticky top-0 z-30 shrink-0 border-b border-chrome-border bg-chrome text-chrome-fg",
        className,
      )}
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div className="flex h-10 items-center gap-2 px-2">
        {back ? (
          // `headerFor` only ever supplies this below `lg`; see the note there
          // on why a desktop leaf has no chevron.
          <Link
            to={back.to}
            className="-ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded transition-colors hover:bg-chrome-hover"
            aria-label={back.label}
          >
            <ChevronLeft className="w-4 h-4" />
          </Link>
        ) : (
          <Link to="/" className="shrink-0 px-1 text-sm font-semibold tracking-tight">
            herdrer
          </Link>
        )}

        {/* Rendered, not hidden. Below `lg` the bottom bar is the navigation,
            and two navigations in one document is how they drift apart. */}
        {desktop && <HeaderNav />}

        <div className="min-w-0 flex-1 truncate text-sm font-medium">{title}</div>

        {right}

        <ThemeToggle />
      </div>
    </header>
  );
}

/**
 * The desktop's navigation: three destinations, in one place, on every route.
 *
 * There is no Inbox tab. The queue is a rail down the right of the terminal,
 * permanently visible while you work, so a tab would be a second door to
 * something already on the screen. `/inbox` still resolves — for a typed URL,
 * an old link, or the rail's own footer — because the full history (answered,
 * expired, parked) is the one thing the rail does not carry.
 *
 * Active state is computed rather than delegated to `activeProps` because
 * "Terminal" answers to two URLs: `/terminal` always, and `/` when the window
 * is wide enough that home is the terminal.
 */
export function HeaderNav({ className }: { className?: string }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label="Primary" className={cx("flex shrink-0 items-center gap-1", className)}>
      <HeaderTab to="/" label="Terminal" active={path === "/" || path === TERMINAL_PATH} />
      <HeaderTab to="/agents" label="Agents" active={path === "/agents"} />
      <HeaderTab to="/settings" label="Settings" active={path === "/settings"} />
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
        "flex h-10 w-10 shrink-0 items-center justify-center rounded text-chrome-muted",
        "transition-colors hover:bg-chrome-hover hover:text-chrome-fg",
        className,
      )}
    >
      <ThemeIcon className="w-4 h-4" />
    </button>
  );
}

function HeaderTab({ to, label, active }: { to: string; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      data-active={active || undefined}
      className={cx(
        "rounded px-2 py-1.5 text-xs transition-colors hover:bg-chrome-hover hover:text-chrome-fg",
        active ? "bg-chrome-hover text-chrome-fg" : "text-chrome-muted",
      )}
    >
      {label}
    </Link>
  );
}

/**
 * The phone's navigation, and the inbox is first because the inbox is home.
 *
 * You open herdrer on a phone because something is waiting, not to type: the
 * queue is the product at that size. So `/` is the list, and the terminal is a
 * tab you go to — the reverse of the desktop, where the terminal is the page
 * and the queue is a rail beside it.
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
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav
      aria-label="Primary"
      className={cx(
        "border-t border-border bg-surface-2/95 backdrop-blur-sm",
        embedded ? "shrink-0" : "fixed inset-x-0 bottom-0 z-30",
      )}
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="grid grid-cols-4">
        <NavTab
          to="/"
          icon={<Inbox className="w-4 h-4" />}
          label="Inbox"
          badge={reviewBadge}
          // `/` is the inbox here and `/inbox` is the same list; a tab that
          // went dark depending on which of the two you arrived by would be
          // reporting on the URL rather than on where you are.
          active={path === "/" || path === "/inbox"}
        />
        <NavTab
          to={TERMINAL_PATH}
          icon={<TerminalSquare className="w-4 h-4" />}
          label="Terminal"
          active={path === TERMINAL_PATH}
        />
        <NavTab
          to="/agents"
          icon={<Bot className="w-4 h-4" />}
          label="Agents"
          badge={agentBadge}
          active={path === "/agents"}
        />
        {/* "Settings", not "More" — the desktop menu has always called it that
            and one product does not get two names for one screen. */}
        <NavTab
          to="/settings"
          icon={<Settings className="w-4 h-4" />}
          label="Settings"
          dot={warnMore}
          active={path === "/settings"}
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
  active,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  badge?: number;
  dot?: boolean;
  active: boolean;
}) {
  return (
    <Link
      to={to}
      data-active={active || undefined}
      className={cx(
        "relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px]",
        "transition-colors active:bg-hover",
        "before:absolute before:inset-x-3 before:top-0 before:h-0.5 before:rounded-b before:bg-transparent",
        active ? "text-accent before:bg-accent" : "text-muted",
      )}
    >
      <span className="relative">
        {icon}
        {badge !== undefined && badge > 0 && (
          <span className="absolute -right-2.5 -top-2 min-w-4 rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-danger-fg">
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
