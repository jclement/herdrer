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
              "pointer-events-auto flex w-full max-w-sm items-center gap-2 rounded border px-3 py-2 text-xs shadow-lg",
              "bg-surface-2 text-body",
              t.tone === "danger"
                ? "border-danger/50"
                : t.tone === "ok"
                  ? "border-ok/50"
                  : "border-border",
            )}
          >
            <span className="flex-1">{t.message}</span>
            {t.action && (
              <button
                className="font-medium text-accent"
                onClick={() => {
                  t.action?.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button aria-label="Dismiss" className="text-muted" onClick={() => dismiss(t.id)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
