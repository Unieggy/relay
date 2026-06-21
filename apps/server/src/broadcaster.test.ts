/**
 * Broadcaster tests — proves a client that connects by session id receives a
 * schema-valid event over a real WebSocket, plus disconnect + validation safety.
 *
 * The WS cases use Node's global `WebSocket` client (an independent RFC 6455
 * implementation, same protocol a browser uses), which requires the
 * `--experimental-websocket` flag on Node < 22.4. When it's unavailable those
 * cases skip so the default `npm test` stays green; run them with:
 *
 *   node --experimental-websocket --import tsx --test src/broadcaster.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { SessionBroadcaster } from "./broadcaster";
import { RelayEvent } from "../../../packages/shared/events";

const WS_SKIP = typeof WebSocket === "undefined"
  ? "requires Node global WebSocket (run with --experimental-websocket)"
  : false;

async function listen(broadcaster: SessionBroadcaster): Promise<{
  server: http.Server;
  url: (sessionId: string) => string;
}> {
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  broadcaster.attach(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: (id) => `ws://127.0.0.1:${port}/ws/sessions/${id}` };
}

/** Poll until `predicate()` is true or time runs out. */
async function waitFor(predicate: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test(
  "a client connected by session id receives a schema-valid event",
  { skip: WS_SKIP },
  async () => {
    const broadcaster = new SessionBroadcaster();
    const { server, url } = await listen(broadcaster);
    const sessionId = "sess-abc";

    const ws = new WebSocket(url(sessionId));
    const received = new Promise<unknown>((resolve, reject) => {
      ws.addEventListener("message", (e) =>
        resolve(JSON.parse(e.data as string))
      );
      ws.addEventListener("error", () => reject(new Error("ws error")));
    });
    await new Promise<void>((resolve) =>
      ws.addEventListener("open", () => resolve())
    );
    // Connection is registered synchronously during the handshake; confirm.
    await waitFor(() => broadcaster.clientCount(sessionId) === 1);

    const emitted = broadcaster.emitDemoEvent(sessionId);
    const got = await received;

    assert.doesNotThrow(() => RelayEvent.parse(got)); // schema-valid on the wire
    const parsed = RelayEvent.parse(got);
    assert.equal(parsed.id, emitted.id);
    assert.equal(parsed.sessionId, sessionId);

    ws.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
);

test(
  "events are isolated per session id",
  { skip: WS_SKIP },
  async () => {
    const broadcaster = new SessionBroadcaster();
    const { server, url } = await listen(broadcaster);

    const a = new WebSocket(url("session-a"));
    await new Promise<void>((r) => a.addEventListener("open", () => r()));
    await waitFor(() => broadcaster.clientCount("session-a") === 1);

    let aGotForeign = false;
    a.addEventListener("message", () => (aGotForeign = true));

    // Emit to a *different* session that has no clients — a must not receive it.
    broadcaster.emitDemoEvent("session-b");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(aGotForeign, false);
    assert.equal(broadcaster.clientCount("session-b"), 0);

    a.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
);

test(
  "a disconnect is cleaned up and does not crash later broadcasts",
  { skip: WS_SKIP },
  async () => {
    const broadcaster = new SessionBroadcaster();
    const { server, url } = await listen(broadcaster);
    const sessionId = "sess-bye";

    const ws = new WebSocket(url(sessionId));
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    await waitFor(() => broadcaster.clientCount(sessionId) === 1);

    ws.close();
    await waitFor(() => broadcaster.clientCount(sessionId) === 0);

    // Broadcasting to a session with no clients is a safe no-op.
    assert.doesNotThrow(() => broadcaster.emitDemoEvent(sessionId));

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
);

test("broadcast rejects a payload that is not a schema-valid RelayEvent", () => {
  const broadcaster = new SessionBroadcaster();
  assert.throws(() => broadcaster.broadcast({ not: "an event" }));
});
