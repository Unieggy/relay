# Baton — Presentation Brief

> Source-of-truth doc for building a PowerPoint deck (via ChatGPT) and for
> talking through the project with a recruiter. Everything here is factual —
> backed by the codebase, not marketing fluff. Numbers that are *not yet
> measured* are flagged honestly so you never get caught overclaiming.

---

## 0. One-liner (memorize this)

**Baton keeps AI coding work alive when the agent dies.** When a coding agent
hits a usage limit, crashes, or the provider has an outage, Baton compiles the
in-progress work into a small, verified handoff packet and launches a *different*
agent to finish the job — so the developer never has to re-explain the task.

Elevator version (15 sec): *"Today an AI coding agent is a single point of
failure — if it stops, you lose all the context and have to restart from scratch
with another tool. Baton makes that work portable: it captures what the agent was
doing from real evidence — git diff, test results — hands it to a second agent,
and verifies the result with real tests. One provider's outage stops being your
blocked day."*

---

## 1. What it is

- A **provider-neutral handoff engine** for AI coding agents (Claude Code ⇄ Codex
  CLI today; built to add more).
- **Not** an editor or a Cursor clone. It moves work *between* independent tools
  through a visible, vendor-agnostic manifest.
- Ships as a local control server + React dashboard + a native Electron desktop
  companion that docks beside your real terminal.

## 2. The problem (the pain a recruiter will instantly get)

- AI coding agents fail constantly mid-task: **usage limits, crashes, context
  windows filling up, and provider-side outages.**
- When that happens, the session — and all its context — dies.
- The human becomes the recovery mechanism: re-read the diff, reconstruct what
  the agent meant, and re-prompt a fresh tool from zero. **That re-explanation
  tax is paid every single time, and grows with the size of the change.**
- You're also **locked to one vendor** — if Claude is down or rate-limited, work
  stops, even if Codex is sitting right there, healthy.

## 3. The solution (how Baton fixes it)

Baton treats agent work as **portable, verifiable state** — not a disposable chat
session. Four moves:

1. **Capture from evidence, not vibes.** It reconstructs the work from facts a
   machine can verify — `git diff`, `git status`, changed files, test exit codes,
   terminal output — never from the agent's own (possibly wrong) self-report.
2. **Compile a small handoff packet.** An LLM distills only the *reasoning* a
   fresh agent can't recover from disk (intent, decisions, what NOT to do);
   deterministic code fills the hard facts. The result is a tiny, schema-
   validated packet.
3. **Hand off to a different agent / provider.** It launches a second tool in the
   same repo, seeded only by that packet. Claude down → Codex continues, and
   vice versa.
4. **Verify with real tests.** Pass/fail is decided **solely by the command exit
   code** — never by what the agent claimed. The verdict is shown live.

**The developer never re-explains the task during the transfer.**

## 4. Key features (deck-ready bullets)

- **Provider-neutral handoff** — Claude Code ⇄ Codex CLI; bidirectional; adapters
  make adding new agents a drop-in.
- **Evidence-based capture** — git diff/status, changed files, command exit codes,
  terminal output. The repo and exit codes outrank any agent summary.
- **Failure memory ("pitfalls")** — the packet carries explicit "do NOT do X"
  derived from the failure, so the next agent doesn't repeat the mistake.
- **Real verification** — runs the actual test command; pass/fail = exit code,
  full stop. No trusting the AI's word.
- **Token reduction metric** — measures how much smaller the handoff packet is
  vs the raw session context.
- **Outage / rate-limit resilience** — the packet is built from local disk, so it
  doesn't need the failed provider to be reachable; automatic failover to a
  healthy agent.
- **Live dashboard** — React/Vite UI with a streaming terminal and a Baton rail
  (live "WORKING ON", context meter, reconnect status, verification verdict).
- **Native desktop companion** — Electron window that snaps to a screen edge (the
  "magnet"), with a native folder picker for the workspace.
- **One-command demo** — `npm run demo` runs deterministic fake agents end-to-end,
  no API keys needed; `npm run desktop:real` runs against real authenticated CLIs.
- **Durable timelines** — optional Redis event store with cursor replay; survives
  a browser refresh (and is the path to surviving an orchestrator restart).
- **Safe by construction** — server binds to loopback only; git invoked without a
  shell, with timeouts and output caps.

## 5. How it works (architecture — for the technical slide)

```
RuntimeContext (goal, commands, latest failure)  ─┐
                                                   ├─► collectEvidence() → EvidenceBundle
git (branch, diff, status, changed files) ────────┘        (Zod-validated)
                                                                  │
                                                                  ▼
                                          distill(evidence, meta)  →  LLM writes the
                                          reasoning JSON; code fills the hard facts
                                                                  │
                                                                  ▼
                                              HandoffPacket v1.0 (Zod-validated)
                                                                  │
                          orchestrator: save packet → launch the *target* agent
                                                                  │
                                                                  ▼
                                       runVerification() → exit code = pass / fail
```

- **`packages/shared/`** — runtime-validated Zod contracts (events, evidence,
  handoff, session). The dependency boundary; contracts never import an app.
- **`apps/server/src/`** — HTTP + WebSocket server, session manager (state
  machine), process runner, orchestrator (owns the loop), evidence collector,
  verifier, broadcaster, event store (Redis or in-memory).
- **`adapters/`** — real `claude` and `codex exec` CLI integration (`launch()` +
  `compress()` per provider).
