import {
  HandoffPacket,
  type HandoffPacket as HandoffPacketT,
  type RelayEvent as RelayEventT,
} from "../../packages/shared";

export type Phase = "working" | "switching" | "resumed";
export type LineKind = "plain" | "muted" | "prompt" | "pass" | "fail" | "relay";
export interface Line {
  kind: LineKind;
  value: string;
}

function cleanActivity(text: string): string {
  const lines = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const latest = lines.at(-1) ?? "";
  if (/^Warning: no stdin data received in 3s/i.test(latest)) return "";
  return latest.length > 120 ? `${latest.slice(0, 117)}…` : latest;
}

/** Read a string-ish field off an event payload. */
function s(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
}

function provider(
  payload: Record<string, unknown>,
  key: string
): "claude" | "codex" | undefined {
  const value = payload[key];
  if (value === "claude" || value === "codex") return value;
  if (value && typeof value === "object" && "provider" in value) {
    const id = (value as { provider?: unknown }).provider;
    if (id === "claude" || id === "codex") return id;
  }
  return undefined;
}

function args(payload: Record<string, unknown>): string {
  const value = payload.args;
  return Array.isArray(value)
    ? value.filter((part): part is string => typeof part === "string").join(" ")
    : s(payload, "args") ?? "";
}

function metric(payload: Record<string, unknown>, key: string): number | undefined {
  const direct = payload[key];
  if (typeof direct === "number") return direct;
  const metrics = payload.metrics;
  if (metrics && typeof metrics === "object") {
    const nested = (metrics as Record<string, unknown>)[key];
    if (typeof nested === "number") return nested;
  }
  return undefined;
}

/** Render one RelayEvent as a terminal line. */
export function eventLine(e: RelayEventT): Line {
  const p = e.payload;
  switch (e.type) {
    case "session.started":
      return {
        kind: "prompt",
        value: `$ baton start — ${provider(p, "provider") ?? e.agent ?? "claude"}`,
      };
    case "agent.started":
      return { kind: "prompt", value: `$ ${e.agent ?? "agent"} running` };
    case "process.started":
      return {
        kind: "prompt",
        value: `$ ${[s(p, "command"), args(p)].filter(Boolean).join(" ") || "process"}`,
      };
    case "terminal.output": {
      // The process runner streams `{ stream, chunk }`; older sources use message/line.
      const text = s(p, "chunk") ?? s(p, "message") ?? s(p, "line") ?? "";
      return {
        kind: p.stream === "stderr" ? "fail" : "plain",
        value: text.replace(/\n+$/, ""),
      };
    }
    case "process.exited": {
      const ok = p.exitCode === 0;
      return {
        kind: ok ? "pass" : "fail",
        value: `${ok ? "✔" : "✖"} exited (code ${s(p, "exitCode") ?? "?"}${p.timedOut ? ", timed out" : ""})`,
      };
    }
    case "command.finished": {
      const ok = p.exitCode === 0;
      return {
        kind: ok ? "pass" : "fail",
        value: `${ok ? "✔" : "✖"} ${s(p, "command") ?? "command"} (exit ${s(p, "exitCode") ?? "?"})`,
      };
    }
    case "file.changed":
      return {
        kind: "plain",
        value: `● ${s(p, "path") ?? "file"}${p.additions != null ? `  +${s(p, "additions")}` : ""}`,
      };
    case "test.failed":
      return { kind: "fail", value: `✖ ${s(p, "command") ?? "test"} failed` };
    case "test.passed":
      return { kind: "pass", value: `✔ ${s(p, "command") ?? "tests"} passed` };
    case "limit.detected":
      return {
        kind: "fail",
        value: `✖ ${s(p, "reason") ?? "limit"}${s(p, "detail") ? ` — ${s(p, "detail")}` : ""}`,
      };
    case "handoff.started":
      return { kind: "relay", value: "↪ baton: building handoff" };
    case "workspace.frozen":
      return {
        kind: "relay",
        value: `↪ baton: workspace frozen · ${s(p, "changedFiles") ?? "?"} files`,
      };
    case "agent.routed":
      return {
        kind: "relay",
        value: `↪ baton: routed → ${provider(p, "to") ?? s(p, "provider") ?? "codex"}`,
      };
    case "handoff.distilling":
      return { kind: "relay", value: "↪ baton: distilling packet" };
    case "handoff.created": {
      const pct = metric(p, "reductionPercent");
      return {
        kind: "relay",
        value: `↪ baton: packet ready${typeof pct === "number" ? ` · −${Math.round(pct)}%` : ""}`,
      };
    }
    case "agent.launching":
      return {
        kind: "prompt",
        value: `$ ${provider(p, "target") ?? provider(p, "to") ?? "codex"} ${
          p.resumed ? "resume --packet" : "launch"
        }`,
      };
    case "agent.switched":
      return {
        kind: "relay",
        value: `↪ baton: switched ${provider(p, "from") ?? "claude"} → ${provider(p, "to") ?? "codex"}`,
      };
    case "handoff.failed":
      return {
        kind: "fail",
        value: `✖ baton handoff failed${s(p, "error") ? ` — ${s(p, "error")}` : ""}`,
      };
    case "session.completed":
      return { kind: "pass", value: "✔ session complete" };
    case "session.failed":
      return {
        kind: "fail",
        value: `✖ session failed${s(p, "error") ? ` — ${s(p, "error")}` : ""}`,
      };
    default:
      return { kind: "plain", value: `${e.type}` };
  }
}

