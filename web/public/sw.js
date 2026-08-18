/**
 * herdrer service worker.
 *
 * Three rules:
 *   1. Cache-first for the shell, so the app is visibly itself in well under a
 *      second on a train with no signal. The shell is static assets and holds
 *      no data.
 *   2. NEVER cache an API response. See below.
 *   3. NEVER queue a mutation. An answer that lands forty minutes later,
 *      against an item whose world has moved, is a hazard dressed as a feature.
 *      Offline answering fails loudly and keeps the draft.
 *
 * On rule 2 — this worker used to cache /api/v1/review and /api/v1/bootstrap
 * network-first with a 2s timeout, falling back to the last copy so a review
 * could be read underground. That was a data leak, and it was observed in the
 * wild: the cached copy was served on timeout *and after logout*, because a
 * Cache Storage entry carries no notion of who it was fetched for. A phone that
 * had once been logged in would render a sidebar of open review titles to
 * whoever picked it up next, with no session and no request to the server.
 *
 * There is no version of response caching that fixes this, because the check
 * that matters lives on the server and a cache hit never reaches it. Reading
 * offline was worth little anyway — rule 3 means you could not answer, and
 * herdrer's entire job is answering. So: the shell is cached, and nothing else.
 */
const VERSION = "v2";
const SHELL = `herdrer-shell-${VERSION}`;
const SHELL_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icons/favicon.svg",
  "/icons/icon-192.png",
  "/icons/apple-touch-icon.png",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      // Deletes herdrer-data-v1 wherever it still exists. The version bump is
      // what makes an already-installed worker drop the data it should never
      // have kept, without the human having to clear site data by hand.
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isShellAsset(url) {
  return (
    url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest"
  );
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Mutations and sockets go straight to the network, always.
  if (request.method !== "GET") return;
  if (url.pathname.startsWith("/ws/")) return;
  // Every API response goes to the network, every time. A Cache Storage entry
  // has no idea who it was fetched for, so serving one is answering an
  // authorisation question that only the server can answer.
  if (url.pathname.startsWith("/api/")) return;
  // The sandboxed review document is API-shaped but not under /api/; it is
  // per-item, agent-authored and authenticated, and must never be replayed.
  if (url.pathname.endsWith("/render")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/", { cacheName: SHELL })));
    return;
  }

  if (isShellAsset(url)) {
    event.respondWith(cacheFirst(request, SHELL));
  }
});

/**
 * Purge everything on demand.
 *
 * The app posts this on logout. The version bump already drops the old data
 * cache on activation, but activation is lazy — an installed worker may keep
 * serving for the rest of the session — and "I logged out" is precisely the
 * moment a human expects their data to stop being on the device.
 */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "herdrer:purge") {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});

/**
 * Every push must produce a visible notification: iOS treats a push that does
 * not call showNotification as silent and revokes the subscription after a few
 * of them. So there is no data-only path here, deliberately.
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "herdrer", body: event.data ? event.data.text() : "Something is waiting." };
  }
  const title = payload.title || "herdrer";
  const options = {
    body: payload.body || "Something is waiting on you.",
    tag: payload.tag || payload.id || "herdrer",
    data: { url: payload.navigate || payload.url || "/" },
    badge: "/icons/icon-192.png",
    icon: "/icons/icon-192.png",
  };
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      if (typeof payload.app_badge === "number" && self.navigator.setAppBadge) {
        await self.navigator.setAppBadge(payload.app_badge);
      }
    })(),
  );
});

/**
 * notificationclick deep-linking is unreliable on iOS — the app often lands on
 * start_url instead of the target. Belt and braces: focus an existing client and
 * tell it where to go, and only then fall back to openWindow.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        if ("focus" in client) {
          await client.focus();
          client.postMessage({ type: "herdrer:navigate", url: target, at: Date.now() });
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
