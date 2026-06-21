# `@relay/shared` — Locked Contracts

The single source of truth for the data shapes that flow through RelayIDE.
**Everyone builds against these.** They are written in [Zod](https://zod.dev), so
each export is both a runtime validator (`.parse()`) and a TypeScript type
(`z.infer`) from one definition — no drift between compile-time and runtime.

```ts
import {
  EvidenceBundle,
  HandoffPacket,
  RelayEvent,
  RelaySession,
  AgentId,
} from "@relay/shared";

const packet = HandoffPacket.parse(rawJson); // throws if invalid; returns typed
type Packet = import("@relay/shared").HandoffPacket; // the inferred TS type
```

> Import path is the `packages/shared` barrel (`index.ts`). Adjust to your
> workspace alias (`@relay/shared`) or a relative path until the alias is set.

---

## The three formats and how they connect

```
repo + terminal ──► EvidenceBundle ──► [Distiller] ──► HandoffPacket ──► next agent
                     (raw facts)                        (small, validated)

every step also emits ──► RelayEvent ──► Redis timeline stream ──► UI
```

| Format | What it is | Produced by | Consumed by |
|---|---|---|---|
| `EvidenceBundle` | RAW facts (git, commands, terminal, goal) | evidence-collector | distiller |
| `HandoffPacket` | DISTILLED summary handed to the next agent | distiller | orchestrator → next adapter, UI |
| `RelayEvent` | one timeline entry ("what happened") | every component | event-store (Redis), UI |
| `RelaySession` | current session lifecycle and task configuration | server | runtime, API, UI |

---

## `common.ts` — shared primitives

Just the pieces reused by more than one schema. Right now that's a single thing:

```ts
export const AgentId = z.enum(["claude", "codex"]); // a provider identifier
```

`HandoffPacket` uses it for `sourceAgent`/`targetAgent`; `RelayEvent` uses it for
the optional `agent` field. It lives here so both import the *same* definition.

---

## `EvidenceBundle` (`evidence.ts`)

The unprocessed input to distillation.

| Field | Meaning |
|---|---|
| `sessionId` | the session this belongs to |
| `goal` | the original ask — the intent anchor |
| `acceptanceCriteria` | what "done" means |
| `branch` | current git branch |
| `gitStatus` | `git status --porcelain` |
| `gitDiff` | `git diff` |
| `changedFiles` | files touched |
| `commands[]` | `{ command, exitCode, output }` — recent runs (e.g. tests) |
| `latestFailure` | most recent failing output, or `null` |
| `relevantTerminalExcerpt` | bounded recent terminal context |

---

## `HandoffPacket` (`handoff.ts`)

The small, validated output. **This is the contract the next agent reads.**

| Field | Meaning |
|---|---|
| `version` | always `"1.0"` |
| `sessionId` | session id |
| `sourceAgent` / `targetAgent` | `AgentId` — who handed off, who picks up |
| `trigger` | `manual \| rate_limit \| crash \| context_full` |
| `task` | `{ goal, acceptanceCriteria }` |
| `state` | `{ status: in_progress \| blocked \| tests_failing, summary }` |
| `evidence` | `{ changedFiles, commands[{command,exitCode}], latestFailure, diffSummary[] }` |
| `decisions[]` | `{ text, source: user \| repository \| agent }` |
| `constraints[]` | invariants/rules to respect |
| `nextActions[]` | concrete next steps |
| `verificationCommand` | the command that proves the task is done (e.g. `npm test`) |
| `metrics` | `{ sourceTokens, packetTokens, reductionPercent, confidence }` |
| `pitfalls[]` | **failure memory — explicit "do NOT do X"** (defaults `[]`) |
| `focusFiles[]` | `{ path, role, state }` — pointers so the next agent skips re-reading the repo (defaults `[]`) |

---

## `RelayEvent` (`events.ts`)

One normalized entry in the timeline.

```ts
{ id, sessionId, type, timestamp /*ISO*/, agent?, payload }
```

`type` is usually one of `RELAY_EVENT_TYPES`:

```
session.started · agent.started · process.started · terminal.output ·
process.exited · command.finished ·
file.changed · test.failed · limit.detected · handoff.started ·
workspace.frozen · agent.routed · handoff.distilling · handoff.created ·
agent.launching · agent.switched · switch.coalesced · handoff.failed ·
test.passed · session.completed
```

`limit.detected` is emitted when a trigger fires (context_full / rate_limit / crash).

`RelayEventSink` is the shared function type used to connect adapters and process
runners to broadcasters and persistence without importing either implementation.

---

## `RelaySession` (`session.ts`)

The validated session shape returned by the API and consumed by the runtime and
UI. `CreateSessionRequest` is the public POST body contract. The server keeps
filesystem validation and state-transition behavior in its own domain layer.

---

## Deviations from the original spec (agreed)

1. **`sourceAgent`/`targetAgent` are an enum, not fixed literals.** The spec
   hardcoded `"claude"`/`"codex"` (one-way). Both ends use `AgentId` so handoffs
   work in **both** directions.
2. **Two added fields:** `pitfalls` (the "do NOT do X" failure memory) and
   `focusFiles` (anti re-read pointers). Both default to `[]`, so packets that
   ignore them still validate.

---

## Validating in your code

```ts
import { HandoffPacket } from "@relay/shared";

// strict — throws on any mismatch
const packet = HandoffPacket.parse(json);

// safe — no throw; inspect .success
const result = HandoffPacket.safeParse(json);
if (!result.success) console.error(result.error.issues);
```

The Distiller validates with `HandoffPacket.parse()` before storing/sending. If
the model call fails or returns junk, it falls back to a deterministic packet
(goal + changed files + diff summary + last command + verification command) so
compression is never a single point of failure.
