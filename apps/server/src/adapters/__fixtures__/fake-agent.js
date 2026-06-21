#!/usr/bin/env node
/**
 * Fixture executable standing in for the `claude` / `codex` CLIs in adapter
 * tests — NO real provider is ever invoked. It:
 *   - prints the argv it received as `ARGV:[...]`
 *   - echoes any stdin it receives as `STDIN:<data>`
 *   - exits with $FAKE_AGENT_EXIT (default 0), either on stdin EOF or after a
 *     short fallback so a kept-open stdin never hangs the test.
 */

const args = process.argv.slice(2);
process.stdout.write("ARGV:" + JSON.stringify(args) + "\n");

const exitCode = Number(process.env.FAKE_AGENT_EXIT || "0");

process.stdin.on("data", (d) => {
  process.stdout.write("STDIN:" + d.toString());
});
process.stdin.on("end", () => process.exit(exitCode));

// Fallback: the adapter keeps stdin open for sendInput, so guarantee an exit.
setTimeout(() => process.exit(exitCode), 250);
