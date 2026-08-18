import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import {
  ChevronLeft,
  ClipboardPaste,
  Fingerprint,
  Keyboard,
  Minus,
  Plus,
  Power,
  ShieldOff,
} from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ApiError, api, describeError, wsURL } from "../../lib/api";
import { stepUp } from "../../lib/stepup";
import type { Ticket } from "../../lib/types";
import { flags } from "../../lib/storage";
import { useVisualViewport } from "../../lib/viewport";
import { Button, cx } from "../../components/ui";
import { useToast } from "../../components/toast";

/**
 * The wire format is in the API contract: the first byte of every frame is the
 * lane. 0x00 is terminal bytes in both directions, 0x01 is a JSON control frame.
 */
const LANE_DATA = 0x00;
const LANE_CONTROL = 0x01;

type Phase = "connecting" | "open" | "closed" | "error";

/**
 * Why the terminal is not connecting, when the reason is the human's to fix.
 * `stepup` is recoverable here and now; `review-only` is a decision made
 * elsewhere and can only be undone in Settings, from a permitted device.
 */
type Gate = "stepup" | "review-only";

const FONT_SIZES = [10, 12, 14] as const;

export function TerminalPage() {
  const { name } = useParams({ from: "/agents/$name/term" });
  const toast = useToast();
  const vv = useVisualViewport();

  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [phase, setPhase] = useState<Phase>("connecting");
  const [failure, setFailure] = useState<string | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [asserting, setAsserting] = useState(false);
  const steppedUp = useRef(false);
  const [interactive, setInteractive] = useState(false);
  const [fontSize, setFontSize] = useState<number>(() => {
    const stored = Number(flags.read("term-font"));
    return FONT_SIZES.includes(stored as (typeof FONT_SIZES)[number]) ? stored : 12;
  });
  const [sticky, setSticky] = useState<{
    ctrl: boolean;
    alt: boolean;
    lock: "ctrl" | "alt" | null;
  }>({
    ctrl: false,
    alt: false,
    lock: null,
  });

  const encoder = useMemo(() => new TextEncoder(), []);

  const sendBytes = useCallback((bytes: Uint8Array) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame = new Uint8Array(bytes.length + 1);
    frame[0] = LANE_DATA;
    frame.set(bytes, 1);
    ws.send(frame);
  }, []);

  const sendText = useCallback(
    (text: string) => sendBytes(encoder.encode(text)),
    [encoder, sendBytes],
  );

  const sendControl = useCallback(
    (msg: unknown) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const body = encoder.encode(JSON.stringify(msg));
      const frame = new Uint8Array(body.length + 1);
      frame[0] = LANE_CONTROL;
      frame.set(body, 1);
      ws.send(frame);
    },
    [encoder],
  );

  // No page scroll at all on this route: that removes the whole class of
  // terminal-scroll-versus-page-scroll gesture conflict rather than arbitrating it.
  useEffect(() => {
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, []);

  // Build the terminal once; font size changes are applied in place.
  useEffect(() => {
    if (!hostRef.current) return;
    const css = getComputedStyle(document.documentElement);
    const term = new Terminal({
      fontFamily: css.getPropertyValue("--font-mono").trim() || "monospace",
      fontSize,
      cursorBlink: true,
      convertEol: false,
      scrollback: 2000,
      theme: {
        background: css.getPropertyValue("--color-surface").trim() || "#0f141a",
        foreground: css.getPropertyValue("--color-body").trim() || "#c2ccd7",
        cursor: css.getPropertyValue("--color-accent").trim() || "#4aa8ff",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // iOS predictive text silently corrupts what you type into a shell.
    const textarea = hostRef.current.querySelector("textarea");
    if (textarea) {
      textarea.setAttribute("autocorrect", "off");
      textarea.setAttribute("autocapitalize", "off");
      textarea.setAttribute("autocomplete", "off");
      textarea.setAttribute("spellcheck", "false");
      textarea.setAttribute("enterkeyhint", "send");
    }

    const sub = term.onData((data) => sendText(data));
    return () => {
      sub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    flags.write("term-font", String(fontSize));
    fitRef.current?.fit();
    sendControl({ type: "resize", cols: term.cols, rows: term.rows });
  }, [fontSize, sendControl]);

  // Connect: ticket first (single use, 60s), then the socket.
  useEffect(() => {
    if (gate) return; // waiting on a passkey, or on a permission we cannot grant
    let cancelled = false;

    const connect = async () => {
      setPhase("connecting");
      setFailure(null);
      let ticket: Ticket;
      try {
        // stepUp:false: the client would happily prompt and retry underneath,
        // but a Face ID sheet nobody asked for reads as a bug. Explain first,
        // then assert from the button — which is also the user gesture Safari
        // wants before it will run the ceremony at all.
        ticket = await api.post<Ticket>(
          "/api/v1/terminal/ticket",
          { session: name },
          { stepUp: false },
        );
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.isStepUp) {
          setGate("stepup");
          return;
        }
        // A plain 403 *after* a good assertion means the passkey that satisfied
        // it is not allowed to open a shell — a different story with a
        // different fix.
        if (err instanceof ApiError && err.status === 403 && steppedUp.current) {
          setGate("review-only");
          return;
        }
        setPhase("error");
        setFailure(describeError(err));
        return;
      }
      if (cancelled) return;

      const term = termRef.current;
      const ws = new WebSocket(
        wsURL("/ws/terminal", {
          ticket: ticket.ticket,
          cols: term?.cols ?? 80,
          rows: term?.rows ?? 24,
          session: name,
        }),
      );
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setPhase("open");
        const t = termRef.current;
        if (t) sendControl({ type: "resize", cols: t.cols, rows: t.rows });
      };

      ws.onmessage = (ev) => {
        const t = termRef.current;
        if (!t) return;
        if (typeof ev.data === "string") {
          // Not in the contract, but a text frame is readable output, not a crash.
          t.write(ev.data);
          return;
        }
        const buf = new Uint8Array(ev.data as ArrayBuffer);
        if (buf.length === 0) return;
        const lane = buf[0];
        const body = buf.subarray(1);
        if (lane === LANE_DATA) {
          t.write(body);
        } else if (lane === LANE_CONTROL) {
          try {
            const msg = JSON.parse(new TextDecoder().decode(body)) as { type?: string };
            if (msg.type === "bell") {
              if (navigator.vibrate) navigator.vibrate(30);
            }
          } catch {
            /* an unparseable control frame is not worth killing the session over */
          }
        }
      };

      ws.onerror = () => {
        if (!cancelled) setPhase("error");
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (!cancelled) setPhase("closed");
      };
    };

    void connect();
    return () => {
      cancelled = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [name, sendControl, gate, attempt]);

  const authorise = async () => {
    setAsserting(true);
    setFailure(null);
    try {
      const result = await stepUp();
      steppedUp.current = true;
      if (result.credential?.can_terminal === false) {
        setGate("review-only");
        return;
      }
      setGate(null);
      setAttempt((n) => n + 1);
    } catch (err) {
      setFailure(describeError(err));
    } finally {
      setAsserting(false);
    }
  };

  // The PTY follows the visible area, so rows are never hidden behind the keyboard.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      fitRef.current?.fit();
      const term = termRef.current;
      if (term) sendControl({ type: "resize", cols: term.cols, rows: term.rows });
    }, 150);
    return () => window.clearTimeout(handle);
  }, [vv.height, vv.offsetTop, sendControl]);

  const takeControl = () => {
    setInteractive(true);
    termRef.current?.focus();
  };

  const pressKey = (seq: string) => {
    if (!interactive) return;
    sendText(seq);
    if (sticky.lock === null && (sticky.ctrl || sticky.alt)) {
      setSticky({ ctrl: false, alt: false, lock: null });
    }
    termRef.current?.focus();
  };

  const pressLetterWithModifiers = (letter: string) => {
    if (sticky.ctrl) {
      const code = letter.toUpperCase().charCodeAt(0) - 64;
      pressKey(String.fromCharCode(code));
    } else if (sticky.alt) {
      pressKey(`\x1b${letter}`);
    } else {
      pressKey(letter);
    }
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendText(text);
    } catch {
      toast.show("The clipboard wouldn't open. Long-press over a canvas is unreliable on iOS.", {
        tone: "danger",
      });
    }
  };

  const barHeight = interactive ? 96 : 48;
  const termHeight = Math.max(120, vv.height - 40 - barHeight);

  return (
    <div className="fixed inset-0 flex flex-col bg-surface" style={{ height: vv.height }}>
      <header
        className="flex h-10 shrink-0 items-center gap-2 bg-chrome px-2 text-chrome-fg"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <Link
          to="/agents"
          aria-label="Back to agents"
          className="-ml-1 flex h-9 w-9 items-center justify-center rounded hover:bg-white/10"
        >
          <ChevronLeft className="w-4 h-4" />
        </Link>
        <div className="min-w-0 flex-1 truncate font-mono text-xs">{name}</div>
        <span
          className={cx(
            "rounded border px-1.5 py-0.5 text-[10px]",
            phase === "open"
              ? "border-ok/50 text-ok"
              : phase === "connecting"
                ? "border-chrome-border text-chrome-muted"
                : "border-danger/50 text-danger",
          )}
        >
          {phase}
        </span>
        <FontControl size={fontSize} onChange={setFontSize} />
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={hostRef}
          className="h-full overflow-hidden px-1"
          style={{ height: termHeight, touchAction: "manipulation" }}
        />
        {gate && (
          <StepUpGate
            gate={gate}
            busy={asserting}
            onAssert={() => void authorise()}
            failure={failure}
          />
        )}
      </div>

      {failure && !gate && (
        <div className="border-t border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
          {failure}
        </div>
      )}
      {phase === "closed" && !failure && !gate && (
        <div className="border-t border-border px-3 py-2 text-xs text-muted">
          The socket closed. Tickets are single use — go back and open it again.
        </div>
      )}

      {!interactive ? (
        <div
          className="flex shrink-0 items-center gap-2 border-t border-border bg-surface-2 px-3 py-2"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)" }}
        >
          <div className="flex-1 text-[11px] text-muted">
            Read-only. Nothing you do here reaches the agent until you take control.
          </div>
          <Button variant="primary" size="lg" onClick={takeControl} disabled={phase !== "open"}>
            <Power className="w-4 h-4" />
            Take control
          </Button>
        </div>
      ) : (
        <ModifierBar
          sticky={sticky}
          setSticky={setSticky}
          onKey={pressKey}
          onLetter={pressLetterWithModifiers}
          onPaste={() => void paste()}
          onKeyboard={() => termRef.current?.focus()}
        />
      )}
    </div>
  );
}

