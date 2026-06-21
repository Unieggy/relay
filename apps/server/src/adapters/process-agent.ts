/**
 * Relay server — process-backed agent adapter (base)
 * --------------------------------------------------
 * Shared machinery for real agent adapters that run a CLI via the process
 * runner. A concrete adapter (Claude, Codex) only declares its identity,
 * capabilities, and how to turn `AgentStartOptions` into an argv + optional
 * stdin prompt; this base handles the lifecycle:
 *
 *   start      → build the launch plan, spawn via `startProcess`, forward the
 *                initial prompt, and track status from the process result.
 *   sendInput  → forward to the child's stdin.
 *   stop       → terminate safely (SIGTERM→SIGKILL) and wait for exit. Idempotent.
 *   status     → derived from the process lifecycle.
 *
 * Every emitted event is tagged with the session id and the agent id, because
 * `startProcess` stamps `sessionId` + `agent` onto each `RelayEvent`.
 */

import * as fs from "node:fs";
import {
  startProcess,
  type RelayProcessHandle,
  type ProcessResult,
} from "../process-runner";
import type { AgentId } from "../../../../packages/shared/common";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentStartOptions,
  AgentStatus,
  AgentUsage,
  RelayEventSink,
} from "./types";
import type { RelayEvent } from "../../../../packages/shared/events";

/** How a concrete adapter wants the process launched. */
export interface AgentLaunchPlan {
  command: string;
  args: string[];
  /** Written to the child's stdin right after start (e.g. Claude's prompt). */
  stdinPrompt?: string;
  /** Exact prompt text used for token estimation when it is not stdinPrompt. */
  promptForUsage?: string;
}

export interface ProcessAgentConfig {
  /** Override the executable — tests point this at a fixture binary. */
  executable?: string;
  /** Extra env merged over `process.env` (tests drive fixture behavior with it). */
  env?: NodeJS.ProcessEnv;
  /** Override the advertised model list. */
  models?: string[];
}

export abstract class ProcessAgentAdapter implements AgentAdapter {
  protected handle: RelayProcessHandle | null = null;
  protected state: AgentStatus = "idle";
  protected sessionId = "";
  protected outputChars = 0;
  protected promptChars = 0;
  protected observedTokens: number | null = null;

  /** The provider id stamped onto every event. */
  abstract readonly agent: AgentId;
  /** Default executable name when `config.executable` is not set. */
  protected abstract readonly defaultExecutable: string;

  constructor(protected readonly config: ProcessAgentConfig = {}) {}

  abstract capabilities(): AgentCapabilities;

  /** Turn start options into an argv (+ optional stdin prompt). */
  protected abstract plan(opts: AgentStartOptions): AgentLaunchPlan;

  protected get executable(): string {
    return this.config.executable ?? this.defaultExecutable;
  }

  /**
   * Build the spawn env. The child inherits `process.env`; a per-run `apiKey`
   * (from the UI) is mapped to the provider's variable. Returns undefined when
   * there is nothing to override, so the runner uses the plain inherited env.
   */
  protected spawnEnv(opts: AgentStartOptions): NodeJS.ProcessEnv | undefined {
    const keyVar =
      this.agent === "claude"
        ? "ANTHROPIC_API_KEY"
        : this.agent === "codex"
          ? "OPENAI_API_KEY"
          : null;
    const overrides: NodeJS.ProcessEnv = { ...this.config.env };
    if (opts.apiKey && keyVar) overrides[keyVar] = opts.apiKey;
    if (Object.keys(overrides).length === 0) return undefined;
    return { ...process.env, ...overrides };
  }

  status(): AgentStatus {
    return this.state;
  }

  usage(): AgentUsage {
    const tokens =
      this.observedTokens ??
      Math.ceil((this.promptChars + this.outputChars) / 4);
    return {
      tokens,
      window: this.capabilities().contextWindow ?? 200_000,
    };
  }

