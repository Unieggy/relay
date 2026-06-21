/**
 * Agent-adapter contract tests. The headline case proves the orchestrator can
 * drive the fake purely through the `AgentAdapter` interface — it never sees the
 * concrete type — which is the ticket's Definition of Done.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeAgentAdapter } from "./fake";
import type { AgentAdapter } from "./types";
import { RelayEvent } from "../../../../packages/shared/events";

/**
 * A stand-in for the orchestrator: it only knows the `AgentAdapter` interface.
 * If this drives the fake to completion, any adapter implementing the contract
 * works the same way.
 */
async function orchestrate(
  adapter: AgentAdapter,
  onEvent: (e: RelayEvent) => void
): Promise<void> {
  const caps = adapter.capabilities();
  assert.equal(adapter.status(), "idle");

  await adapter.start(
    { sessionId: "sess-1", cwd: process.cwd(), model: caps.models[0] },
    onEvent
  );
  assert.equal(adapter.status(), "running");

  if (caps.supportsInput) adapter.sendInput("continue\n");

  await adapter.stop();
  assert.equal(adapter.status(), "exited");
}

test("orchestrator drives an adapter through the interface without knowing its type", async () => {
  const events: RelayEvent[] = [];
  const adapter: AgentAdapter = new FakeAgentAdapter(); // typed only as the contract

  await orchestrate(adapter, (e) => events.push(e));

  const types = events.map((e) => e.type);
  assert.ok(types.includes("agent.started"), "emits agent.started");
  assert.ok(types.includes("terminal.output"), "streams output");
  assert.equal(types.at(-1), "process.exited", "ends with process.exited");
  // Every emitted event is schema-valid on the wire.
  for (const e of events) assert.doesNotThrow(() => RelayEvent.parse(e));
});

test("sendInput is recorded + echoed, and rejected when not running", async () => {
  const events: RelayEvent[] = [];
  const fake = new FakeAgentAdapter();

  assert.throws(() => fake.sendInput("too early"), /Cannot sendInput/);

  await fake.start({ sessionId: "s2", cwd: process.cwd() }, (e) => events.push(e));
  fake.sendInput("hello\n");
  assert.deepEqual(fake.received, ["hello\n"]);
  const echoed = events.some(
    (e) => e.type === "terminal.output" && String((e.payload as { chunk?: string }).chunk).includes("echo: hello")
  );
  assert.ok(echoed, "input is echoed as terminal.output");

  await fake.stop();
  assert.throws(() => fake.sendInput("after stop"), /Cannot sendInput/);
});

test("capabilities describe input/resume/models and are configurable", () => {
  const fake = new FakeAgentAdapter({
    id: "fake",
    models: ["m1", "m2"],
    supportsResume: false,
  });
  const caps = fake.capabilities();
  assert.equal(caps.id, "fake");
  assert.equal(caps.supportsInput, true);
  assert.equal(caps.supportsResume, false);
  assert.deepEqual([...caps.models], ["m1", "m2"]);
});

test("stop is idempotent and safe before start", async () => {
  const fake = new FakeAgentAdapter();
  await fake.stop(); // never started — no throw
  assert.equal(fake.status(), "exited");
  await fake.stop(); // again — still fine
  assert.equal(fake.status(), "exited");
});
