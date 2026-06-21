/**
 * Relay server — Git + command evidence collector
 * ------------------------------------------------
 * Turns a workspace directory plus the runtime context the orchestrator records
 * (goal, commands, latest failure, terminal excerpt) into a validated
 * `EvidenceBundle` — the raw facts the handoff is built from.
 *
 * Git is the source of truth: branch, status, diff, and changed files are
 * re-derived from read-only `git` calls each time (never cached, never
 * mutating). Safe by construction — `git` is invoked via `execFileSync` (no
 * shell), every call has a timeout and a bounded buffer, and a non-git folder
 * yields empty git facts instead of throwing.
 *
 * Consolidated into apps/server from the original root `extract.ts` /
 * `evidence-collector.ts` engine prototype.
 */

import { execFileSync } from "node:child_process";
import {
  EvidenceBundle,
  type CommandResult,
} from "../../../packages/shared/evidence";

const GIT_TIMEOUT_MS = 5000;
const MAX_GIT_BYTES = 5 * 1024 * 1024; // 5 MiB cap on any single git output

/** The ephemeral facts git can't provide — recorded live by the orchestrator. */
export interface RuntimeContext {
  sessionId: string;
  goal: string;
  acceptanceCriteria?: string[];
  commands?: CommandResult[];
  latestFailure?: string | null;
  relevantTerminalExcerpt?: string;
}

/** Read-only git facts derived from the workspace. */
export interface GitFacts {
  isGitRepo: boolean;
  branch: string;
  gitStatus: string; // `git status --porcelain`
  gitDiff: string; // `git diff` (working tree vs HEAD)
  changedFiles: string[];
}

/**
 * Run `git` read-only inside `dir`. Never throws: on a non-zero exit, timeout,
 * or missing binary it returns whatever was captured (often ""), so callers get
 * best-effort facts instead of an exception.
 */
function git(args: string[], dir: string): string {
  try {
    return execFileSync("git", args, {
      cwd: dir,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    }).trimEnd();
  } catch (err) {
    const out = (err as { stdout?: Buffer | string })?.stdout;
    return out ? out.toString().trimEnd() : "";
  }
}

/** Parse changed file paths out of `git status --porcelain` (handles renames). */
function parseChangedFiles(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const pathPart = line.replace(/^\s*[MADRCU?!]{1,2}\s+/, "");
      const rename = pathPart.split(" -> ");
      return rename[rename.length - 1]!.trim();
    })
    .filter(Boolean);
}

/** Collect read-only git facts for `dir`. A non-git folder returns empties. */
export function collectGitFacts(dir: string): GitFacts {
  const isGitRepo =
    git(["rev-parse", "--is-inside-work-tree"], dir) === "true";
  if (!isGitRepo) {
    return {
      isGitRepo: false,
      branch: "(no-git)",
      gitStatus: "",
      gitDiff: "",
      changedFiles: [],
    };
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], dir) || "(unknown)";
  const gitStatus = git(["status", "--porcelain"], dir);
  const gitDiff = git(["diff"], dir);
  return {
    isGitRepo: true,
    branch,
    gitStatus,
    gitDiff,
    changedFiles: parseChangedFiles(gitStatus),
  };
}

/** Produce a validated `EvidenceBundle` for `dir` given the runtime context. */
export function collectEvidence(
  dir: string,
  runtime: RuntimeContext
): EvidenceBundle {
  const facts = collectGitFacts(dir);
  return EvidenceBundle.parse({
    sessionId: runtime.sessionId,
    goal: runtime.goal,
    acceptanceCriteria: runtime.acceptanceCriteria ?? [],
    branch: facts.branch,
    gitStatus: facts.gitStatus,
    gitDiff: facts.gitDiff,
    changedFiles: facts.changedFiles,
    commands: runtime.commands ?? [],
    latestFailure: runtime.latestFailure ?? null,
    relevantTerminalExcerpt: runtime.relevantTerminalExcerpt ?? "",
  });
}
