/**
 * Relay server — orchestrator (runtime coordinator)
 * -------------------------------------------------
 * The conductor of a session's runtime. It is the only component that starts or
 * stops agents, and it drives the session state machine while fanning every
 * `RelayEvent` to the event store and the broadcaster. It coordinates the
 * pieces but owns none of them — adapters, the evidence collector, the handoff
 * builder, the verifier, and the event store are all injected.
 *
 *   startClaude → claude_running
 *   sendInput   → forward to the live agent
 *   buildHandoff→ handoff_building → (collect evidence → createHandoff →
 *                 validate → save → emit) → handoff_ready
 *   startCodex  → codex_running   (resumes from the saved packet)
 *   verify      → verifying → completed | failed
 *
 * Built against the apps/server contracts (SessionManager, AgentAdapter, the
 * process runner) — it supersedes the root engine-prototype orchestrator.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  RelayEvent,
  type RelayEventType,
} from "../../../packages/shared/events";
import {
  HandoffPacket,
  type HandoffTrigger,
} from "../../../packages/shared/handoff";
import type { EvidenceBundle } from "../../../packages/shared/evidence";
import type { AgentId } from "../../../packages/shared/common";
import type { SessionManager } from "./session-manager";
import type { AgentAdapter, RelayEventSink } from "./adapters/types";
import { collectEvidence, collectGitFacts } from "./evidence-collector";
import { runVerification, type VerificationResult } from "./verifier";

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/** Metadata only the orchestrator knows, handed to the handoff builder. */
export interface HandoffMeta {
  sessionId: string;
  sourceAgent: AgentId;
  targetAgent: AgentId;
  trigger: HandoffTrigger;
  verificationCommand: string;
}

/** The handoff builder seam — Michael's `packages/context` provides the real one. */
export type CreateHandoff = (
  evidence: EvidenceBundle,
  meta: HandoffMeta
) => HandoffPacket | Promise<HandoffPacket>;

/**
 * The durable store the orchestrator depends on. Michael's
 * `apps/server/src/event-store.ts` (Redis) implements this; `InMemoryEventStore`
 * below is the fallback used for local dev and tests.
 */
export interface EventStore {
  appendEvent(sessionId: string, event: RelayEvent): void | Promise<void>;
  readEvents(sessionId: string): RelayEvent[] | Promise<RelayEvent[]>;
  saveHandoff(sessionId: string, packet: HandoffPacket): void | Promise<void>;
  loadHandoff(
    sessionId: string
  ): HandoffPacket | null | Promise<HandoffPacket | null>;
}

export interface OrchestratorDeps {
  sessions: SessionManager;
  /** Factory per provider — a fresh adapter instance per agent run. */
  adapters: Record<AgentId, () => AgentAdapter>;
  store: EventStore;
  createHandoff: CreateHandoff;
  /** Broadcaster sink — every event is forwarded here for live UI. */
  onEvent?: RelayEventSink;
  /** Verification runner (injectable for tests). Defaults to `runVerification`. */
  verify?: typeof runVerification;
}

interface SessionRuntime {
  provider: AgentId;
  adapter: AgentAdapter | null;
  terminal: string;
  latestFailure: string | null;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  private readonly runtime = new Map<string, SessionRuntime>();

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Start the first agent (Claude) on a freshly created session. */
  async startClaude(
    sessionId: string,
    opts: { model?: string; prompt?: string } = {}
  ): Promise<void> {
    await this.startAgent(sessionId, "claude", "claude_running", opts);
  }

  /** Forward input to the live agent's stdin. */
  sendInput(sessionId: string, data: string): void {
    const rt = this.runtime.get(sessionId);
    if (!rt?.adapter) throw new Error(`No live agent for session "${sessionId}".`);
    rt.adapter.sendInput(data);
  }

