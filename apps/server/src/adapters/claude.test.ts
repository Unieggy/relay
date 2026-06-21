/**
 * Claude adapter tests — driven against a fixture executable (never the real
 * `claude` CLI). Covers argv, stdin input forwarding, idempotent stop, a missing
 * executable, exit-status mapping, and manifest resume.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeAdapter } from "./claude";
import type { AgentStatus, RelayEventSink } from "./types";
import { RelayEvent } from "../../../../packages/shared/events";

const FIXTURE = path.join(__dirname, "__fixtures__", "fake-agent.js");

function collect(): { events: RelayEvent[]; sink: RelayEventSink } {
  const events: RelayEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}
const isTerminal = (s: AgentStatus): boolean => s === "exited" || s === "failed";
async function waitFor(p: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!p()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function outputText(events: RelayEvent[]): string {
  return events
    .filter((e) => e.type === "terminal.output")
    .map((e) => String((e.payload as { chunk?: string }).chunk))
    .join("");
}
function parseArgv(out: string): string[] {
  const m = /ARGV:(\[.*\])/.exec(out);
  return m ? (JSON.parse(m[1]!) as string[]) : [];
}

test("builds the correct claude argv (with model)", async () => {
  const { events, sink } = collect();
  const a = new ClaudeAdapter({ executable: FIXTURE });
  await a.start(
    { sessionId: "s", cwd: process.cwd(), model: "claude-opus-4-8", prompt: "go" },
    sink
  );
  await waitFor(() => isTerminal(a.status()));
  assert.deepEqual(parseArgv(outputText(events)), [
    "-p",
    "--output-format",
    "json",
    "--model",
    "claude-opus-4-8",
  ]);
});

test("omits --model when none is given", async () => {
  const { events, sink } = collect();
  const a = new ClaudeAdapter({ executable: FIXTURE });
  await a.start({ sessionId: "s", cwd: process.cwd() }, sink);
  await waitFor(() => isTerminal(a.status()));
  assert.deepEqual(parseArgv(outputText(events)), ["-p", "--output-format", "json"]);
});

test("forwards the prompt and sendInput to stdin", async () => {
  const { events, sink } = collect();
  const a = new ClaudeAdapter({ executable: FIXTURE });
  await a.start({ sessionId: "s", cwd: process.cwd(), prompt: "PROMPT-X" }, sink);
  a.sendInput("INPUT-Y\n");
  await waitFor(() => isTerminal(a.status()));
  const out = outputText(events);
  assert.match(out, /PROMPT-X/); // initial prompt reached stdin
  assert.match(out, /INPUT-Y/); // sendInput reached stdin
});

test("every emitted event carries the session id and the claude agent tag", async () => {
  const { events, sink } = collect();
  const a = new ClaudeAdapter({ executable: FIXTURE });
  await a.start({ sessionId: "sess-77", cwd: process.cwd() }, sink);
  await waitFor(() => isTerminal(a.status()));
  assert.ok(events.length > 0);
  for (const e of events) {
    assert.equal(e.sessionId, "sess-77");
    assert.equal(e.agent, "claude");
    assert.doesNotThrow(() => RelayEvent.parse(e));
  }
});

test("stop is safe and idempotent", async () => {
  const { sink } = collect();
  const a = new ClaudeAdapter({ executable: FIXTURE });
  await a.start({ sessionId: "s", cwd: process.cwd() }, sink);
  await a.stop();
  assert.equal(a.status(), "exited");
  await a.stop(); // no throw the second time
  assert.equal(a.status(), "exited");
});

test("a missing executable surfaces as failure", async () => {
  const { events, sink } = collect();
  const a = new ClaudeAdapter({ executable: "/no/such/relay-claude-bin" });
  await a.start({ sessionId: "s", cwd: process.cwd() }, sink);
  await waitFor(() => isTerminal(a.status()));
  assert.equal(a.status(), "failed");
  const exit = events.find((e) => e.type === "process.exited");
  assert.equal((exit!.payload as { exitCode: number | null }).exitCode, null);
});

test("exit-status mapping: 0 → exited, non-zero → failed", async () => {
  const ok = new ClaudeAdapter({ executable: FIXTURE });
  const okEvents = collect();
  await ok.start({ sessionId: "s", cwd: process.cwd() }, okEvents.sink);
  await waitFor(() => isTerminal(ok.status()));
  assert.equal(ok.status(), "exited");

  const bad = new ClaudeAdapter({ executable: FIXTURE, env: { FAKE_AGENT_EXIT: "2" } });
  const badEvents = collect();
  await bad.start({ sessionId: "s", cwd: process.cwd() }, badEvents.sink);
  await waitFor(() => isTerminal(bad.status()));
  assert.equal(bad.status(), "failed");
  const exit = badEvents.events.find((e) => e.type === "process.exited");
  assert.equal((exit!.payload as { exitCode: number | null }).exitCode, 2);
});

test("resumes from a manifest by feeding the packet to stdin", async () => {
  const manifestPath = path.join(os.tmpdir(), `relay-manifest-${Date.now()}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify({ marker: "RESUME-MARKER-123" }));
  try {
    const { events, sink } = collect();
    const a = new ClaudeAdapter({ executable: FIXTURE });
    await a.start({ sessionId: "s", cwd: process.cwd(), manifestPath }, sink);
    await waitFor(() => isTerminal(a.status()));
    assert.match(outputText(events), /RESUME-MARKER-123/);
  } finally {
    fs.unlinkSync(manifestPath);
  }
});

test("capabilities advertise input + resume", () => {
  const caps = new ClaudeAdapter().capabilities();
  assert.equal(caps.id, "claude");
  assert.equal(caps.supportsInput, true);
  assert.equal(caps.supportsResume, true);
});
