/**
 * Relay server — bootstrap
 * ------------------------
 * The only entry point that has side effects: validate env, build the app, bind
 * the port, and install graceful shutdown. Everything it uses is built and
 * tested in isolation (`env.ts`, `app.ts`), so this file stays thin.
 */

import { loadEnv } from "./env";
import { createAppRuntime, type AppRuntime } from "./app";

/** Drain in-flight requests, then exit. Idempotent + force-quits if stuck. */
function installGracefulShutdown(runtime: AppRuntime): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[relay:server] ${signal} received — shutting down…`);

    const forceTimer = setTimeout(() => {
      console.error("[relay:server] shutdown timed out — forcing exit.");
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    try {
      await runtime.close();
      clearTimeout(forceTimer);
      console.log("[relay:server] closed cleanly.");
      process.exit(0);
    } catch (err) {
      clearTimeout(forceTimer);
      console.error("[relay:server] error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function main(): void {
  const env = loadEnv();
  const runtime = createAppRuntime(env);
  const { server } = runtime;

  server.listen(env.PORT, () => {
    console.log(
      `[relay:server] listening on http://localhost:${env.PORT} (web=${env.WEB_URL})`
    );
  });

  installGracefulShutdown(runtime);
}

main();
