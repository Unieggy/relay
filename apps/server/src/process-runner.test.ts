/**
 * Process runner tests — driven with a harmless `node -e` command (never Claude
 * or Codex). The headline case streams real command output to a connected
 * WebSocket client through the broadcaster, proving the DoD end-to-end.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { startProcess } from "./process-runner";
import { SessionBroadcaster } from "./broadcaster";
import { RelayEvent } from "../../../packages/shared/events";

const NODE = process.execPath; // guaranteed-present, cross-platform binary

function payload(e: RelayEvent): { stream?: string; chunk?: string } {
  return e.payload as { stream?: string; chunk?: string };
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("emits started → terminal.output → exited for a harmless command", async () => {
  const events: RelayEvent[] = [];
  const handle = startProcess(
    {
      sessionId: "s1",
      command: NODE,
      args: ["-e", 'process.stdout.write("hello\\n"); process.stderr.write("warn\\n");'],
      cwd: process.cwd(),
    },
    (e) => events.push(e)
  );

  const result = await handle.done;
  assert.equal(result.exitCode, 0);

  assert.equal(events[0]!.type, "process.started");
  assert.equal(events.at(-1)!.type, "process.exited");

  const outputs = events.filter((e) => e.type === "terminal.output");
  const stdout = outputs
    .filter((e) => payload(e).stream === "stdout")
    .map((e) => payload(e).chunk)
    .join("");
  const stderr = outputs
    .filter((e) => payload(e).stream === "stderr")
    .map((e) => payload(e).chunk)
    .join("");
  assert.match(stdout, /hello/);
  assert.match(stderr, /warn/);
});

test("real command output streams to a connected browser client", async () => {
  const broadcaster = new SessionBroadcaster();
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  broadcaster.attach(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const sessionId = "stream-1";

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`);
  const lines: string[] = [];
  const sawExit = new Promise<void>((resolve) => {
    ws.on("message", (data: WebSocket.RawData) => {
      const ev = JSON.parse(data.toString()) as RelayEvent;
      if (ev.type === "terminal.output") lines.push(String(payload(ev).chunk));
      if (ev.type === "process.exited") resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  await waitFor(() => broadcaster.clientCount(sessionId) === 1);

  const handle = startProcess(
    {
      sessionId,
      command: NODE,
      args: ["-e", 'console.log("streamed-line-A"); console.log("streamed-line-B");'],
      cwd: process.cwd(),
    },
    (e) => broadcaster.broadcast(e)
  );
  await handle.done;
  await sawExit;

  const all = lines.join("");
  assert.match(all, /streamed-line-A/);
  assert.match(all, /streamed-line-B/);

  ws.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("writes to stdin and the process consumes it", async () => {
  const events: RelayEvent[] = [];
  const handle = startProcess(
    {
      sessionId: "s3",
      command: NODE,
      args: [
        "-e",
        'process.stdin.on("data",(d)=>{process.stdout.write("got:"+d.toString().trim());process.exit(0);});',
      ],
      cwd: process.cwd(),
    },
    (e) => events.push(e)
  );

  await waitFor(() => events.some((e) => e.type === "process.started"));
  assert.equal(handle.write("ping\n"), true);

  const result = await handle.done;
  assert.equal(result.exitCode, 0);
  const stdout = events
    .filter((e) => e.type === "terminal.output")
    .map((e) => payload(e).chunk)
    .join("");
  assert.match(stdout, /got:ping/);
});

test("ignored stdin behaves like /dev/null for one-shot commands", async () => {
  const events: RelayEvent[] = [];
  const handle = startProcess(
    {
      sessionId: "s-ignore-stdin",
      command: NODE,
      args: [
        "-e",
        'process.stdin.on("end",()=>process.stdout.write("stdin-closed"));process.stdin.resume();',
      ],
      cwd: process.cwd(),
      stdin: "ignore",
    },
    (event) => events.push(event)
  );

  assert.equal(handle.write("unused\n"), false);
  const result = await handle.done;
  assert.equal(result.exitCode, 0);
  assert.match(
    events
      .filter((event) => event.type === "terminal.output")
      .map((event) => payload(event).chunk)
      .join(""),
    /stdin-closed/
  );
});

test("terminate() stops a long-running process safely", async () => {
  const events: RelayEvent[] = [];
  const handle = startProcess(
    {
      sessionId: "s4",
      command: NODE,
      args: ["-e", "setInterval(()=>{},1000);"],
      cwd: process.cwd(),
    },
    (e) => events.push(e)
  );

  await waitFor(() => events.some((e) => e.type === "process.started"));
  handle.terminate();

  const result = await handle.done;
  assert.equal(result.signal !== null, true); // killed by a signal
  assert.equal(events.at(-1)!.type, "process.exited");
});

test("startProcess throws for a non-existent cwd", () => {
  assert.throws(
    () =>
      startProcess(
        { sessionId: "x", command: NODE, args: ["-e", ""], cwd: "/no/such/relay/dir" },
        () => {}
      ),
    /cwd does not exist/
  );
});
