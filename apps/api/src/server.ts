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
import { createGoogleNewsClient, PROVIDER as GOOGLE_NEWS_PROVIDER } from "@zammy/google-news-client";
import { createDb, databaseSsl } from "@zammy/storage";
import { registerHealthRoutes } from "./health.js";
import {
  registerQueryRoutes,
  registerTrendingRoute,
  type QueryRouteDeps,
} from "./routes.js";
import type { IngestHandler, IngestQueue } from "./ingest-queue.js";
import {
  createIngestQueue,
  createLabeler,
  createLabelMergeRules,
  createLinkerConfig,
  createSummarizer,
} from "./wiring.js";
import { createQuotaGovernors } from "./quota-redis.js";
import { watchRateLimitFailOpen } from "./rate-limit-fail-open.js";
import { processSegmentJob } from "./coverage-fill.js";
import {
  processSummarizeJob,
  type SummarizeJobDeps,
} from "./storyline-summary-job.js";
import { processDeepenJob } from "./storyline-deepening.js";
import { processSampleJob, type TrendingDeps } from "./trending-service.js";

/**
 * Subdivision floor (§6.3): a truncated segment this short is accepted as
 * truncated rather than split further, or a pathologically dense keyword
 * would recurse until it consumed the whole daily quota.
 */
const MIN_SEGMENT_MS = 60 * 60 * 1000;

/**
 * Key prefix for the per-IP rate-limit counters (§7.1's convention, §3.5's
 * move to Redis). Exported because the counter now OUTLIVES the process that
 * wrote it, which is the whole point in production and a nuisance in a test
 * suite: a run that deliberately exhausts the limit leaves the bucket full for
 * whatever runs next inside the window.
 */
export const RATE_LIMIT_NAMESPACE = "ratelimit:";

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
  /**
   * Whether THIS instance started the §9.1 consumer. Reported rather than
   * assumed, because it is the one thing about a built app that differs by
   * deployment shape, and "did anything start draining the queue?" is
   * otherwise unanswerable from the outside.
   */
  consumer: boolean;
  close: () => Promise<void>;
}

export interface BuildAppOptions {
  /**
   * Run the §9.1 ingest consumer inside this process, alongside the HTTP
   * surface. True by default, because that is what a persistent process wants:
   * Compose and the container image run one process that both serves and
   * drains, and ARCHITECTURE §4.1 leans on that (the drain path is exercised
   * on every `docker compose down`).
   *
   * A serverless request instance must pass `false`. It still constructs the
   * `IngestQueue` — the read path enqueues (coverage-fill, trending-service)
   * and the trending locks are scoped by the queue's `name` — but a worker in a
   * function that suspends between requests would poll from a frozen instance
   * and hold jobs it may never be woken to finish (VERCEL-ALL-IN-SCOPE §3.1).
   * There the consumer is its own deployable, a push-mode Vercel Queues
   * function behind the same interface (`vercel-queue.ts`).
   */
  consumer?: boolean;
}

/**
 * The narrowest logger the wiring below needs. Fastify's own satisfies it, and
 * so does the JSON-lines logger a function entrypoint or a CLI builds by hand —
 * which is the point: `buildServices` must be reachable from a process that has
 * no Fastify instance to borrow one from.
 */
export interface ServiceLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

/**
 * Everything behind the HTTP surface: the stores, the upstream client, the
 * queue, and the two dependency bundles the services take.
 *
 * This is the §2 "Split" — one function became two. There are now two processes
 * that need all of this and only one of them serves HTTP: the request function
 * builds it and registers routes over it, while the push-mode queue consumer
 * builds it and drains. They must build it IDENTICALLY, for the reason
 * `wiring.ts` exists — the linker rules, the labeller's pacing and the queue's
 * name are all decisions, and a consumer that assembled its own approximation
 * would make storyline decisions at a bar the read path never used.
 */
