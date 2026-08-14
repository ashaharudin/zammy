import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { Pool } from "pg";
// Named import: ioredis is CJS, so the default import resolves to a namespace
// rather than the class under NodeNext resolution.
import { Redis } from "ioredis";
import { type Config, redactConfig } from "@zammy/config";
import { createCurrentsClient, type CurrentsClient } from "@zammy/currents-client";
import { createDb } from "@zammy/storage";
import { registerHealthRoutes } from "./health.js";
import { registerQueryRoutes, registerTrendingRoute } from "./routes.js";
import { IngestQueue } from "./ingest-queue.js";
import {
  ChoreQueue,
  runDormancyChore,
  runRetentionChore,
  runStorylineLabelChore,
  type ChoreDeps,
} from "./chores.js";
import { createGeminiClient } from "./gemini.js";
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

  // §12 observability: everything the planner counts, scraped from one place.
  const metrics = new Metrics({ quota: () => currents.quota() });
  registerMetricsRoute(app, metrics);

  // The query service (§6) and its in-process job consumer (§9.1). The
  // consumer shares this process — Fargate keeps CPU allocated for the life
  // of a task, so no separate deployable is needed (§4.1).
  const db = createDb(pool);
  const queue = new IngestQueue(config.REDIS_URL);

  // The labeler, built once (ADR-0011's Labels). No key is a supported
  // configuration and not a degraded one: the generator is null, the bigram
  // extractor becomes the only path, and it renders. What is NOT supported is a
  // storyline that gets no label until an operator remembers to run the CLI,
  // which is what this wiring ends.
  const labeler = {
    generator: config.GEMINI_API_KEY
      ? createGeminiClient({
          apiKey: config.GEMINI_API_KEY,
          model: config.GEMINI_MODEL,
          baseUrl: config.GEMINI_BASE_URL,
          thinkingLevel: config.GEMINI_THINKING_LEVEL,
          timeoutMs: config.GEMINI_TIMEOUT_MS,
        })
      : null,
    sampleSize: config.STORYLINE_LABEL_SAMPLE,
    driftFactor: config.STORYLINE_LABEL_DRIFT_FACTOR,
    logger: app.log,
  };

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
      storylinesV2: config.STORYLINES_V2,
      grouping: {
        enabled: config.GROUPING_ENABLED,
        threshold: config.GROUPING_SIMILARITY_THRESHOLD,
        timeZone: config.APP_TIMEZONE,
        storyline: {
          enabled: config.STORYLINE_ENABLED,
          anchorMaxShare: config.STORYLINE_ANCHOR_SHARE,
          massThreshold: config.STORYLINE_MASS_THRESHOLD,
        },
        linker: {
          enabled: config.STORYLINES_V2,
          rules: {
            anchorMaxShare: config.STORYLINE_ANCHOR_MAX_SHARE,
            anchorDfFloor: config.STORYLINE_ANCHOR_DF_FLOOR,
            massThreshold: config.STORYLINE_MASS_THRESHOLD_V2,
            dormancyDays: config.STORYLINE_DORMANCY_DAYS,
            dormantStrictness: config.STORYLINE_DORMANT_STRICTNESS,
          },
          mergeBridges: config.STORYLINE_MERGE_BRIDGES,
          storyDf: {
            windowDays: config.STORYLINE_DF_WINDOW_DAYS,
            timeZone: config.APP_TIMEZONE,
          },
          timeZone: config.APP_TIMEZONE,
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
      halfLifeHours: config.TERM_HALF_LIFE_HOURS,
      baselineWindowDays: config.BASELINE_WINDOW_DAYS,
    },
  };

  queue.startConsumer((job) =>
    job.kind === "sample" ? processSampleJob(trendingDeps, job) : processSegmentJob(deps, job),
  );
  await registerQueryRoutes(app, { deps, defaultLanguage: config.DEFAULT_LANGUAGE });
  registerTrendingRoute(app, { deps: trendingDeps });

  // Nightly chores (§9.1): the retention report (§7.5), and the storyline
  // lifecycle pass that keeps `status` honest (ADR-0011).
  const choreDeps: ChoreDeps = {
    db,
    config: {
      retentionDays: config.RETENTION_DAYS,
      baselineWindowDays: config.BASELINE_WINDOW_DAYS,
      storyDfWindowDays: config.STORYLINE_DF_WINDOW_DAYS,
      storylineDormancyDays: config.STORYLINE_DORMANCY_DAYS,
      timeZone: config.APP_TIMEZONE,
    },
    now: () => new Date(),
    log: app.log,
  };
  const chores = new ChoreQueue(config.REDIS_URL);
  chores.startConsumer({
    retention: () => runRetentionChore(choreDeps),
    // Dormancy first, then the labels: a storyline the sweep just marked quiet
    // is not a candidate the label pass should spend a call on.
    storylines: async () => {
      await runDormancyChore(choreDeps);
      await runStorylineLabelChore({ ...choreDeps, labeler });
    },
  });
  await chores.scheduleNightlyRetention();
  await chores.scheduleNightlyStorylines();

  app.log.info({ config: redactConfig(config) }, "configuration loaded");

  const close = async (): Promise<void> => {
    await app.close();
    // The queue first (it holds Redis connections and may be mid-job), then
    // the stores. db.destroy() ends the shared pool — nothing ends it twice.
    await queue.close().catch(() => {});
    await chores.close().catch(() => {});
    await Promise.allSettled([db.destroy(), redis.quit(), currents.close()]);
  };

  return { app, pool, redis, currents, close };
}

declare module "fastify" {
  interface FastifyInstance {
    currents: CurrentsClient;
  }
}
