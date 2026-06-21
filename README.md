# Relay

Relay preserves coding-session intent and operational context when an AI agent
hits a rate limit, crashes, or runs out of context. The engine freezes workspace
evidence, distills a validated handoff packet, and resumes the task on another
provider.

## Repository map

```text
packages/shared/       Runtime-validated contracts used by every layer
apps/server/src/       HTTP, sessions, WebSockets, process execution, adapters
adapters/               Existing one-shot engine provider integrations
ui/src/                 Terminal companion interface and live event projection
tests/                  Root engine and cross-layer contract tests
demo-repo/              Small deterministic repository for the handoff demo
```

Shared schemas are the dependency boundary: server, engine, persistence, and UI
may import `packages/shared`, but shared contracts never import an application.
Provider adapters emit `RelayEvent`s through `RelayEventSink`; they do not know
whether events are broadcast, persisted, or both.

## Terminal Companion

The React prototype in `ui/` keeps the terminal live on the left with a slim
Relay rail on the right. While an agent works the rail stays quiet; the moment it
fails, one click (**Create handoff**) streams the continuation straight into the
same terminal as the next agent resumes from a validated packet — the task is
never re-explained. The rail shows the active agent, current task, the
transferred packet, and verification.

The demo fixtures are runtime-validated with the same `RelayEvent` and
`HandoffPacket` Zod schemas used by the engine.

```bash
npm run ui:dev
```

Open `http://127.0.0.1:4173`.

Create a production build with:

```bash
npm run ui:build
```

## Verification

```bash
npm test
npm run typecheck
npm run ui:build
```