- **`ui/`** — React dashboard, live terminal, Baton rail.
- **`electron/`** — native docked desktop companion.

**Stack:** TypeScript · Node.js · React · Vite · Redis · WebSocket · Zod ·
Claude · Codex · Electron.

## 6. Live demo script (the money moment — ~90 seconds)

1. An agent (Claude) starts fixing a real bug in `demo-repo/` — a migration runs
   `ALTER TABLE` unconditionally, so the focused test fails.
2. The agent **hits a usage limit** with the test still red.
3. Baton **freezes the workspace, distills a verified handoff packet, and launches
   the other agent (Codex)** in the same repo — from the packet alone.
4. Codex finishes the work. Click **Verify** → Baton runs the real test command
   and shows the exit code and the green verdict.
5. Punchline: **"I never re-typed the task. The work survived the agent dying."**

## 7. Honest metrics (say these exactly — do not inflate)

- ✅ **Token reduction** — real math (`1 − packetTokens/sourceTokens`) on a
  ~4-chars-per-token approximation. Directionally honest; not a lab tokenizer.
- ✅ **Verification** — fully objective: pass/fail is the real process exit code.
- ⚠️ **Confidence score** — this is the LLM's *self-reported* 0–1 number, **not a
  measured accuracy.** Don't present it as "X% accurate."
- ⚠️ **No-Baton baseline** — not yet instrumented; we have no measured end-to-end
  comparison against a no-Baton workflow. (This is the #1 thing to build next.)
- ✅ **Engineering proof** — 96+ tests pass, typecheck clean, 37 PRs merged,
  built by a team of 4 in a hackathon day.

> If a recruiter asks "how do you know the handoff is good?" — the honest, strong
> answer is: *"the only thing we trust is the real test exit code; everything else
> is evidence the next agent can re-verify itself. Measuring end-to-end success
> rate vs a no-Baton baseline is our next milestone."* That candor reads as
> engineering maturity, not weakness.

## 8. Who it's for

- **Individual developers** — never re-explain a task; use whichever agent is up,
  cheap, or healthy; local and private by default.
- **Teams & enterprises** — resilience to provider outages and rate limits;
  auditable, provider-neutral handoffs; no vendor lock-in; cost control; a
  factual evidence trail for compliance/review.

## 9. Roadmap (the "where this goes" slide)

- **Provider resilience** — health-aware routing that fails over *before* a task
  stalls; more adapters behind the same contract; retry-and-escalate.
- **Proof** — instrument a no-Baton baseline so we can show a real, measured
  end-to-end delta.
- **Team** — handoff packets that move *between developers*, not just tools;
  centralized signed audit log; policy controls (allowed providers, data
  residency); self-hosted / VPC + SSO.
- **Verification** — richer verdicts (per-test results, coverage deltas, lint/type
  gates) attached to each packet.

## 10. Why this is impressive (the recruiter takeaway)

- **Sharp, non-obvious idea** — reframes the agent from a chat session into
  portable, verifiable state. Not another wrapper.
- **Real systems engineering** — process orchestration, a typed contract layer, a
  session state machine, WebSocket streaming, Redis replay, and a native desktop
  shell — all integrated and tested.
- **Intellectual honesty** — measures what it can prove (exit codes, token counts)
  and refuses to invent the numbers it can't. That judgment is the signal.
- **Team velocity** — a coherent, multi-layer product shipped by 4 people in a day
  with green tests and clean types.

---

## 11. ChatGPT prompt — paste this to generate the deck

> Copy everything in the code block below into ChatGPT, then paste this whole
> `PRESENTATION.md` file right after it.

```
You are a senior product-marketing designer building a polished, recruiter-facing
PowerPoint pitch deck for a hackathon project called "Baton."

I'm pasting a detailed brief below. Use ONLY the facts in it — do not invent
features, numbers, or claims. Where the brief flags a metric as "not yet
measured" or "self-reported," respect that exactly and never present it as a hard
result.

Audience: a technical recruiter (and possibly an engineer) seeing this for the
first time. They care about: what it is, why it matters, how it works, what was
actually built, and whether the person behind it can build and reason well.

Produce a 12–14 slide deck. For EACH slide give me:
- Slide title (short, punchy)
- 3–5 concise bullet points (recruiter-skimmable, not paragraphs)
- A one-line "speaker note" telling me what to say out loud
- A suggested visual/diagram for the slide

Slide order:
1. Title + one-liner hook
2. The problem (AI agents are a single point of failure)
3. The cost of the problem (the re-explanation tax + vendor lock-in)
4. The solution — Baton, in one sentence + the 4 moves
5. Key features (the strongest 6)
6. How it works — the architecture pipeline (evidence → distill → handoff → verify)
7. Live demo walkthrough (the 90-second failover story)
8. Tech stack + engineering proof (tests, PRs, team)
9. Honest metrics (what's measured vs what's next — frame the candor as a strength)
10. Who it's for (developers + enterprises, with the outage-resilience angle)
11. Roadmap
12. Why this is impressive / closing ask

Design direction: clean, modern, dark-tech aesthetic; minimal text per slide;
strong visual hierarchy; one idea per slide. Suggest an accent color and a
font pairing. Give me the architecture pipeline as an ASCII or boxes-and-arrows
diagram I can recreate.

After the slides, give me a 60-second verbal pitch script I can memorize, and 5
likely recruiter questions with strong, honest answers.

Here is the brief:
[PASTE THE FULL PRESENTATION.md BELOW THIS LINE]
```
