/**
 * Relay server — verification runner
 * ----------------------------------
 * Runs a session's stored verification command (e.g. `npm test -- auth.test.ts`)
 * in the workspace and reports the truth: command, exit code, bounded output,
 * duration, and pass/fail. Pass/fail is decided SOLELY by the process exit code
 * — never by anything the agent printed — and emitted as `test.passed` /
 * `test.failed`. Output streams as `terminal.output` while it runs.
 *
 * CONTRACT NOTE: `VerificationResult` is a spec'd shared contract but isn't in
 * `packages/shared` yet — defined here and proposed for promotion (same pattern
 * as `RelaySession`).
 */

import { randomUUID } from "node:crypto";
import { startProcess, type RelayEventSink } from "./process-runner";
import { RelayEvent } from "../../../packages/shared/events";
import type { AgentId } from "../../../packages/shared/common";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 64 * 1024; // bound the stored output (tail-biased)

export interface VerificationResult {
  command: string;
  exitCode: number | null;
  passed: boolean;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface VerifyOptions {
  sessionId: string;
  /** The stored verification command, run via the shell. */
  command: string;
  cwd: string;
  timeoutMs?: number;
  agent?: AgentId;
}

function boundTail(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `…[truncated]\n${text.slice(text.length - MAX_OUTPUT_CHARS)}`;
}

/**
 * Run the verification command and resolve to a `VerificationResult`. Streams
 * the command's output through `onEvent` and emits a final test verdict.
 */
export async function runVerification(
  opts: VerifyOptions,
  onEvent?: RelayEventSink
): Promise<VerificationResult> {
  let output = "";
  const sink: RelayEventSink = (e) => {
    if (e.type === "terminal.output") {
      output += String((e.payload as { chunk?: string }).chunk ?? "");
    }
    onEvent?.(e); // forward process lifecycle/output to the broadcaster
  };

  const handle = startProcess(
    {
      sessionId: opts.sessionId,
      command: "sh",
      args: ["-c", opts.command],
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(opts.agent ? { agent: opts.agent } : {}),
    },
    sink
  );

  const res = await handle.done;
  const passed = res.exitCode === 0; // EXIT CODE is the only source of truth
  const result: VerificationResult = {
    command: opts.command,
    exitCode: res.exitCode,
    passed,
    output: boundTail(output),
    durationMs: res.durationMs,
    timedOut: res.timedOut,
  };

  onEvent?.(
    RelayEvent.parse({
      id: `evt-${randomUUID()}`,
      sessionId: opts.sessionId,
      type: passed ? "test.passed" : "test.failed",
      timestamp: new Date().toISOString(),
      ...(opts.agent ? { agent: opts.agent } : {}),
      payload: {
        command: opts.command,
        exitCode: res.exitCode,
        durationMs: res.durationMs,
        timedOut: res.timedOut,
      },
    })
  );

  return result;
}
