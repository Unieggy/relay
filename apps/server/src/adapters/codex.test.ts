/**
 * Codex adapter tests — driven against a fixture executable (never the real
 * `codex` CLI). Covers argv (prompt as positional + -C cwd, conditional -m),
 * stdin input forwarding, idempotent stop, a missing executable, exit-status
 * mapping, and manifest resume (packet in the argv).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodexAdapter } from "./codex";
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

test("builds the correct codex argv (prompt positional + -C cwd + -m model)", async () => {
  const { events, sink } = collect();
  const a = new CodexAdapter({ executable: FIXTURE });
  await a.start(
    { sessionId: "s", cwd: process.cwd(), model: "gpt-5-codex", prompt: "PROMPT-X" },
    sink
  );
  await waitFor(() => isTerminal(a.status()));
  const argv = parseArgv(outputText(events));
  assert.deepEqual(argv.slice(0, 3), ["exec", "--skip-git-repo-check", "--json"]);
  assert.deepEqual(argv.slice(3, 5), ["-m", "gpt-5-codex"]);
  assert.equal(argv[argv.indexOf("-C") + 1], process.cwd());
  assert.equal(argv.at(-1), "PROMPT-X"); // prompt is the positional arg
});

test("omits -m for a non-codex model", async () => {
  const { events, sink } = collect();
  const a = new CodexAdapter({ executable: FIXTURE });
  await a.start(
    { sessionId: "s", cwd: process.cwd(), model: "claude-opus-4-8", prompt: "x" },
    sink
  );
  await waitFor(() => isTerminal(a.status()));
  assert.equal(parseArgv(outputText(events)).includes("-m"), false);
});

test("forwards sendInput to stdin", async () => {
  const { events, sink } = collect();
  const a = new CodexAdapter({ executable: FIXTURE });
  await a.start({ sessionId: "s", cwd: process.cwd(), prompt: "go" }, sink);
  a.sendInput("INPUT-Y\n");
  await waitFor(() => isTerminal(a.status()));
  assert.match(outputText(events), /INPUT-Y/);
});

test("every emitted event carries the session id and the codex agent tag", async () => {
  const { events, sink } = collect();
  const a = new CodexAdapter({ executable: FIXTURE });
  await a.start({ sessionId: "sess-88", cwd: process.cwd(), prompt: "go" }, sink);
  await waitFor(() => isTerminal(a.status()));
  assert.ok(events.length > 0);
  for (const e of events) {
    assert.equal(e.sessionId, "sess-88");
    assert.equal(e.agent, "codex");
    assert.doesNotThrow(() => RelayEvent.parse(e));
  }
});

test("stop is safe and idempotent", async () => {
  const { sink } = collect();
  const a = new CodexAdapter({ executable: FIXTURE });
  await a.start({ sessionId: "s", cwd: process.cwd(), prompt: "go" }, sink);
  await a.stop();
  assert.equal(a.status(), "exited");
  await a.stop();
  assert.equal(a.status(), "exited");
});

test("a missing executable surfaces as failure", async () => {
  const { events, sink } = collect();
  const a = new CodexAdapter({ executable: "/no/such/relay-codex-bin" });
  await a.start({ sessionId: "s", cwd: process.cwd(), prompt: "go" }, sink);
  await waitFor(() => isTerminal(a.status()));
  assert.equal(a.status(), "failed");
  const exit = events.find((e) => e.type === "process.exited");
  assert.equal((exit!.payload as { exitCode: number | null }).exitCode, null);
});

test("exit-status mapping: 0 → exited, non-zero → failed", async () => {
  const ok = new CodexAdapter({ executable: FIXTURE });
  const okEvents = collect();
  await ok.start({ sessionId: "s", cwd: process.cwd(), prompt: "go" }, okEvents.sink);
  await waitFor(() => isTerminal(ok.status()));
  assert.equal(ok.status(), "exited");

  const bad = new CodexAdapter({ executable: FIXTURE, env: { FAKE_AGENT_EXIT: "5" } });
  const badEvents = collect();
  await bad.start({ sessionId: "s", cwd: process.cwd(), prompt: "go" }, badEvents.sink);
  await waitFor(() => isTerminal(bad.status()));
  assert.equal(bad.status(), "failed");
  const exit = badEvents.events.find((e) => e.type === "process.exited");
  assert.equal((exit!.payload as { exitCode: number | null }).exitCode, 5);
});

test("resumes from a manifest by feeding the packet into the argv prompt", async () => {
  const manifestPath = path.join(os.tmpdir(), `relay-codex-manifest-${Date.now()}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify({ marker: "RESUME-MARKER-999" }));
  try {
    const { events, sink } = collect();
    const a = new CodexAdapter({ executable: FIXTURE });
    await a.start({ sessionId: "s", cwd: process.cwd(), manifestPath }, sink);
    await waitFor(() => isTerminal(a.status()));
    assert.match(String(parseArgv(outputText(events)).at(-1)), /RESUME-MARKER-999/);
  } finally {
    fs.unlinkSync(manifestPath);
  }
});

test("capabilities advertise input + resume", () => {
  const caps = new CodexAdapter().capabilities();
  assert.equal(caps.id, "codex");
  assert.equal(caps.supportsInput, true);
  assert.equal(caps.supportsResume, true);
});
