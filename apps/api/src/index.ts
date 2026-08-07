import { ConfigError, loadConfig } from "@zammy/config";
import { buildApp } from "./server.js";

/**
 * Entry point. Two things here are deployment requirements, not niceties
 * (ARCHITECTURE 4.1):
 *
 *   1. Config is validated before anything else. A bad deploy fails immediately
 *      with every problem listed, rather than 401ing on the first user search.
 *   2. SIGTERM drains rather than drops. ECS sends SIGTERM on every deploy and
 *      scaling event, and `docker compose down` sends it locally — so the drain
 *      path is exercised constantly in development instead of debuting in prod.
 */

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      console.error("\nCopy .env.example to .env and fill in the blanks.");
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  const { app, close } = await buildApp(config);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");

    // Grace period below the platform's SIGKILL timeout: drain, then give up.
    const timeout = setTimeout(() => {
      app.log.error("graceful shutdown timed out; exiting");
      process.exit(1);
    }, 10_000);
    timeout.unref();

    try {
      await close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error("fatal:", error);
  process.exit(1);
});
