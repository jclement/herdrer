/**
 * herdrer service worker.
 *
 * Three rules, and the third is the one that matters:
 *   1. Cache-first for the shell, so the app is visibly itself in well under a
 *      second on a train with no signal.
 *   2. Network-first with a short timeout for review data, falling back to the
 *      last copy — reading a review on the Underground is a real use.
 *   3. NEVER queue a mutation. An answer that lands forty minutes later, against
 *      an item whose world has moved, is a hazard dressed as a feature. Offline
 *      answering fails loudly and keeps the draft.
 */
const VERSION = "v1";
const SHELL = `herdrer-shell-${VERSION}`;
const DATA = `herdrer-data-${VERSION}`;
const SHELL_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icons/favicon.svg",
  "/icons/icon-192.png",
  "/icons/apple-touch-icon.png",
];
const DATA_TIMEOUT_MS = 2000;

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
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))),
      )
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

function isCacheableData(url) {
  return (
    url.pathname === "/api/v1/bootstrap" ||
    url.pathname === "/api/v1/review" ||
    url.pathname.startsWith("/api/v1/review/")
  );
}

async function networkFirst(request) {
  const cache = await caches.open(DATA);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DATA_TIMEOUT_MS);
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
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
  // The sandboxed review document must never be served from a shared cache.
  if (url.pathname.endsWith("/render")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/", { cacheName: SHELL })));
    return;
  }

  if (isShellAsset(url)) {
    event.respondWith(cacheFirst(request, SHELL));
    return;
  }

  if (isCacheableData(url)) {
    event.respondWith(networkFirst(request));
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
