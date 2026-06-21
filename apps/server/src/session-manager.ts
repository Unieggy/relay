/**
 * Relay server — in-memory session manager + state machine
 * --------------------------------------------------------
 * Owns the lifecycle of a Relay session: create, read, update, and — the part
 * that matters — guarded state transitions. Every state change goes through
 * `transition()`, which rejects any move not in the transition map, so a session
 * can never skip from `created` straight to `completed`.
 *
 * Storage is a plain in-memory Map. Michael's event-store / Redis owns durable
 * persistence; this manager is the authoritative in-process state and is written
 * against the same shape so it can later be backed by (or mirrored into) Redis
 * without changing callers.
 *
 * The wire-level `RelaySession` and `SessionState` schemas live in
 * `packages/shared`; this module owns only lifecycle behavior and storage.
 */

import { randomUUID } from "node:crypto";
import {
  RelaySession,
  SESSION_STATES,
  SessionState,
  type AgentId,
} from "../../../packages/shared";

// Preserve the existing server import surface while making shared the source of truth.
export { RelaySession, SESSION_STATES, SessionState } from "../../../packages/shared";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/** End states — no outgoing transitions. */
export const TERMINAL_STATES: readonly SessionState[] = ["completed", "failed"];

/**
 * Allowed transitions, excluding failure edges (added universally below).
 *
 *   created ─▶ claude_running ─▶ handoff_building ─▶ handoff_ready
 *          └▶ codex_running  ───┘
 *                                       ▲                  │
 *                                       │            ┌─────┴─────┐
 *                                       │            ▼           ▼
 *                                  codex_running ◀───┘     claude_running
 *                                   │      ▲  (switch back / resume)
 *                                   ▼      │
 *                               verifying ─┘ (verification failed → keep going)
 *                                   │
 *                                   ▼
 *                               completed
 *
 * Plus: any non-terminal state may transition to `failed` (crash / hard error).
 */
const BASE_TRANSITIONS: Record<SessionState, SessionState[]> = {
  created: ["claude_running", "codex_running"],
  claude_running: ["handoff_building"],
  handoff_building: ["handoff_ready"],
  // A built packet can be picked up by Codex (the demo) or resumed on Claude.
  handoff_ready: ["codex_running", "claude_running"],
  // Codex either runs verification or hands back for another switch.
  codex_running: ["verifying", "handoff_building"],
  // Verification passes (completed) or fails and work continues.
  verifying: ["completed", "codex_running"],
  completed: [],
  failed: [],
};

/** The full transition map: base edges + a `failed` edge from every live state. */
function buildTransitions(): Record<SessionState, ReadonlySet<SessionState>> {
  const map = {} as Record<SessionState, Set<SessionState>>;
  for (const from of SESSION_STATES) {
    const outs = new Set<SessionState>(BASE_TRANSITIONS[from]);
    if (!TERMINAL_STATES.includes(from)) outs.add("failed");
    map[from] = outs;
  }
  return map;
}

export const TRANSITIONS: Record<SessionState, ReadonlySet<SessionState>> =
  buildTransitions();

/** Pure predicate: is `from → to` a legal move? */
export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].has(to);
}

export interface CreateSessionInput {
  goal: string;
  verificationCommand: string;
  workspaceDir: string;
  acceptanceCriteria?: string[];
  sourceAgent?: AgentId; // who runs first; defaults to "claude"
  targetAgent?: AgentId | null;
  /** Optional explicit id (tests / replays); generated when omitted. */
  id?: string;
}

/** Fields callers may patch via `update()` — never `id`, `state`, or timestamps. */
export type SessionPatch = Partial<
  Pick<
    RelaySession,
    | "goal"
    | "acceptanceCriteria"
    | "verificationCommand"
    | "sourceAgent"
    | "targetAgent"
    | "error"
  >
>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SessionNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`No session with id "${id}".`);
    this.name = "SessionNotFoundError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: SessionState,
    readonly to: SessionState
  ) {
    super(`Invalid session transition: ${from} → ${to}.`);
    this.name = "InvalidTransitionError";
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface SessionManagerOptions {
  /** Clock + id generators are injectable so tests are deterministic. */
  now?: () => string;
  generateId?: () => string;
}

export class SessionManager {
  private readonly store = new Map<string, RelaySession>();
  private readonly now: () => string;
  private readonly generateId: () => string;

  constructor(opts: SessionManagerOptions = {}) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.generateId = opts.generateId ?? (() => `sess-${randomUUID()}`);
  }

  /** Create a fresh session in `created`. Validated before it's stored. */
  create(input: CreateSessionInput): RelaySession {
    const id = input.id ?? this.generateId();
    if (this.store.has(id)) {
      throw new Error(`Session id "${id}" already exists.`);
    }
    const ts = this.now();
    const session = RelaySession.parse({
      id,
      state: "created",
      goal: input.goal,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      verificationCommand: input.verificationCommand,
      workspaceDir: input.workspaceDir,
      sourceAgent: input.sourceAgent ?? "claude",
      targetAgent: input.targetAgent ?? null,
      error: null,
      createdAt: ts,
      updatedAt: ts,
    });
    this.store.set(id, session);
    return session;
  }

  /** Read a session; throws if unknown. */
  get(id: string): RelaySession {
    const session = this.store.get(id);
    if (!session) throw new SessionNotFoundError(id);
    return session;
  }

  has(id: string): boolean {
    return this.store.has(id);
  }

  /** All sessions, oldest-created first. */
  list(): RelaySession[] {
    return [...this.store.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
    );
  }

  /** Patch mutable fields (not state). Returns the updated session. */
  update(id: string, patch: SessionPatch): RelaySession {
    const current = this.get(id);
    const next = RelaySession.parse({
      ...current,
      ...patch,
      updatedAt: this.now(),
    });
    this.store.set(id, next);
    return next;
  }

  /**
   * Move a session to `to`, rejecting any transition not in the map. When
   * moving to `failed`, an optional error message is recorded.
   */
  transition(
    id: string,
    to: SessionState,
    opts: { error?: string } = {}
  ): RelaySession {
    const current = this.get(id);
    if (!canTransition(current.state, to)) {
      throw new InvalidTransitionError(current.state, to);
    }
    const next = RelaySession.parse({
      ...current,
      state: to,
      error: to === "failed" ? opts.error ?? current.error : current.error,
      updatedAt: this.now(),
    });
    this.store.set(id, next);
    return next;
  }
}
