import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentStartOptions } from "./adapters/types";
import type { FakeWorkspaceChange } from "./adapters/fake";

const BROKEN_LINE = '  db.run("ALTER TABLE users ADD COLUMN age INT");';
const FIXED_LINES = [
  '  const columns = db.tableInfo("users").map((column) => column.name);',
  '  if (!columns.includes("age")) {',
  '    db.run("ALTER TABLE users ADD COLUMN age INT");',
  "  }",
].join("\n");

/**
 * Deterministically completes the bundled migration fixture when fake Codex
 * resumes from a handoff. It refuses to touch arbitrary user workspaces.
 */
export function completeBundledDemo(
  opts: AgentStartOptions
): FakeWorkspaceChange[] {
  if (!opts.manifestPath) return [];
  const packagePath = path.join(opts.cwd, "package.json");
  const migrationPath = path.join(opts.cwd, "migrate.ts");
  if (!fs.existsSync(packagePath) || !fs.existsSync(migrationPath)) return [];

  let packageName = "";
  try {
    packageName = JSON.parse(fs.readFileSync(packagePath, "utf8")).name;
  } catch {
    return [];
  }
  if (packageName !== "baton-demo-repo") return [];

  const source = fs.readFileSync(migrationPath, "utf8");
  if (source.includes(FIXED_LINES)) return [];
  if (!source.includes(BROKEN_LINE)) {
    throw new Error("Bundled demo migration no longer matches the fixture.");
  }
  fs.writeFileSync(migrationPath, source.replace(BROKEN_LINE, FIXED_LINES));
  return [{ path: "migrate.ts", additions: 4, deletions: 1 }];
}
