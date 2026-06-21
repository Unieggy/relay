/**
 * Relay API — response + request-body helpers
 * -------------------------------------------
 * Small utilities shared by the route handlers: write a JSON response, read a
 * bounded JSON request body, and serialize a thrown error into the standard
 * envelope. Kept in the routes layer so the API is self-contained and testable
 * without the top-level server.
 */

import * as http from "node:http";
import { ZodError } from "zod";
import { HttpError, toErrorResponse } from "../errors";

/** Largest request body we accept (256 KiB) — bounds untrusted input. */
const MAX_BODY_BYTES = 256 * 1024;

export function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/**
 * Read and JSON-parse the request body, capped at MAX_BODY_BYTES. An empty body
 * resolves to `{}` (so schema validation reports the missing fields). Throws an
 * `HttpError` on oversized (413) or malformed (400) input.
 */
export function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(
          new HttpError(413, "Request body too large.", "payload_too_large")
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "Request body is not valid JSON.", "invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

/** Serialize any thrown value into the JSON error envelope + status. */
export function sendError(res: http.ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  // Body/param validation failures become a 400 with the offending fields.
  if (err instanceof ZodError) {
    sendJson(res, 400, {
      error: {
        code: "validation_error",
        message: "Request failed validation.",
        issues: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    });
    return;
  }
  const { statusCode, body, headers, unexpected } = toErrorResponse(err);
  if (unexpected) {
    console.error("[relay:api] unhandled request error:", err);
  }
  sendJson(res, statusCode, body, headers);
}
