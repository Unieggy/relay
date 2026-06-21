/**
 * Relay API router
 * ----------------
 * Composes the `/api/*` routes into a single request handler with centralized
 * error serialization. `createApiRouter(deps)` returns a handler the top-level
 * server delegates to (and that tests mount directly). Dependencies (the
 * SessionManager, later the orchestrator/event-store) are injected, never
 * imported as singletons, so the API stays testable in isolation.
 */

import * as http from "node:http";
import { notFound } from "../errors";
import type { SessionManager } from "../session-manager";
import type { Orchestrator } from "../orchestrator";
import { handleSessionRoutes } from "./sessions";
import { handleControlRoutes } from "./control";
import { sendError } from "./respond";

export interface ApiDeps {
  sessions: SessionManager;
  /** Required for the control routes (start/input/handoff/codex/verify/diff/events). */
  orchestrator?: Orchestrator;
}

export type ApiHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => Promise<void>;

export function createApiRouter(deps: ApiDeps): ApiHandler {
  return async (req, res) => {
    try {
      const handled =
        (await handleSessionRoutes(req, res, deps)) ||
        (await handleControlRoutes(req, res, deps));
      if (!handled) {
        throw notFound(`No route for ${req.method} ${req.url}`);
      }
    } catch (err) {
      sendError(res, err);
    }
  };
}

export { handleSessionRoutes } from "./sessions";
export { handleControlRoutes } from "./control";
