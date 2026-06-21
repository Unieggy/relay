/**
 * Relay API — session routes
 * --------------------------
 *   POST /api/sessions       → create a session (validated), 201 + RelaySession
 *   GET  /api/sessions/:id   → fetch a session, 200 + RelaySession (404 if absent)
 *
 * Validation lives here: goal, verificationCommand, and a workspaceDir that must
 * resolve to a real directory on disk (the repo the agents operate in). The
 * route depends only on an injected `SessionManager`, so it's unit-testable.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { CreateSessionRequest } from "../../../../packages/shared";
import { HttpError, methodNotAllowed, notFound } from "../errors";
import {
  SessionManager,
  SessionNotFoundError,
  type CreateSessionInput,
} from "../session-manager";
import { readJsonBody, sendJson } from "./respond";

export interface SessionRoutesDeps {
  sessions: SessionManager;
}

/** Resolve + verify the repository path is an existing directory. */
function resolveWorkspaceDir(input: string): string {
  const dir = path.resolve(input);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new HttpError(
      400,
      `workspaceDir does not exist: ${dir}`,
      "invalid_workspace"
    );
  }
  if (!stat.isDirectory()) {
    throw new HttpError(
      400,
      `workspaceDir is not a directory: ${dir}`,
      "invalid_workspace"
    );
  }
  return dir;
}

async function createSession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: SessionRoutesDeps
): Promise<void> {
  const body = CreateSessionRequest.parse(await readJsonBody(req));
  const input: CreateSessionInput = {
    goal: body.goal,
    verificationCommand: body.verificationCommand,
    workspaceDir: resolveWorkspaceDir(body.workspaceDir),
    acceptanceCriteria: body.acceptanceCriteria,
    sourceAgent: body.sourceAgent,
    targetAgent: body.targetAgent ?? null,
  };
  const session = deps.sessions.create(input);
  sendJson(res, 201, session, { location: `/api/sessions/${session.id}` });
}

function getSession(
  res: http.ServerResponse,
  deps: SessionRoutesDeps,
  id: string
): void {
  try {
    sendJson(res, 200, deps.sessions.get(id));
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      throw notFound(`No session with id "${id}".`);
    }
    throw err;
  }
}

/**
 * Dispatch a request against the session routes. Returns true if the path
 * belonged to this router (handled or method-rejected), false otherwise so a
 * parent router can keep matching.
 */
export async function handleSessionRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: SessionRoutesDeps
): Promise<boolean> {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");

  if (pathname === "/api/sessions") {
    if (req.method !== "POST") {
      throw methodNotAllowed(["POST"], `${req.method} not allowed on /api/sessions`);
    }
    await createSession(req, res, deps);
    return true;
  }

  const match = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
  if (match) {
    const id = decodeURIComponent(match[1]!); // group 1 is present when matched
    if (req.method !== "GET") {
      throw methodNotAllowed(["GET"], `${req.method} not allowed on /api/sessions/:id`);
    }
    getSession(res, deps, id);
    return true;
  }

  return false;
}
