/**
 * Focused verification for the users.age migration.
 *
 * With the current (buggy) `applyMigration`, the re-run and data-preservation
 * tests FAIL — the second ALTER throws `duplicate column name: age`. Once the
 * migration is made idempotent they all pass. This is the deterministic bug the
 * Baton demo hands off from Claude to Codex.
 *
 * Run:  npm test     (from demo-repo/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DB } from "./db";
import { applyMigration } from "./migrate";

function freshDb(): DB {
  const db = new DB();
  db.seed(
    "users",
    [
      { name: "id", type: "INTEGER" },
      { name: "name", type: "TEXT" },
    ],
    [
      { id: 1, name: "Ada" },
      { id: 2, name: "Linus" },
    ]
  );
  return db;
}

test("applyMigration adds the age column on a first run", () => {
  const db = freshDb();
  const result = applyMigration(db);
  assert.equal(result.ok, true);
  assert.ok(
    db.tableInfo("users").some((c) => c.name === "age"),
    "users.age should exist after the migration"
  );
});

test("applyMigration is safe to re-run (idempotent)", () => {
  const db = freshDb();
  applyMigration(db);
  // A second run must not throw — the column already exists.
  assert.doesNotThrow(() => applyMigration(db));
});

test("existing user rows are preserved across re-runs", () => {
  const db = freshDb();
  applyMigration(db);
  applyMigration(db);
  const rows = db.rows("users");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.name, "Ada");
  assert.equal(rows[1]?.name, "Linus");
});
