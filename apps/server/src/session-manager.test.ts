/**
 * Session manager tests — CRUD plus exhaustive coverage of the state machine:
 * every (from, to) pair across all eight states is exercised against both the
 * pure `canTransition` predicate and the guarded `transition()` method.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SessionManager,
  SessionNotFoundError,
  InvalidTransitionError,
  canTransition,
  SESSION_STATES,
  TERMINAL_STATES,
  type SessionState,
  type CreateSessionInput,
} from "./session-manager";

const INPUT: CreateSessionInput = {
  goal: "Fix the users.age migration so it is safe to re-run.",
  verificationCommand: "npm test",
  workspaceDir: "/tmp/relay-workspace",
};

/** Deterministic clock (advances 1s/call) + monotonic ids for stable asserts. */
function makeManager(): SessionManager {
  let clock = 0;
  let ids = 0;
  return new SessionManager({
    now: () => new Date(1_700_000_000_000 + clock++ * 1000).toISOString(),
    generateId: () => `sess-${++ids}`,
  });
}

/** A known valid path from `created` to each state, used to seed test fixtures. */
const PATH_TO: Record<SessionState, SessionState[]> = {
  created: [],
  claude_running: ["claude_running"],
  handoff_building: ["claude_running", "handoff_building"],
  handoff_ready: ["claude_running", "handoff_building", "handoff_ready"],
  codex_running: [
    "claude_running",
    "handoff_building",
    "handoff_ready",
    "codex_running",
  ],
  verifying: [
    "claude_running",
    "handoff_building",
    "handoff_ready",
    "codex_running",
    "verifying",
  ],
  completed: [
    "claude_running",
    "handoff_building",
    "handoff_ready",
    "codex_running",
    "verifying",
    "completed",
  ],
  failed: ["failed"],
};

function seed(mgr: SessionManager, state: SessionState): string {
  const s = mgr.create(INPUT);
  for (const step of PATH_TO[state]) mgr.transition(s.id, step);
  assert.equal(mgr.get(s.id).state, state, `seed(${state})`);
  return s.id;
}

/** The intended adjacency — pinned so any map change is a conscious test edit. */
const EXPECTED: Record<SessionState, SessionState[]> = {
  created: ["claude_running", "failed"],
  claude_running: ["handoff_building", "failed"],
  handoff_building: ["handoff_ready", "failed"],
  handoff_ready: ["codex_running", "claude_running", "failed"],
  codex_running: ["verifying", "handoff_building", "failed"],
  verifying: ["completed", "codex_running", "failed"],
  completed: [],
  failed: [],
};

// --- CRUD -------------------------------------------------------------------

test("create() starts a session in `created` with defaults + timestamps", () => {
  const mgr = makeManager();
  const s = mgr.create(INPUT);
  assert.equal(s.state, "created");
  assert.equal(s.id, "sess-1");
  assert.equal(s.sourceAgent, "claude");
  assert.equal(s.targetAgent, null);
  assert.deepEqual(s.acceptanceCriteria, []);
  assert.equal(s.error, null);
  assert.equal(s.createdAt, s.updatedAt);
});

test("create() rejects a duplicate explicit id", () => {
  const mgr = makeManager();
  mgr.create({ ...INPUT, id: "dupe" });
  assert.throws(() => mgr.create({ ...INPUT, id: "dupe" }), /already exists/);
});

test("get() throws SessionNotFoundError for an unknown id", () => {
  const mgr = makeManager();
  assert.throws(() => mgr.get("missing"), SessionNotFoundError);
});

test("has() and list() reflect stored sessions in creation order", () => {
  const mgr = makeManager();
  const a = mgr.create(INPUT);
  const b = mgr.create(INPUT);
  assert.equal(mgr.has(a.id), true);
  assert.equal(mgr.has("nope"), false);
  assert.deepEqual(
    mgr.list().map((s) => s.id),
    [a.id, b.id]
  );
});

test("update() patches mutable fields, bumps updatedAt, leaves state", () => {
  const mgr = makeManager();
  const s = mgr.create(INPUT);
  const updated = mgr.update(s.id, { targetAgent: "codex", goal: "new goal" });
  assert.equal(updated.targetAgent, "codex");
  assert.equal(updated.goal, "new goal");
  assert.equal(updated.state, "created");
  assert.notEqual(updated.updatedAt, s.updatedAt);
  assert.equal(updated.createdAt, s.createdAt);
});

test("update() throws for an unknown id", () => {
  const mgr = makeManager();
  assert.throws(() => mgr.update("missing", { goal: "x" }), SessionNotFoundError);
});

// --- State machine ----------------------------------------------------------

test("happy path traverses created → … → completed", () => {
  const mgr = makeManager();
  const id = mgr.create(INPUT).id;
  const path: SessionState[] = [
    "claude_running",
    "handoff_building",
    "handoff_ready",
    "codex_running",
    "verifying",
    "completed",
  ];
  for (const to of path) assert.equal(mgr.transition(id, to).state, to);
  assert.equal(mgr.get(id).state, "completed");
});

test("transition to `failed` records the error and is terminal", () => {
  const mgr = makeManager();
  const id = seed(mgr, "codex_running");
  const failed = mgr.transition(id, "failed", { error: "boom: exit 1" });
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "boom: exit 1");
  // Terminal: nothing leaves `failed`.
  for (const to of SESSION_STATES) {
    assert.throws(() => mgr.transition(id, to), InvalidTransitionError);
  }
});

test("terminal states have no outgoing transitions", () => {
  for (const terminal of TERMINAL_STATES) {
    for (const to of SESSION_STATES) {
      assert.equal(canTransition(terminal, to), false, `${terminal}->${to}`);
    }
  }
});

test("canTransition matches the documented machine for all pairs", () => {
  for (const from of SESSION_STATES) {
    for (const to of SESSION_STATES) {
      assert.equal(
        canTransition(from, to),
        EXPECTED[from].includes(to),
        `${from} -> ${to}`
      );
    }
  }
});

test("transition() allows exactly the legal moves and rejects the rest", () => {
  for (const from of SESSION_STATES) {
    for (const to of SESSION_STATES) {
      const mgr = makeManager();
      const id = seed(mgr, from);
      if (canTransition(from, to)) {
        assert.equal(mgr.transition(id, to).state, to, `${from} -> ${to}`);
      } else {
        assert.throws(
          () => mgr.transition(id, to),
          InvalidTransitionError,
          `${from} -> ${to} should reject`
        );
        // A rejected transition leaves the session untouched.
        assert.equal(mgr.get(id).state, from, `${from} unchanged`);
      }
    }
  }
});
