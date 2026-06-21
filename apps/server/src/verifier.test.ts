/**
 * Verifier tests — harmless shell commands prove pass/fail comes from the exit
 * code (never prose) and that the right verdict event is emitted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runVerification } from "./verifier";
import type { RelayEvent } from "../../../packages/shared/events";

test("a zero-exit command passes and emits test.passed", async () => {
  const events: RelayEvent[] = [];
  const result = await runVerification(
    { sessionId: "s", command: "echo all-good", cwd: process.cwd() },
    (e) => events.push(e)
  );
  assert.equal(result.passed, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /all-good/);
  assert.ok(events.some((e) => e.type === "test.passed"));
  assert.ok(!events.some((e) => e.type === "test.failed"));
});

test("a non-zero command fails and emits test.failed (prose ignored)", async () => {
  const events: RelayEvent[] = [];
  // Prints a reassuring lie to stdout, then exits non-zero. Verdict must follow
  // the exit code, not the text.
  const result = await runVerification(
    { sessionId: "s", command: "echo 'all tests passed'; exit 1", cwd: process.cwd() },
    (e) => events.push(e)
  );
  assert.equal(result.passed, false);
  assert.equal(result.exitCode, 1);
  assert.ok(events.some((e) => e.type === "test.failed"));
});

test("verdict event carries the real exit code", async () => {
  const events: RelayEvent[] = [];
  await runVerification(
    { sessionId: "s", command: "exit 7", cwd: process.cwd() },
    (e) => events.push(e)
  );
  const verdict = events.find((e) => e.type === "test.failed");
  assert.equal((verdict!.payload as { exitCode: number }).exitCode, 7);
});
