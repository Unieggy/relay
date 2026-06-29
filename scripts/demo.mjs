/**
 * Baton - one-command demo launcher.
 *
 * Starts the orchestration server (fake agents by default, so the full handoff
 * loop runs with no provider CLI/auth) and the Vite dashboard, then prints the
 * live URL. Ctrl-C stops both.
 *
 *   npm run demo                 # fake agents (reliable demo)
 *   RELAY_FAKE_AGENTS=0 npm run demo   # real Claude/Codex CLIs (must be installed + authed)
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const API_PORT = process.env.PORT ?? "4000";
const WEB_PORT = process.env.WEB_PORT ?? "4173";
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const fake = process.env.RELAY_FAKE_AGENTS ?? "1";

// Every fake demo starts from the same intentionally broken fixture. The fake
// Codex adapter repairs this exact snippet after receiving the handoff packet.
const migrationPath = resolve("demo-repo/migrate.ts");
const brokenMigration =
  '  db.run("ALTER TABLE users ADD COLUMN age INT");';
const fixedMigration = [
  '  const columns = db.tableInfo("users").map((column) => column.name);',
  '  if (!columns.includes("age")) {',
  '    db.run("ALTER TABLE users ADD COLUMN age INT");',
  "  }",
].join("\n");
function resetDemoFixture() {
  if (fake === "0") return;
  const migration = readFileSync(migrationPath, "utf8");
  if (migration.includes(fixedMigration)) {
    writeFileSync(migrationPath, migration.replace(fixedMigration, brokenMigration));
  }
}
resetDemoFixture();

const children = [];
function run(name, cmd, args, env) {
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const tag = `[${name}]`;
  child.stdout.on("data", (d) => process.stdout.write(`${tag} ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`${tag} ${d}`));
  child.on("exit", (code) => {
    console.log(`${tag} exited (${code})`);
    shutdown();
  });
  children.push(child);
  return child;
}

let down = false;
function shutdown() {
  if (down) return;
  down = true;
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  resetDemoFixture();
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run("server", "npx", ["tsx", "apps/server/src/index.ts"], {
  PORT: API_PORT,
  WEB_URL,
  RELAY_FAKE_AGENTS: fake,
});
run(
  "ui",
  "npx",
  [
    "vite",
    "--config",
    "ui/vite.config.ts",
    "--port",
    WEB_PORT,
    "--strictPort",
  ],
  {}
);

setTimeout(() => {
  console.log("\n────────────────────────────────────────────────────────");
  console.log("  Baton demo");
  console.log(`  Dashboard : ${WEB_URL}/?api=http://127.0.0.1:${API_PORT}&ws=ws://127.0.0.1:${API_PORT}`);
  console.log(`  Server    : http://127.0.0.1:${API_PORT}  (fake agents: ${fake !== "0"})`);
  console.log("  Ctrl-C to stop both.");
  console.log("────────────────────────────────────────────────────────\n");
}, 2500);
