/**
 * TEMPORARY WebSocket broadcaster harness — for integration with Syed's client.
 * ----------------------------------------------------------------------------
 * Remove once the broadcaster is wired into the real server + orchestrator. Runs
 * a standalone HTTP server with the WS broadcaster attached plus one debug
 * endpoint that emits a single event, so the live channel can be exercised
 * end-to-end without the rest of the stack:
 *
 *   npx tsx apps/server/src/ws-demo.ts            # starts on :4100 (PORT to override)
 *
 *   1. connect a client to   ws://localhost:4100/ws/sessions/<id>
 *   2. POST                  http://localhost:4100/_debug/sessions/<id>/emit
 *   3. the connected client receives one schema-valid RelayEvent
 */

import * as http from "node:http";
import { SessionBroadcaster } from "./broadcaster";

const broadcaster = new SessionBroadcaster();

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const match = /^\/_debug\/sessions\/([^/]+)\/emit$/.exec(pathname);

  if (match && req.method === "POST") {
    const sessionId = decodeURIComponent(match[1]!);
    const event = broadcaster.emitDemoEvent(sessionId);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        emitted: event,
        clients: broadcaster.clientCount(sessionId),
      })
    );
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code: "not_found", message: "Unknown route" } }));
});

broadcaster.attach(server);

const port = Number(process.env.PORT ?? 4100);
server.listen(port, () => {
  console.log(`[relay:ws-demo] WS:    ws://localhost:${port}/ws/sessions/:id`);
  console.log(
    `[relay:ws-demo] EMIT:  POST http://localhost:${port}/_debug/sessions/:id/emit`
  );
});
