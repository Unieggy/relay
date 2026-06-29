import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { demoPacket } from "./demo";
import { useRelayStream, type StreamStatus } from "./useRelayStream";
import {
  activeAgent,
  activeSupportsInput,
  currentActivity,
  derivePhase,
  eventLine,
  latestHandoffPacket,
  migrationState,
  packetReady,
  type Line,
  type Phase,
} from "./live";
import type { HandoffPacket } from "../../packages/shared";
import {
  agentLabel,
  createSession as createRelaySession,
  modelFor,
  otherAgent,
  switchAgent as switchRelayAgent,
  type AgentId,
  type RelayApi,
} from "./controlFlow";

type IconName = "arrow" | "check" | "cross" | "spark" | "shield" | "file";

const icons: Record<IconName, ReactNode> = {
  arrow: <path d="M5 12h13m-5-6 6 6-6 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  cross: <path d="M6 6l12 12M18 6 6 18" />,
  spark: <path d="m12 3 1.2 5L18 9l-4.8 1L12 15l-1.2-5L6 9l4.8-1z" />,
  shield: (
    <>
      <path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h5" />
    </>
  ),
};

function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {icons[name]}
    </svg>
  );
}

/** Claude's sunburst mark in its brand clay/orange. */
function ClaudeMark({ size = 22 }: { size?: number }) {
  const rays = Array.from({ length: 12 }, (_, i) => (i * 360) / 12);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <g stroke="#d97757" strokeWidth="2.1" strokeLinecap="round">
        {rays.map((deg) => (
          <line
            key={deg}
            x1="12"
            y1="12"
            x2="12"
            y2="3.5"
            transform={`rotate(${deg} 12 12)`}
          />
        ))}
      </g>
    </svg>
  );
}

function BatonMark({ size = 18 }: { size?: number }) {
  return (
    <span
      className="baton-mark"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <i />
    </span>
  );
}

const readyLines: Line[] = [
  { kind: "relay", value: "↪ baton: control tower ready" },
  { kind: "muted", value: "Choose a workspace and starting agent, then start Baton." },
];

function Terminal({
  lines,
  phase,
  interactive = false,
  onInput,
}: {
  lines: Line[];
  phase: Phase;
  interactive?: boolean;
  onInput?: (text: string) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, interactive]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !onInput) return;
    onInput(text);
    setDraft("");
  }

  return (
    <section className="terminal" aria-label="Live terminal">
      <header className="terminal-bar">
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
        <span className="terminal-title">baton — zsh</span>
        <span className="terminal-branch">baton session</span>
      </header>
      <div
        className="terminal-body"
        ref={bodyRef}
        onClick={() => inputRef.current?.focus()}
      >
        {lines.map((line, i) => (
          <div className={`line ${line.kind}`} key={i}>
            {line.value || " "}
          </div>
        ))}
        {!interactive && phase !== "switching" && <span className="cursor" />}
      </div>
      {interactive && (
        <form className="chat-dock" onSubmit={submit}>
          <span className="chat-label">CHAT</span>
          <input
            ref={inputRef}
            className="chat-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="message the active agent…"
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
          <button type="submit" className="chat-send" disabled={!draft.trim()}>
            Send
          </button>
        </form>
      )}
    </section>
  );
}