export interface Services {
  pool: Pool;
  redis: Redis;
  currents: CurrentsClient;
  queue: IngestQueue;
  /**
   * The one object the four planner modules are all driven from. `QueryRouteDeps`
   * because the HTTP surface reaches the widest set of them; the queue consumer
   * hands the same object to a subset (`ingestDispatch`).
   */
  deps: QueryRouteDeps;
  trendingDeps: TrendingDeps;
  /**
   * The click plane (ADR-0027). Its own field rather than a slice of `deps`,
   * because it is the one plane that makes no upstream call and holds no
   * `CurrentsClient` — it needs a summariser, a gate and two bounds, and
   * nothing `QueryRouteDeps` carries.
   */
  summarizeDeps: SummarizeJobDeps;
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

export async function buildServices(config: Config, log: ServiceLogger): Promise<Services> {
  // One pool for the request path, shared with Kysely and with /readyz.
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
  redis.on("error", (error: unknown) => log.warn({ err: error }, "redis error"));
  void redis.connect().catch((error: unknown) => {
    log.warn({ err: error }, "redis unavailable at boot; serving degraded");
  });

  // Everything below this line can throw — `createNewsClient` reads the fixture
  // corpus off disk and refuses an empty one — and until now a throw cost
  // nothing, because the only caller was `index.ts` and it exits the process.
  // The function entrypoints instead retry the boot on the NEXT invocation, so
  // anything this attempt left open leaks once per invocation for the life of
  // an instance that lives for hours. Not hypothetical: the failure in question
  // is `fixtures/` landing somewhere the function cannot read it, which is the
  // one thing about Phase 1 that only a deploy could settle.
  const abandon: Array<() => unknown> = [
    // Forceful, not `quit()`: a boot that failed is not draining anything, and
    // `quit()` on a client that never finished connecting can reject or hang.
    () => redis.disconnect(),
    () => pool.end(),
  ];
  try {
    // One interface for both modes AND for however many providers are configured:
    // nothing below this line knows or cares whether articles come from the live
    // API or from recorded payloads, nor which upstream answered
    // (ARCHITECTURE 4.1 — a code path that branches on environment is a code path
    // local development stops predicting; ARCHITECTURE 5.6 for the provider seam).
    // The quota governors are built from the SAME Redis client the page cache
    // and the locks use, and handed in here rather than defaulted inside the
    // adapters: the burst ceiling is a per-KEY limit, so it has to be counted
    // once across every instance that holds the key, not once per instance
    // (VERCEL-ALL-IN-SCOPE §3.4). Each falls open to the in-process counting
    // that was here before, so Redis being down costs exactly today's
    // behaviour.
    const currents = await createNewsClient(config, {
      logger: log,
      quota: createQuotaGovernors(config, redis, log),
    });
    abandon.push(() => currents.close());
    if (config.CURRENTS_MODE === "fixture") {
      log.info(
        { dir: config.FIXTURES_DIR },
        "CURRENTS_MODE=fixture — serving recorded payloads, no upstream calls, no quota spend",
      );
    }
    if (config.GNEWS_ENABLED) {
      log.info(
        { mode: config.GNEWS_MODE, dailyLimit: config.GNEWS_DAILY_CALL_LIMIT },
        "GNEWS_ENABLED — fanning out to a second provider as best-effort breadth; " +
          "it records its own coverage, and the planner still plans against Currents'",
      );
    }

    // The DEEPENING plane's provider (ADR-0019, plan §G5), or nothing.
    //
    // Built here rather than inside `createNewsClient` and deliberately NOT
    // handed to the composite: the composite exists to fan ONE plan out to
    // several providers, and ADR-0019 ends the shared plan. This provider is
    // planned against `storyline_coverage` and its own limits — no offset
    // parameter at all, 100 items per query — which is not a plan Currents
    // could be given a share of.
    //
    // `undefined` is the shipped state. `createGoogleNewsClient` refuses to
    // build with the flag off (G4 put the refusal in the factory rather than
    // only at the call site, so that "off" means unreachable), so the flag is
    // checked here and the whole deepening path is absent rather than present
    // and throwing.
    const deepening = config.GOOGLE_NEWS_ENABLED
      ? await createGoogleNewsClient(
          {
            ...config,
            // One User-Agent for the whole service unless someone deliberately
            // splits them — `createNewsClient` makes the same fallback for
            // GNews, and for the same reason: the Currents one is required and
            // non-empty, so this cannot fall back to a default library UA.
            GOOGLE_NEWS_USER_AGENT:
              config.GOOGLE_NEWS_USER_AGENT?.trim() || config.CURRENTS_USER_AGENT,
          },
          {
            logger: log,
            quota: createQuotaGovernors(config, redis, log)[GOOGLE_NEWS_PROVIDER],
          },
        )
      : undefined;
    if (deepening) {
      abandon.push(() => deepening.close());
      log.info(
        {
          mode: config.GOOGLE_NEWS_MODE,
          dailyLimit: config.GOOGLE_NEWS_DAILY_CALL_LIMIT,
        },
        "GOOGLE_NEWS_ENABLED — a storyline open now also deepens the arc from " +
          "Google News; its articles join that arc by provenance and feed no ranking",
      );
    }

    const db = createDb(pool);
    // WHICH transport this is depends on `INGEST_QUEUE_DRIVER` and nothing else
    // here knows: the read path publishes and polls the pending set through the
    // same seven members either way.
    const queue = createIngestQueue(config, { log });
    abandon.push(() => queue.close());

    // The labeler, built once for this process (ADR-0011's Labels). What is NOT
    // supported is a storyline that gets no label until an operator remembers to
    // run the CLI, which is what this wiring ends.
    //
    // Once shared with the nightly chores; they now run in their own process and
    // build their own client from the same factory, so one pacer no longer covers
    // both. See `wiring.ts` for what that costs on a shared key.
    const labeler = createLabeler(config, log);

    // `satisfies` rather than an annotation, and the difference is load-bearing
    // downstream. Each planner module declares the narrow slice of the client
    // and the queue it may touch, so `QueryRouteDeps` is narrow too — annotating
    // would erase the fact that what this process actually holds is a whole
    // `CurrentsClient` and a whole `IngestQueue`, and `trendingDeps` below
    // (which needs `latestNews` and `enqueueSample`) is built by spreading this.
    // Checked against the contract, carried at its real width.
    const deps = {
      db,
      redis,
      currents,
      ...(deepening ? { deepening } : {}),
      queue,
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
            rules: createLabelMergeRules(config),
            threshold: config.STORYLINE_LABEL_MERGE_TRIGGER,
          },
          // The membership-change re-offer (`storyline-rejoin-trigger.ts`), on the
          // same tail. Off by default — the knob's own note says why, and it is
          // about the candidate cap rather than about the trigger.
          reofferJoinedGroups: config.STORYLINE_REOFFER_JOINED_GROUPS,
        },
      },
      now: () => new Date(),
      log,
    } satisfies QueryRouteDeps;
    // The summariser the click plane spends, built from the same factory the
    // nightly pass uses — so a sentence written behind a click is written under
    // the same prompt, contract, model and sample as one written at 05:00. It
    // gets its own pacer because `createSummarizer` is handed none here: the API
    // instance has no label pass to share a window with, and the ceiling the
    // client builds for itself is `GEMINI_MAX_RPM`.
    const summarizeDeps: SummarizeJobDeps = {
      db,
      redis,
      summarizer: createSummarizer(config, log),
      enabled: config.SUMMARIES_ENABLED,
      gate: {
        minArticlesExclusive: config.SUMMARY_MIN_ARTICLES_PER_DAY,
        minGroups: config.SUMMARY_MIN_GROUPS,
      },
      maxDays: config.SUMMARY_CLICK_MAX_DAYS,
      budgetMs: config.SUMMARY_CLICK_BUDGET_MS,
      // The summary pass's rate, not the key's ceiling: this shares a key with
      // the labeler and with the nightly pass, and `SUMMARY_MAX_RPM` is the
      // number that was sized against both (see its comment).
      ratePerMinute: config.SUMMARY_MAX_RPM,
      now: () => new Date(),
      log,
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

    const close = async (): Promise<void> => {
      // The queue first (it holds Redis connections and may be mid-job), then
      // the stores.
      await queue.close().catch(() => {});
      await Promise.allSettled([db.destroy(), redis.quit(), currents.close()]);
      // db.destroy() ends the shared pool ONLY if Kysely ever initialized its
      // driver, which it does lazily on the first query — so an instance that
      // served nothing but `/healthz` and `/readyz` used to finish shutdown with
      // its pool and that pool's idle connections still open. Measured: one
      // backend surviving `close()`, last query `SELECT 1`, which is /readyz's.
      // Ending it here makes shutdown mean the same thing on every path. The
      // guard rather than a bare call because pg REJECTS a second `end()`, and
      // the common case is that Kysely already did it — and it reads `ending`
      // rather than `ended` because that is the flag pg's own guard tests:
      // `ended` only flips once the drain finishes, so a pool still draining
      // would pass an `ended` check and take the rejection.
      if (!pool.ending) await pool.end();
    };

    return { pool, redis, currents, queue, deps, trendingDeps, summarizeDeps, close };
  } catch (error) {
    await Promise.allSettled(abandon.reverse().map((release) => release()));
    throw error;
  }
}

