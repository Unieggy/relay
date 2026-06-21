/**
 * Relay — WebSocket test client (Syed-owned integration harness)
 * --------------------------------------------------------------
 * Connects to the server's session broadcaster (`WS /ws/sessions/:id`), and
 * resolves as soon as it receives the first message that validates as a shared
 * `RelayEvent`. This is the consumer half of James's broadcaster ticket — its
 * "done when Syed's test client receives a real event" gate.
 *
 * Library use (tests):  await awaitFirstEvent(url)
 * CLI use (manual):     npm run ws:client -- <sessionId> [baseUrl]
 *                       e.g. npm run ws:client -- demo-session
 *                            npm run ws:client -- demo-session ws://127.0.0.1:4000
 *
 * Non-JSON or non-RelayEvent frames are logged and ignored, so a stray keepalive
 * or banner won't end the wait — only a real, schema-valid event does.
 */

import WebSocket from "ws";
import { RelayEvent } from "./packages/shared";

const DEFAULT_BASE = "ws://127.0.0.1:4000";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface AwaitEventOptions {
  /** Reject if no valid event arrives within this window. */
  timeoutMs?: number;
  /** Called for every valid RelayEvent (the harness resolves on the first). */
  onEvent?: (event: RelayEvent) => void;
}

/** Build the canonical broadcaster URL for a session. */
export function sessionUrl(sessionId: string, base = DEFAULT_BASE): string {
  return `${base.replace(/\/$/, "")}/ws/sessions/${encodeURIComponent(sessionId)}`;
}

/** Connect, validate, and resolve with the first schema-valid RelayEvent. */
export function awaitFirstEvent(
  url: string,
  opts: AwaitEventOptions = {}
): Promise<RelayEvent> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<RelayEvent>((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;

    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      fn();
    };

    const timer = setTimeout(
      () => done(() => reject(new Error(`no RelayEvent within ${timeoutMs}ms`))),
      timeoutMs
    );

    ws.on("open", () => console.error(`[ws-client] connected → ${url}`));

    ws.on("message", (data: WebSocket.RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        console.error("[ws-client] ignoring non-JSON frame");
        return;
      }
      const result = RelayEvent.safeParse(parsed);
      if (!result.success) {
        console.error(
          `[ws-client] ignoring non-RelayEvent: ${result.error.issues[0]?.message ?? "invalid"}`
        );
        return;
      }
      opts.onEvent?.(result.data);
      done(() => resolve(result.data));
    });

    ws.on("error", (err) => done(() => reject(err)));
  });
}

/** CLI entry — run directly via `npm run ws:client -- <sessionId> [baseUrl]`. */
async function main(): Promise<void> {
  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error("usage: npm run ws:client -- <sessionId> [baseUrl]");
    process.exit(2);
  }
  const url = sessionUrl(sessionId, process.argv[3] ?? DEFAULT_BASE);
  console.error(`[ws-client] waiting for a RelayEvent on session "${sessionId}"…`);
  try {
    const event = await awaitFirstEvent(url);
    console.error("[ws-client] ✅ received a real RelayEvent:");
    console.log(JSON.stringify(event, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(`[ws-client] ❌ ${(err as Error).message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