/**
 * The interstitial that stands between a session and a shell.
 *
 * The friction is the feature: a stolen phone with a live session still cannot
 * open a PTY. So say why in one line — friction with no explanation is
 * indistinguishable from a bug, and the next thing the reader does is file one.
 */
function StepUpGate({
  gate,
  busy,
  onAssert,
  failure,
}: {
  gate: Gate;
  busy: boolean;
  onAssert: () => void;
  failure: string | null;
}) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/95 px-4">
      <div className="w-full max-w-sm rounded border border-border bg-surface-2 p-4 text-center">
        {gate === "stepup" ? (
          <>
            <Fingerprint className="mx-auto w-4 h-4 text-accent" />
            <p className="mt-2 text-sm text-heading">Touch your passkey to open a terminal</p>
            <p className="mt-1 text-xs text-muted">
              A signed-in session isn't enough to reach a shell — herdrer wants a passkey check from
              the last five minutes.
            </p>
            <Button
              variant="primary"
              size="lg"
              className="mt-3 w-full"
              loading={busy}
              onClick={onAssert}
            >
              <Fingerprint className="w-4 h-4" />
              Use passkey
            </Button>
          </>
        ) : (
          <>
            <ShieldOff className="mx-auto w-4 h-4 text-warn" />
            <p className="mt-2 text-sm text-heading">This passkey is review-only</p>
            <p className="mt-1 text-xs text-muted">
              It can answer reviews, but it cannot open a shell — that is deliberate, so a stolen
              phone stays harmless. Allow it in Settings, from a device that already may.
            </p>
            <Link
              to="/settings"
              className="mt-3 inline-block text-xs text-accent underline underline-offset-2"
            >
              Open Settings → Passkeys
            </Link>
          </>
        )}
        {failure && <p className="mt-3 text-xs text-danger">{failure}</p>}
      </div>
    </div>
  );
}

