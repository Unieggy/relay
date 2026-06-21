/**
 * Relay server — fake agent adapter
 * ---------------------------------
 * A deterministic, in-memory `AgentAdapter` for tests and local wiring. It does
 * NOT spawn a real process or call any provider CLI — it emits schema-valid
 * `RelayEvent`s and tracks its own lifecycle, so the orchestrator can be
 * exercised end-to-end without Claude or Codex.
 */

import { randomUUID } from "node:crypto";
import { RelayEvent } from "../../../../packages/shared/events";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentStartOptions,
  AgentStatus,
  RelayEventSink,
} from "./types";

export interface FakeAgentOptions {
  id?: string;
  displayName?: string;
  models?: string[];
  supportsInput?: boolean;
  supportsResume?: boolean;
}

export class FakeAgentAdapter implements AgentAdapter {
  private state: AgentStatus = "idle";
  private sink: RelayEventSink = () => {};
  private sessionId = "";
  private readonly caps: AgentCapabilities;

  /** Inputs received via `sendInput`, exposed for test assertions. */
  readonly received: string[] = [];

  constructor(opts: FakeAgentOptions = {}) {
    this.caps = {
      id: opts.id ?? "fake",
      displayName: opts.displayName ?? "Fake Agent",
      supportsInput: opts.supportsInput ?? true,
      supportsResume: opts.supportsResume ?? true,
      models: opts.models ?? ["fake-1"],
    };
  }

  capabilities(): AgentCapabilities {
    return this.caps;
  }

  status(): AgentStatus {
    return this.state;
  }

  async start(opts: AgentStartOptions, onEvent: RelayEventSink): Promise<void> {
    if (this.state === "starting" || this.state === "running") {
      throw new Error("FakeAgentAdapter is already started.");
    }
    this.sink = onEvent;
    this.sessionId = opts.sessionId;
    this.state = "starting";
    this.emit("agent.started", {
      provider: this.caps.id,
      model: opts.model ?? this.caps.models[0] ?? "",
      cwd: opts.cwd,
      resumed: Boolean(opts.manifestPath),
    });
    if (opts.prompt) {
      this.emit("terminal.output", {
        stream: "stdout",
        chunk: `fake received prompt: ${opts.prompt}\n`,
      });
    }
    this.state = "running";
  }

  sendInput(data: string): void {
    if (this.state !== "running") {
      throw new Error(`Cannot sendInput while status is "${this.state}".`);
    }
    this.received.push(data);
    this.emit("terminal.output", { stream: "stdout", chunk: `echo: ${data}` });
  }

  async stop(): Promise<void> {
    if (this.state === "exited") return;
    const wasLive = this.state === "running" || this.state === "starting";
    this.state = "exited";
    if (wasLive) {
      this.emit("process.exited", { exitCode: 0, signal: null });
    }
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    this.sink(
      RelayEvent.parse({
        id: `evt-${randomUUID()}`,
        sessionId: this.sessionId,
        type,
        timestamp: new Date().toISOString(),
        payload,
      })
    );
  }
}
