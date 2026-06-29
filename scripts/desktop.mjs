/**
 * Baton desktop launcher.
 *
 * Starts the local server + Vite UI, waits until both are ready, then opens the
 * Electron rail. One Ctrl-C (or closing Electron) shuts the whole stack down.
 *
 *   npm run desktop          # deterministic fake-agent demo
 *   npm run desktop:real     # authenticated Claude/Codex subscription CLIs
 */

import { spawn, spawnSync } from "node:child_process";

const API_PORT = process.env.PORT ?? "4000";
const WEB_PORT = process.env.WEB_PORT ?? "4173";
const API = `http://127.0.0.1:${API_PORT}`;
const UI = `http://127.0.0.1:${WEB_PORT}`;
const WS = `ws://127.0.0.1:${API_PORT}`;
const fake = process.env.RELAY_FAKE_AGENTS ?? "1";
const children = new Set();
let shuttingDown = false;

function authenticated(command, args, acceptsOutput) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
  });
  return result.status === 0 && acceptsOutput(`${result.stdout}\n${result.stderr}`);
}

function requireSubscriptionLogins() {
  const claudeReady = authenticated(
    "claude",
    ["auth", "status"],
    (output) => /"loggedIn"\s*:\s*true/.test(output)
  );
  const codexReady = authenticated(
    "codex",
    ["login", "status"],
    (output) => /logged in/i.test(output)
  );
  if (claudeReady && codexReady) return;

  console.error("\nBaton real mode needs both local subscription CLIs signed in:");
  if (!claudeReady) console.error("  ✖ Claude: run `claude` and complete sign-in");
  if (!codexReady) console.error("  ✖ Codex: run `codex login`");
  console.error("\nThen retry: npm run desktop:real\n");
  process.exit(1);
}

function launch(name, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      console.log(`[baton:${name}] exited (${code ?? signal ?? "unknown"})`);
      shutdown(code ?? 0);
    }
  });
  child.once("error", (error) => {
    console.error(`[baton:${name}] ${error.message}`);
    shutdown(1);
  });
  return child;
}

async function waitFor(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The local process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already closed.
    }
  }
  setTimeout(() => process.exit(code), 350);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(
  `[baton] starting desktop app (${fake === "0" ? "real subscription CLIs" : "safe demo mode"})`
);
if (fake === "0") requireSubscriptionLogins();

launch("stack", process.execPath, ["scripts/demo.mjs"], {
  PORT: API_PORT,
  WEB_PORT,
  RELAY_FAKE_AGENTS: fake,
});

try {
  await Promise.all([waitFor(`${API}/health`), waitFor(UI)]);
  launch("desktop", "npx", ["electron", "electron/main.cjs"], {
    RELAY_UI: UI,
    RELAY_API: API,
    RELAY_WS: WS,
  });
} catch (error) {
  console.error(`[baton] could not start desktop app: ${error.message}`);
  shutdown(1);
}
