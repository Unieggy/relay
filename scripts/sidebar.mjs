/**
 * Baton - docked sidebar launcher.
 *
 * Opens the rail-only companion (?rail=1) as a frameless, app-style desktop
 * window you can pin beside your real terminal. Zero extra dependencies — it
 * reuses Chrome's app mode. Run `npm run demo` first (server + UI), then:
 *
 *   npm run sidebar
 *
 * Override the dashboard origin with RELAY_UI (default http://127.0.0.1:4173).
 */

import { spawn } from "node:child_process";

const ui = process.env.RELAY_UI ?? "http://127.0.0.1:4173";
const api = process.env.RELAY_API ?? "http://127.0.0.1:4000";
const ws = process.env.RELAY_WS ?? "ws://127.0.0.1:4000";
const url = `${ui}/?rail=1&api=${encodeURIComponent(api)}&ws=${encodeURIComponent(ws)}`;

const args = [
  "-na",
  "Google Chrome",
  "--args",
  `--app=${url}`,
  "--window-size=440,920",
  "--window-position=1460,60",
];

console.log(`[baton:sidebar] opening companion -> ${url}`);
const child = spawn("open", args, { stdio: "inherit" });
child.on("error", (err) => {
  console.error("[baton:sidebar] could not open Chrome:", err.message);
  console.error(`[baton:sidebar] open this URL in any browser instead:\n  ${url}`);
  process.exit(1);
});
