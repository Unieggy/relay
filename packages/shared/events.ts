/**
 * RelayIDE — Relay Events (locked shared contract)
 * ------------------------------------------------
 * The normalized events that flow into the Redis timeline stream — the
 * "what happened" log that drives the UI timeline and survives a refresh.
 *
 * Emitted by: your collector / distiller / adapters (and the orchestrator).
 * Stored by:  the event-store (Redis) — NOT by your engine.
 * Consumed by: the UI's EventTimeline.
 */

import { z } from "zod";
import { AgentId } from "./common";

/** The canonical event names appended to the timeline. */
export const RELAY_EVENT_TYPES = [
  "session.started",
  "agent.started",
  "process.started",
  "terminal.output",
  "process.exited",
  "command.finished",
  "file.changed",
  "test.failed",
  "limit.detected", // a trigger fired (context_full / rate_limit / crash)
  "handoff.started",
  "workspace.frozen",
  "agent.routed",
  "handoff.distilling",
  "handoff.created",
  "agent.launching",
  "agent.switched",
  "switch.coalesced",
  "handoff.failed",
  "test.passed",
  "session.completed",
] as const;
export type RelayEventType = (typeof RELAY_EVENT_TYPES)[number];

export const RelayEvent = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: z.string(), // usually a RelayEventType; kept open for forward-compat
  timestamp: z.string(), // ISO 8601
  agent: AgentId.optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type RelayEvent = z.infer<typeof RelayEvent>;

/** Neutral event destination used by adapters, runners, broadcasters, and stores. */
export type RelayEventSink = (event: RelayEvent) => void;