function Rail({
  phase,
  handoffDone,
  live = false,
  agentName,
  migration,
  sessionLabel = "session 7f3a",
  controls,
  activity,
  activityLabel = "NOW",
  packet,
  streamStatus = "idle",
  verifyLabel,
  verifyEditable = false,
  onVerifyChange,
  failed = false,
  completed = false,
}: {
  phase: Phase;
  handoffDone: boolean;
  live?: boolean;
  agentName?: "claude" | "codex";
  migration?: "pass" | "fail" | "pending";
  sessionLabel?: string;
  controls?: ReactNode;
  activity: string;
  activityLabel?: string;
  packet: HandoffPacket | null;
  streamStatus?: StreamStatus;
  verifyLabel: string;
  verifyEditable?: boolean;
  onVerifyChange?: (value: string) => void;
  failed?: boolean;
  completed?: boolean;
}) {
  const isCodex = agentName ? agentName === "codex" : phase === "resumed";
  const agent = isCodex
    ? { name: "Codex", letter: "X", tone: "codex" }
    : { name: "Claude", letter: "C", tone: "claude" };

  const status =
    failed
      ? "failed"
      : completed
        ? "completed"
        : !live
          ? "ready"
          : phase === "switching"
            ? "relaying context…"
      : phase === "resumed"
        ? "resumed · working"
        : "running";

  // Verification: explicit override in live mode, else derived from phase.
  const migrationOk = migration ? migration === "pass" : phase === "resumed";

  return (
    <aside className="rail" aria-label="Baton">
      <header className="rail-head">
        <BatonMark />
        <strong>Baton</strong>
        <span className="session">{sessionLabel}</span>
      </header>

      <div className="rail-body">
        {live && streamStatus !== "open" && (
          <div className={`connection-banner ${streamStatus}`} role="status">
            <span className="connection-dot" />
            <span>
              {streamStatus === "connecting"
                ? "Connecting to the local session..."
                : "Live connection lost. Reconnecting..."}
            </span>
          </div>
        )}

        <div className="agent">
          <span className={`glyph ${agent.tone} ${phase}`}>
            {isCodex ? agent.letter : <ClaudeMark size={22} />}
          </span>
          <div>
            <small>ACTIVE AGENT</small>
            <strong>{agent.name}</strong>
            <span
              className={`status ${failed ? "failed" : completed ? "completed" : phase}`}
            >
              {status}
            </span>
          </div>
        </div>

        <section className="handoff-chain" aria-label="Handoff chain">
          <small>HANDOFF CHAIN</small>
          <div className={`chain-track ${phase}`}>
            <span className={`chain-node source ${!isCodex ? "active" : "done"}`} />
            <span className={`chain-node next ${phase !== "working" ? "active" : ""}`} />
            <span className={`chain-node finish ${completed ? "active" : ""}`} />
          </div>
          <div className="chain-labels">
            <span>{isCodex ? "Claude" : agent.name}</span>
            <span>{isCodex ? "Codex" : "next agent"}</span>
            <span>finish</span>
          </div>
          <p>
            <strong>{agent.name}</strong> holds the baton. Context, diffs, and
            failure memory travel with the handoff; <code>{verifyLabel}</code>{" "}
            decides when the work is done.
          </p>
        </section>

        <div className="block activity">
          <small>{activityLabel}</small>
          <p title={activity}>{activity}</p>
        </div>

        <div
          className={`packet ${handoffDone ? "shown" : ""}`}
          aria-hidden={!handoffDone}
        >
          <div className="packet-top">
            <span>
              {packet?.sourceAgent === "codex" ? "Codex" : "Claude"}{" "}
              <Icon name="arrow" size={12} />{" "}
              {packet?.targetAgent === "claude" ? "Claude" : "Codex"}
            </span>
            <b>−{Math.round(packet?.metrics.reductionPercent ?? 93)}%</b>
          </div>
          <div className="packet-meta">
            <span>
              <Icon name="file" size={12} />{" "}
              {packet?.evidence.changedFiles.length ?? 2} files
            </span>
            <span>
              <Icon name="spark" size={12} />{" "}
              {(packet?.metrics.packetTokens ?? 1218).toLocaleString()} tok
            </span>
            <span>
              <Icon name="shield" size={12} /> memory kept
            </span>
          </div>
        </div>

        <div className="block verify">
          <small>VERIFICATION</small>
          {verifyEditable ? (
            <input
              className="verify-input"
              value={verifyLabel}
              onChange={(event) => onVerifyChange?.(event.target.value)}
              placeholder="verification command (e.g. npm test)"
            />
          ) : (
            <div className="check">
              <span
                className={
                  migration === "pending"
                    ? "pending"
                    : migrationOk
                      ? "ok"
                      : "bad"
                }
              >
                <Icon
                  name={
                    migration === "pending"
                      ? "spark"
                      : migrationOk
                        ? "check"
                        : "cross"
                  }
                  size={12}
                />
              </span>
              <code className="check-cmd">{verifyLabel}</code>
              <b
                className={`check-state ${migration ?? (migrationOk ? "pass" : "fail")}`}
              >
                {migration === "pending"
                  ? "pending"
                  : migrationOk
                    ? "pass"
                    : "fail"}
              </b>
            </div>
          )}
        </div>

        {controls}
      </div>

    </aside>
  );
}

