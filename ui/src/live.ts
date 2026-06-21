import { type RelayEvent as RelayEventT } from "../../packages/shared";

export type Phase = "working" | "switching" | "resumed";
export type LineKind = "plain" | "muted" | "prompt" | "pass" | "fail" | "relay";
export interface Line {
  kind: LineKind;
  value: string;
}

/** Read a string-ish field off an event payload. */
function s(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
}

/** Render one RelayEvent as a terminal line. */
export function eventLine(e: RelayEventT): Line {
  const p = e.payload;
  switch (e.type) {
    case "session.started":
      return { kind: "prompt", value: `$ relay start — ${e.agent ?? "claude"}` };
    case "agent.started":
      return { kind: "prompt", value: `$ ${e.agent ?? "agent"} running` };
    case "process.started":
      return {
        kind: "prompt",
        value: `$ ${[s(p, "command"), s(p, "args")].filter(Boolean).join(" ") || "process"}`,
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
      return { kind: "relay", value: "↪ relay: building handoff" };
    case "workspace.frozen":
      return {
        kind: "relay",
        value: `↪ relay: workspace frozen · ${s(p, "changedFiles") ?? "?"} files`,
      };
    case "agent.routed":
      return { kind: "relay", value: `↪ relay: routed → ${s(p, "to") ?? s(p, "provider") ?? "codex"}` };
    case "handoff.distilling":
      return { kind: "relay", value: "↪ relay: distilling packet" };
    case "handoff.created": {
      const pct = p.reductionPercent;
      return {
        kind: "relay",
        value: `↪ relay: packet ready${typeof pct === "number" ? ` · −${Math.round(pct)}%` : ""}`,
      };
    }
    case "agent.launching":
      return { kind: "prompt", value: `$ ${s(p, "to") ?? "codex"} resume --packet` };
    case "agent.switched":
      return {
        kind: "relay",
        value: `↪ relay: switched ${s(p, "from") ?? "claude"} → ${s(p, "to") ?? "codex"}`,
      };
    case "session.completed":
      return { kind: "pass", value: "✔ session complete" };
    default:
      return { kind: "plain", value: `${e.type}` };
  }
}

/** Phase derived from the events seen so far. */
export function derivePhase(events: RelayEventT[]): Phase {
  const types = new Set(events.map((e) => e.type));
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
      const to = e.payload.to;
      if (to === "codex" || to === "claude") return to;
    }
    if (e.agent === "codex" || e.agent === "claude") return e.agent;
  }
  return "claude";
}
