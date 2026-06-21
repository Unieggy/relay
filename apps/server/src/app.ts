/**
 * Relay server — HTTP app
 * -----------------------
 * Builds the `http.Server` and owns request routing + the centralized error
 * handler. Kept dependency-free (Node's built-in `http`) and side-effect-free:
 * it never calls `.listen()` — `index.ts` (bootstrap) does that. This keeps the
 * app importable in tests, which bind it to an ephemeral port themselves.
 *
 * Only GET /health exists in this ticket. Sessions, WebSockets, and the process
 * runner attach to this server in later tickets.
 */

import * as http from "node:http";
import type { Env } from "./env";
import { methodNotAllowed, notFound, toErrorResponse } from "./errors";
import { SessionBroadcaster } from "./broadcaster";
import { SessionManager } from "./session-manager";
import {
  Orchestrator,
  InMemoryEventStore,
  fallbackCreateHandoff,
  type EventStore,
} from "./orchestrator";
import { ClaudeAdapter, CodexAdapter } from "./adapters";
import { createApiRouter, type ApiHandler } from "./routes";

export interface AppOptions {
  sessions?: SessionManager;
  broadcaster?: SessionBroadcaster;
  store?: EventStore;
  orchestrator?: Orchestrator;
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/** Route a single request. Throws on any error; the handler below catches it. */
async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _env: Env,
  api: ApiHandler
): Promise<void> {
  // Parse just the pathname so query strings don't break exact matches.
  const { pathname } = new URL(req.url ?? "/", "http://localhost");

  if (pathname === "/health") {
    if (req.method !== "GET") {
      throw methodNotAllowed(["GET"], `${req.method} not allowed on /health`);
    }
    sendJson(res, 200, {
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (pathname.startsWith("/api/")) {
    await api(req, res);
    return;
  }

  throw notFound(`No route for ${req.method} ${pathname}`);
}

export function createApp(env: Env, opts: AppOptions = {}): http.Server {
  const sessions = opts.sessions ?? new SessionManager();
  const broadcaster = opts.broadcaster ?? new SessionBroadcaster();
  const store = opts.store ?? new InMemoryEventStore();
  const orchestrator =
    opts.orchestrator ??
    new Orchestrator({
      sessions,
      store,
      adapters: {
        claude: () => new ClaudeAdapter(),
        codex: () => new CodexAdapter(),
      },
      createHandoff: fallbackCreateHandoff,
      // Live events flow to any WS clients subscribed to the session.
      onEvent: (event) => {
        try {
          broadcaster.broadcast(event);
        } catch {
          /* never let a broadcast failure break the run */
        }
      },
    });
  const api = createApiRouter({ sessions, orchestrator });

  const server = http.createServer((req, res) => {
    route(req, res, env, api).catch((err) => {
      const { statusCode, body, headers, unexpected } = toErrorResponse(err);
      if (unexpected) {
        // Log the real error server-side; clients only ever see the envelope.
        console.error("[relay:server] unhandled request error:", err);
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, statusCode, body, headers);
    });
  });

  broadcaster.attach(server);
  return server;
}
