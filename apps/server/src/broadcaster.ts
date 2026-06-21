/**
 * Relay server — WebSocket session broadcaster
 * --------------------------------------------
 * Pushes the live `RelayEvent` timeline to browser clients. A client connects to
 * `ws://…/ws/sessions/:id` and receives every event broadcast for that session.
 *
 * Implemented directly on Node's `http` upgrade handshake + RFC 6455 framing so
 * the server stays dependency-free (no `ws` package). The channel is
 * server→client only: outbound text frames are unmasked per spec; inbound is
 * drained and limited to control frames (ping → pong, close), so a chatty or
 * misbehaving client can never stall or crash the process.
 *
 * Every payload is validated with the shared `RelayEvent` schema before it goes
 * on the wire — clients can trust what they receive.
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import type { Duplex } from "node:stream";
import {
  RelayEvent,
  type RelayEventType,
} from "../../../packages/shared/events";

/** Magic GUID from RFC 6455 used to derive the handshake accept token. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Build an unmasked server→client text frame for `text`. */
function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]); // FIN + text opcode, 7-bit length
  } else if (len < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126; // 16-bit extended length
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127; // 64-bit extended length
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

const PONG_EMPTY = Buffer.from([0x8a, 0x00]); // FIN + pong, zero-length
const CLOSE_EMPTY = Buffer.from([0x88, 0x00]); // FIN + close, zero-length

export class SessionBroadcaster {
  /** sessionId → the set of live client sockets subscribed to it. */
  private readonly clients = new Map<string, Set<Duplex>>();

  /** Wire the WebSocket upgrade handler onto an existing HTTP server. */
  attach(server: http.Server): this {
    server.on("upgrade", (req, socket, head) =>
      this.handleUpgrade(req, socket, head)
    );
    return this;
  }

  private handleUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    _head: Buffer
  ): void {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const match = /^\/ws\/sessions\/([^/]+)$/.exec(pathname);
    const key = req.headers["sec-websocket-key"];
    const isWebSocket =
      (req.headers["upgrade"] ?? "").toLowerCase() === "websocket";

    if (!match || !key || !isWebSocket) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    this.register(decodeURIComponent(match[1]!), socket);
  }

  private register(sessionId: string, socket: Duplex): void {
    let set = this.clients.get(sessionId);
    if (!set) {
      set = new Set();
      this.clients.set(sessionId, set);
    }
    set.add(socket);

    const cleanup = (): void => {
      const live = this.clients.get(sessionId);
      if (!live) return;
      live.delete(socket);
      if (live.size === 0) this.clients.delete(sessionId);
    };

    socket.on("close", cleanup);
    socket.on("error", () => {
      cleanup();
      socket.destroy();
    });
    // Drain inbound bytes; only react to control frames. Never let a parse
    // error take down the server.
    socket.on("data", (buf: Buffer) => {
      try {
        this.handleInbound(socket, buf);
      } catch {
        /* ignore malformed client frames */
      }
    });
  }

  private handleInbound(socket: Duplex, buf: Buffer): void {
    if (buf.length < 1) return;
    const opcode = buf[0]! & 0x0f; // opcode lives in the unmasked first byte
    if (opcode === 0x8) {
      // close → echo a close and end the socket
      try {
        socket.write(CLOSE_EMPTY);
      } catch {
        /* socket already gone */
      }
      socket.end();
    } else if (opcode === 0x9) {
      // ping → pong (standard clients don't require the payload echoed back)
      try {
        socket.write(PONG_EMPTY);
      } catch {
        /* socket already gone */
      }
    }
    // text / binary / pong from a client are ignored — this is a push channel.
  }

  /**
   * Validate `event` against the shared schema and push it to every client
   * subscribed to its session. Dead sockets are dropped. Returns the validated
   * event. Throws if `event` is not a schema-valid RelayEvent.
   */
  broadcast(event: unknown): RelayEvent {
    const valid = RelayEvent.parse(event);
    const frame = encodeTextFrame(JSON.stringify(valid));
    const set = this.clients.get(valid.sessionId);
    if (set) {
      for (const socket of [...set]) {
        try {
          socket.write(frame);
        } catch {
          set.delete(socket);
          try {
            socket.destroy();
          } catch {
            /* already destroyed */
          }
        }
      }
      if (set.size === 0) this.clients.delete(valid.sessionId);
    }
    return valid;
  }

  /**
   * Test / demo helper: construct one schema-valid RelayEvent and broadcast it
   * to `sessionId`. Returns the event that was sent.
   */
  emitDemoEvent(
    sessionId: string,
    type: RelayEventType = "terminal.output"
  ): RelayEvent {
    return this.broadcast({
      id: `evt-${crypto.randomUUID()}`,
      sessionId,
      type,
      timestamp: new Date().toISOString(),
      payload: { message: "hello from the Relay broadcaster" },
    });
  }

  /** Number of live clients for a session (or all sessions when omitted). */
  clientCount(sessionId?: string): number {
    if (sessionId !== undefined) return this.clients.get(sessionId)?.size ?? 0;
    let total = 0;
    for (const set of this.clients.values()) total += set.size;
    return total;
  }

  /** Close every live client during server shutdown. Idempotent. */
  close(): void {
    for (const set of this.clients.values()) {
      for (const socket of set) {
        try {
          socket.end(CLOSE_EMPTY);
        } catch {
          try {
            socket.destroy();
          } catch {
            /* already closed */
          }
        }
      }
    }
    this.clients.clear();
  }
}