  async start(opts: AgentStartOptions, onEvent: RelayEventSink): Promise<void> {
    if (this.state === "starting" || this.state === "running") {
      throw new Error(`${this.agent} adapter is already started.`);
    }
    this.sessionId = opts.sessionId;
    this.state = "starting";

    let plan: AgentLaunchPlan;
    try {
      plan = this.plan(opts); // may read the manifest — throws before spawning
      this.promptChars = (plan.promptForUsage ?? plan.stdinPrompt ?? opts.prompt ?? "").length;
      this.outputChars = 0;
      this.observedTokens = null;
      const sink: RelayEventSink = (event) => {
        this.observeEvent(event);
        onEvent(event);
      };
      this.handle = startProcess(
        {
          sessionId: opts.sessionId,
          command: plan.command,
          args: plan.args,
          cwd: opts.cwd,
          agent: this.agent,
          env: this.spawnEnv(opts),
          // Headless Claude/Codex prompts live in argv. Explicitly attach
          // /dev/null so the CLIs do not pause and warn while waiting on stdin.
          stdin:
            plan.stdinPrompt !== undefined || this.capabilities().supportsInput
              ? "pipe"
              : "ignore",
        },
        sink
      );
    } catch (err) {
      this.state = "failed";
      throw err;
    }

    this.state = "running";

    // Track the final status off the process result.
    void this.handle.done
      .then((res: ProcessResult) => {
        this.state = finalStatus(res);
      })
      .catch(() => {
        this.state = "failed";
      });

    if (plan.stdinPrompt !== undefined) {
      this.handle.write(plan.stdinPrompt);
    }
  }

  sendInput(data: string): void {
    if (!this.capabilities().supportsInput) {
      throw new Error(`${this.agent} adapter is one-shot and does not support input.`);
    }
    if (this.state !== "running" || !this.handle) {
      throw new Error(`Cannot sendInput while status is "${this.state}".`);
    }
    this.handle.write(data);
  }

  async stop(): Promise<void> {
    if (!this.handle) {
      // Never started: mark terminal so callers see a consistent end state.
      if (this.state === "idle") this.state = "exited";
      return;
    }
    if (this.state === "exited" || this.state === "failed") return;
    this.handle.terminate("SIGTERM");
    await this.handle.done.catch(() => undefined);
  }

  /** Read a handoff manifest from disk; throws if unreadable. */
  protected readManifest(manifestPath: string): string {
    return fs.readFileSync(manifestPath, "utf8");
  }

  /**
   * Build the agent's opening prompt. With a `manifestPath` the handoff packet
   * is framed as a resume instruction; otherwise the raw prompt is used.
   */
  protected composePrompt(opts: AgentStartOptions): string {
    const base = opts.prompt ?? "";
    if (!opts.manifestPath) return base;
    return buildResumePrompt(this.readManifest(opts.manifestPath), base);
  }

  protected observeEvent(event: RelayEvent): void {
    if (event.type !== "terminal.output") return;
    const chunk = String((event.payload as { chunk?: unknown }).chunk ?? "");
    this.outputChars += chunk.length;
    this.observeTerminalChunk(chunk);
  }

  protected observeTerminalChunk(_chunk: string): void {
    /* provider-specific adapters can parse native usage events */
  }
}

/** Frame a handoff manifest as a continuation prompt for a resumed agent. */
export function buildResumePrompt(manifest: string, extra: string): string {
  const head =
    "Resume the unfinished task described by the Relay handoff packet below. " +
    "Treat the repository on disk as the source of truth and continue from where " +
    "the previous agent stopped; do not redo completed work.";
  const tail = extra ? `\n\n${extra}` : "";
  return `${head}\n\n[HANDOFF PACKET]\n${manifest}${tail}`;
}

/** Map a process result to a terminal agent status. */
function finalStatus(res: ProcessResult): AgentStatus {
  if (res.exitCode === 0) return "exited"; // clean finish
  if (res.signal !== null) return "exited"; // terminated (e.g. by stop())
  return "failed"; // non-zero exit or spawn failure (exitCode null, no signal)
}