/**
 * How a delivered job becomes work, and the only place that mapping exists.
 *
 * Both consumers route through it — the in-process BullMQ worker and the
 * push-mode Vercel function — because the discriminant is the job payload, not
 * the transport, and two copies of this `if` is one place for a sample to start
 * being processed as a segment on exactly one of them.
 */
export function ingestDispatch(services: Services): IngestHandler {
  return (job) => {
    if (job.kind === "sample") return processSampleJob(services.trendingDeps, job);
    if (job.kind === "deepen") return processDeepenJob(services.deps, job);
    if (job.kind === "summarize") return processSummarizeJob(services.summarizeDeps, job);
    return processSegmentJob(services.deps, job);
  };
}

export async function buildApp(
  config: Config,
  options: BuildAppOptions = {},
): Promise<App> {
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

  const services = await buildServices(config, app.log);
  try {
    await app.register(cors, { origin: config.CORS_ORIGIN.split(",").map((o) => o.trim()) });

    // Per-IP limit on /api/v1/* only (§9.4, §12): novel-fingerprint spam can
    // mint topics and spend quota, but the health check must never 429.
    //
    // **The counters are Redis-held, and they used to be in-process on purpose.**
    // The note that stood here said a shared counter "would add a shared failure
    // mode to the request path for precision nobody needs", and on a fixed
    // replica count that was right: the effective ceiling was
    // RATE_LIMIT_PER_MINUTE × a number we chose. Elastic instances make that
    // number unbounded, and Hobby has no WAF to put the limit anywhere else
    // (Pro-only), so the choice collapsed to a Redis store or a decorative guard
    // (VERCEL-ALL-IN-SCOPE §3.5). Decorative is the worse option, because what
    // this limit protects is the thing that actually runs out — the Currents
    // daily quota — and one spammer's novel fingerprints would drain a day of it.
    //
    // The coupling the old note warned about is answered rather than denied:
    // `skipOnError` makes a Redis fault read as "not limited", the same
    // fail-open posture §3.4's governor and the page cache take. Redis down
    // costs us the ceiling, never the request.
    //
    // **That opening is wider than "the first caller through a cold instance",
    // and it was measured, not reasoned about.** 24 concurrent requests against
    // the preview fanned out across six instances and SEVEN of them came back
    // `x-ratelimit-remaining: 60` — a number `INCR` cannot produce, so those
    // seven took the fail-open path. The function log names the cause:
    // `connect ETIMEDOUT` on a cold instance's Upstash handshake. A burst big
    // enough to force scale-out therefore buys the caller a slice of unlimited
    // requests, which is precisely the shape of traffic this guard is for. It
    // is still strictly better than the in-process counter it replaced (which
    // gave every one of those instances a whole fresh allowance, not one
    // request), and the alternative — failing closed — would 429 real users
    // over a cache blip. Worth revisiting if the guard ever has to be tight.
    await app.register(rateLimit, {
      max: config.RATE_LIMIT_PER_MINUTE,
      timeWindow: 60_000,
      allowList: (request) => !request.url.startsWith("/api/"),
      redis: services.redis,
      // §7.1's key convention. The plugin appends `normalizeIP(request.ip)` —
      // the address itself for IPv4, the /64 PREFIX for IPv6 — so the whole
      // deployment shares one bucket per caller, and a v6 client cannot mint a
      // fresh bucket by walking its own subnet. Nothing else joins the key here,
      // because no route sets its own `config.rateLimit` or a `groupId`; either
      // would add the route's method and URL and split the bucket per endpoint.
      nameSpace: RATE_LIMIT_NAMESPACE,
      skipOnError: true,
    });

    // ...and now it says so when it does. `skipOnError` above is unchanged and
    // stays that way — failing closed would 429 real users over a cache blip —
    // but the opening the comment describes was, until here, recorded nowhere:
    // the plugin's catch is `if (!params.skipOnError) throw err` and nothing
    // else, so the only live tell was `x-ratelimit-remaining` on a response
    // nobody reads. MEASUREMENT-RATE-LIMIT-FAIL-OPEN §3.2 is what that cost —
    // an episode whose explanation needed archived log rows replayed through
    // the plugin's own Lua — and §4's third lever is this line.
    // The client is handed in for one field. `redisStatus` tells a harmless cold
    // start — which reaches `ready` before the response finishes — from an
    // instance still unusable when we looked, which is §3.2's and is costing us
    // the ceiling. It does NOT resolve `connecting`: a timing-out handshake sits
    // there too, and is just as blind. `rate-limit-fail-open.ts` has the
    // measurements and says how to read each value.
    watchRateLimitFailOpen(app, { redis: services.redis });

    app.decorate("currents", services.currents);
    registerHealthRoutes(app, {
      pool: services.pool,
      redis: services.redis,
      currents: services.currents,
      // The request path's own handle, so the `chore_runs` digest reads through
      // the pool `/readyz` already probes rather than opening a second one.
      db: services.deps.db,
    });

    // The query service (§6) and its job consumer (§9.1). WHERE the consumer runs
    // is a deployment property, not a code one: a persistent process shares it
    // with the HTTP surface (a container keeps CPU allocated for the life of the
    // task, so no separate deployable is needed, §4.1), while a request-scoped
    // function must not start one at all. Either way the queue itself is built
    // above, because the read path publishes to it.
    const consumer = options.consumer ?? true;
    if (consumer) {
      services.queue.startConsumer(ingestDispatch(services));
    } else {
      // Worth a line in the log, because the symptom of getting this wrong is
      // silent: reads still succeed, they just sit at `meta.ingest.pendingJobs > 0`
      // forever while the pending set grows and nothing drains it.
      app.log.info(
        "consumer disabled for this instance — serving requests only; enqueued ingest waits for whatever drains the queue",
      );
    }
    await registerQueryRoutes(app, {
      deps: services.deps,
      defaultLanguage: config.DEFAULT_LANGUAGE,
      summariesEnabled: config.SUMMARIES_ENABLED,
    });
    registerTrendingRoute(app, { deps: services.trendingDeps });

    // The nightly chores (§9.1) do NOT run here. They are one-shot invocations of
    // `chores-cli.ts` on the platform's scheduler — retention at 03:00 UTC, the
    // storyline pass at 04:00 UTC. This process therefore does not have to be
    // awake for them, and equally cannot make them happen: if nothing schedules
    // the runner, the retention report and the storyline lifecycle passes simply
    // never run, and no log line here will say so. See `chores.ts`.

    app.log.info({ config: redactConfig(config) }, "configuration loaded");

    const close = async (): Promise<void> => {
      await app.close();
      await services.close();
    };

    return {
      app,
      pool: services.pool,
      redis: services.redis,
      currents: services.currents,
      consumer,
      close,
    };
  } catch (error) {
    await services.close().catch(() => {});
    throw error;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    currents: CurrentsClient;
  }
}
