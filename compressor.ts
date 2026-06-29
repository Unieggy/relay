/**
 * RelayIDE — Distiller (EvidenceBundle → HandoffPacket)
 * ----------------------------------------------------
 * The Distiller's single input is an `EvidenceBundle` (+ `PacketMeta`); its
 * single output is a validated `HandoffPacket`. The orchestrator calls
 * `distill(evidence, meta)`; this file's `main()` is just a test harness that
 * builds those inputs from the mock workspace.
 *
 * Design:
 *  - The LLM produces only the reasoning subset (`DistilledClaims`); code fills
 *    the deterministic facts from `evidence` + `meta`.
 *  - Token-reduction `metrics` are computed and attached.
 *  - The packet is validated with `HandoffPacket.parse()` (Zod).
 *  - On any failure a DETERMINISTIC fallback packet is returned instead.
 *
 * Public API (for the orchestrator): `distill(evidence, meta)`.
 * Harness:  npx tsx compressor.ts ./relay-mock
 */

import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { collectEvidence, RuntimeContext } from "./evidence-collector";
import { CompressBackend } from "./contracts";
import { claudeAdapter } from "./adapters/claude";
import { codexAdapter } from "./adapters/codex";
import {
  EvidenceBundle,
  HandoffPacket,
  HandoffStatus,
  Decision,
  FocusFile,
  AgentId,
  HandoffTrigger,
} from "./packages/shared";

// ---------------------------------------------------------------------------
// Config (env-driven; the orchestrator supplies these as PacketMeta in prod)
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = path.resolve(process.argv[2] || process.cwd());
const MOCK_STDERR_FILE = path.join(WORKSPACE_DIR, "mock-stderr.log");
const MOCK_ASK_FILE = path.join(WORKSPACE_DIR, "mock-ask.txt");
const HANDOFF_FILE = path.join(WORKSPACE_DIR, ".relay_handoff.json");

const COMPRESSOR_MODEL =
  process.env.RELAY_COMPRESSOR_MODEL || "claude-sonnet-4-6";

const SESSION_ID = process.env.RELAY_SESSION_ID || "demo-session";
const SOURCE_AGENT = AgentId.parse(process.env.RELAY_SOURCE_AGENT || "claude");
const TARGET_AGENT = AgentId.parse(process.env.RELAY_TARGET_AGENT || "codex");
const TRIGGER = HandoffTrigger.parse(process.env.RELAY_TRIGGER || "manual");
const VERIFY_COMMAND = process.env.RELAY_VERIFY_CMD || "npm test";
const SOURCE_TOKENS_OVERRIDE = process.env.RELAY_SOURCE_TOKENS
  ? Number(process.env.RELAY_SOURCE_TOKENS)
  : null;

const COMPRESS_BACKEND_NAME = process.env.RELAY_COMPRESS_BACKEND || "claude";
const BACKENDS: Record<string, CompressBackend> = {
  claude: claudeAdapter.compress,
  codex: codexAdapter.compress,
};
const COMPRESS_BACKEND: CompressBackend =
  BACKENDS[COMPRESS_BACKEND_NAME] ?? claudeAdapter.compress;

// ---------------------------------------------------------------------------
// Distiller input/output contract
// ---------------------------------------------------------------------------

/** The deterministic facts the orchestrator supplies alongside the evidence. */
export interface PacketMeta {
  sessionId: string;
  sourceAgent: z.infer<typeof AgentId>;
  targetAgent: z.infer<typeof AgentId>;
  trigger: z.infer<typeof HandoffTrigger>;
  verificationCommand: string;
  sourceTokens: number; // the live session's token count (for the metric)
}

/** Optional runtime overrides for embedding and deterministic tests. */
export interface DistillOptions {
  backend?: CompressBackend;
  model?: string;
  cwd?: string;
}

/** What the model is asked to produce — the reasoning subset of the packet. */
const DistilledClaims = z.object({
  goal: z.string(),
  acceptanceCriteria: z.array(z.string()),
  status: HandoffStatus,
  summary: z.string(),
  decisions: z.array(Decision),
  constraints: z.array(z.string()),
  nextActions: z.array(z.string()),
  diffSummary: z.array(z.string()),
  pitfalls: z.array(z.string()),
  focusFiles: z.array(FocusFile),
  confidence: z.number(),
});
type DistilledClaims = z.infer<typeof DistilledClaims>;

// ---------------------------------------------------------------------------
// Prompt assembler (consumes the EvidenceBundle)
// ---------------------------------------------------------------------------

