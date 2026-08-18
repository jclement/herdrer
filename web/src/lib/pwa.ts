import { api } from "./api";

/**
 * iOS gives us no install prompt and no push outside a Home Screen web app, so
 * everything here is detection plus teaching. Nothing auto-prompts: permission
 * must be requested from a user gesture or the prompt is burned.
 */

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const legacy = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return window.matchMedia("(display-mode: standalone)").matches || legacy;
}

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return /iPad|iPhone|iPod/.test(ua) || iPadOS;
}

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

export type PermissionState = "default" | "granted" | "denied" | "unsupported";

export function notificationPermission(): PermissionState {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as PermissionState;
}

export interface PushHealth {
  standalone: boolean;
  supported: boolean;
  permission: PermissionState;
  endpoint: string | null;
}

export async function readPushHealth(): Promise<PushHealth> {
  const base: PushHealth = {
    standalone: isStandalone(),
    supported: pushSupported(),
    permission: notificationPermission(),
    endpoint: null,
  };
  if (!base.supported) return base;
  try {
    // `ready` rather than `getRegistration()`: on a reload the latter can
    // resolve before the worker has activated and hand back undefined, so the
    // page decides there is no subscription and offers to create one that
    // already exists. That is the "turn it on, refresh, it forgot" bug.
    //
    // Raced against a timeout because `ready` never rejects — if no worker ever
    // activates it simply hangs, and a settings page that never renders is
    // worse than one that reports the truth pessimistically.
    const reg = await withTimeout(navigator.serviceWorker.ready, 3000);
    const sub = await reg?.pushManager.getSubscription();
    base.endpoint = sub?.endpoint ?? null;
  } catch {
    /* a registration that is not there is not an error */
  }
  return base;
}

/** Resolves to null rather than hanging or throwing. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Must be called from a user gesture. Subscribes and registers the subscription
 * with the box; a failure here is reported, never swallowed.
 */
export async function enablePush(vapidPublicKey: string): Promise<PushHealth> {
  if (!pushSupported()) throw new Error("This browser has no Push API.");
  if (!isStandalone() && isIOS()) {
    throw new Error(
      "On iOS, add herdrer to the Home Screen first — push does not exist in Safari.",
    );
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted.");

  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
    }));

  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  await api.post("/api/v1/push/subscribe", {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
  });
  return readPushHealth();
}

export async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  if (import.meta.env.DEV) return; // the dev server has no /sw.js worth caching
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    /* the app works fine without it; it just isn't installable */
  }
}

/** The badge is one number: open items that need action. */
export async function setBadge(count: number): Promise<void> {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) await nav.setAppBadge?.(count);
    else await nav.clearAppBadge?.();
  } catch {
    /* not installed, or unsupported */
  }
}
