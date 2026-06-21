import { useEffect, useState } from "react";
import { RelayEvent, type RelayEvent as RelayEventT } from "../../packages/shared";

export type StreamStatus = "idle" | "connecting" | "open" | "closed" | "error";

export interface RelayStream {
  events: RelayEventT[];
  status: StreamStatus;
}

/**
 * Subscribe to the server's session broadcaster (`WS /ws/sessions/:id`) and
 * accumulate every frame that validates as a shared `RelayEvent`. Non-event
 * frames are ignored. Returns idle (no socket) when `sessionId` is null, so the
 * UI falls back to its fixture demo when not running live.
 */
export function useRelayStream(
  sessionId: string | null,
  base = "ws://127.0.0.1:4000"
): RelayStream {
  const [events, setEvents] = useState<RelayEventT[]>([]);
  const [status, setStatus] = useState<StreamStatus>("idle");

  useEffect(() => {
    if (!sessionId) {
      setStatus("idle");
      return;
    }
    setEvents([]);
    setStatus("connecting");

    const url = `${base.replace(/\/$/, "")}/ws/sessions/${encodeURIComponent(sessionId)}`;
    const ws = new WebSocket(url);

    ws.onopen = () => setStatus("open");
    ws.onmessage = (e) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const result = RelayEvent.safeParse(parsed);
      if (result.success) setEvents((prev) => [...prev, result.data]);
    };
    ws.onerror = () => setStatus("error");
    ws.onclose = () => setStatus((s) => (s === "error" ? s : "closed"));

    return () => ws.close();
  }, [sessionId, base]);

  return { events, status };
}
