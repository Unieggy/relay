/**
 * Relay server — HTTP app
 * -----------------------
 * Builds the `http.Server` and owns request routing + the centralized error
 * handler. Kept dependency-free (Node's built-in `http`) and side-effect-free:
 * it never calls `.listen()` — `index.ts` (bootstrap) does that. This keeps the
 * app importable in tests, which bind it to an ephemeral port themselves.
 *
 * The app mounts health/session HTTP routes and the session-scoped WebSocket
 * broadcaster. Runtime dependencies are exposed by `createAppRuntime()` so the
 * coordinator and event store can be added without hidden singletons.
 */

import * as http from "node:http";
import type { Env } from "./env";
import { methodNotAllowed, notFound, toErrorResponse } from "./errors";
import { SessionBroadcaster } from "./broadcaster";
import { SessionManager } from "./session-manager";
import {
  Orchestrator,
  InMemoryEventStore,
  compressorCreateHandoff,
  type EventStore,
} from "./orchestrator";
import { ClaudeAdapter, CodexAdapter } from "./adapters";
import { RedisEventStore } from "./event-store";
import { createApiRouter, type ApiHandler } from "./routes";

export interface AppOptions {
  sessions?: SessionManager;
  broadcaster?: SessionBroadcaster;
  store?: EventStore;
  orchestrator?: Orchestrator;
}

export interface AppRuntime {
  server: http.Server;
  sessions: SessionManager;
  broadcaster: SessionBroadcaster;
  orchestrator: Orchestrator;
  /** Null only when a fully custom orchestrator was injected without its store. */
  store: EventStore | null;
  /** Stop agents, close sockets/server, and flush durable storage. */
  close(): Promise<void>;
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

function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

/** Route a single request. Throws on any error; the handler below catches it. */
async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _env: Env,
  api: ApiHandler
): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }
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

export function createAppRuntime(
  env: Env,
  opts: AppOptions = {}
): AppRuntime {
  const sessions = opts.sessions ?? new SessionManager();
  const broadcaster = opts.broadcaster ?? new SessionBroadcaster();
  let store = opts.store ?? null;
  let orchestrator = opts.orchestrator;

  if (!orchestrator) {
    // Durable Redis store when REDIS_URL is set; in-memory otherwise (dev/tests).
    store ??= env.REDIS_URL
      ? new RedisEventStore(env.REDIS_URL)
      : new InMemoryEventStore();
    orchestrator = new Orchestrator({
      sessions,
      store,
      adapters: {
        claude: () => new ClaudeAdapter(),
        codex: () => new CodexAdapter(),
      },
      createHandoff: compressorCreateHandoff,
      // Live events flow to any WS clients subscribed to the session.
      onEvent: (event) => {
        try {
          broadcaster.broadcast(event);
        } catch {
          /* never let a broadcast failure break the run */
        }
      },
    });
  }
  const api = createApiRouter({ sessions, orchestrator });

  const server = http.createServer((req, res) => {
    for (const [name, value] of Object.entries(corsHeaders(req))) {
      res.setHeader(name, value);
    }
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
      sendJson(res, statusCode, body, { ...corsHeaders(req), ...headers });
    });
  });

  broadcaster.attach(server);
  let closed = false;
  return {
    server,
    sessions,
    broadcaster,
    orchestrator,
    store,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await orchestrator.stopAll();
      broadcaster.close();
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve()))
        );
      }
      await store?.flush?.();
      await store?.close?.();
    },
  };
}

/** Compatibility helper for callers that only need the HTTP server. */
export function createApp(env: Env, opts: AppOptions = {}): http.Server {
  return createAppRuntime(env, opts).server;
}
