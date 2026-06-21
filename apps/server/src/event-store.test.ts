/**
 * RedisEventStore — durable EventStore tests.
 *
 * These exercise real Redis. When none is reachable at REDIS_URL the suite
 * skips (so CI without a Redis service stays green) — except the
 * "Redis unavailable" case, which asserts the store degrades safely.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { RedisEventStore } from "./event-store";
import { RelayEvent } from "../../../packages/shared/events";
import { HandoffPacket } from "../../../packages/shared/handoff";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

async function redisAvailable(): Promise<boolean> {
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 200,
    maxRetriesPerRequest: 1,
  });
  redis.on("error", () => {});
  try {
    await redis.connect();
    await redis.ping();
    return true;
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

/** Run `fn` against a clean store, or skip when Redis is down. */
async function withStore(
  t: TestContext,
  fn: (store: RedisEventStore) => Promise<void>
): Promise<void> {
  if (!(await redisAvailable())) {
    t.skip(`Redis not available at ${REDIS_URL}`);
    return;
  }
  const store = new RedisEventStore(REDIS_URL);
  try {
    await fn(store);
  } finally {
    await store.close();
  }
}

function evt(sessionId: string, id: string, type = "terminal.output"): RelayEvent {
  return RelayEvent.parse({
    id,
    sessionId,
    type,
    timestamp: new Date().toISOString(),
    payload: { chunk: id },
  });
}

const PACKET = HandoffPacket.parse({
  version: "1.0",
  sessionId: "redis-packet",
  sourceAgent: "claude",
  targetAgent: "codex",
  trigger: "rate_limit",
  task: {
    goal: "Persist the full handoff packet through Redis.",
    acceptanceCriteria: ["packet survives a reload"],
  },
  state: { status: "in_progress", summary: "Ready to resume." },
  evidence: {
    changedFiles: ["apps/server/src/event-store.ts"],
    commands: [],
    latestFailure: null,
    diffSummary: ["Added the Redis-backed event store"],
  },
  decisions: [],
  constraints: [],
  nextActions: ["Reload the packet on the next agent"],
  verificationCommand: "npm test",
  metrics: { sourceTokens: 1000, packetTokens: 100, reductionPercent: 90, confidence: 0.9 },
  pitfalls: [],
  focusFiles: [],
});

test("isolates events by session", async (t) => {
  await withStore(t, async (store) => {
    const a = "redis-iso-a";
    const b = "redis-iso-b";
    await store.clear(a);
    await store.clear(b);
    store.appendEvent(a, evt(a, "a-1"));
    store.appendEvent(b, evt(b, "b-1"));
    await store.flush();
    assert.deepEqual((await store.readEvents(a)).map((e) => e.id), ["a-1"]);
    assert.deepEqual((await store.readEvents(b)).map((e) => e.id), ["b-1"]);
    await store.clear(a);
    await store.clear(b);
  });
});

test("preserves event order", async (t) => {
  await withStore(t, async (store) => {
    const s = "redis-order";
    await store.clear(s);
    store.appendEvent(s, evt(s, "evt-1"));
    store.appendEvent(s, evt(s, "evt-2"));
    store.appendEvent(s, evt(s, "evt-3"));
    await store.flush();
    assert.deepEqual((await store.readEvents(s)).map((e) => e.id), [
      "evt-1",
      "evt-2",
      "evt-3",
    ]);
    await store.clear(s);
  });
});

test("persists the full handoff packet", async (t) => {
  await withStore(t, async (store) => {
    const s = "redis-packet";
    await store.clear(s);
    store.saveHandoff(s, PACKET);
    await store.flush();
    const loaded = await store.loadHandoff(s);
    assert.equal(loaded?.sessionId, PACKET.sessionId);
    assert.equal(loaded?.task.goal, PACKET.task.goal);
    assert.equal(loaded?.metrics.reductionPercent, 90);
    await store.clear(s);
  });
});

test("replays after reconnect, honoring the cursor", async (t) => {
  await withStore(t, async (store) => {
    const s = "redis-reconnect";
    await store.clear(s);
    store.appendEvent(s, evt(s, "evt-1"));
    store.appendEvent(s, evt(s, "evt-2"));
    await store.flush();

    // A fresh store (new connection) rebuilds the full timeline.
    const reopened = new RedisEventStore(REDIS_URL);
    try {
      assert.deepEqual((await reopened.readEvents(s)).map((e) => e.id), [
        "evt-1",
        "evt-2",
      ]);
      reopened.appendEvent(s, evt(s, "evt-3"));
      await reopened.flush();
      // Only events strictly after the cursor come back.
      assert.deepEqual((await reopened.readEvents(s, "evt-1")).map((e) => e.id), [
        "evt-2",
        "evt-3",
      ]);
    } finally {
      await reopened.clear(s);
      await reopened.close();
    }
  });
});

test("does not throw when Redis is unavailable", async () => {
  const store = new RedisEventStore("redis://127.0.0.1:1");
  assert.doesNotThrow(() => store.appendEvent("redis-down", evt("redis-down", "evt-1")));
  assert.doesNotThrow(() => store.saveHandoff("redis-down", PACKET));
  await assert.doesNotReject(() => store.flush());
  store.close().catch(() => {});
});

test("ignores duplicate event ids", async (t) => {
  await withStore(t, async (store) => {
    const s = "redis-dupe";
    await store.clear(s);
    const dup = evt(s, "evt-1");
    store.appendEvent(s, dup);
    store.appendEvent(s, dup);
    await store.flush();
    assert.deepEqual((await store.readEvents(s)).map((e) => e.id), ["evt-1"]);
    await store.clear(s);
  });
});
