/**
 * RelayIDE — Orchestrator
 * -----------------------
 * The conductor — the teammate-owned LOOP that drives the engine. It is the
 * ONLY component allowed to start or stop a session, and it never reaches into
 * Redis or the UI: it calls the engine's pure functions
 * (`collectEvidence` → `distill` → `adapter.launch`) and emits `RelayEvent`s for
 * whoever is listening (event-store / control tower).
 *
 * It is provider-neutral by construction: it holds a registry of
 * `ProviderAdapter`s and a `Router`, and never treats one provider as a "home
 * base". A "switch" is the same flow whether we're leaving Claude for Codex,
 * Codex for Claude, or anything else.
 *
 * The switch transaction (one transactional flow per trigger), matching the
 * "minimal end-to-end" in INTEGRATION.md:
 *
 *   freeze   → capture the workspace snapshot (git diff + changed files)
 *   route    → reason + snapshot → where to land (which provider/model)
 *   collect  → assemble the EvidenceBundle (fresh git facts + runtime context)
 *   distill  → EvidenceBundle → validated HandoffPacket (never throws)
 *   persist  → write the packet to .relay_handoff.json (what adapters resume from)
 *   launch   → boot a fresh session of the target, seeded with the packet
 *   resume   → retire the old session, adopt the new one as current
 *
 * Triggers feed in through a single door — `requestSwitch(reason)` — whether
 * they come from a live session's `onError` (rate limit / crash), a monitor
 * (context pressure), or a human (manual). The runtime facts a packet needs
 * (commands, the latest failure, terminal context) can't be re-pulled from git,
 * so the loop records them live via `recordCommand` / `recordFailure`.
 */

import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { captureWorkspace, WorkspaceSnapshot } from "./extract";
import { collectEvidence, RuntimeContext } from "./evidence-collector";
import { distill, PacketMeta } from "./compressor";
import {
  CompressBackend,
  LiveSession,
  ProviderAdapter,
  RouteTarget,
  Router,
  SwitchReason,
} from "./contracts";
import {
  AgentId,
  CommandResult,
  HandoffPacket,
  HandoffTrigger,
  RelayEvent,
} from "./packages/shared";

// ---------------------------------------------------------------------------
// Default router — a simple ordered fleet with failover
// ---------------------------------------------------------------------------

/**
 * The Router is "owned by the routing team" per the contract, but the
 * orchestrator must be runnable on its own, so this is the sensible default:
 * an ordered fleet of targets. A manual switch with an explicit target is
 * honoured verbatim; every other reason fails over to the first fleet member
 * that isn't the current provider (and falls back to staying put if the fleet
 * has nowhere else to go).
 */
export class FleetRouter implements Router {
  constructor(private readonly fleet: RouteTarget[]) {
    if (fleet.length === 0) {
      throw new Error("FleetRouter needs at least one RouteTarget.");
    }
  }

