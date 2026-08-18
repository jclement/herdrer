import { useEffect } from "react";
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import { ApiError } from "./lib/api";
import { useBootstrap } from "./lib/queries";
import { useStream } from "./lib/stream";
import { setBadge } from "./lib/pwa";
import { BottomNav, Footer, Header, Page } from "./components/AppShell";
import { Spinner } from "./components/ui";
import { Login } from "./features/auth/Login";
import { InboxPage } from "./features/review/InboxPage";
import { ItemPage } from "./features/review/ItemPage";
import { ReviewQueueProvider } from "./features/review/ReviewQueue";
import { AgentsPage } from "./features/agents/AgentsPage";
import { TerminalPage } from "./features/agents/TerminalPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { NotFound, RouteError } from "./features/misc/Pages";

/**
 * The information architecture, inverted.
 *
 *   /          herdr itself, live, in xterm. The front page.
 *   /agents    the herdr session tree — workspace, tab, pane, agent.
 *   /inbox     the review list, for finding something you deferred.
 *   /r/$id     one review as a page: what a push notification or a link resolves to.
 *   /settings  passkeys, sessions, tokens, push, audit.
 *
 * Review used to be the root and the terminal was buried three segments deep.
 * It is the other way around now, and the list is a place you go looking rather
 * than a place you land: an item that needs you arrives as an overlay on top of
 * whatever you are doing (features/review/ReviewQueue.tsx).
 */

function titleFor(path: string): string | undefined {
  if (path.startsWith("/r/")) return "Review";
  if (path === "/agents") return "Agents";
  if (path === "/inbox") return "Inbox";
  if (path === "/settings") return "Settings";
  return undefined;
}

function backFor(path: string): { to: string; label: string } | undefined {
  if (path.startsWith("/r/")) return { to: "/inbox", label: "Back to the inbox" };
  return undefined;
}

function RootLayout() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const boot = useBootstrap();
  const authFailed = boot.error instanceof ApiError && boot.error.isAuth;
  const signedIn = !!boot.data && !authFailed;

  // The socket connects after first paint and never blocks rendering.
  useStream(signedIn);

  const counts = boot.data?.counts;
  useEffect(() => {
    void setBadge(counts?.review_open ?? 0);
  }, [counts?.review_open]);

  if (authFailed) return <Login />;
  if (boot.isPending) {
    return (
      <div className="flex min-h-full flex-col">
        <Header />
        <Spinner label="Waking up…" />
      </div>
    );
  }
  if (!signedIn) return <Login />;

  // The terminal owns the whole screen: no header, no footer, no page scroll.
  // It carries its own chrome, including the navigation, because the bottom of
  // that screen belongs to the modifier bar the moment you take control.
  if (path === "/") {
    return (
      <ReviewQueueProvider>
        <Outlet />
      </ReviewQueueProvider>
    );
  }

  // A review item is a leaf: its sticky action bar owns the bottom of the screen,
  // so the nav would sit under it.
  const leaf = path.startsWith("/r/");

  return (
    <ReviewQueueProvider>
      <div className="flex min-h-full flex-col">
        <Header title={titleFor(path)} back={backFor(path)} />
        <Page className="flex-1">
          <Outlet />
        </Page>
        <Footer version={boot.data?.version} host={window.location.host} />
        {!leaf && (
          <BottomNav
            reviewBadge={counts?.review_open ?? 0}
            agentBadge={counts?.agents_blocked ?? 0}
            warnMore={boot.data?.vapid_public_key === null}
          />
        )}
      </div>
    </ReviewQueueProvider>
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: ({ error }) => <RouteError error={error} />,
});

const terminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: TerminalPage,
  /**
   * `session` is a herdr session name; absent means the default session, which
   * is the one /agents renders. `pane` is only a note to the human about where
   * they came from — herdrer has no endpoint that focuses a pane, so it cannot
   * be more than that.
   */
  validateSearch: (search: Record<string, unknown>): { session?: string; pane?: string } => ({
    ...(typeof search.session === "string" && search.session !== ""
      ? { session: search.session }
      : {}),
    ...(typeof search.pane === "string" && search.pane !== "" ? { pane: search.pane } : {}),
  }),
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: InboxPage,
});

const itemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$id",
  component: ItemPage,
  // `?a=recommended` pre-selects the recommendation. It never sends.
  validateSearch: (search: Record<string, unknown>): { a?: string } =>
    typeof search.a === "string" ? { a: search.a } : {},
});

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  component: AgentsPage,
});

/**
 * The terminal used to live here, one per agent, with the agent's name passed
 * as the herdr *session* name — which would have made herdr open a new empty
 * session named after the agent rather than showing it. The terminal is the
 * root now and attaches to the shared session; old links land there.
 */
const legacyTerminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/$name/term",
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
  component: TerminalPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  terminalRoute,
  inboxRoute,
  itemRoute,
  agentsRoute,
  legacyTerminalRoute,
  settingsRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultNotFoundComponent: NotFound,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
