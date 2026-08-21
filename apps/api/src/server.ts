import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { Pool } from "pg";
// Named import: ioredis is CJS, so the default import resolves to a namespace
// rather than the class under NodeNext resolution.
import { Redis } from "ioredis";
import { type Config, redactConfig } from "@zammy/config";
import type { CurrentsClient } from "@zammy/currents-client";
import { createNewsClient } from "@zammy/news-providers";
import { createDb, databaseSsl } from "@zammy/storage";
import { registerHealthRoutes } from "./health.js";
import { registerQueryRoutes, registerTrendingRoute } from "./routes.js";
import { IngestQueue } from "./ingest-queue.js";
import { createLabeler, createLinkerConfig } from "./wiring.js";
import { Metrics, registerMetricsRoute } from "./metrics.js";
import { processSegmentJob, type TimelineDeps } from "./timeline-service.js";
import { processSampleJob, type TrendingDeps } from "./trending-service.js";

/**
 * Subdivision floor (§6.3): a truncated segment this short is accepted as
 * truncated rather than split further, or a pathologically dense keyword
 * would recurse until it consumed the whole daily quota.
 */
const MIN_SEGMENT_MS = 60 * 60 * 1000;

/**
 * The §10.1 breadth-sample scope: curated values from the /v2/latest-news
 * taxonomy (PROBE-FINDINGS 6c), comma-joined into ONE call per sample. The
 * four omissions (human_interest, labour, automotive, real_estate) trim the
 * feed toward topics a news cloud should surface; remember the filter
 * excludes but does not balance — a busy category can still crowd a sample.
 */
const SAMPLE_CATEGORIES = [
  "general",
  "society",
  "science_technology",
  "politics_government",
  "economy_business_finance",
  "arts_culture_entertainment",
  "lifestyle_leisure",
  "sport",
  "crime_law_justice",
  "education",
  "environment",
  "health",
] as const;


export interface App {
  app: FastifyInstance;
  pool: Pool;
  redis: Redis;
  currents: CurrentsClient;
  close: () => Promise<void>;
}

/**
 * Fastify's `trustProxy` as a hop count, or `false` when nothing is in front.
 *
 * Named and exported so the security-relevant case is testable: with a boolean
 * `true`, `request.ip` resolves to the LEFTMOST `X-Forwarded-For` entry, which is
 * whatever the caller wrote. With a count, only the hops we operate are trusted
 * and the caller's contribution is never reached.
 */
export function trustedProxyOption(hops: number): number | false {
  return hops > 0 ? hops : false;
}

