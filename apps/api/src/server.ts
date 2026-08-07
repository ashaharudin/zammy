import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { Pool } from "pg";
// Named import: ioredis is CJS, so the default import resolves to a namespace
// rather than the class under NodeNext resolution.
import { Redis } from "ioredis";
import { type Config, redactConfig } from "@zammy/config";
import { createCurrentsClient, type CurrentsClient } from "@zammy/currents-client";
import { registerHealthRoutes } from "./health.js";

export interface App {
  app: FastifyInstance;
  pool: Pool;
  redis: Redis;
  currents: CurrentsClient;
  close: () => Promise<void>;
}

export async function buildApp(config: Config): Promise<App> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never let a key reach the logs (ARCHITECTURE 5.5).
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    // Trust the ALB's X-Forwarded-* headers in AWS so per-IP rate limiting
    // (ARCHITECTURE 12) sees the real client rather than the load balancer.
    trustProxy: config.NODE_ENV === "production",
  });

  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 2,
    // Redis is pure cache: never let a reconnect storm block a request that
    // Postgres could have served.
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  redis.on("error", (error: unknown) => app.log.warn({ err: error }, "redis error"));
  void redis.connect().catch((error: unknown) => {
    app.log.warn({ err: error }, "redis unavailable at boot; serving degraded");
  });

  await app.register(cors, { origin: config.CORS_ORIGIN.split(",").map((o) => o.trim()) });

  // One interface for both modes: nothing below this line knows or cares whether
  // articles come from the live API or from the recorded payloads
  // (ARCHITECTURE 4.1 — a code path that branches on environment is a code path
  // local development stops predicting).
  const currents = await createCurrentsClient(config, { logger: app.log });
  app.decorate("currents", currents);
  if (config.CURRENTS_MODE === "fixture") {
    app.log.info(
      { dir: config.FIXTURES_DIR },
      "CURRENTS_MODE=fixture — serving recorded payloads, no upstream calls, no quota spend",
    );
  }

  registerHealthRoutes(app, { pool, redis, currents });

  app.log.info({ config: redactConfig(config) }, "configuration loaded");

  const close = async (): Promise<void> => {
    await app.close();
    await Promise.allSettled([pool.end(), redis.quit(), currents.close()]);
  };

  return { app, pool, redis, currents, close };
}

declare module "fastify" {
  interface FastifyInstance {
    currents: CurrentsClient;
  }
}
