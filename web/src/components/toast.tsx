import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "./ui";

export interface Toast {
  id: number;
  message: string;
  tone: "info" | "ok" | "danger";
  action?: { label: string; run: () => void };
}

interface ToastApi {
  show: (message: string, opts?: Partial<Omit<Toast, "id" | "message">>) => number;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi>({ show: () => 0, dismiss: () => {} });

export function useToast(): ToastApi {
  return useContext(Ctx);
}

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const show = useCallback<ToastApi["show"]>(
    (message, opts) => {
      const id = next.current++;
      const toast: Toast = { id, message, tone: opts?.tone ?? "info", ...opts };
      setToasts((t) => [...t, toast]);
      window.setTimeout(() => dismiss(id), toast.action ? 6000 : 4000);
      return id;
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-3"
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 4.5rem)" }}
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              "rise pointer-events-auto flex w-full max-w-sm items-center gap-2 rounded-lg border py-1.5 pl-3 pr-1 text-xs shadow-2xl",
              "bg-surface-2 text-body",
              // A hairline stripe down the leading edge, in the tone's colour:
              // it survives a glance where a tinted border does not, and it does
              // not tint the message itself.
              t.tone === "danger"
                ? "border-danger/40 shadow-danger/10"
                : t.tone === "ok"
                  ? "border-ok/40 shadow-ok/10"
                  : "border-border",
            )}
          >
            <span
              aria-hidden
              className={cx(
                "-my-1.5 mr-1 w-0.5 self-stretch rounded-full",
                t.tone === "danger" ? "bg-danger" : t.tone === "ok" ? "bg-ok" : "bg-accent",
              )}
            />
            <span className="min-w-0 flex-1 break-words py-1">{t.message}</span>
            {t.action && (
              <button
                className="h-9 shrink-0 rounded px-2 font-medium text-accent transition-colors hover:bg-hover"
                onClick={() => {
                  t.action?.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              aria-label="Dismiss"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-heading"
              onClick={() => dismiss(t.id)}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