  route(
    reason: SwitchReason,
    ctx: { current: RouteTarget; snapshot: WorkspaceSnapshot }
  ): RouteTarget {
    if (reason.kind === "manual" && reason.target) return reason.target;

    const next = this.fleet.find((t) => t.provider !== ctx.current.provider);
    return next ?? ctx.current;
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export type OrchestratorPhase =
  | "idle" // constructed, no session yet
  | "running" // a session is live
  | "switching" // a switch transaction is in flight
  | "stopped"; // torn down

export interface OrchestratorOptions {
  /** The workspace every provider operates inside (the source of truth). */
  workspaceDir: string;
  /** The provider fleet. Order matters: it doubles as the failover order. */
  adapters: ProviderAdapter[];
  /** Routing policy. Defaults to a FleetRouter over the adapters' providers. */
  router?: Router;
  /** The original ask — the intent anchor that grounds every handoff packet. */
  goal: string;
  /** What "done" means; passed through to the distiller. */
  acceptanceCriteria?: string[];
  /** The focused command that proves completion. Default "npm test". */
  verificationCommand?: string;
  /** Session id stamped onto evidence + packets. Default is generated. */
  sessionId?: string;
  /** Where the handoff packet is written / read between sessions. */
  handoffPath?: string;
}

export class Orchestrator extends EventEmitter {
  private readonly workspaceDir: string;
  private readonly adapters: Map<string, ProviderAdapter>;
  private readonly router: Router;
  private readonly goal: string;
  private readonly acceptanceCriteria: string[];
  private readonly verificationCommand: string;
  private readonly sessionId: string;
  private readonly handoffPath: string;

  private phase: OrchestratorPhase = "idle";
  private current: LiveSession | null = null;
  private currentTarget: RouteTarget | null = null;
  private lastPacket: HandoffPacket | null = null;

  // Runtime facts git can't provide — recorded live as the agent runs.
  private commands: CommandResult[] = [];
  private latestFailure: string | null = null;
  private terminalExcerpt = "";

  /** Held while a switch runs so re-entrant triggers join it instead of racing. */
  private inFlight: Promise<LiveSession> | null = null;
  private eventSequence = 0;

  constructor(opts: OrchestratorOptions) {
    super();
    if (opts.adapters.length === 0) {
      throw new Error("Orchestrator needs at least one ProviderAdapter.");
    }
    this.workspaceDir = path.resolve(opts.workspaceDir);
    this.adapters = new Map(opts.adapters.map((a) => [a.provider, a]));
    this.router =
      opts.router ??
      new FleetRouter(
        opts.adapters.map((a) => ({ provider: a.provider, model: "" }))
      );
    this.goal = opts.goal;
    this.acceptanceCriteria = opts.acceptanceCriteria ?? [];
    this.verificationCommand = opts.verificationCommand ?? "npm test";
    this.sessionId = opts.sessionId ?? `relay-${Date.now()}`;
    this.handoffPath =
      opts.handoffPath ?? path.join(this.workspaceDir, ".relay_handoff.json");
  }

  // --- public surface -----------------------------------------------------

  /**
   * Adopt the first, already-running session. The engine's adapters only
   * `launch` from a handoff packet (resumption), so the cold-start session is
   * created by the runtime/terminal that spawned the agent; the orchestrator
   * takes ownership of it here and starts watching its signals.
   */
  start(initial: RouteTarget, session: LiveSession): LiveSession {
    if (this.phase !== "idle") {
      throw new Error(`Orchestrator already started (phase=${this.phase}).`);
    }
    this.adopt(session, initial);
    this.phase = "running";
    this.emitEvent("session.started", { target: initial });
    return session;
  }

  /**
   * The single door for every trigger. Idempotent under concurrency: if a
   * switch is already running, the caller joins the in-flight transaction
   * rather than kicking off a second one.
   */
  requestSwitch(reason: SwitchReason): Promise<LiveSession> {
    if (this.phase === "stopped") {
      return Promise.reject(new Error("Orchestrator is stopped."));
    }
    if (this.phase === "idle" || !this.current || !this.currentTarget) {
      return Promise.reject(
        new Error("Cannot switch before start() establishes a session.")
      );
    }
    if (this.inFlight) {
      this.emitEvent("switch.coalesced", { reason });
      return this.inFlight;
    }

    this.phase = "switching";
    this.emitEvent("handoff.started", { reason });

    this.inFlight = this.runSwitch(reason)
      .then((session) => {
        if (this.phase !== "stopped") this.phase = "running";
        return session;
      })
      .catch((err) => {
        if (this.phase !== "stopped") {
          // The old session is still the source of truth on failure.
          this.phase = "running";
          this.emitEvent("handoff.failed", {
            phase: "switch",
            error: errMessage(err),
          });
        }
        throw err;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  /** Record a command the live agent ran — feeds the next packet's evidence. */
  recordCommand(command: CommandResult): void {
    this.commands.push(command);
    if (command.exitCode !== null && command.exitCode !== 0) {
      this.latestFailure = command.output;
    }
  }

  /** Record the most recent failing output (a crash / 429 / failed test). */
  recordFailure(output: string): void {
    this.latestFailure = output;
  }

  /** Record bounded recent terminal context for the next packet. */
  recordTerminal(excerpt: string): void {
    this.terminalExcerpt = excerpt;
  }

  /** Current orchestrator state — feeds the control tower / health indicator. */
  getState(): {
    phase: OrchestratorPhase;
    current: RouteTarget | null;
    lastPacket: HandoffPacket | null;
  } {
    return {
      phase: this.phase,
      current: this.currentTarget,
      lastPacket: this.lastPacket,
    };
  }

  /** Tear everything down. Stops the live session and refuses further work. */
  stop(): void {
    if (this.phase === "stopped") return;
    try {
      this.current?.stop();
    } catch {
      /* a provider that's already dead is fine to "stop" */
    }
    this.current = null;
    this.phase = "stopped";
    this.emitEvent("session.completed", {});
    this.currentTarget = null;
  }

  // --- the switch transaction --------------------------------------------

  private async runSwitch(reason: SwitchReason): Promise<LiveSession> {
    const from = this.currentTarget!;
    const previous = this.current!;

    // 1. FREEZE — re-derive the workspace from git, the source of truth.
    const snapshot = captureWorkspace(this.workspaceDir);
    this.emitEvent("workspace.frozen", {
      changedFiles: snapshot.changedFiles,
      churn: snapshot.stats.additions + snapshot.stats.deletions,
    });

    // 2. ROUTE — decide where to land before distilling, so the packet's
    //    targetAgent names the real destination.
    const to = this.router.route(reason, { current: from, snapshot });
    this.adapterFor(to.provider); // validate the target is registered up front
    this.emitEvent("agent.routed", { from, to, reason });

    // 3. COLLECT — fresh git facts + the runtime context we recorded live.
    const runtime: RuntimeContext = {
      sessionId: this.sessionId,
      goal: this.goal,
      acceptanceCriteria: this.acceptanceCriteria,
      commands: this.commands,
      latestFailure: this.latestFailure,
      relevantTerminalExcerpt: this.terminalExcerpt,
    };
    const evidence = collectEvidence(this.workspaceDir, runtime);

    // 4. DISTILL — EvidenceBundle → validated HandoffPacket. Never throws: on
    //    any failure the engine returns a deterministic fallback packet, so a
    //    handoff is always produced.
    const meta: PacketMeta = {
      sessionId: this.sessionId,
      sourceAgent: AgentId.parse(from.provider),
      targetAgent: AgentId.parse(to.provider),
      trigger: toTrigger(reason),
      verificationCommand: this.verificationCommand,
      // The size being compressed — the live session's real token count.
      sourceTokens: previous.usage().tokens,
    };
    // Compress on a provider that is currently UP — never the one that just
    // failed (you can't ask a rate-limited provider to summarise its own 429).
    const { provider: compressProvider, backend } = this.pickCompressBackend(
      reason,
      from,
      to
    );
    this.emitEvent("handoff.distilling", {
      targetModel: to.model,
      compressProvider,
    });
    const packet = await distill(evidence, meta, { backend });
    this.lastPacket = packet;

    // 5. PERSIST — the packet on disk is exactly what the adapter resumes from.
    fs.writeFileSync(
      this.handoffPath,
      JSON.stringify(packet, null, 2) + "\n",
      "utf-8"
    );
    this.emitEvent("handoff.created", {
      handoffPath: this.handoffPath,
      goal: packet.task.goal,
      metrics: packet.metrics,
      packet,
    });

    // 6. LAUNCH — boot the fresh target seeded with the packet.
    this.emitEvent("agent.launching", { target: to });
    const next = await this.adapterFor(to.provider).launch({
      model: to.model,
      workspace: this.workspaceDir,
      manifestPath: this.handoffPath,
    });

    // stop() may have been called while launch was in flight. Never resurrect
    // a stopped orchestrator by adopting the newly-created session.
    if (this.phase === "stopped") {
      try {
        next.stop();
      } catch {
        /* a session can fail while being cancelled */
      }
      throw new Error("Orchestrator stopped while a switch was in flight.");
    }

    // 7. RESUME — only now retire the old session and adopt the new one. If
    //    launch had thrown above, we'd never have touched the still-live old
    //    session. A switch consumes the recorded runtime facts.
    try {
      previous.stop();
    } catch {
      /* old session already gone */
    }
    this.commands = [];
    this.latestFailure = null;
    this.terminalExcerpt = "";
    this.adopt(next, to);
    this.emitEvent("agent.switched", { from, to });
    return next;
  }

  // --- helpers ------------------------------------------------------------

  /**
   * Choose which provider performs the compression. The rule: never the one
   * that just failed. On a failure trigger (rate_limit / outage / crash) the
   * current provider is down, so we exclude it and prefer the destination
   * (which we just routed to and is therefore known-up). For benign triggers
   * (context_full / manual / cost) nothing is down, so the destination is used
   * uniformly. If somehow nothing is usable, we fall back to the destination
   * anyway — `distill`'s deterministic fallback is the real safety net.
   */
  private pickCompressBackend(
    reason: SwitchReason,
    from: RouteTarget,
    to: RouteTarget
  ): { provider: string; backend: CompressBackend } {
    const downProvider =
      reason.kind === "rate_limit" ||
      reason.kind === "outage" ||
      reason.kind === "crash"
        ? from.provider
        : undefined;

    const candidates = [to.provider, ...Array.from(this.adapters.keys())];
    for (const provider of candidates) {
      if (provider === downProvider) continue;
      const adapter = this.adapters.get(provider);
      if (adapter) return { provider, backend: adapter.compress };
    }
    const fb = this.adapterFor(to.provider);
    return { provider: fb.provider, backend: fb.compress };
  }

  private adapterFor(provider: string): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(
        `No adapter registered for provider "${provider}". ` +
          `Known: ${Array.from(this.adapters.keys()).join(", ") || "(none)"}.`
      );
    }
    return adapter;
  }

  /** Adopt a session as current and wire its error stream into the trigger door. */
  private adopt(session: LiveSession, target: RouteTarget): void {
    this.current = session;
    this.currentTarget = target;
    session.onError((e) => {
      // Ignore delayed errors from a session that has already been replaced or
      // stopped. Without this guard, an old provider can trigger a phantom
      // second switch after a successful handoff.
      if (this.phase === "stopped" || this.current !== session) return;

      // The engine's sessions surface structured signals ({ kind, detail }); a
      // raw Error is classified instead. Either way it's a switch trigger.
      const detail = signalDetail(e);
      if (detail) this.latestFailure = detail;
      this.requestSwitch(toSwitchReason(e)).catch(() => {
        /* the switch's own error event already reported this */
      });
    });
  }

  private emitEvent(type: string, payload: Record<string, unknown>): void {
    const parsedAgent = AgentId.safeParse(this.currentTarget?.provider);
    const event = RelayEvent.parse({
      id: `${this.sessionId}:${++this.eventSequence}`,
      sessionId: this.sessionId,
      type,
      timestamp: new Date().toISOString(),
      agent: parsedAgent.success ? parsedAgent.data : undefined,
      payload,
    });
    this.emit("event", event);
  }
}

// Strongly-typed event channel (declaration merge over EventEmitter). Every
// orchestrator emission is a single normalized `event` — the shape the Relay
// timeline / Redis stream consumes.
export type OrchestratorEvent = RelayEvent;
export interface Orchestrator {
  on(event: "event", listener: (e: OrchestratorEvent) => void): this;
  emit(event: "event", e: OrchestratorEvent): boolean;
}

// ---------------------------------------------------------------------------
// Trigger classification — raw signals → structured reasons / triggers
// ---------------------------------------------------------------------------

/** Map a SwitchReason to the packet's HandoffTrigger enum (the four spec'd). */
function toTrigger(reason: SwitchReason): HandoffTrigger {
  switch (reason.kind) {
    case "rate_limit":
      return "rate_limit";
    case "context_full":
      return "context_full";
    case "crash":
    case "outage": // outage has no trigger of its own — closest is "crash"
      return "crash";
    default: // cost | manual
      return "manual";
  }
}

/** Pull a human-readable detail string out of a session signal, if present. */
function signalDetail(e: unknown): string | null {
  if (e && typeof e === "object" && "detail" in e) {
    const d = (e as { detail?: unknown }).detail;
    if (typeof d === "string" && d) return d;
  }
  return null;
}

/**
 * Normalise whatever a session surfaces into a SwitchReason. The engine's
 * sessions already fire `{ kind, detail }` objects; anything else (a thrown
 * Error, a string) is pattern-matched.
 */
export function toSwitchReason(e: unknown): SwitchReason {
  if (e && typeof e === "object" && "kind" in e) {
    const kind = (e as { kind?: unknown }).kind;
    if (kind === "rate_limit") return { kind: "rate_limit" };
    if (kind === "context_full") return { kind: "context_full" };
    if (kind === "outage") return { kind: "outage" };
    if (kind === "crash") {
      return { kind: "crash", detail: signalDetail(e) ?? "session crashed" };
    }
  }
  return classifyError(e);
}

/** Map an opaque error into the structured reason the router expects. */
export function classifyError(err: unknown): SwitchReason {
  const msg = errMessage(err).toLowerCase();
  if (/rate.?limit|\b429\b|quota|too many requests/.test(msg)) {
    return { kind: "rate_limit" };
  }
  if (/context|token limit|maximum context|context length/.test(msg)) {
    return { kind: "context_full" };
  }
  if (/\b5\d\d\b|unavailable|timeout|econn|enotfound|network|outage/.test(msg)) {
    return { kind: "outage" };
  }
  return { kind: "crash", detail: errMessage(err) };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ---------------------------------------------------------------------------
// Demo harness — `npx tsx orchestrator.ts`
// ---------------------------------------------------------------------------
//
// Wires FAKE provider sessions to exercise the orchestrator loop end-to-end: a
// "Claude" session rate-limits, and the orchestrator freezes, routes to Codex,
// collects real git evidence, distills (the real engine — which falls back to a
// deterministic packet if no CLI is reachable), persists, and resumes —
// printing the timeline it would feed the UI. The fake adapters stand in for the
// real ones so the loop runs without spawning agent CLIs.

if (require.main === module) {
  const makeFakeSession = (
    provider: string,
    model: string,
    rateLimit = false
  ): LiveSession => {
    let errCb: (e: unknown) => void = () => {};
    if (rateLimit) {
      setTimeout(
        () => errCb({ kind: "rate_limit", detail: "API error 429: rate limit" }),
        50
      );
    }
    return {
      provider,
      model,
      usage: () => ({ tokens: 18420, window: 200000 }),
      onError: (cb) => {
        errCb = cb;
      },
      readTranscript: () => ({ ask: "fix the migration", tail: [] }),
      stop: () => {},
    };
  };

  const makeFakeAdapter = (provider: string): ProviderAdapter => ({
    provider,
    // distill now routes through the PICKED backend, so the fake returns valid
    // DistilledClaims and stamps which provider compressed — on a claude
    // rate-limit you'll see this run on codex, proving the steering works.
    compress: async () =>
      JSON.stringify({
        goal: "Make applyMigration idempotent and safe to re-run.",
        acceptanceCriteria: ["Running applyMigration twice does not error"],
        status: "blocked",
        summary: `Distilled by ${provider}: the age column may be half-applied after the crash.`,
        decisions: [
          { text: "Guard with a schema check before ALTER", source: "agent" },
        ],
        constraints: ["migrations are append-only"],
        nextActions: ["Add a PRAGMA table_info(users) check before ALTER TABLE"],
        diffSummary: ["migrate.ts: added MigrationResult + signature change"],
        pitfalls: [
          "Do NOT re-run the migration blindly — the column may already exist",
        ],
        focusFiles: [
          { path: "migrate.ts", role: "the file to fix", state: "missing the guard" },
        ],
        confidence: 0.9,
      }),
    launch: async (opts) =>
      makeFakeSession(provider, opts.model || `${provider}-default`),
  });

  const workspace = process.argv[2] || process.cwd();
  const orchestrator = new Orchestrator({
    workspaceDir: workspace,
    adapters: [makeFakeAdapter("claude"), makeFakeAdapter("codex")],
    router: new FleetRouter([
      { provider: "claude", model: "claude-opus-4-8" },
      { provider: "codex", model: "gpt-5-codex" },
    ]),
    goal: "Fix the users.age migration so it is safe to re-run.",
    verificationCommand: "npm test",
  });

  orchestrator.on("event", (e) => {
    console.log(`[baton] ${e.type.padEnd(18)} ${JSON.stringify(e.payload)}`);
  });

  (async () => {
    console.log("[baton] adopting a live claude session…");
    // The runtime spawned the first agent; the orchestrator adopts it. This one
    // rate-limits on its own, which trips the switch.
    orchestrator.start(
      { provider: "claude", model: "claude-opus-4-8" },
      makeFakeSession("claude", "claude-opus-4-8", /* rateLimit */ true)
    );
    await new Promise((r) => setTimeout(r, 1500));
    console.log("[baton] final state:", orchestrator.getState().current);
    orchestrator.stop();
  })().catch((err) => {
    console.error("[baton] demo failed:", err);
    process.exit(1);
  });
}