function assemblePrompt(ev: EvidenceBundle): string {
  const criteria = ev.acceptanceCriteria.length
    ? ev.acceptanceCriteria.map((c) => `- ${c}`).join("\n")
    : "(none provided — infer from the goal)";
  const commands = ev.commands.length
    ? ev.commands
        .map((c) => `$ ${c.command}  (exit ${c.exitCode})\n${c.output}`)
        .join("\n")
    : "(no commands recorded)";

  return `You are RelayIDE's distiller. A coding session is being handed off to a fresh agent that still has the full repo on disk. Analyse the evidence and produce a compressed handoff.

The fresh agent can run git and read any file itself, so do NOT restate file contents or the diff. Capture only what it cannot recover from disk: intent, status, decisions, the few files that matter, and — critically — what it must NOT do based on the failure.

Respond with ONE JSON object and NOTHING ELSE (no prose, no markdown fences) with EXACTLY these keys:
{
  "goal": "string — the objective, grounded in the ORIGINAL ASK; 1-3 sentences",
  "acceptanceCriteria": ["string — what 'done' means"],
  "status": "in_progress | blocked | tests_failing",
  "summary": "string — 1-3 sentences of current state for a cold start",
  "decisions": [{ "text": "a choice already made", "source": "user | repository | agent" }],
  "constraints": ["an invariant/rule to respect"],
  "nextActions": ["the concrete next step(s)"],
  "diffSummary": ["one short bullet per meaningful change in the diff"],
  "pitfalls": ["explicit 'do NOT do X' derived from the failure"],
  "focusFiles": [{ "path": "repo-relative", "role": "why it matters", "state": "its current condition" }],
  "confidence": 0.0
}
Rules: ground "goal" in the ORIGINAL ASK; use the diff to judge progress. "confidence" is your 0..1 certainty the handoff is complete and accurate. Keep every string tight.

=== ORIGINAL ASK ===
${ev.goal || "(none provided)"}

=== ACCEPTANCE CRITERIA ===
${criteria}

=== GIT DIFF ===
${ev.gitDiff || "(no unstaged changes)"}

=== RECENT COMMANDS ===
${commands}

=== LATEST FAILURE ===
${ev.latestFailure || "(none)"}

Output the JSON object now.`;
}

// ---------------------------------------------------------------------------
// JSON extraction (string-aware brace matching)
// ---------------------------------------------------------------------------