// ?live=<sessionId>&ws=<wsBase> switches the UI to the real broadcaster.
// ?rail=1 renders only the Baton rail - the docked terminal-companion sidebar.
function liveConfig(): {
  sessionId: string | null;
  base: string;
  api: string;
  railOnly: boolean;
} {
  if (typeof window === "undefined") {
    return {
      sessionId: null,
      base: "ws://127.0.0.1:4000",
      api: "http://127.0.0.1:4000",
      railOnly: false,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const base = params.get("ws") ?? "ws://127.0.0.1:4000";
  return {
    sessionId: params.get("live"),
    base,
    api: params.get("api") ?? base.replace(/^ws/i, "http"),
    railOnly: params.get("rail") === "1",
  };
}

async function requestJson<T>(
  apiBase: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      data?.error?.message ?? data?.message ?? `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data as T;
}

function updateLiveUrl(sessionId: string, base: string, api: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("live", sessionId);
  url.searchParams.set("ws", base);
  url.searchParams.set("api", api);
  window.history.replaceState(null, "", url);
}

export function App() {
  const config = liveConfig();
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(config.sessionId);
  const [wsBase] = useState(config.base);
  const [apiBase, setApiBase] = useState(config.api);
  const [task, setTask] = useState(demoPacket.task.goal);
  const [verificationCommand, setVerificationCommand] = useState("npm test");
  const [workspaceDir, setWorkspaceDir] = useState("demo-repo");
  const [initialAgent, setInitialAgent] = useState<AgentId>("claude");
  const [claudeModel, setClaudeModel] = useState("claude-sonnet-4-6");
  const [codexModel, setCodexModel] = useState("gpt-5-codex");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [controlMessage, setControlMessage] = useState("");
  const isLive = currentSessionId !== null;

  useEffect(() => {
    if (!currentSessionId) return;
    let cancelled = false;
    void requestJson<{
      goal: string;
      verificationCommand: string;
      workspaceDir: string;
      sourceAgent: AgentId;
    }>(apiBase, `/api/sessions/${currentSessionId}`)
      .then((session) => {
        if (cancelled) return;
        setTask(session.goal);
        setVerificationCommand(session.verificationCommand);
        setWorkspaceDir(session.workspaceDir);
        setInitialAgent(session.sourceAgent);
      })
      .catch(() => {
        // The event stream still provides useful diagnostics if metadata
        // hydration is temporarily unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [currentSessionId, apiBase]);

  // Live mode: events come from the server broadcaster.
  const { events, status } = useRelayStream(
    currentSessionId,
    wsBase,
    apiBase
  );

  async function runControl(action: string, work: () => Promise<void>): Promise<void> {
    setPendingAction(action);
    setControlMessage("");
    try {
      await work();
    } catch (err) {
      setControlMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingAction(null);
    }
  }

  const api: RelayApi = {
    requestJson: (path, init) => requestJson(apiBase, path, init),
  };

  async function createSessionRequest(): Promise<string> {
    const sessionId = await createRelaySession(api, {
        goal: task,
        verificationCommand,
        workspaceDir,
        initialAgent,
    });
    setCurrentSessionId(sessionId);
    updateLiveUrl(sessionId, wsBase, apiBase);
    return sessionId;
  }

  async function ensureLiveSession(): Promise<string> {
    return currentSessionId ?? createSessionRequest();
  }

  async function sessionAction(
    action: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<void> {
    await runControl(action, async () => {
      const sessionId = await ensureLiveSession();
      await requestJson(apiBase, `/api/sessions/${sessionId}${path}`, {
        method: "POST",
        body: body ? JSON.stringify(body) : "{}",
      });
    });
  }

  const apiKeys = { claude: anthropicKey.trim(), codex: openaiKey.trim() };
  function keyFor(agent: AgentId): string | undefined {
    const k = agent === "claude" ? apiKeys.claude : apiKeys.codex;
    return k ? k : undefined;
  }

  async function startNewSession(): Promise<void> {
    await runControl(`start ${initialAgent}`, async () => {
      const sessionId = await createSessionRequest();
      await requestJson(
        apiBase,
        `/api/sessions/${sessionId}/${initialAgent}/start`,
        {
          method: "POST",
          body: JSON.stringify({
            model: modelFor(initialAgent, {
              claude: claudeModel,
              codex: codexModel,
            }),
            prompt: task,
            apiKey: keyFor(initialAgent),
            apiKeys,
            models: { claude: claudeModel, codex: codexModel },
          }),
        }
      );
    });
  }

  async function switchAgent(target: AgentId): Promise<void> {
    await runControl(`switch to ${target}`, async () => {
      const sessionId = await ensureLiveSession();
      await switchRelayAgent(api, {
        sessionId,
        initialAgent,
        target,
        models: { claude: claudeModel, codex: codexModel },
        prompt: task,
        apiKeys,
      });
    });
  }

  // Resolve what the panels render, from whichever mode is active.
  const liveLines: Line[] = events.length
    ? events.map(eventLine)
    : [
        {
          kind: "muted",
          value:
            status === "open"
              ? `connected · waiting for events on ${currentSessionId}…`
              : status === "error" || status === "closed"
                ? `broadcaster unavailable (${wsBase}) — start the server`
                : `connecting to ${wsBase}…`,
        },
      ];

  const phase: Phase = isLive ? derivePhase(events) : "working";
  const lines = isLive ? liveLines : readyLines;
  const handoffDone = isLive ? packetReady(events) : false;
  const packet = isLive ? latestHandoffPacket(events) : null;
  const selectedActiveAgent = isLive && events.length ? activeAgent(events) : initialAgent;
  const switchTarget = otherAgent(selectedActiveAgent);
  const sessionComplete = isLive && events.some((event) => event.type === "session.completed");
  const sessionFailed =
    isLive &&
    events.some(
      (event) =>
        event.type === "session.failed" || event.type === "handoff.failed"
    );
  const sessionTerminal = sessionComplete || sessionFailed;
  const activity = isLive
    ? currentActivity(events, task)
    : task;
  const hasNativePicker =
    typeof window !== "undefined" && Boolean(window.relay?.pickWorkspace);
  async function browseWorkspace(): Promise<void> {
    const picked = await window.relay?.pickWorkspace?.();
    if (typeof picked === "string") setWorkspaceDir(picked);
  }
  // Open the full dashboard (the live terminal = the run logs) in a new window.
  function openLogs(): void {
    const params = new URLSearchParams();
    if (currentSessionId) params.set("live", currentSessionId);
    params.set("api", apiBase);
    params.set("ws", wsBase);
    const url = `${window.location.origin}/?${params.toString()}`;
    window.open(url, "baton-logs", "width=900,height=640");
  }
  const controls = (
    <div className="controls" aria-label="Session controls">
      {!isLive ? (
        <>
          <label className="field">
            <span>Workspace</span>
            {hasNativePicker ? (
              <div className="input-row">
                <input
                  value={workspaceDir}
                  onChange={(event) => setWorkspaceDir(event.target.value)}
                  disabled={pendingAction !== null}
                  placeholder="path the agents work in"
                />
                <button
                  type="button"
                  className="action"
                  onClick={browseWorkspace}
                  disabled={pendingAction !== null}
                >
                  Browse…
                </button>
              </div>
            ) : (
              <input
                value={workspaceDir}
                onChange={(event) => setWorkspaceDir(event.target.value)}
                disabled={pendingAction !== null}
                placeholder="path the agents work in"
              />
            )}
          </label>
          <label className="field compact">
            <span>Start with</span>
            <select
              value={initialAgent}
              onChange={(event) =>
                setInitialAgent(event.target.value as AgentId)
              }
              disabled={pendingAction !== null}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <button
            className="action primary"
            onClick={startNewSession}
            disabled={
              pendingAction !== null ||
              workspaceDir.trim().length === 0
            }
          >
            {pendingAction?.startsWith("start") ? (
              <span className="spinner light" />
            ) : (
              <Icon name="spark" size={14} />
            )}
            Start Baton
          </button>
          <details className="advanced">
            <summary>Advanced</summary>
            <div className="advanced-fields">
              <p className="advanced-note">
                Provider login — only for the real CLIs. Leave blank to use your
                existing terminal sessions: open <code>claude</code> once to
                complete sign-in, and run <code>codex login</code> for Codex.
                Keys entered here go only to the local server for this run —
                never stored or logged.
              </p>
              <label className="field">
                <span>Anthropic API key</span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="sk-ant-…  (or use claude login)"
                  value={anthropicKey}
                  onChange={(event) => setAnthropicKey(event.target.value)}
                  disabled={pendingAction !== null}
                />
              </label>
              <label className="field">
                <span>OpenAI API key</span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="sk-…  (or use codex login)"
                  value={openaiKey}
                  onChange={(event) => setOpenaiKey(event.target.value)}
                  disabled={pendingAction !== null}
                />
              </label>
              <label className="field">
                <span>Claude model</span>
                <input
                  value={claudeModel}
                  onChange={(event) => setClaudeModel(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Codex model</span>
                <input
                  value={codexModel}
                  onChange={(event) => setCodexModel(event.target.value)}
                />
              </label>
              <label className="field">
                <span>API</span>
                <input
                  value={apiBase}
                  onChange={(event) => setApiBase(event.target.value)}
                />
              </label>
              <button type="button" className="action" onClick={openLogs}>
                Open full logs
              </button>
            </div>
          </details>
        </>
      ) : (
        <>
          <div className="action-grid">
            <button
              className="action primary"
              onClick={() => switchAgent(switchTarget)}
              disabled={
                pendingAction !== null || phase === "switching" || sessionTerminal
              }
            >
              {sessionComplete
                ? "Session complete"
                : sessionFailed
                  ? "Session failed"
                  : `Switch to ${agentLabel(switchTarget)}`}
            </button>
            <button
              className="action"
              onClick={() => sessionAction("verify", "/verify")}
              disabled={
                pendingAction !== null || phase === "switching" || sessionTerminal
              }
            >
              {pendingAction === "verify" ? (
                <>
                  <span className="spinner dark" />
                  Verifying
                </>
              ) : (
                "Verify"
              )}
            </button>
          </div>
          <button type="button" className="action" onClick={openLogs}>
            Open full logs
          </button>
        </>
      )}
      {controlMessage && <div className="control-message">{controlMessage}</div>}
    </div>
  );

  return (
    <main className={`shell ${config.railOnly ? "rail-only" : ""}`}>
      <div className="workspace">
        {!config.railOnly && (
          <Terminal
            lines={lines}
            phase={phase}
            interactive={
              isLive && !sessionTerminal && activeSupportsInput(events)
            }
            onInput={(text) =>
              sessionAction("input", "/input", { data: `${text}\n` })
            }
          />
        )}
        <Rail
          phase={phase}
          handoffDone={handoffDone}
          live={isLive}
          agentName={isLive ? activeAgent(events) : initialAgent}
          migration={isLive ? migrationState(events) : undefined}
          sessionLabel={isLive ? `session ${currentSessionId}` : "new session"}
          controls={controls}
          activity={activity}
          activityLabel={isLive ? "NOW" : "GOAL"}
          packet={packet}
          streamStatus={status}
          verifyLabel={verificationCommand}
          verifyEditable={!isLive}
          onVerifyChange={setVerificationCommand}
          failed={sessionFailed}
          completed={sessionComplete}
        />
      </div>
      {!config.railOnly && (
        <footer className="note">
          <span>Quiet while healthy. Ready when an agent fails.</span>
          <span>validated events · packet v{demoPacket.version}</span>
        </footer>
      )}
    </main>
  );
}
