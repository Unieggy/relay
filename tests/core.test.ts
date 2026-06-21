import assert from "node:assert/strict";
import test from "node:test";
import { buildContinuationPrompt } from "../adapters/continuation";
import { extractSkeleton, formatSkeletons } from "../extract";
import {
  EvidenceBundle,
  HandoffPacket,
  RelayEvent,
  RelaySession,
} from "../packages/shared";

test("extractSkeleton keeps structural TypeScript lines and drops bodies", () => {
  const source = [
    'import { z } from "zod";',
    "const hidden = 1;",
    "export interface Config {",
    "  enabled: boolean;",
    "}",
    "export async function run(): Promise<void> {",
    "  console.log(hidden);",
    "}",
    "export type Result = { ok: boolean };",
  ].join("\n");

  assert.deepEqual(extractSkeleton(source), [
    'import { z } from "zod";',
    "export interface Config {",
    "export async function run(): Promise<void> {",
    "export type Result = { ok: boolean };",
  ]);
});

test("formatSkeletons labels each file and handles an empty snapshot", () => {
  assert.equal(
    formatSkeletons([
      { path: "a.ts", lines: ["export function a() {}"] },
      { path: "b.ts", lines: ["export interface B {}"] },
    ]),
    [
      "// FILE: a.ts",
      "export function a() {}",
      "",
      "// FILE: b.ts",
      "export interface B {}",
    ].join("\n")
  );
  assert.equal(
    formatSkeletons([]),
    "(no structural lines in changed TS files)"
  );
});

test("shared schemas validate evidence, events, and packet defaults", () => {
  const evidence = EvidenceBundle.parse({
    sessionId: "session-1",
    goal: "Resume safely",
    acceptanceCriteria: ["Tests pass"],
    branch: "feature",
    gitStatus: "",
    gitDiff: "",
    changedFiles: [],
    commands: [],
    latestFailure: null,
    relevantTerminalExcerpt: "",
  });
  assert.equal(evidence.goal, "Resume safely");

  const event = RelayEvent.parse({
    id: "event-1",
    sessionId: "session-1",
    type: "handoff.created",
    timestamp: "2026-06-20T00:00:00.000Z",
    payload: {},
  });
  assert.equal(event.type, "handoff.created");

  const packet = HandoffPacket.parse({
    version: "1.0",
    sessionId: "session-1",
    sourceAgent: "claude",
    targetAgent: "codex",
    trigger: "manual",
    task: { goal: "Resume safely", acceptanceCriteria: ["Tests pass"] },
    state: { status: "in_progress", summary: "Ready to continue" },
    evidence: {
      changedFiles: [],
      commands: [],
      latestFailure: null,
      diffSummary: [],
    },
    decisions: [],
    constraints: [],
    nextActions: ["Run tests"],
    verificationCommand: "npm test",
    metrics: {
      sourceTokens: 100,
      packetTokens: 20,
      reductionPercent: 80,
      confidence: 0.9,
    },
  });

  assert.deepEqual(packet.pitfalls, []);
  assert.deepEqual(packet.focusFiles, []);

  const session = RelaySession.parse({
    id: "session-1",
    state: "created",
    goal: "Resume safely",
    verificationCommand: "npm test",
    workspaceDir: "/tmp/relay",
    sourceAgent: "claude",
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
  });
  assert.deepEqual(session.acceptanceCriteria, []);
  assert.equal(session.targetAgent, null);
});

test("handoff schema rejects unsupported providers", () => {
  const result = HandoffPacket.safeParse({
    version: "1.0",
    sessionId: "session-1",
    sourceAgent: "gemini",
    targetAgent: "codex",
    trigger: "manual",
    task: { goal: "Resume", acceptanceCriteria: [] },
    state: { status: "in_progress", summary: "Ready" },
    evidence: {
      changedFiles: [],
      commands: [],
      latestFailure: null,
      diffSummary: [],
    },
    decisions: [],
    constraints: [],
    nextActions: [],
    verificationCommand: "npm test",
    metrics: {
      sourceTokens: 1,
      packetTokens: 1,
      reductionPercent: 0,
      confidence: 1,
    },
  });

  assert.equal(result.success, false);
});

test("continuation prompt preserves the packet's operational guardrails", () => {
  const packet = HandoffPacket.parse({
    version: "1.0",
    sessionId: "session-1",
    sourceAgent: "claude",
    targetAgent: "codex",
    trigger: "crash",
    task: { goal: "Finish migration", acceptanceCriteria: ["Tests pass"] },
    state: { status: "tests_failing", summary: "Migration is incomplete" },
    evidence: {
      changedFiles: ["migrate.ts"],
      commands: [{ command: "npm test", exitCode: 1 }],
      latestFailure: "duplicate column",
      diffSummary: ["Added migration"],
    },
    decisions: [],
    constraints: ["Migration must be idempotent"],
    nextActions: ["Guard the ALTER TABLE"],
    verificationCommand: "npm test",
    pitfalls: ["Do not rerun the ALTER TABLE without a schema guard"],
    focusFiles: [
      { path: "migrate.ts", role: "migration", state: "needs a guard" },
    ],
    metrics: {
      sourceTokens: 1000,
      packetTokens: 100,
      reductionPercent: 90,
      confidence: 0.95,
    },
  });

  const prompt = buildContinuationPrompt(packet);

  assert.match(prompt, /Do NOT redo completed work/);
  assert.match(prompt, /Do not rerun the ALTER TABLE without a schema guard/);
  assert.match(prompt, /"verificationCommand": "npm test"/);
});
