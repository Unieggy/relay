/**
 * Session routes API test — exercises the real router over HTTP on an ephemeral
 * port. The headline case (DoD) creates a session and retrieves it; the rest
 * pin the validation + error contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { SessionManager } from "../session-manager";
import { createApiRouter } from "./index";

async function withApi(
  fn: (base: string, sessions: SessionManager) => Promise<void>
): Promise<void> {
  const sessions = new SessionManager();
  const server = http.createServer(createApiRouter({ sessions }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, sessions);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const VALID_BODY = {
  goal: "Fix the users.age migration so it is safe to re-run.",
  verificationCommand: "npm test",
  workspaceDir: process.cwd(), // a directory that exists during the test run
};

function postSession(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST then GET creates and retrieves one session", async () => {
  await withApi(async (base) => {
    const createRes = await postSession(base, VALID_BODY);
    assert.equal(createRes.status, 201);
    assert.equal(createRes.headers.get("location") !== null, true);
    const created = (await createRes.json()) as {
      id: string;
      state: string;
      goal: string;
    };
    assert.ok(created.id);
    assert.equal(created.state, "created");

    const getRes = await fetch(`${base}/api/sessions/${created.id}`);
    assert.equal(getRes.status, 200);
    const got = (await getRes.json()) as { id: string; goal: string };
    assert.equal(got.id, created.id);
    assert.equal(got.goal, VALID_BODY.goal);
  });
});

test("POST rejects a missing goal with 400 validation_error", async () => {
  await withApi(async (base) => {
    const res = await postSession(base, { ...VALID_BODY, goal: "" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "validation_error");
  });
});

test("POST rejects a non-existent workspaceDir with 400 invalid_workspace", async () => {
  await withApi(async (base) => {
    const res = await postSession(base, {
      ...VALID_BODY,
      workspaceDir: "/no/such/relay/dir",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "invalid_workspace");
  });
});

test("GET an unknown session id returns 404", async () => {
  await withApi(async (base) => {
    const res = await fetch(`${base}/api/sessions/does-not-exist`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "not_found");
  });
});

test("wrong method on /api/sessions returns 405 with Allow: POST", async () => {
  await withApi(async (base) => {
    const res = await fetch(`${base}/api/sessions`, { method: "GET" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  });
});
