import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { Fingerprint, KeyRound, Terminal } from "lucide-react";
import { api, describeError } from "../../lib/api";
import { useAuthState } from "../../lib/queries";
import type { User } from "../../lib/types";
import { Button, ErrorState, Field, Spinner, inputClass } from "../../components/ui";
import { Footer, Header } from "../../components/AppShell";
import { isStandalone } from "../../lib/pwa";

interface BeginAuth {
  publicKey: PublicKeyCredentialRequestOptionsJSON;
}
interface BeginReg {
  publicKey: PublicKeyCredentialCreationOptionsJSON;
}

/**
 * Passkeys only. Two failure modes get their own copy, because both look like a
 * broken login otherwise:
 *   - no user exists on the box yet → tell him to run `herdrer enroll`;
 *   - the installed PWA is a separate storage context → say that a second
 *     ceremony is expected, not a bug.
 */
export function Login() {
  const qc = useQueryClient();
  const { data: state, isPending, error, refetch } = useAuthState();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [code, setCode] = useState("");
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");

  const done = async (user: User | undefined) => {
    if (!user) throw new Error("The server accepted the passkey but sent no user back.");
    await qc.invalidateQueries();
  };

  const signIn = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const begin = await api.post<BeginAuth>("/api/v1/auth/login/begin", {});
      const assertion = await startAuthentication({ optionsJSON: begin.publicKey });
      const user = await api.post<User>("/api/v1/auth/login/finish", assertion);
      await done(user);
    } catch (err) {
      setFailure(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const register = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const begin = await api.post<BeginReg>("/api/v1/auth/register/begin", {
        code: code.trim(),
        ...(handle.trim() ? { handle: handle.trim() } : {}),
        ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
      });
      const attestation = await startRegistration({ optionsJSON: begin.publicKey });
      const user = await api.post<User>("/api/v1/auth/register/finish", attestation);
      await done(user);
    } catch (err) {
      setFailure(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <Header title="Sign in" />
      <div className="mx-auto w-full max-w-sm flex-1 px-4 py-8">
        {isPending && <Spinner label="Asking the box who it knows…" />}

        {error && (
          <ErrorState
            title="Can't reach the box"
            message={describeError(error)}
            onRetry={() => void refetch()}
          />
        )}

        {state && !state.enrolled && (
          <div className="rounded-lg border border-border bg-surface-2 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-heading">
              <Terminal className="w-4 h-4" />
              No passkey registered yet
            </div>
            <p className="mt-2 text-xs text-body">
              This box has no users. Open a shell on it and run:
            </p>
            <pre className="scroll-x mt-2 rounded-md border border-border bg-surface-3 p-2 font-mono text-xs text-heading">
              herdrer enroll
            </pre>
            <p className="mt-2 text-xs text-muted">
              It prints an enrollment code. Come back here with it and this page will offer a
              registration form.
            </p>
            <Button className="mt-3" onClick={() => void refetch()}>
              Check again
            </Button>
          </div>
        )}

        {state?.enrolled && mode === "signin" && (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-surface-2 p-5 text-center">
              <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-accent/40 bg-accent-weak text-accent">
                <Fingerprint className="w-5 h-5" />
              </span>
              <p className="mt-2 text-sm text-heading">Sign in with your passkey</p>
              <p className="mt-1 text-xs text-muted">
                {isStandalone()
                  ? "This installed app is a separate storage context from Safari, so signing in again is expected."
                  : "One Face ID prompt. No password to lose."}
              </p>
              <Button
                variant="primary"
                size="lg"
                className="mt-3 w-full"
                loading={busy}
                onClick={() => void signIn()}
              >
                <Fingerprint className="w-4 h-4" />
                Use passkey
              </Button>
            </div>
            {state.enrollment_open && (
              <button
                className="min-h-11 w-full text-center text-xs text-accent underline underline-offset-2"
                onClick={() => setMode("register")}
              >
                I have an enrollment code — add a passkey
              </button>
            )}
          </div>
        )}

        {state && (mode === "register" || (!state.enrolled && state.enrollment_open)) && (
          <form
            onSubmit={register}
            className="mt-4 space-y-3 rounded-lg border border-border bg-surface-2 p-4"
          >
            <div className="flex items-center gap-2 text-sm font-medium text-heading">
              <KeyRound className="w-4 h-4" />
              Register a passkey
            </div>
            <Field label="Enrollment code" hint="Printed by `herdrer enroll` on the box.">
              <input
                className={inputClass}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                required
              />
            </Field>
            <Field label="Handle" hint="Optional. Defaults to whatever the permit says.">
              <input
                className={inputClass}
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </Field>
            <Field label="Display name">
              <input
                className={inputClass}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </Field>
            <Button variant="primary" size="lg" className="w-full" loading={busy} type="submit">
              Create passkey
            </Button>
            {state.enrolled && (
              <button
                type="button"
                className="min-h-11 w-full text-center text-xs text-muted underline underline-offset-2"
                onClick={() => setMode("signin")}
              >
                Back to sign in
              </button>
            )}
          </form>
        )}

        {failure && (
          <div className="mt-3 rounded-md border border-danger/40 bg-danger-weak p-3 text-xs break-words text-danger">
            {failure}
          </div>
        )}
      </div>
      <Footer host={state?.rp_id} />
    </div>
  );
}
