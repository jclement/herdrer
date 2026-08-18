import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, setStepUpHandler } from "./api";
import { installStepUp, stepUp, stepUpSecondsLeft } from "./stepup";

const { startAuthentication } = vi.hoisted(() => ({
  startAuthentication: vi.fn(async () => ({ id: "cred_1", response: {} })),
}));
vi.mock("@simplewebauthn/browser", () => ({ startAuthentication }));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const stepUpRequired = () =>
  jsonResponse(403, {
    error: { code: "STEP_UP_REQUIRED", message: "opening a terminal needs a fresh passkey check" },
  });

/** Queues one response per call, so the order of attempts is what is asserted. */
function mockFetch(...responses: Response[]) {
  const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("fetch called more times than the test allowed");
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  startAuthentication.mockClear();
});

afterEach(() => {
  setStepUpHandler(null);
  vi.unstubAllGlobals();
});

describe("STEP_UP_REQUIRED recovery", () => {
  it("runs the ceremony once and retries the original request", async () => {
    const fetchMock = mockFetch(stepUpRequired(), jsonResponse(200, { data: { ticket: "tk_1" } }));
    const ceremony = vi.fn(async () => undefined);
    setStepUpHandler(ceremony);

    const ticket = await api.post<{ ticket: string }>("/api/v1/terminal/ticket", { session: "a" });

    expect(ticket).toEqual({ ticket: "tk_1" });
    expect(ceremony).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("replays the same method and body on the retry", async () => {
    const fetchMock = mockFetch(stepUpRequired(), new Response(null, { status: 204 }));
    setStepUpHandler(async () => undefined);

    await api.post("/api/v1/credentials/c_1/terminal", { allowed: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [path, init] of fetchMock.mock.calls) {
      expect(path).toBe("/api/v1/credentials/c_1/terminal");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ allowed: true }));
    }
  });

  it("gives up after one retry when the server keeps asking", async () => {
    const fetchMock = mockFetch(stepUpRequired(), stepUpRequired());
    const ceremony = vi.fn(async () => undefined);
    setStepUpHandler(ceremony);

    await expect(api.post("/api/v1/terminal/ticket", {})).rejects.toMatchObject({
      code: "STEP_UP_REQUIRED",
    });
    // One prompt, two requests. Never a loop, however stubborn the server is.
    expect(ceremony).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces the original error when the human declines", async () => {
    const fetchMock = mockFetch(stepUpRequired());
    setStepUpHandler(async () => {
      throw new Error("NotAllowedError: the ceremony was cancelled");
    });

    const err = await api.post("/api/v1/terminal/ticket", {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isStepUp).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the caller alone when it opted out", async () => {
    const fetchMock = mockFetch(stepUpRequired());
    const ceremony = vi.fn(async () => undefined);
    setStepUpHandler(ceremony);

    await expect(api.post("/api/v1/terminal/ticket", {}, { stepUp: false })).rejects.toMatchObject({
      code: "STEP_UP_REQUIRED",
    });
    expect(ceremony).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not confuse a plain FORBIDDEN with a recoverable one", async () => {
    const fetchMock = mockFetch(jsonResponse(403, { error: { code: "FORBIDDEN", message: "no" } }));
    const ceremony = vi.fn(async () => undefined);
    setStepUpHandler(ceremony);

    await expect(api.post("/api/v1/terminal/ticket", {})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(ceremony).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("stepUp", () => {
  const finished = {
    stepped_up_until: new Date(Date.now() + 300_000).toISOString(),
    credential: { id: "c_1", name: "iPhone", can_terminal: true },
  };

  it("runs begin, asserts, then finishes", async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, { data: { publicKey: { challenge: "abc" } } }),
      jsonResponse(200, { data: finished }),
    );

    await expect(stepUp()).resolves.toEqual(finished);
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: "abc" } });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "/api/v1/auth/stepup/begin",
      "/api/v1/auth/stepup/finish",
    ]);
  });

  it("raises one prompt for two requests that need it at once", async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, { data: { publicKey: { challenge: "abc" } } }),
      jsonResponse(200, { data: finished }),
    );

    const [a, b] = await Promise.all([stepUp(), stepUp()]);

    expect(a).toEqual(finished);
    expect(b).toEqual(finished);
    expect(startAuthentication).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("installs itself as the client's recovery, and reports the credential", async () => {
    mockFetch(
      stepUpRequired(),
      jsonResponse(200, { data: { publicKey: { challenge: "abc" } } }),
      jsonResponse(200, { data: finished }),
      jsonResponse(200, { data: { ticket: "tk_1" } }),
    );
    const seen = vi.fn();
    installStepUp(seen);

    await expect(api.post("/api/v1/terminal/ticket", {})).resolves.toEqual({ ticket: "tk_1" });
    expect(seen).toHaveBeenCalledWith(finished);
  });

  it("reports how much of the window is left", () => {
    expect(stepUpSecondsLeft(null)).toBe(0);
    expect(stepUpSecondsLeft({ ...finished, stepped_up_until: "not a date" })).toBe(0);
    expect(stepUpSecondsLeft(finished)).toBeGreaterThan(280);
  });
});
