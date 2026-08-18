/**
 * The one place that knows the envelope: `{data}` on success,
 * `{error:{message,code}}` on failure. Everything else in the app deals in
 * plain values and ApiError.
 */

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "STEP_UP_REQUIRED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "NETWORK"
  | "MALFORMED";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(message: string, code: ApiErrorCode, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }

  get isAuth(): boolean {
    return this.code === "UNAUTHORIZED" || this.status === 401;
  }

  /**
   * Recoverable, unlike FORBIDDEN. The session is real; it just has not proved
   * a passkey recently enough for whatever it asked to do. Prompt, assert,
   * retry — never a dead end.
   */
  get isStepUp(): boolean {
    return this.code === "STEP_UP_REQUIRED";
  }

  /** Offline and "the box is not answering" are the same story to the user. */
  get isOffline(): boolean {
    return this.code === "NETWORK";
  }
}

interface Envelope<T> {
  data?: T;
  error?: { message?: string; code?: string };
}

const JSON_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

export interface RequestOptions {
  /**
   * Whether a `STEP_UP_REQUIRED` answer should trigger the passkey ceremony and
   * one retry. Default true. Set false by the ceremony's own calls (they would
   * recurse) and by callers that want to explain the friction first — an
   * unannounced biometric prompt reads as a bug, and on Safari a prompt raised
   * outside a user gesture is refused anyway.
   */
  stepUp?: boolean;
}

/**
 * Runs the step-up ceremony. Resolves when the session is stepped up; rejects
 * if the human declined or the ceremony failed.
 *
 * Registered by lib/stepup.ts rather than imported, so this module keeps no
 * dependency on WebAuthn and stays trivially testable.
 */
export type StepUpHandler = () => Promise<unknown>;

let stepUpHandler: StepUpHandler | null = null;

/** Installs (or with null, removes) the ceremony the client runs on a 403. */
export function setStepUpHandler(handler: StepUpHandler | null): void {
  stepUpHandler = handler;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
  retrying = false,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { Accept: "application/json" } : JSON_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Can't reach the box.", "NETWORK", 0);
  }

  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }

  const text = await res.text();
  let parsed: Envelope<T> | null = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as Envelope<T>;
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const code = (parsed?.error?.code as ApiErrorCode | undefined) ?? fallbackCode(res.status);
    const message = parsed?.error?.message ?? `${res.status} ${res.statusText}`;
    const err = new ApiError(message, code, res.status);

    // Step up and try again — exactly once. `retrying` is what bounds it: the
    // second attempt cannot ask for a third, so a server that keeps answering
    // STEP_UP_REQUIRED costs two requests and one prompt, not a loop.
    if (err.isStepUp && !retrying && options.stepUp !== false && stepUpHandler) {
      try {
        await stepUpHandler();
      } catch {
        // The human cancelled, or the assertion failed. The original error is
        // the more useful one: it tells the caller a passkey check is what is
        // missing, which is exactly the screen to show next.
        throw err;
      }
      return request<T>(method, path, body, options, true);
    }
    throw err;
  }

  if (parsed === null) {
    if (text.trim() === "") return undefined as T;
    throw new ApiError("The server sent something that isn't JSON.", "MALFORMED", res.status);
  }
  // A 200 with no `data` key is legal for empty responses; hand back undefined
  // rather than pretending it failed.
  return parsed.data as T;
}

function fallbackCode(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return "VALIDATION_ERROR";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    default:
      return "INTERNAL_ERROR";
  }
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>("GET", path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>("POST", path, body ?? {}, options),
  del: <T>(path: string, options?: RequestOptions) =>
    request<T>("DELETE", path, undefined, options),
};

/** Absolute ws:// or wss:// URL for a same-origin socket path. */
export function wsURL(path: string, params: Record<string, string | number>): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return url.toString();
}

/** Human wording for a failure, used by every error surface in the app. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.isOffline) return "Can't reach the box — you may be offline.";
    if (err.isAuth) return "Your session expired. Sign in again.";
    if (err.isStepUp) return "That needs a fresh passkey check.";
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