function FontControl({ size, onChange }: { size: number; onChange: (n: number) => void }) {
  const idx = FONT_SIZES.indexOf(size as (typeof FONT_SIZES)[number]);
  return (
    <div className="flex items-center gap-1">
      <button
        aria-label="Smaller text"
        className="flex h-8 w-8 items-center justify-center rounded text-chrome-muted hover:bg-white/10"
        onClick={() => onChange(FONT_SIZES[Math.max(0, idx - 1)] ?? 10)}
      >
        <Minus className="w-4 h-4" />
      </button>
      <span className="font-mono text-[10px] text-chrome-muted">{size}</span>
      <button
        aria-label="Larger text"
        className="flex h-8 w-8 items-center justify-center rounded text-chrome-muted hover:bg-white/10"
        onClick={() => onChange(FONT_SIZES[Math.min(FONT_SIZES.length - 1, idx + 1)] ?? 14)}
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}

/**
 * A phone keyboard has no ctrl, esc, tab or arrows, so the bar supplies them.
 * ctrl and alt are sticky one-shots: tap, then a letter. Double-tap locks.
 */
function ModifierBar({
  sticky,
  setSticky,
  onKey,
  onLetter,
  onPaste,
  onKeyboard,
}: {
  sticky: { ctrl: boolean; alt: boolean; lock: "ctrl" | "alt" | null };
  setSticky: (s: { ctrl: boolean; alt: boolean; lock: "ctrl" | "alt" | null }) => void;
  onKey: (seq: string) => void;
  onLetter: (letter: string) => void;
  onPaste: () => void;
  onKeyboard: () => void;
}) {
  const vv = useVisualViewport();

  const toggle = (which: "ctrl" | "alt") => {
    const active = which === "ctrl" ? sticky.ctrl : sticky.alt;
    if (active && sticky.lock !== which) {
      setSticky({ ...sticky, [which]: true, lock: which });
    } else if (sticky.lock === which) {
      setSticky({ ctrl: false, alt: false, lock: null });
    } else {
      setSticky({ ctrl: which === "ctrl", alt: which === "alt", lock: null });
    }
  };

  const key = (label: string, seq: string) => (
    <BarKey key={label} label={label} onPress={() => onKey(seq)} />
  );

  return (
    <div
      className="shrink-0 border-t border-border bg-surface-2"
      style={{
        paddingBottom: vv.keyboardOpen ? 0 : "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <div className="scroll-x no-scrollbar flex items-center gap-1 px-2 py-1.5">
        <BarKey label="esc" onPress={() => onKey("\x1b")} />
        <BarKey label="tab" onPress={() => onKey("\t")} />
        <BarKey
          label="ctrl"
          active={sticky.ctrl}
          locked={sticky.lock === "ctrl"}
          onPress={() => toggle("ctrl")}
        />
        <BarKey
          label="alt"
          active={sticky.alt}
          locked={sticky.lock === "alt"}
          onPress={() => toggle("alt")}
        />
        {key("↑", "\x1b[A")}
        {key("↓", "\x1b[B")}
        {key("←", "\x1b[D")}
        {key("→", "\x1b[C")}
        <BarKey label="^C" onPress={() => onKey("\x03")} />
        <BarKey label="^D" onPress={() => onKey("\x04")} />
        <BarKey label="^Z" onPress={() => onKey("\x1a")} />
        {key("|", "|")}
        {key("/", "/")}
        {key("-", "-")}
        {key("~", "~")}
        <BarKey label="y" onPress={() => onLetter("y")} />
        <BarKey label="n" onPress={() => onLetter("n")} />
        <button
          aria-label="Paste"
          onClick={onPaste}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded border border-border text-muted"
        >
          <ClipboardPaste className="w-4 h-4" />
        </button>
        <button
          aria-label="Show keyboard"
          onClick={onKeyboard}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded border border-border text-muted"
        >
          <Keyboard className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function BarKey({
  label,
  onPress,
  active,
  locked,
}: {
  label: string;
  onPress: () => void;
  active?: boolean;
  locked?: boolean;
}) {
  return (
    <button
      onClick={onPress}
      className={cx(
        "h-11 min-w-11 shrink-0 rounded border px-2 font-mono text-xs",
        locked
          ? "border-accent bg-accent text-accent-fg"
          : active
            ? "border-accent text-accent"
            : "border-border text-heading",
      )}
    >
      {label}
    </button>
  );
}
