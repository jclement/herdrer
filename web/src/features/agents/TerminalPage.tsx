import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import {
  Bell,
  ClipboardPaste,
  Fingerprint,
  Image as ImageIcon,
  Keyboard,
  Loader2,
  Minus,
  Plus,
  Power,
  ShieldOff,
  X,
} from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ApiError, api, describeError, wsURL } from "../../lib/api";
import { stepUp } from "../../lib/stepup";
import type { Ticket } from "../../lib/types";
import { flags } from "../../lib/storage";
import { lockScroll } from "../../lib/overlay";
import { useIsDesktop } from "../../lib/layout";
import { cssReader, terminalFont, terminalTheme } from "../../lib/termTheme";
import { useVisualViewport } from "../../lib/viewport";
import { humanBytes, imageFromTransfer, sendImage, uploadPaste } from "../../lib/paste";
import { useBootstrap } from "../../lib/queries";
import { Button, cx } from "../../components/ui";
import { ScrollX } from "../../components/ScrollX";
import { BottomNav, HeaderNav, ThemeToggle } from "../../components/AppShell";
import { useToast } from "../../components/toast";
import { useReviewQueue } from "../review/ReviewQueue";
import { ReviewRail } from "../review/ReviewRail";

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

/** An image on its way to the box, or the reason it did not get there. */
interface ImagePasteState {
  name: string;
  bytes: number;
  loaded: number;
  status: "uploading" | "error";
  message?: string;
}

/**
 * herdr, live, and the front page of the app.
 *
 * The inversion this route represents is the whole redesign: you open herdrer
 * and you are looking at the multiplexer, not at a list of things it wants from
 * you. Questions arrive on top of this (see features/review/ReviewQueue.tsx)
 * and dismiss back to it.
 *
 * This route is two layouts, not one responsive layout — see lib/layout.ts.
 *
 * On a phone, two ergonomics are load-bearing:
 *
 *   Read-only until you take control. A PTY that accepts input the moment it
 *   paints is a PTY that eats a stray tap on a train. Taking control is a
 *   deliberate act, and it is also the signal the review queue uses to decide
 *   whether an arriving question may interrupt.
 *
 *   The bottom of the screen belongs to exactly one thing at a time. Before you
 *   take control it is navigation; after, it is the modifier bar, because a
 *   phone keyboard has no ctrl, esc, tab or arrows. Releasing control gives the
 *   navigation back.
 *
 * On a desktop both of those are wrong, so neither is there:
 *
 *   Nothing to take. A stray tap is a thumb problem. A mouse pointer does not
 *   brush against a shell while it scrolls, and a keyboard has ctrl, esc, tab
 *   and arrows already — so the terminal is live the moment it connects, and
 *   the bottom of the screen is the terminal, because the navigation is a menu
 *   across the top and the queue is a rail down the right.
 *
 *   Nothing interrupts. The rail shows what is waiting *while* you work, which
 *   is the one thing a phone cannot do, and a click on it opens the same
 *   document the phone's sheet shows — as a modal, over the same component.
 */
