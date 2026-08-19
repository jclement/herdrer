import { Suspense, lazy, useEffect } from "react";
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
import { useIsDesktop } from "./lib/layout";
import { setBadge } from "./lib/pwa";
import {
  BottomNav,
  Footer,
  Header,
  Page,
  TERMINAL_PATH,
  headerFor,
  isTerminalPath,
} from "./components/AppShell";
import { Spinner } from "./components/ui";
import { Login } from "./features/auth/Login";
import { InboxPage } from "./features/review/InboxPage";
import { ItemPage } from "./features/review/ItemPage";
import { TasksPage } from "./features/tasks/TasksPage";
import { TaskPage } from "./features/tasks/TaskPage";
import { ReviewQueueProvider } from "./features/review/ReviewQueue";
import { NotFound, RouteError } from "./features/misc/Pages";

/**
 * The terminal, the agents board and settings are split out of the entry chunk.
 *
 * The product's primary entry path is a push notification tap landing on
 * `/r/$id`, and `TerminalPage` statically imports `@xterm/xterm`, its fit addon
 * and its stylesheet — the single biggest passenger in a 781 kB bundle, loaded
 * on a phone, over LTE, before the question can render. None of these three is
 * on that path. The review surfaces stay eagerly imported for the same reason:
 * a second round trip in front of the thing someone was paged about is worse
 * than the bytes. That holds all the more now that the inbox is what `/` shows
 * on a phone — the entry chunk *is* the first screen.
 */
const TerminalPage = lazy(() =>
  import("./features/agents/TerminalPage").then((m) => ({ default: m.TerminalPage })),
);
const AgentsPage = lazy(() =>
  import("./features/agents/AgentsPage").then((m) => ({ default: m.AgentsPage })),
);
const SettingsPage = lazy(() =>
  import("./features/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);

/** A chunk arriving is not an event worth a spinner unless it is slow. */
function Lazy({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<Spinner label="" />}>{children}</Suspense>;
}

/**
 * The information architecture.
 *
 *   /          home — and home is not the same screen at both widths.
 *   /terminal  herdr itself, live, in xterm, at any width.
 *   /agents    the herdr session tree — workspace, tab, pane, agent.
 *   /inbox     the review list in full: open, parked, answered, expired.
 *   /r/$id     one review as a page: what a push notification resolves to.
 *   /settings  passkeys, sessions, tokens, push, audit.
 *
 * On a desktop `/` is the terminal with the review rail down its right, which
 * is the strongest arrangement in the product: you watch three agents' questions
 * pile up *while* you type at a fourth. On a phone one screen holds one thing,
 * and the thing worth holding is the queue — you open herdrer because something
 * is waiting, not to type. So `/` is the inbox there, and the terminal is a tab.
 */

/**
 * Home, resolved by breakpoint rather than by redirect.
 *
 * A redirect would rewrite the URL out from under the human on a rotation or a
 * window drag — `/` becomes `/inbox`, and now the back button goes to `/`,
 * which redirects to `/inbox` again, and back is broken. It would also make a
 * bookmark or a shared link mean different things depending on the width of the
 * window that opened it. Rendering keeps one URL for "home" and lets the layout
 * decide what home is, which is the same trick the rest of the app already
 * plays with `useIsDesktop`.
 */
function HomeRoute() {
  const desktop = useIsDesktop();
  if (!desktop) return <InboxPage />;
  return (
    <Lazy>
      <TerminalPage />
    </Lazy>
  );
}

/**
 * `session` is a herdr session name; absent means the default session, which is
 * the one /agents renders. `pane` is only a note to the human about where they
 * came from — herdrer has no endpoint that focuses a pane, so it cannot be more
 * than that. Both routes that can render the terminal accept them.
 */
function terminalSearch(search: Record<string, unknown>): { session?: string; pane?: string } {
  return {
    ...(typeof search.session === "string" && search.session !== ""
      ? { session: search.session }
      : {}),
    ...(typeof search.pane === "string" && search.pane !== "" ? { pane: search.pane } : {}),
  };
}

function RootLayout() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const desktop = useIsDesktop();
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

  // The terminal owns the whole screen: no page scroll, no footer, and on a
  // phone no bottom bar either once you take control, because the bottom of
  // that screen belongs to the modifier bar. It still uses the shared header —
  // it just supplies the header's right-hand slot itself.
  if (isTerminalPath(path, desktop)) {
    return (
      <ReviewQueueProvider>
        <Outlet />
      </ReviewQueueProvider>
    );
  }

  // A review item is a leaf: its sticky action bar owns the bottom of the
  // screen, so the nav would sit under it.
  const leaf = path.startsWith("/r/");
  const { title, back } = headerFor(path, desktop);

  return (
    <ReviewQueueProvider>
      <div className="flex min-h-full flex-col">
        <Header title={title} back={back} />
        <Page className="flex-1">
          <Outlet />
        </Page>
        <Footer version={boot.data?.version} host={window.location.host} />
        {/* Rendered, not hidden by a class: on a desktop the header carries the
            only navigation there is. */}
        {!leaf && !desktop && (
          <BottomNav
            reviewBadge={counts?.review_open ?? 0}
            taskBadge={counts?.tasks_attention ?? 0}
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

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeRoute,
  validateSearch: terminalSearch,
});

const terminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: TERMINAL_PATH,
  component: () => (
    <Lazy>
      <TerminalPage />
    </Lazy>
  ),
  validateSearch: terminalSearch,
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: InboxPage,
});

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks",
  component: TasksPage,
});

const taskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/$id",
  component: TaskPage,
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
  component: () => (
    <Lazy>
      <AgentsPage />
    </Lazy>
  ),
});

/**
 * The terminal used to live here, one per agent, with the agent's name passed
 * as the herdr *session* name — which would have made herdr open a new empty
 * session named after the agent rather than showing it. Old links land on the
 * terminal's current home instead.
 */
const legacyTerminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/$name/term",
  beforeLoad: () => {
    throw redirect({ to: TERMINAL_PATH });
  },
  component: () => (
    <Lazy>
      <TerminalPage />
    </Lazy>
  ),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: () => (
    <Lazy>
      <SettingsPage />
    </Lazy>
  ),
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  terminalRoute,
  inboxRoute,
  tasksRoute,
  taskRoute,
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