function extractJson(raw: string): unknown {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf("{");
  if (start === -1) throw new Error(`No JSON object found:\n${raw}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error(`Unbalanced JSON:\n${raw}`);
  return JSON.parse(text.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// Metrics (documented approximation)
// ---------------------------------------------------------------------------

/** ~4 chars/token approximation. Swap for a provider tokenizer for exact counts. */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function evidenceText(ev: EvidenceBundle): string {
  return [
    ev.goal,
    ev.gitDiff,
    ev.latestFailure ?? "",
    ...ev.commands.map((c) => c.output),
  ].join("\n");
}

function reduction(sourceTokens: number, packetTokens: number): number {
  return sourceTokens > 0
    ? Math.round((1 - packetTokens / sourceTokens) * 1000) / 10
    : 0;
}

// ---------------------------------------------------------------------------
// Packet assembly
// ---------------------------------------------------------------------------

function buildPacket(
  claims: DistilledClaims,
  ev: EvidenceBundle,
  meta: PacketMeta
): HandoffPacket {
  const core = {
    version: "1.0" as const,
    sessionId: meta.sessionId,
    sourceAgent: meta.sourceAgent,
    targetAgent: meta.targetAgent,
    trigger: meta.trigger,
    task: { goal: claims.goal, acceptanceCriteria: claims.acceptanceCriteria },
    state: { status: claims.status, summary: claims.summary },
    evidence: {
      changedFiles: ev.changedFiles,
      commands: ev.commands.map((c) => ({
        command: c.command,
        exitCode: c.exitCode,
      })),
      latestFailure: ev.latestFailure,
      diffSummary: claims.diffSummary,
    },
    decisions: claims.decisions,
    constraints: claims.constraints,
    nextActions: claims.nextActions,
    verificationCommand: meta.verificationCommand,
    pitfalls: claims.pitfalls,
    focusFiles: claims.focusFiles,
  };

  const packetTokens = approxTokens(JSON.stringify(core));
  return HandoffPacket.parse({
    ...core,
    metrics: {
      sourceTokens: meta.sourceTokens,
      packetTokens,
      reductionPercent: reduction(meta.sourceTokens, packetTokens),
      confidence: Math.max(0, Math.min(1, claims.confidence)),
    },
  });
}

/** Deterministic fallback — built WITHOUT the model when distillation fails. */
function buildFallbackPacket(ev: EvidenceBundle, meta: PacketMeta): HandoffPacket {
  const core = {
    version: "1.0" as const,
    sessionId: meta.sessionId,
    sourceAgent: meta.sourceAgent,
    targetAgent: meta.targetAgent,
    trigger: meta.trigger,
    task: {
      goal:
        ev.goal ||
        "(intent unavailable — distillation failed; infer the goal from the diff)",
      acceptanceCriteria: ev.acceptanceCriteria,
    },
    state: {
      status: "in_progress" as const,
      summary:
        "Deterministic fallback: the distillation model was unavailable. Treat the git diff and evidence as the source of truth.",
    },
    evidence: {
      changedFiles: ev.changedFiles,
      commands: ev.commands.map((c) => ({
        command: c.command,
        exitCode: c.exitCode,
      })),
      latestFailure: ev.latestFailure,
      diffSummary: ev.changedFiles.map((f) => `${f} changed`),
    },
    decisions: [],
    constraints: [],
    nextActions: [
      "Review the git diff to understand what was changed",
      `Run the verification command: ${meta.verificationCommand}`,
    ],
    verificationCommand: meta.verificationCommand,
    pitfalls: [],
    focusFiles: [],
  };

  const packetTokens = approxTokens(JSON.stringify(core));
  return HandoffPacket.parse({
    ...core,
    metrics: {
      sourceTokens: meta.sourceTokens,
      packetTokens,
      reductionPercent: reduction(meta.sourceTokens, packetTokens),
      confidence: 0.3,
    },
  });
}

// ---------------------------------------------------------------------------
// Public API — the orchestrator calls this
// ---------------------------------------------------------------------------

/** Optional overrides for a single `distill` call. */
export interface DistillOptions {
  /**
   * Override the compression backend. The orchestrator uses this to route
   * compression to a provider that is currently UP — never the one that just
   * rate-limited (you can't ask Claude to summarise its own 429). Defaults to
   * the env-selected backend.
   */
  backend?: CompressBackend;
  /** Override the compression model. Defaults to COMPRESSOR_MODEL. */
  model?: string;
  /** Working dir for the backend process. Defaults to WORKSPACE_DIR. */
  cwd?: string;
}

/** Distill an EvidenceBundle into a validated HandoffPacket. Never throws —
 *  on any failure it returns a deterministic fallback packet. */
export async function distill(
  evidence: EvidenceBundle,
  meta: PacketMeta,
  options: DistillOptions = {}
): Promise<HandoffPacket> {
  const backend = options.backend ?? COMPRESS_BACKEND;
  const model = options.model ?? COMPRESSOR_MODEL;
  const cwd = options.cwd ?? WORKSPACE_DIR;
  try {
    const prompt = assemblePrompt(evidence);
    const raw = await backend(prompt, { model, cwd });
    const claims = DistilledClaims.parse(extractJson(raw));
    return buildPacket(claims, evidence, meta);
  } catch (err) {
    console.warn(
      `[baton] ⚠️  distillation failed (${err instanceof Error ? err.message : err}) — using deterministic fallback.`
    );
    return buildFallbackPacket(evidence, meta);
  }
}

// ---------------------------------------------------------------------------
// Test harness — builds the inputs from the mock workspace
// ---------------------------------------------------------------------------

function readMock(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim() : "";
}

async function main(): Promise<void> {
  console.log(`[baton] workspace : ${WORKSPACE_DIR}`);

  // 1. Build the runtime context (in prod: from the live session).
  const stderr = readMock(MOCK_STDERR_FILE);
  const runtime: RuntimeContext = {
    sessionId: SESSION_ID,
    goal: readMock(MOCK_ASK_FILE),
    acceptanceCriteria: [],
    commands: [],
    latestFailure: stderr || null,
    relevantTerminalExcerpt: stderr,
  };

  // 2. Collect evidence (fresh git facts + the runtime context).
  console.log("[baton] collecting evidence…");
  const evidence = collectEvidence(WORKSPACE_DIR, runtime);
  console.log(
    `[baton]   branch: ${evidence.branch} | files: ${evidence.changedFiles.length} | ask: ${evidence.goal ? "yes" : "none"} | failure: ${evidence.latestFailure ? "yes" : "no"}`
  );

  // 3. Distill (the single-input contract the orchestrator uses).
  const meta: PacketMeta = {
    sessionId: SESSION_ID,
    sourceAgent: SOURCE_AGENT,
    targetAgent: TARGET_AGENT,
    trigger: TRIGGER,
    verificationCommand: VERIFY_COMMAND,
    sourceTokens: SOURCE_TOKENS_OVERRIDE ?? approxTokens(evidenceText(evidence)),
  };
  console.log(`[baton] distilling via ${COMPRESS_BACKEND_NAME} (${COMPRESSOR_MODEL})…`);
  const packet = await distill(evidence, meta);

  // 4. Write the handoff.
  fs.writeFileSync(HANDOFF_FILE, JSON.stringify(packet, null, 2) + "\n", "utf-8");

  const m = packet.metrics;
  console.log(
    `\n[baton] ✅ wrote ${HANDOFF_FILE}\n[baton]   ${m.sourceTokens} → ${m.packetTokens} tokens (${m.reductionPercent}% reduction, confidence ${m.confidence})\n`
  );
  console.log(JSON.stringify(packet, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\n[baton] ❌ distiller crashed:\n", err.message || err);
    process.exit(1);
  });
}