/** Phase derived from the events seen so far. */
export function derivePhase(events: RelayEventT[]): Phase {
  const types = new Set(events.map((e) => e.type));
  const agents = new Set(
    events
      .map((e) => {
        if (e.agent === "claude" || e.agent === "codex") return e.agent;
        return provider(e.payload, "provider");
      })
      .filter((agent): agent is "claude" | "codex" => agent === "claude" || agent === "codex")
  );
  if (agents.size > 1) return "resumed";
  if (types.has("agent.switched") || types.has("session.completed")) return "resumed";
  if (
    types.has("handoff.started") ||
    types.has("workspace.frozen") ||
    types.has("handoff.distilling") ||
    types.has("handoff.created") ||
    types.has("limit.detected")
  )
    return "switching";
  return "working";
}

/** Whether a validated handoff packet has been produced. */
export function packetReady(events: RelayEventT[]): boolean {
  return events.some((e) => e.type === "handoff.created");
}

/** Latest complete packet carried by a handoff.created event, when available. */
export function latestHandoffPacket(
  events: RelayEventT[]
): HandoffPacketT | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== "handoff.created") continue;
    const parsed = HandoffPacket.safeParse(event.payload.packet);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** Migration/test verification state from the latest relevant test event. */
export function migrationState(events: RelayEventT[]): "pass" | "fail" | "pending" {
  let state: "pass" | "fail" | "pending" = "pending";
  for (const e of events) {
    if (e.type === "test.failed") state = "fail";
    else if (e.type === "test.passed" || e.type === "session.completed") state = "pass";
  }
  return state;
}

/** Active agent name from the stream (falls back to the source agent). */
export function activeAgent(events: RelayEventT[]): "claude" | "codex" {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "agent.switched") {
      const to = provider(e.payload, "to");
      if (to === "codex" || to === "claude") return to;
    }
    if (e.type === "agent.started") {
      const started = provider(e.payload, "provider");
      if (started === "codex" || started === "claude") return started;
    }
    if (e.agent === "codex" || e.agent === "claude") return e.agent;
  }
  return "claude";
}

/** Whether the current adapter supports input after launch. */
export function activeSupportsInput(events: RelayEventT[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== "agent.launching") continue;
    return event.payload.supportsInput === true;
  }
  return false;
}

/**
 * A calm, one-line answer to “what is Baton doing right now?”.
 *
 * Prefer semantic lifecycle events over dumping raw logs into the rail. A
 * terminal line is used only when it is the newest meaningful signal.
 */
export function currentActivity(
  events: RelayEventT[],
  fallback = "Ready for a task"
): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    const p = event.payload;
    switch (event.type) {
      case "session.failed":
        return s(p, "error") ? `Stopped — ${s(p, "error")}` : "Session failed";
      case "handoff.failed":
        return s(p, "error") ? `Handoff failed — ${s(p, "error")}` : "Handoff failed";
      case "session.completed":
        return "Task completed";
      case "test.passed":
        return `Verification passed — ${s(p, "command") ?? "tests"}`;
      case "test.failed":
        return `Verification failed — ${s(p, "command") ?? "tests"}`;
      case "agent.switched": {
        const target = provider(p, "to") ?? event.agent ?? "agent";
        return `${target === "codex" ? "Codex" : "Claude"} resumed from the handoff`;
      }
      case "agent.launching": {
        const target = provider(p, "target") ?? provider(p, "to") ?? "codex";
        return `${p.resumed ? "Resuming" : "Launching"} ${
          target === "codex" ? "Codex" : "Claude"
        }`;
      }
      case "handoff.created":
        return "Handoff packet ready";
      case "handoff.distilling":
        return "Compiling the smallest useful context";
      case "agent.routed": {
        const target = provider(p, "to") ?? provider(p, "provider") ?? "codex";
        return `Routing the task to ${target === "codex" ? "Codex" : "Claude"}`;
      }
      case "workspace.frozen":
        return "Freezing repository state";
      case "handoff.started":
        return "Building a safe handoff";
      case "limit.detected":
        return "Usage limit detected — preparing handoff";
      case "file.changed":
        return `Editing ${s(p, "path") ?? "a project file"}`;
      case "process.started": {
        const command = [s(p, "command"), args(p)].filter(Boolean).join(" ");
        return `Running ${command || "a command"}`;
      }
      case "agent.started": {
        const agent = event.agent ?? provider(p, "provider") ?? "agent";
        return `${agent === "codex" ? "Codex" : agent === "claude" ? "Claude" : "Agent"} is working`;
      }
      case "terminal.output": {
        const text = cleanActivity(
          s(p, "chunk") ?? s(p, "message") ?? s(p, "line") ?? ""
        );
        if (text) return text;
        break;
      }
      case "session.started":
        return fallback;
    }
  }
  return fallback;
}
