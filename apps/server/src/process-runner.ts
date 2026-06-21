/**
 * Relay server — generic process runner
 * --------------------------------------
 * Spawns a child process in a configured working directory and turns its
 * lifecycle into schema-valid `RelayEvent`s:
 *
 *   process.started   — { command, args, cwd, pid }
 *   terminal.output   — { stream: "stdout" | "stderr", chunk, seq }   (one per chunk)
 *   process.exited    — { exitCode, signal, timedOut, truncated, durationMs }
 *
 * Events flow out through an injected sink (`onEvent`) so the caller wires them
 * to the broadcaster and/or the event-store — the runner itself knows nothing
 * about WebSockets or Redis.
 *
 * Safety rails per the server's process boundaries: a configurable timeout
 * (terminate on expiry), a bounded total output (stop streaming past a cap), and
 * `terminate()` that escalates SIGTERM → SIGKILL so a process can't be left
 * wedged. It is provider-agnostic; the Claude/Codex adapters are separate.
 *
 * `process.started`, `terminal.output`, and `process.exited` are all canonical
 * shared event types, so downstream broadcasters, stores, and UIs can consume
 * the lifecycle without provider-specific parsing.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  RelayEvent,
  type AgentId,
  type RelayEventSink,
} from "../../../packages/shared";

export type { RelayEventSink } from "../../../packages/shared";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB streamed per process
const KILL_GRACE_MS = 3000; // SIGTERM → SIGKILL escalation window

export interface ProcessRunOptions {
  sessionId: string;
  command: string;
  args?: string[];
  /** Working directory the process runs in (must be an existing directory). */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Terminate the process if it runs longer than this (ms). 0/undefined = off. */
  timeoutMs?: number;
  /** Stop streaming output past this many bytes. Defaults to 1 MiB. */
  maxOutputBytes?: number;
  /** Optional agent tag stamped onto every emitted event. */
  agent?: AgentId;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface RelayProcessHandle {
  readonly pid: number | undefined;
  /** Write to the process's stdin. Returns false if stdin is unavailable. */
  write(data: string): boolean;
  /** Request termination; escalates to SIGKILL if the process ignores it. */
  terminate(signal?: NodeJS.Signals): void;
  /** Resolves when the process has exited (and the exit event was emitted). */
  done: Promise<ProcessResult>;
}

/**
 * Start a process and stream its lifecycle to `onEvent`. Throws synchronously
 * only if `cwd` is not an existing directory; a failure to spawn the binary
 * itself surfaces as a stderr `terminal.output` + a `process.exited` event.
 */
export function startProcess(
  opts: ProcessRunOptions,
  onEvent: RelayEventSink
): RelayProcessHandle {
  assertDirectory(opts.cwd);

  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = Date.now();
  let seq = 0;
  let totalBytes = 0;
  let truncated = false;
  let timedOut = false;
  let settled = false;
  let killTimer: NodeJS.Timeout | undefined;

  const emit = (type: string, payload: Record<string, unknown>): void => {
    onEvent(
      RelayEvent.parse({
        id: `evt-${randomUUID()}`,
        sessionId: opts.sessionId,
        type,
        timestamp: new Date().toISOString(),
        ...(opts.agent ? { agent: opts.agent } : {}),
        payload,
      })
    );
  };

  const child = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  emit("process.started", {
    command: opts.command,
    args: opts.args ?? [],
    cwd: opts.cwd,
    pid: child.pid ?? null,
  });

  const streamChunk = (stream: "stdout" | "stderr", buf: Buffer): void => {
    if (truncated) return;
    totalBytes += buf.length;
    if (totalBytes > maxOutputBytes) {
      truncated = true;
      emit("terminal.output", {
        stream,
        chunk: `\n[relay] output truncated at ${maxOutputBytes} bytes\n`,
        truncated: true,
      });
      return;
    }
    emit("terminal.output", { stream, chunk: buf.toString("utf8"), seq: seq++ });
  };

  child.stdout?.on("data", (d: Buffer) => streamChunk("stdout", d));
  child.stderr?.on("data", (d: Buffer) => streamChunk("stderr", d));

  const timer =
    opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          terminate("SIGTERM");
        }, opts.timeoutMs)
      : undefined;
  timer?.unref();

  const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    const result: ProcessResult = {
      exitCode,
      signal,
      timedOut,
      truncated,
      durationMs: Date.now() - startedAt,
    };
    emit("process.exited", { ...result });
    resolveDone(result);
  };

  let resolveDone!: (r: ProcessResult) => void;
  const done = new Promise<ProcessResult>((resolve) => {
    resolveDone = resolve;
  });

  child.on("error", (err) => {
    // Spawn-level failure (e.g. ENOENT) — report it then settle.
    emit("terminal.output", { stream: "stderr", chunk: String(err) });
    finish(null, null);
  });
  child.on("close", (code, signal) => finish(code, signal));

  function terminate(signal: NodeJS.Signals = "SIGTERM"): void {
    if (settled) return;
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
    if (!killTimer) {
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      killTimer.unref();
    }
  }

  return {
    pid: child.pid,
    write(data: string): boolean {
      if (!child.stdin || child.stdin.destroyed) return false;
      return child.stdin.write(data);
    },
    terminate,
    done,
  };
}

function assertDirectory(dir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error(`process cwd does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`process cwd is not a directory: ${dir}`);
  }
}
