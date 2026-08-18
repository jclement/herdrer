import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { api, setStepUpHandler } from "./api";
import type { StepUpResult } from "./types";

/**
 * Step-up re-authentication.
 *
 * A session cookie is enough to read the inbox and answer a question. It is not
 * enough to open a shell or to change which passkeys may open one: those want a
 * WebAuthn assertion completed in the last five minutes, and the server answers
 * `403 STEP_UP_REQUIRED` until it has one.
 *
 * That code is recoverable, and the client treats it that way: prompt, assert,
 * retry the original request. lib/api.ts does the retry centrally so every
 * privileged call — the terminal ticket, the per-passkey terminal flag, and
 * whatever gets added next — inherits it without asking.
 *
 * The credential that satisfies the ceremony is the one whose `can_terminal`
 * permission the server then checks, which is why the result carries it back:
 * a phone enrolled as review-only stays review-only even holding a live session.
 */

interface BeginStepUp {
  publicKey: PublicKeyCredentialRequestOptionsJSON;
}

/**
 * One ceremony at a time.
 *
 * Two privileged requests failing in the same tick must raise one prompt, not
 * two: the second `navigator.credentials.get()` would be rejected by the
 * browser anyway, and the human would see a mystery second Face ID sheet.
 */
let inflight: Promise<StepUpResult> | null = null;

/** Runs begin → assert → finish, resolving once the session is stepped up. */
export function stepUp(): Promise<StepUpResult> {
  if (inflight) return inflight;
  const run = ceremony();
  inflight = run;
  void run
    .catch(() => {})
    .then(() => {
      if (inflight === run) inflight = null;
    });
  return run;
}

async function ceremony(): Promise<StepUpResult> {
  // stepUp:false on both: these *are* the ceremony, and a ceremony that
  // triggered itself would be a loop rather than a login.
  const begin = await api.post<BeginStepUp>("/api/v1/auth/stepup/begin", {}, { stepUp: false });
  const assertion = await startAuthentication({ optionsJSON: begin.publicKey });
  const result = await api.post<StepUpResult>("/api/v1/auth/stepup/finish", assertion, {
    stepUp: false,
  });
  if (!result) throw new Error("The box accepted the passkey but sent nothing back.");
  return result;
}

/**
 * Teaches the API client to recover from STEP_UP_REQUIRED on its own.
 *
 * Called once at startup. `onStepUp` lets the app react to a successful
 * ceremony — refreshing bootstrap, which carries `stepped_up`.
 */
export function installStepUp(onStepUp?: (result: StepUpResult) => void): void {
  setStepUpHandler(async () => {
    const result = await stepUp();
    onStepUp?.(result);
    return result;
  });
}

/** How much of the five-minute window is left, in whole seconds. */
export function stepUpSecondsLeft(result: StepUpResult | null): number {
  if (!result) return 0;
  const until = Date.parse(result.stepped_up_until);
  if (!Number.isFinite(until)) return 0;
  return Math.max(0, Math.floor((until - Date.now()) / 1000));
}
