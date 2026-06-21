/**
 * Relay server — environment validation
 * -------------------------------------
 * The single, typed gate between `process.env` and the rest of the server.
 * Nothing else reads `process.env` directly; everyone takes a validated `Env`.
 * Invalid config fails loudly at boot rather than surfacing as a confusing
 * runtime error later.
 *
 * This ticket validates only PORT and WEB_URL (plus NODE_ENV). More vars
 * (REDIS_URL, SENTRY_*) get added to this schema as their features land.
 */

import { z } from "zod";

const EnvSchema = z.object({
  /** Port the HTTP server binds to. `0` is allowed so tests can use an
   *  ephemeral port. */
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  /** Origin of the Relay dashboard — used later for CORS / WS allow-listing. */
  WEB_URL: z.url().default("http://localhost:3000"),
  /** Redis connection for the durable event store. When unset, events are kept
   *  in memory (fine for dev/tests; lost on restart). Set it to enable Redis. */
  REDIS_URL: z.url().optional(),
  /** When set, run deterministic in-memory fake agents instead of spawning the
   *  real Claude/Codex CLIs. Lets the full handoff loop demo without provider
   *  auth. Real adapters are the default. */
  RELAY_FAKE_AGENTS: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse + validate the environment. Throws a single readable error listing
 * every invalid/missing var, so a misconfigured boot is obvious. Accepts an
 * explicit source (defaults to `process.env`) so tests can supply their own.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid server environment:\n${issues}`);
  }
  return parsed.data;
}
