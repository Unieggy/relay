# Relay

**Relay compiles noisy agent work into the smallest verified state another coding tool needs to continue.**

When an AI coding agent hits a usage limit, crashes, or stalls mid-task, you
normally have to re-explain everything to the next tool. Relay captures the
unfinished work from *factual evidence* (git diff, test exit codes, terminal
output), compiles a small portable **handoff packet**, launches a **different**
agent in the same repository, and verifies whether it actually finished — the
developer never re-explains the task.

Relay is not an editor or a Cursor clone. It transfers work *between* independent
tools (Claude Code ⇄ Codex CLI) through a visible, provider-neutral manifest.

---

## Quickstart

```bash
npm install
npm run demo
```

Open the printed dashboard URL (`http://127.0.0.1:4173/?api=…&ws=…`) and click
**Start Relay**. The demo runs deterministic fake agents end-to-end — no provider
CLI or auth required.

Run against the real CLIs (must be installed + authenticated):

```bash
RELAY_FAKE_AGENTS=0 npm run demo
```

### Docked sidebar (terminal companion)

Pin the rail beside your real terminal as a frameless desktop window:

```bash
npm run demo       # in one shell (server + UI)
npm run sidebar    # in another — opens the rail-only companion
```

Or open the rail-only view in any browser:
`http://127.0.0.1:4173/?rail=1`. (A standalone Electron/VS-code wrapper is the
next step — both reuse this same view, no rewrite.)

## The demo flow

1. An agent (Claude) starts fixing a real bug in `demo-repo/` — the `users.age`
   migration runs `ALTER TABLE` unconditionally, so the focused test fails.
2. The agent hits a usage limit with the test still red.
3. Relay freezes the workspace, distills a validated handoff packet, and launches
   the other agent (Codex) in the same repo from that packet alone.
4. Codex finishes the task; Relay runs the verification command and shows the
   real exit code + final diff.

The user never re-explains the task during the transfer.

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│  React / Vite dashboard (ui/)                                │
│  live terminal + Relay rail   ◀── WebSocket events           │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTP (/api) + WS (/ws/sessions/:id)
┌───────────────▼─────────────────────────────────────────────┐
│  Node + TypeScript server (apps/server/src/)                 │
│  ┌────────────┐ ┌───────────┐ ┌────────────┐ ┌────────────┐ │
│  │ session    │ │ process   │ │ orchestr.  │ │ broadcaster│ │
│  │ manager    │ │ runner    │ │ + handoff  │ │ (WS)       │ │
│  └────────────┘ └───────────┘ └─────┬──────┘ └────────────┘ │
│  ┌────────────┐ ┌───────────┐       │  ┌──────────────────┐ │
│  │ adapters   │ │ verifier  │       └─▶│ event store      │ │
│  │ claude/cdx │ │           │          │ Redis | in-memory│ │
│  └─────┬──────┘ └───────────┘          └──────────────────┘ │
└────────┼─────────────────────────────────────────────────────┘
         ▼
   Local Git repository (the workspace the agents operate in)
```

The browser requests actions; the server controls processes and secrets.
Evidence flows from the repo and command exit codes — **the repository and
executable evidence outrank agent summaries.**

## Repository map

```text
packages/shared/    Runtime-validated contracts (RelayEvent, HandoffPacket, …)
apps/server/src/    HTTP, sessions, WebSockets, process runner, adapters, store
ui/src/             Terminal companion dashboard + live event projection
demo-repo/          Deterministic migration bug — the handoff target
tests/              Engine + cross-layer contract tests
```

Shared schemas are the dependency boundary: every layer may import
`packages/shared`, but contracts never import an application. Adapters emit
`RelayEvent`s through a `RelayEventSink`; they don't know whether events are
broadcast, persisted, or both.

## Verification

```bash
npm test          # engine + server suites
npm run typecheck
npm run ui:build
```

Redis is optional — set `REDIS_URL` for durable, refresh-surviving timelines;
without it, an in-memory store with the same interface is used.

## Built with

TypeScript · Node.js · React · Vite · Redis · WebSocket · Zod · Claude · Codex

## What's next

- Real multi-CLI runs with authenticated `claude` + `codex`
- Session persistence across server restarts
- RelayBench: measured with-vs-without continuation comparisons
- Controlled multi-hop handoffs
- Package the rail as a true terminal companion / desktop overlay
