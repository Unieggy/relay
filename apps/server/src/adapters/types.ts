/**
 * Relay server — agent-adapter contract
 * -------------------------------------
 * The neutral seam the orchestrator drives. Every coding agent (Claude, Codex,
 * a test fake) is just an `AgentAdapter`: the orchestrator calls `start` /
 * `sendInput` / `stop` / `status` / `capabilities` and never special-cases a
 * provider. Adapters surface everything that happens as schema-valid
 * `RelayEvent`s through the injected sink, so the orchestrator monitors the run
 * without knowing how the agent is implemented.
 *
 * This ticket defines the contract + a fake. The real Claude/Codex adapters
 * implement this interface in a later ticket (typically by wrapping the
 * process runner).
 */

import type { RelayEventSink } from "../../../../packages/shared";

export type { RelayEventSink } from "../../../../packages/shared";

/** Lifecycle of a single agent run. */
export type AgentStatus = "idle" | "starting" | "running" | "exited" | "failed";

/** Static description of what an adapter can do — read before driving it. */
export interface AgentCapabilities {
  /** Stable provider id, e.g. "claude" | "codex" | "fake". */
  readonly id: string;
  readonly displayName: string;
  /** Accepts `sendInput` after `start`. */
  readonly supportsInput: boolean;
  /** Can resume from a handoff manifest (`AgentStartOptions.manifestPath`). */
  readonly supportsResume: boolean;
  /** Models this adapter can run (may be empty). */
  readonly models: readonly string[];
  /** Provider context window used by the proactive context-pressure trigger. */
  readonly contextWindow?: number;
}

export interface AgentUsage {
  /** Best available tokens currently represented by this run. */
  readonly tokens: number;
  /** Model context window for the current provider/model. */
  readonly window: number;
}

export interface AgentStartOptions {
  sessionId: string;
  /** Working directory the agent operates in (the repo). */
  cwd: string;
  model?: string;
  /** Resume from this handoff packet instead of cold-starting. */
  manifestPath?: string;
  /** Initial instruction / prompt. */
  prompt?: string;
}

/**
 * One agent run. An adapter instance manages a single agent lifecycle: `start`
 * boots it, `sendInput`/`stop` drive it, `status` reports where it is, and
 * `capabilities` describes it. All output + lifecycle is emitted via the sink
 * passed to `start`.
 */
export interface AgentAdapter {
  /** Describe the adapter (safe to call any time). */
  capabilities(): AgentCapabilities;
  /** Boot the agent in `opts.cwd`; resolves once it is running. */
  start(opts: AgentStartOptions, onEvent: RelayEventSink): Promise<void>;
  /** Send a chunk to the running agent's stdin. */
  sendInput(data: string): void;
  /** Current lifecycle status. */
  status(): AgentStatus;
  /** Best-effort usage meter for proactive context-pressure triggers. */
  usage(): AgentUsage;
  /** Stop the agent safely. Idempotent. */
  stop(): Promise<void>;
}
