/**
 * Control routes API test — exercises the full session lifecycle over HTTP with
 * fake adapters and the in-memory store: create → claude/start → input → handoff
 * → codex/start → verify → diff → events, plus the key error mappings.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { createApiRouter } from "./index";
import { SessionManager } from "../session-manager";
import {
  Orchestrator,
  InMemoryEventStore,
  fallbackCreateHandoff,
} from "../orchestrator";
import { FakeAgentAdapter } from "../adapters/fake";

async function withApi(
  fn: (base: string) => Promise<void>
): Promise<void> {
  const sessions = new SessionManager();
  const orchestrator = new Orchestrator({
    sessions,
    store: new InMemoryEventStore(),
    adapters: {
      claude: () => new FakeAgentAdapter({ id: "claude" }),
      codex: () => new FakeAgentAdapter({ id: "codex" }),
    },
    createHandoff: fallbackCreateHandoff,
  });
  const server = http.createServer(createApiRouter({ sessions, orchestrator }));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const json = (method: string, body?: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

async function createSession(base: string): Promise<string> {
  const res = await fetch(`${base}/api/sessions`, json("POST", {
    goal: "Fix the failing auth redirect",
    verificationCommand: "exit 0",
    workspaceDir: process.cwd(),
  }));
  assert.equal(res.status, 201);
  return ((await res.json()) as { id: string }).id;
}

test("full lifecycle: claude/start → input → handoff → codex/start → verify", async () => {
  await withApi(async (base) => {
    const id = await createSession(base);

    const start = await fetch(`${base}/api/sessions/${id}/claude/start`, json("POST", {}));
    assert.equal(start.status, 202);

    const input = await fetch(`${base}/api/sessions/${id}/input`, json("POST", { data: "hint\n" }));
    assert.equal(input.status, 200);

    const handoff = await fetch(`${base}/api/sessions/${id}/handoff`, json("POST"));
    assert.equal(handoff.status, 200);
    const packet = (await handoff.json()) as { sourceAgent: string; targetAgent: string };
    assert.equal(packet.sourceAgent, "claude");
    assert.equal(packet.targetAgent, "codex");

    const codex = await fetch(`${base}/api/sessions/${id}/codex/start`, json("POST", {}));
    assert.equal(codex.status, 202);

    const verify = await fetch(`${base}/api/sessions/${id}/verify`, json("POST"));
    assert.equal(verify.status, 200);
    const result = (await verify.json()) as { passed: boolean };
    assert.equal(result.passed, true);

    const diff = await fetch(`${base}/api/sessions/${id}/diff`);
    assert.equal(diff.status, 200);
    const diffBody = (await diff.json()) as { branch: string; changedFiles: string[] };
    assert.ok(diffBody.branch.length > 0);

    const events = await fetch(`${base}/api/sessions/${id}/events`);
    assert.equal(events.status, 200);
    const eventsBody = (await events.json()) as { events: unknown[] };
    assert.ok(eventsBody.events.length > 0);
  });
});

test("input without data is a 400 validation_error", async () => {
  await withApi(async (base) => {
    const id = await createSession(base);
    await fetch(`${base}/api/sessions/${id}/claude/start`, json("POST", {}));
    const res = await fetch(`${base}/api/sessions/${id}/input`, json("POST", {}));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "validation_error");
  });
});

test("diff on an unknown session is a 404", async () => {
  await withApi(async (base) => {
    const res = await fetch(`${base}/api/sessions/nope/diff`);
    assert.equal(res.status, 404);
  });
});

test("wrong method on a control route is a 405", async () => {
  await withApi(async (base) => {
    const id = await createSession(base);
    const res = await fetch(`${base}/api/sessions/${id}/handoff`); // GET, expects POST
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  });
});
