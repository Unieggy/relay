/**
 * Orchestrator tests — the full Claude → handoff → Codex → verify flow driven
 * with fake adapters and the in-memory store, so it never launches a real agent.
 * This is the Prompt 12 Definition of Done.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Orchestrator,
  InMemoryEventStore,
  fallbackCreateHandoff,
  type OrchestratorDeps,
} from "./orchestrator";
import { SessionManager } from "./session-manager";
import { FakeAgentAdapter } from "./adapters/fake";
import { HandoffPacket } from "../../../packages/shared/handoff";
import type { RelayEvent } from "../../../packages/shared/events";

function makeOrchestrator(over: Partial<OrchestratorDeps> = {}): {
  orch: Orchestrator;
  sessions: SessionManager;
  store: InMemoryEventStore;
  broadcast: RelayEvent[];
} {
  const sessions = new SessionManager();
  const store = new InMemoryEventStore();
  const broadcast: RelayEvent[] = [];
  const orch = new Orchestrator({
    sessions,
    store,
    adapters: {
      claude: () => new FakeAgentAdapter({ id: "claude" }),
      codex: () => new FakeAgentAdapter({ id: "codex" }),
    },
    createHandoff: fallbackCreateHandoff,
    onEvent: (e) => broadcast.push(e),
    ...over,
  });
  return { orch, sessions, store, broadcast };
}

const newSession = (sessions: SessionManager, verify = "exit 0") =>
  sessions.create({
    goal: "Fix the failing auth redirect",
    verificationCommand: verify,
    workspaceDir: process.cwd(),
  });

test("Claude → handoff → Codex → verify drives the full state machine", async () => {
  const { orch, sessions, store, broadcast } = makeOrchestrator();
  const s = newSession(sessions);

  await orch.startClaude(s.id, { prompt: "start" });
  assert.equal(sessions.get(s.id).state, "claude_running");

  orch.sendInput(s.id, "a hint\n");

  const packet = await orch.buildHandoff(s.id);
  assert.equal(sessions.get(s.id).state, "handoff_ready");
  assert.equal(packet.sourceAgent, "claude");
  assert.equal(packet.targetAgent, "codex");
  assert.doesNotThrow(() => HandoffPacket.parse(packet));
  assert.equal(packet.task.goal, "Fix the failing auth redirect");
  assert.equal(packet.verificationCommand, "exit 0");

  await orch.startCodex(s.id);
  assert.equal(sessions.get(s.id).state, "codex_running");

  const result = await orch.verify(s.id);
  assert.equal(result.passed, true);
  assert.equal(sessions.get(s.id).state, "completed");

  // The packet was persisted and the timeline captured the key milestones.
  assert.ok(await store.loadHandoff(s.id));
  const events = await orch.getEvents(s.id);
  assert.ok(events.some((e) => e.type === "handoff.created"));
  assert.ok(events.some((e) => e.type === "test.passed"));
  assert.ok(broadcast.length > 0, "events were broadcast");
});

test("a failing verification moves the session to failed", async () => {
  const { orch, sessions } = makeOrchestrator();
  const s = newSession(sessions, "exit 1");
  await orch.startClaude(s.id);
  await orch.buildHandoff(s.id);
  await orch.startCodex(s.id);
  const result = await orch.verify(s.id);
  assert.equal(result.passed, false);
  assert.equal(sessions.get(s.id).state, "failed");
});

test("a handoff-builder failure leaves the session in failed, not stuck", async () => {
  const { orch, sessions } = makeOrchestrator({
    createHandoff: () => {
      throw new Error("builder boom");
    },
  });
  const s = newSession(sessions);
  await orch.startClaude(s.id);
  await assert.rejects(() => orch.buildHandoff(s.id), /builder boom/);
  assert.equal(sessions.get(s.id).state, "failed");
});

test("getDiff returns git facts for the workspace", async () => {
  const { orch, sessions } = makeOrchestrator();
  const s = newSession(sessions);
  const diff = orch.getDiff(s.id);
  assert.ok(diff.branch.length > 0);
  assert.ok(Array.isArray(diff.changedFiles));
});

test("sendInput throws when no agent is live", () => {
  const { orch, sessions } = makeOrchestrator();
  const s = newSession(sessions);
  assert.throws(() => orch.sendInput(s.id, "x"), /No live agent/);
});
