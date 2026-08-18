import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, wsURL } from "./api";
import { qk } from "./queries";
import type { StreamEvent, Ticket } from "./types";

/**
 * `/ws/stream` carries ids and versions, never bodies: an event invalidates a
 * query and the body is fetched over HTTP, so there is exactly one source of
 * truth for an item's content.
 *
 * iOS suspends backgrounded web apps hard and the socket dies without a close
 * frame, so we don't fight it — we detect it on resume and reconnect at once,
 * ignoring the backoff.
 */
export type StreamState = "connecting" | "open" | "closed";

const MAX_BACKOFF = 30_000;

export function useStream(enabled: boolean): StreamState {
  const qc = useQueryClient();
  const [state, setState] = useState<StreamState>("closed");
  const socketRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    stoppedRef.current = false;

    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const schedule = () => {
      if (stoppedRef.current) return;
      const attempt = attemptRef.current++;
      const base = Math.min(1000 * 2 ** attempt, MAX_BACKOFF);
      const delay = base / 2 + Math.random() * (base / 2);
      clearTimer();
      timerRef.current = window.setTimeout(() => void connect(), delay);
    };

    const connect = async () => {
      if (stoppedRef.current) return;
      setState("connecting");
      let ticket: Ticket | undefined;
      try {
        ticket = await api.post<Ticket>("/api/v1/stream/ticket");
      } catch {
        setState("closed");
        schedule();
        return;
      }
      if (stoppedRef.current || !ticket?.ticket) {
        setState("closed");
        return;
      }

      const ws = new WebSocket(wsURL("/ws/stream", { ticket: ticket.ticket }));
      socketRef.current = ws;

      ws.onopen = () => {
        attemptRef.current = 0;
        setState("open");
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        let msg: StreamEvent;
        try {
          msg = JSON.parse(ev.data) as StreamEvent;
        } catch {
          return;
        }
        handle(msg);
      };
      ws.onclose = () => {
        socketRef.current = null;
        setState("closed");
        schedule();
      };
      ws.onerror = () => ws.close();
    };

    const handle = (msg: StreamEvent) => {
      switch (msg.type) {
        case "review.created":
        case "review.answered":
        case "review.updated":
          void qc.invalidateQueries({ queryKey: ["reviews"] });
          if (typeof msg.id === "string") {
            void qc.invalidateQueries({ queryKey: qk.review(msg.id) });
          }
          void qc.invalidateQueries({ queryKey: qk.bootstrap });
          break;
        case "agent.status":
          void qc.invalidateQueries({ queryKey: qk.agents });
          void qc.invalidateQueries({ queryKey: qk.herdrState });
          void qc.invalidateQueries({ queryKey: qk.bootstrap });
          break;
        case "counts":
          void qc.invalidateQueries({ queryKey: qk.bootstrap });
          break;
        default:
          break;
      }
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // The screen must be correct within one round trip, before the socket is back.
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
      void qc.invalidateQueries({ queryKey: ["reviews"] });
      void qc.invalidateQueries({ queryKey: qk.herdrState });
      if (socketRef.current?.readyState === WebSocket.OPEN) return;
      attemptRef.current = 0;
      clearTimer();
      void connect();
    };

    void connect();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stoppedRef.current = true;
      document.removeEventListener("visibilitychange", onVisible);
      clearTimer();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [enabled, qc]);

  return state;
}
