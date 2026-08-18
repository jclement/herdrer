import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ApiError } from "./lib/api";
import { installStepUp } from "./lib/stepup";
import { qk } from "./lib/queries";
import { registerServiceWorker } from "./lib/pwa";
import { ToastHost } from "./components/toast";
import { router } from "./router";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A phone on a train reconnects constantly; refetching on focus is what
      // makes the screen correct within one round trip after six hours asleep.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 5_000,
      retry: (count, err) => !(err instanceof ApiError && err.isAuth) && count < 2,
    },
    mutations: { retry: false },
  },
});

// Privileged calls answer 403 STEP_UP_REQUIRED until the session has asserted a
// passkey recently. One registration here and every one of them recovers by
// prompting and retrying, instead of each caller inventing its own dead end.
installStepUp(() => {
  void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
});

const root = document.getElementById("root");
if (!root) throw new Error("no #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastHost>
        <RouterProvider router={router} />
      </ToastHost>
    </QueryClientProvider>
  </StrictMode>,
);

void registerServiceWorker();

// The service worker relays notification taps, because iOS routinely drops the
// deep link and opens start_url instead.
navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as { type?: string; url?: string } | null;
  if (!data || data.type !== "herdrer:navigate") return;
  if (typeof data.url !== "string" || !data.url.startsWith("/")) return;
  router.history.push(data.url);
});
