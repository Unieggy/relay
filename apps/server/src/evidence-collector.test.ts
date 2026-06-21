/**
 * Evidence collector tests — runs against the real git tree (and a non-git temp
 * dir), so it exercises actual read-only git plumbing, not mocks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectEvidence, collectGitFacts } from "./evidence-collector";
import { EvidenceBundle } from "../../../packages/shared/evidence";

const REPO_ROOT = path.resolve(__dirname, "../../..");

test("collectGitFacts reads a real git repo", () => {
  const facts = collectGitFacts(REPO_ROOT);
  assert.equal(facts.isGitRepo, true);
  assert.ok(facts.branch.length > 0);
  assert.equal(facts.branch.includes("\n"), false);
});

test("collectGitFacts reads Syed's demo-repo (inside the tree)", () => {
  const demo = path.join(REPO_ROOT, "demo-repo");
  const facts = collectGitFacts(demo);
  assert.equal(facts.isGitRepo, true);
});

test("collectGitFacts on a non-git folder returns empties, no throw", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-nogit-"));
  try {
    const facts = collectGitFacts(tmp);
    assert.equal(facts.isGitRepo, false);
    assert.equal(facts.branch, "(no-git)");
    assert.deepEqual(facts.changedFiles, []);
    assert.equal(facts.gitDiff, "");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectEvidence merges git facts with runtime context into a valid bundle", () => {
  const bundle = collectEvidence(REPO_ROOT, {
    sessionId: "s1",
    goal: "Fix the failing auth test",
    acceptanceCriteria: ["auth.test.ts passes"],
    commands: [{ command: "npm test", exitCode: 1, output: "1 failing" }],
    latestFailure: "AssertionError: expected redirect",
    relevantTerminalExcerpt: "...",
  });
  assert.doesNotThrow(() => EvidenceBundle.parse(bundle));
  assert.equal(bundle.sessionId, "s1");
  assert.equal(bundle.goal, "Fix the failing auth test");
  assert.equal(bundle.commands[0]!.exitCode, 1);
  assert.equal(bundle.latestFailure, "AssertionError: expected redirect");
  assert.ok(bundle.branch.length > 0);
});

test("collectEvidence defaults the ephemeral fields when omitted", () => {
  const bundle = collectEvidence(REPO_ROOT, { sessionId: "s2", goal: "g" });
  assert.deepEqual(bundle.commands, []);
  assert.equal(bundle.latestFailure, null);
  assert.equal(bundle.relevantTerminalExcerpt, "");
});
