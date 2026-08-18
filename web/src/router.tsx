import { useEffect } from "react";
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
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
import { AgentsPage } from "./features/agents/AgentsPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { NotFound, RouteError } from "./features/misc/Pages";

function titleFor(path: string): string | undefined {
  if (path === "/") return undefined;
  if (path.startsWith("/r/")) return "Review";
  if (path === "/agents") return "Agents";
  if (path === "/settings") return "Settings";
  return undefined;
}

function backFor(path: string): { to: string; label: string } | undefined {
  if (path.startsWith("/r/")) return { to: "/", label: "Back to the inbox" };
  if (path.startsWith("/agents/")) return { to: "/agents", label: "Back to agents" };
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

  // The terminal owns the whole screen: no header, no nav, no page scroll.
  if (path.endsWith("/term")) {
    return signedIn ? <Outlet /> : <Login />;
  }

  if (authFailed) return <Login />;
  if (boot.isPending) {
    return (
      <div className="flex min-h-full flex-col">
        <Header />
        <Spinner label="Waking up…" />
      </div>
    );
  }

  // A review item is a leaf: its sticky action bar owns the bottom of the screen,
  // so the nav would sit under it.
  const leaf = path.startsWith("/r/");

  return (
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
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: ({ error }) => <RouteError error={error} />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
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

const terminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/$name/term",
  // xterm is the biggest thing in the bundle and most sessions never open it,
  // so the terminal route is fetched on demand.
  component: lazyRouteComponent(() => import("./features/agents/TerminalPage"), "TerminalPage"),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  itemRoute,
  agentsRoute,
  terminalRoute,
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
