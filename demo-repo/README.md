# demo-repo — the Baton handoff target

A small, self-contained, **deterministic** repository used by the Baton demo. An
agent (Claude) starts fixing a real bug, a focused test stays red, Baton hands
off to a second agent (Codex), and the verification command proves the result.

No native dependencies — an in-memory `DB` (`db.ts`) models the one SQLite
behavior that matters: `ALTER TABLE ... ADD COLUMN` fails if the column already
exists.

## The bug

`applyMigration` in `migrate.ts` runs `ALTER TABLE users ADD COLUMN age INT`
**unconditionally**. Run it twice — or re-run it after a partial/crashed first
attempt — and it throws:

```
SQLITE_ERROR: duplicate column name: age
```

## The task

Make `applyMigration` **idempotent** (safe to re-run) without losing data, and
keep the public `applyMigration` signature stable.

## The fix (one guard)

```ts
const cols = db.tableInfo("users").map((c) => c.name);
if (!cols.includes("age")) {
  db.run("ALTER TABLE users ADD COLUMN age INT");
}
```

## Verify

```bash
npm test
```

- **Before the fix:** 1 pass / 2 fail (`is safe to re-run`, `rows preserved`).
- **After the fix:** 3 pass / 0 fail.

This is the real `verificationCommand` Relay runs to decide pass/fail.
