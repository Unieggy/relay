/**
 * Env validation tests — boot should fail loudly on bad config, and good
 * config should parse with the documented defaults.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "./env";

test("loadEnv rejects a non-numeric PORT", () => {
  assert.throws(
    () => loadEnv({ PORT: "not-a-port" }),
    /Invalid server environment/
  );
});

test("loadEnv rejects an out-of-range PORT", () => {
  assert.throws(() => loadEnv({ PORT: "70000" }), /PORT/);
});

test("loadEnv rejects a malformed WEB_URL", () => {
  assert.throws(() => loadEnv({ WEB_URL: "not-a-url" }), /WEB_URL/);
});

test("loadEnv rejects an unknown NODE_ENV", () => {
  assert.throws(() => loadEnv({ NODE_ENV: "staging" }), /NODE_ENV/);
});

test("loadEnv rejects a malformed REDIS_URL", () => {
  assert.throws(() => loadEnv({ REDIS_URL: "not-a-url" }), /REDIS_URL/);
});

test("loadEnv applies defaults when vars are absent", () => {
  const env = loadEnv({});
  assert.equal(env.PORT, 4000);
  assert.equal(env.WEB_URL, "http://localhost:3000");
  assert.equal(env.NODE_ENV, "development");
  // REDIS_URL is opt-in: unset → the in-memory store is used.
  assert.equal(env.REDIS_URL, undefined);
});

test("loadEnv coerces a valid PORT string to a number", () => {
  const env = loadEnv({ PORT: "8080", WEB_URL: "http://localhost:3000" });
  assert.equal(env.PORT, 8080);
});
