/**
 * Relay server — Redis-backed EventStore
 * --------------------------------------
 * The durable implementation of the orchestrator's `EventStore` seam (the
 * in-memory one in `orchestrator.ts` is the dev/test fallback). It persists the
 * RelayEvent timeline so the UI can rebuild it after a refresh/reconnect, and
 * stores the latest handoff packet — the artifact that bridges old → new agent.
 *
 * Keys (per session):
 *   relay:session:{id}:events    STREAM  ordered RelayEvent timeline (replayable)
 *   relay:session:{id}:eventIds  SET     seen event ids → idempotent appends
 *   relay:session:{id}:handoff   STRING  latest handoff packet
 *
 * Persistence is off the hot path: `appendEvent`/`saveHandoff` enqueue a
 * fire-and-forget write — a Redis hiccup is logged, never thrown into a live
 * agent run. `flush()`/`close()` drain in-flight writes so shutdown and tests
 * are deterministic.
 */

import Redis from "ioredis";
import { RelayEvent } from "../../../packages/shared/events";
import { HandoffPacket } from "../../../packages/shared/handoff";
import type { EventStore } from "./orchestrator";

export class RedisEventStore implements EventStore {
  private readonly redis: Redis;
  private readonly pending = new Set<Promise<void>>();

  constructor(redisUrl = "redis://127.0.0.1:6379") {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    // A Redis problem is logged, never thrown into the engine.
    this.redis.on("error", (err) =>
      console.warn(`[event-store] redis error: ${err.message}`)
    );
  }

  private key(sessionId: string, suffix: string): string {
    return `relay:session:${sessionId}:${suffix}`;
  }

  /** Track a fire-and-forget write so `flush()` can await it. */
  private enqueue(work: Promise<unknown>, label: string): void {
    const write = work
      .then(() => undefined)
      .catch((err: Error) =>
        console.warn(`[event-store] failed to ${label}: ${err.message}`)
      )
      .finally(() => this.pending.delete(write));
    this.pending.add(write);
  }

  appendEvent(sessionId: string, event: RelayEvent): void {
    this.enqueue(this.writeEvent(sessionId, event), `persist ${event.type}`);
  }

  private async writeEvent(sessionId: string, event: RelayEvent): Promise<void> {
    // Idempotent: a duplicate event id is recorded exactly once.
    const inserted = await this.redis.sadd(
      this.key(sessionId, "eventIds"),
      event.id
    );
    if (inserted === 0) return;
    await this.redis.xadd(
      this.key(sessionId, "events"),
      "*",
      "data",
      JSON.stringify(event)
    );
  }

  /**
   * The ordered timeline. With `after` (a RelayEvent id), returns only events
   * strictly after it — the reconnect path: the UI replays once, then asks for
   * everything past the last id it already has.
   */
  async readEvents(sessionId: string, after?: string): Promise<RelayEvent[]> {
    const rows = await this.redis.xrange(this.key(sessionId, "events"), "-", "+");
    const events = rows.map(([, fields]) =>
      RelayEvent.parse(JSON.parse(fields[1] ?? "{}"))
    );
    if (!after) return events;
    const idx = events.findIndex((e) => e.id === after);
    return idx === -1 ? events : events.slice(idx + 1);
  }

  saveHandoff(sessionId: string, packet: HandoffPacket): void {
    this.enqueue(
      this.redis.set(this.key(sessionId, "handoff"), JSON.stringify(packet)),
      "save handoff"
    );
  }

  async loadHandoff(sessionId: string): Promise<HandoffPacket | null> {
    const raw = await this.redis.get(this.key(sessionId, "handoff"));
    return raw ? HandoffPacket.parse(JSON.parse(raw)) : null;
  }

  /** Wipe a session's keys (useful between demo runs / tests). */
  async clear(sessionId: string): Promise<void> {
    await this.redis.del(
      this.key(sessionId, "events"),
      this.key(sessionId, "eventIds"),
      this.key(sessionId, "handoff")
    );
  }

  /** Await all in-flight fire-and-forget writes. */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  async close(): Promise<void> {
    await this.flush();
    await this.redis.quit();
  }
}
