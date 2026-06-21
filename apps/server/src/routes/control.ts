/**
 * Relay API — session control routes (orchestrator-backed)
 * --------------------------------------------------------
 *   POST /api/sessions/:id/claude/start   start Claude
 *   POST /api/sessions/:id/input          forward stdin to the live agent
 *   POST /api/sessions/:id/handoff        build the handoff packet
 *   POST /api/sessions/:id/codex/start    resume with Codex from the packet
 *   POST /api/sessions/:id/verify         run the verification command
 *   GET  /api/sessions/:id/diff           current git diff + changed files
 *   GET  /api/sessions/:id/events         the event timeline
 *
 * Each handler delegates to the injected `Orchestrator`; it never touches
 * processes or state directly.
 */

import * as http from "node:http";
import { z } from "zod";
import { HttpError, methodNotAllowed } from "../errors";
import { readJsonBody, sendJson } from "./respond";
import type { Orchestrator } from "../orchestrator";

export interface ControlDeps {
  orchestrator?: Orchestrator;
}

const StartBody = z
  .object({ model: z.string().optional(), prompt: z.string().optional() })
  .default({});
const InputBody = z.object({ data: z.string().min(1, "data is required") });

const ACTION =
  /^\/api\/sessions\/([^/]+)\/(claude\/start|codex\/start|input|handoff|verify|diff|events)$/;

function orchestratorOf(deps: ControlDeps): Orchestrator {
  if (!deps.orchestrator) {
    throw new HttpError(503, "Orchestrator is not configured.", "not_configured");
  }
  return deps.orchestrator;
}

function requireMethod(
  req: http.IncomingMessage,
  expected: string,
  pathname: string
): void {
  if (req.method !== expected) {
    throw methodNotAllowed([expected], `${req.method} not allowed on ${pathname}`);
  }
}

export async function handleControlRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ControlDeps
): Promise<boolean> {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const match = ACTION.exec(pathname);
  if (!match) return false;

  const id = decodeURIComponent(match[1]!);
  const action = match[2]!;
  const orch = orchestratorOf(deps);

  switch (action) {
    case "claude/start": {
      requireMethod(req, "POST", pathname);
      const body = StartBody.parse(await readJsonBody(req));
      await orch.startClaude(id, body);
      sendJson(res, 202, { sessionId: id, state: "claude_running" });
      return true;
    }
    case "input": {
      requireMethod(req, "POST", pathname);
      const { data } = InputBody.parse(await readJsonBody(req));
      orch.sendInput(id, data);
      sendJson(res, 200, { ok: true });
      return true;
    }
    case "handoff": {
      requireMethod(req, "POST", pathname);
      const packet = await orch.buildHandoff(id);
      sendJson(res, 200, packet);
      return true;
    }
    case "codex/start": {
      requireMethod(req, "POST", pathname);
      const body = StartBody.parse(await readJsonBody(req));
      await orch.startCodex(id, { model: body.model });
      sendJson(res, 202, { sessionId: id, state: "codex_running" });
      return true;
    }
    case "verify": {
      requireMethod(req, "POST", pathname);
      const result = await orch.verify(id);
      sendJson(res, 200, result);
      return true;
    }
    case "diff": {
      requireMethod(req, "GET", pathname);
      sendJson(res, 200, orch.getDiff(id));
      return true;
    }
    case "events": {
      requireMethod(req, "GET", pathname);
      sendJson(res, 200, { events: await orch.getEvents(id) });
      return true;
    }
    default:
      return false;
  }
}