  /**
   * Build a handoff packet from current evidence and make the session ready for
   * the next agent. On any failure the session is moved to `failed` rather than
   * left in an inconsistent state.
   */
  async buildHandoff(sessionId: string): Promise<HandoffPacket> {
    const session = this.deps.sessions.get(sessionId);
    const rt = this.ensureRuntime(sessionId);
    this.deps.sessions.transition(sessionId, "handoff_building");
    this.emit(sessionId, "handoff.started", { from: rt.provider });

    try {
      // Detach the current agent before snapshotting the workspace.
      await rt.adapter?.stop();

      const evidence = collectEvidence(session.workspaceDir, {
        sessionId,
        goal: session.goal,
        acceptanceCriteria: session.acceptanceCriteria,
        latestFailure: rt.latestFailure,
        relevantTerminalExcerpt: rt.terminal,
      });

      const targetAgent: AgentId = rt.provider === "claude" ? "codex" : "claude";
      const packet = HandoffPacket.parse(
        await this.deps.createHandoff(evidence, {
          sessionId,
          sourceAgent: rt.provider,
          targetAgent,
          trigger: "manual",
          verificationCommand: session.verificationCommand,
        })
      );

      await this.deps.store.saveHandoff(sessionId, packet);
      this.deps.sessions.update(sessionId, { targetAgent });
      this.emit(sessionId, "handoff.created", {
        goal: packet.task.goal,
        targetAgent: packet.targetAgent,
        metrics: packet.metrics,
      });
      this.deps.sessions.transition(sessionId, "handoff_ready");
      return packet;
    } catch (err) {
      this.deps.sessions.transition(sessionId, "failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Resume the next agent (Codex) from the saved handoff packet. */
  async startCodex(
    sessionId: string,
    opts: { model?: string } = {}
  ): Promise<void> {
    const packet = await this.deps.store.loadHandoff(sessionId);
    if (!packet) {
      throw new Error(`No handoff packet saved for session "${sessionId}".`);
    }
    const manifestPath = path.join(
      os.tmpdir(),
      `relay-handoff-${sessionId}.json`
    );
    fs.writeFileSync(manifestPath, JSON.stringify(packet, null, 2));
    await this.startAgent(sessionId, "codex", "codex_running", {
      model: opts.model,
      manifestPath,
    });
  }

  /** Run the session's verification command and record the verdict. */
  async verify(sessionId: string): Promise<VerificationResult> {
    const session = this.deps.sessions.get(sessionId);
    const rt = this.ensureRuntime(sessionId);
    this.deps.sessions.transition(sessionId, "verifying");
    const verify = this.deps.verify ?? runVerification;
    const result = await verify(
      {
        sessionId,
        command: session.verificationCommand,
        cwd: session.workspaceDir,
        agent: rt.provider,
      },
      this.sink(sessionId)
    );
    this.deps.sessions.transition(
      sessionId,
      result.passed ? "completed" : "failed",
      result.passed ? undefined : { error: `verification failed (exit ${result.exitCode})` }
    );
    return result;
  }

  /** Current git diff + changed files for the session's workspace. */
  getDiff(sessionId: string): {
    branch: string;
    diff: string;
    changedFiles: string[];
  } {
    const session = this.deps.sessions.get(sessionId);
    const facts = collectGitFacts(session.workspaceDir);
    return {
      branch: facts.branch,
      diff: facts.gitDiff,
      changedFiles: facts.changedFiles,
    };
  }

  /** The ordered event timeline for a session. */
  async getEvents(sessionId: string): Promise<RelayEvent[]> {
    return this.deps.store.readEvents(sessionId);
  }

  // --- internals ----------------------------------------------------------

  private async startAgent(
    sessionId: string,
    provider: AgentId,
    targetState: "claude_running" | "codex_running",
    opts: { model?: string; prompt?: string; manifestPath?: string }
  ): Promise<void> {
    const session = this.deps.sessions.get(sessionId);
    const factory = this.deps.adapters[provider];
    if (!factory) throw new Error(`No adapter registered for "${provider}".`);

    const adapter = factory();
    const rt: SessionRuntime = { provider, adapter, terminal: "", latestFailure: null };
    this.runtime.set(sessionId, rt);

    this.deps.sessions.transition(sessionId, targetState);
    await adapter.start(
      {
        sessionId,
        cwd: session.workspaceDir,
        model: opts.model,
        prompt: opts.prompt ?? session.goal,
        manifestPath: opts.manifestPath,
      },
      this.sink(sessionId)
    );
  }

  private ensureRuntime(sessionId: string): SessionRuntime {
    let rt = this.runtime.get(sessionId);
    if (!rt) {
      // A session whose agent was started out-of-band; default to claude.
      rt = { provider: "claude", adapter: null, terminal: "", latestFailure: null };
      this.runtime.set(sessionId, rt);
    }
    return rt;
  }

  /** The wrapped sink: store → observe runtime evidence → broadcast. */
  private sink(sessionId: string): RelayEventSink {
    return (event) => {
      void this.deps.store.appendEvent(sessionId, event);
      this.observe(sessionId, event);
      this.deps.onEvent?.(event);
    };
  }

  private observe(sessionId: string, event: RelayEvent): void {
    const rt = this.runtime.get(sessionId);
    if (!rt) return;
    if (event.type === "terminal.output") {
      const chunk = String((event.payload as { chunk?: string }).chunk ?? "");
      rt.terminal = (rt.terminal + chunk).slice(-8000); // bounded tail
    }
    const exitCode = (event.payload as { exitCode?: number | null }).exitCode;
    if (
      event.type === "test.failed" ||
      (event.type === "process.exited" && typeof exitCode === "number" && exitCode !== 0)
    ) {
      rt.latestFailure = rt.terminal.slice(-2000) || `exit ${exitCode}`;
    }
  }

  private emit(
    sessionId: string,
    type: RelayEventType,
    payload: Record<string, unknown>
  ): void {
    this.sink(sessionId)(
      RelayEvent.parse({
        id: `evt-${randomUUID()}`,
        sessionId,
        type,
        timestamp: new Date().toISOString(),
        payload,
      })
    );
  }
}

// ---------------------------------------------------------------------------
// In-memory fallbacks (replaced by Michael's event-store + context package)
// ---------------------------------------------------------------------------

/** In-memory `EventStore` for local dev/tests. Same interface as Redis's. */
export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, RelayEvent[]>();
  private readonly handoffs = new Map<string, HandoffPacket>();

  appendEvent(sessionId: string, event: RelayEvent): void {
    const list = this.events.get(sessionId) ?? [];
    list.push(event);
    this.events.set(sessionId, list);
  }
  readEvents(sessionId: string): RelayEvent[] {
    return [...(this.events.get(sessionId) ?? [])];
  }
  saveHandoff(sessionId: string, packet: HandoffPacket): void {
    this.handoffs.set(sessionId, packet);
  }
  loadHandoff(sessionId: string): HandoffPacket | null {
    return this.handoffs.get(sessionId) ?? null;
  }
}

const approxTokens = (s: string): number => Math.ceil(s.length / 4);

/**
 * Deterministic placeholder handoff builder so the handoff route works before
 * Michael's `createFallbackHandoff` lands. Preserves the exact goal, changed
 * files, commands, latest failure, and verification command; generates a
 * concise next action by rule. Injected — swap for the real builder later.
 */
export const fallbackCreateHandoff: CreateHandoff = (evidence, meta) => {
  const status = evidence.latestFailure ? "tests_failing" : "in_progress";
  const summary = `${evidence.changedFiles.length} file(s) changed.${
    evidence.latestFailure ? " A failure is recorded." : ""
  }`;
  const nextActions = evidence.latestFailure
    ? ["Investigate the latest failure and make the failing check pass."]
    : ["Continue the task toward the stated goal."];
  const sourceTokens = approxTokens(JSON.stringify(evidence));

  const draft = {
    version: "1.0" as const,
    sessionId: meta.sessionId,
    sourceAgent: meta.sourceAgent,
    targetAgent: meta.targetAgent,
    trigger: meta.trigger,
    task: { goal: evidence.goal, acceptanceCriteria: evidence.acceptanceCriteria },
    state: { status, summary },
    evidence: {
      changedFiles: evidence.changedFiles,
      commands: evidence.commands.map((c) => ({
        command: c.command,
        exitCode: c.exitCode,
      })),
      latestFailure: evidence.latestFailure,
      diffSummary: evidence.changedFiles.map((f) => `changed: ${f}`),
    },
    decisions: [],
    constraints: [],
    nextActions,
    verificationCommand: meta.verificationCommand,
    metrics: { sourceTokens, packetTokens: 0, reductionPercent: 0, confidence: 0.3 },
    pitfalls: [],
    focusFiles: [],
  };
  const packetTokens = approxTokens(JSON.stringify(draft));
  draft.metrics.packetTokens = packetTokens;
  draft.metrics.reductionPercent =
    sourceTokens > 0
      ? Math.max(0, Math.round((1 - packetTokens / sourceTokens) * 1000) / 10)
      : 0;
  return HandoffPacket.parse(draft);
};