export async function buildApp(config: Config): Promise<App> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never let a key reach the logs (ARCHITECTURE 5.5).
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    // A hop COUNT, never `true`. Trusting the whole X-Forwarded-For chain makes
    // the leftmost entry win, and the leftmost entry is client-supplied — so
    // `true` lets a forged header defeat the per-IP ceiling that rate limiting
    // depends on (ARCHITECTURE 12; see TRUSTED_PROXY_HOPS in @zammy/config).
    // Counting hops trusts only the proxies we run, so `req.ip` is what our own
    // load balancer observed.
    trustProxy: trustedProxyOption(config.TRUSTED_PROXY_HOPS),
  });

  // One pool for the request path, shared with Kysely and with /readyz below.
  // Its size is config, not a literal: 10 suits a server whose replica count is
  // known, and an elastic-instance platform where every instance holds its own
  // pool wants 1–2 (RESEARCH-VERCEL-SUPABASE §4.3). TLS is decided here rather
  // than in the URL, because node-postgres would silently ignore it there
  // (@zammy/storage's databaseSsl).
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    ssl: databaseSsl({ mode: config.DATABASE_SSL, caCert: config.DATABASE_CA_CERT }),
  });
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

  // Per-IP limit on /api/v1/* only (§9.4, §12): novel-fingerprint spam can
  // mint topics and spend quota, but the ALB health check and the Prometheus
  // scrape must never 429. Counters are in-process on purpose — per-task
  // limiting is bounded enough, and a Redis-held counter would add a shared
  // failure mode to the request path for precision nobody needs.
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: 60_000,
    allowList: (request) => !request.url.startsWith("/api/"),
  });

  // One interface for both modes AND for however many providers are configured:
  // nothing below this line knows or cares whether articles come from the live
  // API or from recorded payloads, nor which upstream answered
  // (ARCHITECTURE 4.1 — a code path that branches on environment is a code path
  // local development stops predicting; ARCHITECTURE 5.6 for the provider seam).
  const currents = await createNewsClient(config, { logger: app.log });
  app.decorate("currents", currents);
  if (config.CURRENTS_MODE === "fixture") {
    app.log.info(
      { dir: config.FIXTURES_DIR },
      "CURRENTS_MODE=fixture — serving recorded payloads, no upstream calls, no quota spend",
    );
  }
  if (config.GNEWS_ENABLED) {
    app.log.info(
      { mode: config.GNEWS_MODE, dailyLimit: config.GNEWS_DAILY_CALL_LIMIT },
      "GNEWS_ENABLED — fanning out to a second provider as best-effort breadth; " +
        "Currents remains coverage-bearing",
    );
  }

  registerHealthRoutes(app, { pool, redis, currents });

  // §12 observability: everything the planner counts, scraped from one place.
  const metrics = new Metrics({ quota: () => currents.quota() });
  registerMetricsRoute(app, metrics);

  // The query service (§6) and its in-process job consumer (§9.1). The
  // consumer shares this process — Fargate keeps CPU allocated for the life
  // of a task, so no separate deployable is needed (§4.1).
  const db = createDb(pool);
  const queue = new IngestQueue(config.REDIS_URL);

  // The labeler, built once for this process (ADR-0011's Labels). What is NOT
  // supported is a storyline that gets no label until an operator remembers to
  // run the CLI, which is what this wiring ends.
  //
  // Once shared with the nightly chores; they now run in their own process and
  // build their own client from the same factory, so one pacer no longer covers
  // both. See `wiring.ts` for what that costs on a shared key.
  const labeler = createLabeler(config, app.log);

  const deps: TimelineDeps = {
    db,
    redis,
    currents,
    queue,
    metrics,
    labeler,
    config: {
      syncFillDeadlineMs: config.SYNC_FILL_DEADLINE_MS,
      maxSyncUpstreamCalls: config.MAX_SYNC_UPSTREAM_CALLS,
      lookbackDays: config.CURRENTS_MAX_LOOKBACK_DAYS,
      minSegmentMs: MIN_SEGMENT_MS,
      perTopicDailyCallCap: config.PER_TOPIC_DAILY_CALL_CAP,
      grouping: {
        enabled: config.GROUPING_ENABLED,
        threshold: config.GROUPING_SIMILARITY_THRESHOLD,
        timeZone: config.APP_TIMEZONE,
        // Shared with the nightly sweeps by construction, not by copying: they
        // exist to re-offer the linker what it declined, and an offer judged at
        // a different bar is a different decision (`wiring.ts`).
        linker: createLinkerConfig(config),
        // The collision-triggered label merge: the nightly repair, run by the
        // ingest tail at the moment a label write creates the collision. The
        // rules are the chore's own knobs — a merge decided at a different
        // grace or valve than the nightly pass would be a different decision.
        labelMerge: {
          rules: {
            graceDays: config.STORYLINE_LABEL_MERGE_GRACE_DAYS,
            maxComponent: config.STORYLINE_LABEL_MERGE_MAX_COMPONENT,
          },
          threshold: config.STORYLINE_LABEL_MERGE_TRIGGER,
        },
      },
    },
    now: () => new Date(),
    log: app.log,
  };
  const trendingDeps: TrendingDeps = {
    ...deps,
    trending: {
      sampleCategories: SAMPLE_CATEGORIES,
      samplePages: config.SAMPLE_PAGES,
      sampleRefreshMinutes: config.SAMPLE_REFRESH_MINUTES,
      windowHours: config.TREND_WINDOW_HOURS,
      halfLifeHours: config.TREND_HALF_LIFE_HOURS,
    },
  };

  queue.startConsumer((job) =>
    job.kind === "sample" ? processSampleJob(trendingDeps, job) : processSegmentJob(deps, job),
  );
  await registerQueryRoutes(app, { deps, defaultLanguage: config.DEFAULT_LANGUAGE });
  registerTrendingRoute(app, { deps: trendingDeps });

  // The nightly chores (§9.1) do NOT run here. They are one-shot invocations of
  // `chores-cli.ts` on the platform's scheduler — retention at 03:00 UTC, the
  // storyline pass at 04:00 UTC. This process therefore does not have to be
  // awake for them, and equally cannot make them happen: if nothing schedules
  // the runner, the retention report and the storyline lifecycle passes simply
  // never run, and no log line here will say so. See `chores.ts`.

  app.log.info({ config: redactConfig(config) }, "configuration loaded");

  const close = async (): Promise<void> => {
    await app.close();
    // The queue first (it holds Redis connections and may be mid-job), then
    // the stores. db.destroy() ends the shared pool — nothing ends it twice.
    await queue.close().catch(() => {});
    await Promise.allSettled([db.destroy(), redis.quit(), currents.close()]);
  };

  return { app, pool, redis, currents, close };
}

declare module "fastify" {
  interface FastifyInstance {
    currents: CurrentsClient;
  }
}