export function TerminalPage() {
  const search = useSearch({ from: "/" }) as { session?: string; pane?: string };
  const session = search.session ?? "";
  const toast = useToast();
  const vv = useVisualViewport();
  const queue = useReviewQueue();
  const boot = useBootstrap();
  const desktop = useIsDesktop();

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
  const [paneHint, setPaneHint] = useState<string | null>(search.pane ?? null);
  const [dragging, setDragging] = useState(false);
  const [imagePaste, setImagePaste] = useState<ImagePasteState | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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

  useEffect(() => setPaneHint(search.pane ?? null), [search.pane]);

  /*
   * Whether keystrokes reach the PTY.
   *
   * On a desktop this is simply true: read-only-until-you-ask exists to stop a
   * thumb, and there is no thumb. Keeping the gate there would be friction that
   * reads as the terminal being broken, which is what it was reported as.
   */
  const holding = desktop || interactive;

  const encoder = useMemo(() => new TextEncoder(), []);

  // The terminal is built once and never re-created, so the queue is reached
  // through a ref rather than being captured in the onData closure.
  const noteInputRef = useRef(queue.noteInput);
  noteInputRef.current = queue.noteInput;

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
  useEffect(() => lockScroll(), []);

  // Build the terminal once; font size changes are applied in place.
  useEffect(() => {
    if (!hostRef.current) return;
    const read = cssReader();
    const term = new Terminal({
      fontFamily: terminalFont(read),
      fontSize,
      cursorBlink: true,
      convertEol: false,
      scrollback: 2000,
      // The full sixteen plus background, foreground, cursor and selection, out
      // of styles.css — see lib/termTheme.ts. Three of them was why an agent's
      // colours came out as whatever xterm's defaults happened to be.
      theme: terminalTheme(read),
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

    const sub = term.onData((data) => {
      // Every keystroke tells the review queue the human is mid-word, which is
      // what stops a sheet mounting on top of the next one.
      noteInputRef.current();
      sendText(data);
    });
    return () => {
      sub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * Follow the theme toggle without dropping the PTY.
   *
   * `applyTheme` decides light from dark by toggling one class on <html>, and
   * that is true for the system option too — so watching that attribute catches
   * the toggle and an OS-level switch alike, with no second subscription. The
   * repaint is an assignment: rebuilding the Terminal would close the socket
   * and throw away the scrollback to change a background colour.
   */
  useEffect(() => {
    const repaint = () => {
      const term = termRef.current;
      if (term) term.options.theme = terminalTheme(cssReader());
    };
    const observer = new MutationObserver(repaint);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
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
        //
        // `session` is a *herdr session name*, and omitting it attaches to the
        // default session — the one whose tree /agents renders. It is not an
        // agent name: passing one would make herdr launch a brand new, empty
        // session named after the agent you were trying to look at.
        ticket = await api.post<Ticket>("/api/v1/terminal/ticket", session ? { session } : {}, {
          stepUp: false,
        });
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
          ...(session ? { session } : {}),
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
  }, [session, sendControl, gate, attempt]);

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

  /*
   * The PTY follows the box, whatever changed the box.
   *
   * The viewport effect below covers the phone's case — the keyboard opening —
   * but on a desktop the terminal is sized by flexbox, and the things that
   * resize it (the window, a status strip arriving under it) produce no
   * viewport event at all. Debounced, because a window drag produces a hundred
   * of these and each one would otherwise be a control frame.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    let timer = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        fitRef.current?.fit();
        const term = termRef.current;
        if (term) sendControl({ type: "resize", cols: term.cols, rows: term.rows });
      }, 100);
    });
    observer.observe(host);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [sendControl]);

  // The PTY follows the visible area, so rows are never hidden behind the keyboard.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      fitRef.current?.fit();
      const term = termRef.current;
      if (term) sendControl({ type: "resize", cols: term.cols, rows: term.rows });
    }, 150);
    return () => window.clearTimeout(handle);
  }, [vv.height, vv.offsetTop, sendControl]);

  // Whether the human holds the terminal is what decides if a `normal` question
  // may take the screen, so the queue has to know.
  useEffect(() => {
    queue.setInteractive(holding);
    // Leaving the terminal releases it: nothing else on the app sets this, and a
    // stale `true` would keep `normal` questions peeking forever on /agents.
    return () => queue.setInteractive(false);
  }, [holding, queue]);

  /*
   * On a desktop the terminal is the page, so it takes the keyboard as soon as
   * it has one to give it to. Autofocus is usually a rudeness; here the alt is
   * a live shell you have to click before it will accept the command you
   * already started typing.
   */
  useEffect(() => {
    if (!desktop || phase !== "open") return;
    if (queue.sheetId !== null) return;
    termRef.current?.focus();
  }, [desktop, phase, queue.sheetId]);

  /*
   * Handing focus over, and taking it back.
   *
   * A sheet only ever mounts when the queue has decided it cannot cost a
   * keystroke, so by the time we get here it is safe to move focus — but it is
   * still not safe to leave the PTY focused underneath, or characters typed at
   * the sheet's note field would race the shell. Blur on the way in; restore on
   * the way out, but only if the human still holds the terminal.
   */
  const sheetId = queue.sheetId;
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (sheetId !== null) {
      term.blur();
      return;
    }
    if (holding) term.focus();
  }, [sheetId, holding]);

  const takeControl = () => {
    setInteractive(true);
    termRef.current?.focus();
  };

  const releaseControl = () => {
    setInteractive(false);
    setSticky({ ctrl: false, alt: false, lock: null });
    termRef.current?.blur();
  };

  const pressKey = (seq: string) => {
    if (!holding) return;
    queue.noteInput();
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
      if (text) {
        queue.noteInput();
        sendText(text);
      }
    } catch {
      toast.show("The clipboard wouldn't open. Long-press over a canvas is unreliable on iOS.", {
        tone: "danger",
      });
    }
  };

  /**
   * An image, handed to whatever agent herdr has focused.
   *
   * Nothing is written to the socket until the upload has landed — see
   * lib/paste.ts. A failure leaves the terminal untouched and says why, because
   * a path typed for a file that does not exist would have the agent report
   * something baffling about a missing image instead.
   */
  const putImage = useCallback(
    async (file: File | Blob, label?: string) => {
      if (!holding) {
        toast.show("Take control first — the terminal is read-only until you do.");
        return;
      }
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        toast.show("The terminal isn't connected.", { tone: "danger" });
        return;
      }
      const name = label ?? (file instanceof File ? file.name : "image");
      setImagePaste({ name, bytes: file.size, loaded: 0, status: "uploading" });
      const ok = await sendImage(file, {
        upload: uploadPaste,
        write: (text) => {
          queue.noteInput();
          sendText(text);
        },
        onProgress: (loaded) =>
          setImagePaste((s) => (s && s.status === "uploading" ? { ...s, loaded } : s)),
        onError: (message) =>
          setImagePaste({ name, bytes: file.size, loaded: 0, status: "error", message }),
        onDone: () => termRef.current?.focus(),
      });
      if (ok) setImagePaste(null);
    },
    [holding, queue, sendText, toast],
  );

  /*
   * Paste is registered in the capture phase on the host, above xterm's own
   * handler on its hidden textarea. An image paste is claimed here and stopped
   * before xterm sees it; anything else — text, which is the common case — is
   * left entirely alone and falls through to the terminal's normal handling.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onPaste = (e: ClipboardEvent) => {
      // While a review is up the paste belongs to its note field, not to the
      // shell underneath. It cannot reach here through the DOM, but say so.
      if (queue.sheetId !== null) return;
      const file = imageFromTransfer(e.clipboardData);
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      void putImage(file);
    };
    host.addEventListener("paste", onPaste, true);
    return () => host.removeEventListener("paste", onPaste, true);
  }, [putImage, queue.sheetId]);

  const onDrop = (e: React.DragEvent) => {
    setDragging(false);
    const file = imageFromTransfer(e.dataTransfer);
    if (!file) return;
    e.preventDefault();
    void putImage(file);
  };

  const headerRef = useRef<HTMLElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(40);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = () => setHeaderHeight(el.offsetHeight || 40);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /*
   * How much of the viewport is not terminal.
   *
   * Desktop has nothing below the terminal at all — no take-control bar, no
   * modifier bar, no bottom nav — so it is zero, and the terminal gets every
   * row between the menu and the bottom of the window. That is the "terminal
   * takes most of the screen" half of the desktop design; the rail takes width,
   * not height.
   */
  const chrome = desktop ? 0 : interactive ? 96 : 48 + 56; // key bar, or read-only bar plus nav
  /*
   * The header is measured, not assumed.
   *
   * It used to be a literal 40 here, matching the `h-10` on the bar — which was
   * only true because the safe-area inset was applied to the *same* element as
   * that height, so a notched phone silently clamped the content box to zero
   * and rendered the header's own buttons below the bar. With the inset moved
   * to a wrapper (where it belongs) the header is 40px plus the inset, and the
   * inset is a number only the engine knows. So ask it.
   */
  const termHeight = Math.max(
    120,
    vv.height - headerHeight - chrome - (paneHint ? 28 : 0) - (imagePaste ? 36 : 0),
  );

  return (
    <div className="fixed inset-0 flex flex-col bg-surface" style={{ height: vv.height }}>
      <header
        ref={headerRef}
        className="shrink-0 border-b border-chrome-border bg-chrome text-chrome-fg"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="flex h-10 items-center gap-2 px-2">
          <span className="shrink-0 text-sm font-semibold tracking-tight">herdrer</span>
          {/* The desktop's navigation. Below `lg` it renders nothing and the
            bottom nav is the navigation instead. */}
          <HeaderNav />
          {/* The default session is the common case and needs no label; a named
            one does, because it is a different herdr server entirely. */}
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-chrome-muted">
            {session}
          </span>
          <span
            className={cx(
              "shrink-0 rounded border px-1.5 py-0.5 text-[10px]",
              phase === "open"
                ? "border-ok/50 text-ok"
                : phase === "connecting"
                  ? "border-chrome-border text-chrome-muted"
                  : "border-danger/50 text-danger",
            )}
          >
            {phase}
          </span>
          {/* The bell is the phone's way to reach the queue. On a desktop the
            rail is already showing it, and a second count is just a second
            thing to keep in sync. */}
          {queue.open > 0 && !desktop && (
            <button
              onClick={queue.openStack}
              aria-label={`${queue.open} waiting on you`}
              className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded text-chrome-fg hover:bg-chrome-hover"
            >
              <Bell className="w-4 h-4" />
              <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-danger-fg">
                {queue.open > 99 ? "99+" : queue.open}
              </span>
            </button>
          )}
          <FontControl size={fontSize} onChange={setFontSize} />
          {desktop && (
            <button
              aria-label="Send an image"
              title="Send an image to herdr's focused pane"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-chrome-muted hover:bg-chrome-hover hover:text-chrome-fg"
            >
              <ImageIcon className="w-4 h-4" />
            </button>
          )}
          {desktop && <ThemeToggle />}
        </div>
      </header>

      {/*
        The desktop split: the terminal column takes the width that is left, and
        the review rail takes a fixed 20rem of it. Below `lg` the rail is not
        rendered at all — not hidden — so the terminal's own arithmetic never
        has to know about it.
      */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {paneHint && (
            <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-surface-2 px-2 text-[11px] text-muted">
              <span className="truncate">
                you came from pane <span className="font-mono text-heading">{paneHint}</span> —
                herdr has no focus-by-id over HTTP, so switch to it in the TUI
              </span>
              <button
                aria-label="Dismiss"
                onClick={() => setPaneHint(null)}
                className="ml-auto shrink-0 p-1"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div
            className="relative min-h-0 flex-1 overflow-hidden"
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            {/*
              On a phone the height is arithmetic against the *visual* viewport,
              because that is the only thing that tracks the software keyboard.
              On a desktop there is no keyboard to track and there are optional
              strips below the terminal, so let flexbox size it and let the
              ResizeObserver above tell the PTY what happened.
            */}
            <div
              ref={hostRef}
              className="h-full overflow-hidden px-1"
              style={{
                ...(desktop ? null : { height: termHeight }),
                touchAction: "manipulation",
              }}
            />
            {dragging && (
              <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded border-2 border-dashed border-accent bg-surface/80 text-sm text-accent">
                Drop an image to hand it to the agent
              </div>
            )}
            {gate && (
              <StepUpGate
                gate={gate}
                busy={asserting}
                onAssert={() => void authorise()}
                failure={failure}
              />
            )}
          </div>

          {imagePaste && (
            <ImagePasteStrip state={imagePaste} onDismiss={() => setImagePaste(null)} />
          )}

          {failure && !gate && (
            <div className="shrink-0 border-t border-danger/40 bg-danger-weak px-3 py-2 text-xs text-danger">
              {failure}
            </div>
          )}
          {phase === "closed" && !failure && !gate && (
            <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted">
              <span className="flex-1">The socket closed. Tickets are single use.</span>
              <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
                Reconnect
              </Button>
            </div>
          )}
        </div>

        {desktop && (
          <ReviewRail items={queue.items} deferred={queue.deferred} onOpen={queue.openItem} />
        )}
      </div>

      {/* The only route in on iOS, where a web terminal has no image paste at all. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void putImage(file);
        }}
      />

      {/*
        Nothing below the terminal on a desktop: no bar to press, no nav to make
        room for. The keyboard already has every key the modifier bar supplies.
      */}
      {desktop ? null : !interactive ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface-2 px-3 py-2">
            <div className="flex-1 text-[11px] text-muted">
              Read-only. Nothing you do here reaches the agent until you take control.
            </div>
            <Button variant="primary" size="lg" onClick={takeControl} disabled={phase !== "open"}>
              <Power className="w-4 h-4" />
              Take control
            </Button>
          </div>
          <BottomNav
            embedded
            reviewBadge={queue.open}
            agentBadge={boot.data?.counts.agents_blocked ?? 0}
            warnMore={boot.data?.vapid_public_key === null}
          />
        </>
      ) : (
        <ModifierBar
          sticky={sticky}
          setSticky={setSticky}
          onKey={pressKey}
          onLetter={pressLetterWithModifiers}
          onPaste={() => void paste()}
          onKeyboard={() => termRef.current?.focus()}
          onRelease={releaseControl}
          onPickImage={() => fileInputRef.current?.click()}
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
              the last five minutes. Answering a review never asks for this.
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

/**
 * What is happening to the image, in one row.
 *
 * A 12 MiB screenshot over LTE takes long enough that silence reads as a hang,
 * and a refusal that produced no visible change reads as a bug. So: a real byte
 * count while it is in flight, the server's own words when it says no, and a
 * note about where the path is going to land — herdr types it into whichever
 * pane it currently has focused, which is usually but not always the one you
 * were looking at.
 */
function ImagePasteStrip({ state, onDismiss }: { state: ImagePasteState; onDismiss: () => void }) {
  const failed = state.status === "error";
  const pct = state.bytes > 0 ? Math.min(100, Math.round((state.loaded / state.bytes) * 100)) : 0;

  return (
    <div
      className={cx(
        "flex h-9 shrink-0 items-center gap-2 border-t px-2 text-[11px]",
        failed
          ? "border-danger/40 bg-danger-weak text-danger"
          : "border-border bg-surface-2 text-muted",
      )}
      role="status"
      aria-live="polite"
    >
      {failed ? (
        <ImageIcon className="w-3.5 h-3.5 shrink-0" />
      ) : (
        <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">
        {failed ? (
          state.message
        ) : (
          <>
            sending {state.name} · {humanBytes(state.loaded)} of {humanBytes(state.bytes)} ({pct}%)
            — the path goes to herdr's focused pane
          </>
        )}
      </span>
      {failed && (
        <button aria-label="Dismiss" onClick={onDismiss} className="shrink-0 p-1">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

function FontControl({ size, onChange }: { size: number; onChange: (n: number) => void }) {
  const idx = FONT_SIZES.indexOf(size as (typeof FONT_SIZES)[number]);
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        aria-label="Smaller text"
        className="flex h-8 w-8 items-center justify-center rounded text-chrome-muted hover:bg-chrome-hover"
        onClick={() => onChange(FONT_SIZES[Math.max(0, idx - 1)] ?? 10)}
      >
        <Minus className="w-4 h-4" />
      </button>
      <span className="font-mono text-[10px] text-chrome-muted">{size}</span>
      <button
        aria-label="Larger text"
        className="flex h-8 w-8 items-center justify-center rounded text-chrome-muted hover:bg-chrome-hover"
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
 *
 * The release key is not decoration: while you hold the terminal the bottom of
 * the screen is this bar rather than the app's navigation, and letting go is
 * how you get the rest of the app back.
 */
function ModifierBar({
  sticky,
  setSticky,
  onKey,
  onLetter,
  onPaste,
  onKeyboard,
  onRelease,
  onPickImage,
}: {
  sticky: { ctrl: boolean; alt: boolean; lock: "ctrl" | "alt" | null };
  setSticky: (s: { ctrl: boolean; alt: boolean; lock: "ctrl" | "alt" | null }) => void;
  onKey: (seq: string) => void;
  onLetter: (letter: string) => void;
  onPaste: () => void;
  onKeyboard: () => void;
  onRelease: () => void;
  onPickImage: () => void;
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
      {/* Twenty-two 44px keys: this one genuinely has to scroll, so it says
          so — ScrollX fades whichever edge still has keys behind it. */}
      <ScrollX className="flex items-center gap-1 px-2 py-1.5">
        <button
          aria-label="Release control"
          onClick={onRelease}
          className="flex h-11 shrink-0 items-center gap-1 rounded border border-border px-2 text-xs text-muted"
        >
          <Power className="w-4 h-4" />
          release
        </button>
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
          aria-label="Send an image"
          onClick={onPickImage}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded border border-border text-muted"
        >
          <ImageIcon className="w-4 h-4" />
        </button>
        <button
          aria-label="Show keyboard"
          onClick={onKeyboard}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded border border-border text-muted"
        >
          <Keyboard className="w-4 h-4" />
        </button>
      </ScrollX>
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
