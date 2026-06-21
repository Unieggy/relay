/**
 * Self-test for the WS test client — stands up a throwaway broadcaster, emits
 * one schema-valid RelayEvent, and asserts the client receives + validates it.
 * Proves the consumer contract independently of James's server, so when his
 * broadcaster lands the only variable is the server side.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { awaitFirstEvent, sessionUrl } from "./ws-test-client";

test("client resolves on the first schema-valid RelayEvent", async () => {
  const wss = new WebSocketServer({ port: 0 });
  const { port } = wss.address() as AddressInfo;

  wss.on("connection", (socket) => {
    // What a real broadcaster pushes: a normalized RelayEvent for the session.
    socket.send(
      JSON.stringify({
        id: "demo-session:8",
        sessionId: "demo-session",
        type: "agent.switched",
        timestamp: new Date().toISOString(),
        agent: "codex",
        payload: { from: "claude", to: "codex", model: "gpt-5-codex" },
      })
    );
  });

  try {
    const url = sessionUrl("demo-session", `ws://127.0.0.1:${port}`);
    const event = await awaitFirstEvent(url, { timeoutMs: 3000 });
    assert.equal(event.type, "agent.switched");
    assert.equal(event.sessionId, "demo-session");
    assert.equal(event.agent, "codex");
  } finally {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

test("client ignores noise and waits for a real event", async () => {
  const wss = new WebSocketServer({ port: 0 });
  const { port } = wss.address() as AddressInfo;

  wss.on("connection", (socket) => {
    socket.send("not json at all"); // ignored
    socket.send(JSON.stringify({ hello: "world" })); // valid JSON, not a RelayEvent → ignored
    socket.send(
      JSON.stringify({
        id: "demo-session:1",
        sessionId: "demo-session",
        type: "session.started",
        timestamp: new Date().toISOString(),
        payload: { model: "claude-opus-4-8" },
      })
    );
  });

  try {
    const url = sessionUrl("demo-session", `ws://127.0.0.1:${port}`);
    const event = await awaitFirstEvent(url, { timeoutMs: 3000 });
    assert.equal(event.type, "session.started");
  } finally {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});
