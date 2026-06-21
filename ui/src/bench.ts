import { type RelayEvent as RelayEventT } from "../../packages/shared";

/**
 * RelayBench — compares a continuation WITHOUT Relay against one WITH Relay.
 *
 * Hard rule: record measured values only. Anything we did not actually measure
 * is `null` and renders as "not measured" — never an invented number. We have
 * no baseline (no-Relay) run instrumented, so that column is honestly empty.
 */

export interface BenchRow {
  label: string;
  /** Measured no-Relay value, or null when not measured. */
  without: string | null;
  /** Measured with-Relay value, or null when not measured. */
  withRelay: string | null;
}

function ts(events: RelayEventT[], type: string): number | null {
  const e = events.find((x) => x.type === type);
  return e ? Date.parse(e.timestamp) : null;
}

function seconds(from: number | null, to: number | null): string | null {
  if (from == null || to == null || to < from) return null;
  return `${((to - from) / 1000).toFixed(1)}s`;
}

function num(v: unknown): string | null {
  return typeof v === "number" && Number.isFinite(v) ? v.toLocaleString() : null;
}

/** Derive the measured RelayBench rows from the live event stream + packet. */
export function deriveBench(
  events: RelayEventT[],
  packet: { metrics?: { packetTokens?: number } } | null
): BenchRow[] {
  const start = ts(events, "session.started");
  const firstEdit = ts(events, "file.changed");
  const end =
    ts(events, "session.completed") ?? ts(events, "agent.switched");

  let verification: string | null = null;
  for (const e of events) {
    if (e.type === "test.failed") verification = "fail";
    else if (e.type === "test.passed" || e.type === "session.completed")
      verification = "pass";
  }

  return [
    {
      label: "Time to first edit",
      without: null,
      withRelay: seconds(start, firstEdit),
    },
    {
      label: "Continuation input tokens",
      without: null,
      withRelay: num(packet?.metrics?.packetTokens),
    },
    {
      label: "Tool calls before first edit",
      without: null,
      withRelay: null,
    },
    {
      label: "Completion duration",
      without: null,
      withRelay: seconds(start, end),
    },
    {
      label: "Verification",
      without: null,
      withRelay: verification,
    },
  ];
}
