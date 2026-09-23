import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "@zammy/config";
import { TimelinePage } from "@zammy/shared";
import {
  TRACE_ID_HEADER,
  TRACE_REQUEST_HEADER,
  TRACE_UNSTORED,
  TraceReadResponse,
  traceAuthorization,
  traceReadPath,
  traceSignature,
  type TraceEnvironment,
} from "@zammy/shared/request-trace";
import { canonicalize } from "./canonical.js";
import type { IngestJob, SegmentJob, SummarizeJob } from "./ingest-queue.js";
import { pageCacheKey } from "./page-cache.js";
import { TRACE_UNSTORED_MESSAGE } from "./observations.js";
import { registerQueryRoutes, registerTrendingRoute } from "./routes.js";
import { buildApp, dispatchOver } from "./server.js";
import type { SummarizeJobDeps } from "./storyline-summary-job.js";
import { captureLog, createTestHarness, type TestHarness } from "./test-support.js";
import { traceRuns } from "./trace-dispatch.js";
import {
  MAX_OPEN_TRACES,
  TRACE_OPENS_PER_MINUTE,
  TRACE_READS_PER_MINUTE,
  TRACE_READ_ROUTE,
  registerRequestTracing,
  scopedDeps,
  type RequestTracingOptions,
} from "./trace-http.js";
import { createTouchRecorder, type TouchRecorder } from "./trace-recorder.js";
import { createTraceRuntime, traceKey, type TraceRuntime } from "./trace-store.js";
import type { TrendingDeps } from "./trending-service.js";

/**
 * Request tracing over a real Fastify app, real limiter, real Postgres and
 * Redis and the fixture upstream (ADR-0029, "The change" 2, 5 and 7).
 *
 * The first thing these hold is that tracing is INVISIBLE to anyone who did not
 * ask for it: with it registered, an untraced request gets the same headers,
 * the same body and the same Redis commands in the same order as with it
 * absent, and a traced one differs only by two response headers. The second is
 * the redaction rule end to end — a real search for "quokka zebra", its stored
 * trace and its job run, and not one byte of the query, the fingerprint, a key,
 * an address, a URL, the token or a job id in any of it. Then the bounds (a
 * wrong token, the per-minute budget, the concurrent cap, the read route's own
 * bucket) and the failure modes (a store that is down, a recorder that throws),
 * each of which must leave the reader's response exactly as it would have been.
 */

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
const FIXTURES_DIR = new URL("../../../fixtures/", import.meta.url).pathname;
const TOKEN = "k".repeat(40);
const AUTH = { [TRACE_REQUEST_HEADER]: traceAuthorization(TOKEN) };
/** The fixture era: the recorded climate corpus is dated 2026-08-02/03. */
const NOW = new Date("2026-08-06T12:00:00.000Z");
/** A window no other suite asks for, so no other suite's cached page can answer it. */
const SEED_FROM = "2026-08-01T12:00:00Z";
const SEED_TO = "2026-08-04T00:00:00Z";
const SEED_QS = `from=${SEED_FROM}&to=${SEED_TO}`;
/** One day that closed long before `NOW`: a complete, cacheable page. */
const HISTORICAL_QS = "from=2026-08-02T00:00:00Z&to=2026-08-03T00:00:00Z";

const ENVIRONMENT: TraceEnvironment = {
  queue: "bullmq",
  currents: "fixture",
  gnews: false,
  googleNews: "off",
  summaries: false,
  labeler: false,
};

function traceConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    DATABASE_URL: "postgres://zammy:zammy@localhost:5432/zammy",
    REDIS_URL,
    CURRENTS_MODE: "fixture",
    CURRENTS_USER_AGENT: "zammy-tests/0.1",
    FIXTURES_DIR,
    REQUEST_TRACE_ENABLED: "true",
    REQUEST_TRACE_TOKEN: TOKEN,
    ...overrides,
  } as NodeJS.ProcessEnv);
}

/** A keyword nobody else searches: letters only, so it canonicalizes to one term. */
function uniqueWord(): string {
  const letters = randomUUID()
    .replaceAll("-", "")
    .replace(/[0-9]/g, (digit) => "ghijklmnop"[Number(digit)]!);
  return `zq${letters}`.slice(0, 16);
}

let harness: TestHarness;
let runtime: TraceRuntime;
const apps: FastifyInstance[] = [];
const namespaces: string[] = [];
/** Segment jobs the routes published, so a test can run one through `traceRuns`. */
let enqueued: IngestJob[] = [];

beforeAll(async () => {
  harness = await createTestHarness({ maxSyncUpstreamCalls: 1 }, NOW);
  runtime = makeRuntime();
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  await purge(`${harness.queue.name}:trace:*`);
  for (const ns of namespaces.splice(0)) await purge(`${ns}*`);
  enqueued = [];
});

afterAll(async () => {
  await harness.teardown();
});

function makeRuntime(redis: Redis = harness.redis, log = captureLog().log): TraceRuntime {
  return createTraceRuntime(traceConfig(), {
    redis,
    queueName: harness.queue.name,
    environment: ENVIRONMENT,
    log,
  });
}

/** SCAN, then delete by explicit name. */
async function purge(pattern: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await harness.redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = next;
    if (keys.length > 0) await harness.redis.del(...keys);
  } while (cursor !== "0");
}

async function traceKeys(): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await harness.redis.scan(
      cursor,
      "MATCH",
      `${harness.queue.name}:trace:*`,
      "COUNT",
      200,
    );
    cursor = next;
    found.push(...keys);
  } while (cursor !== "0");
  return found;
}

interface AppOptions {
  tracing?: boolean;
  runtime?: TraceRuntime;
  max?: number;
  settledTrending?: boolean;
  tracingOptions?: RequestTracingOptions;
  redis?: unknown;
  /** A `preHandler` hook, after tracing's own `onRequest`: sees what a handler would. */
  preHandler?: (request: import("fastify").FastifyRequest) => void;
}

/**
 * The app these run against: the real limiter (a Redis namespace of its own per
 * app, so no test spends another's bucket), tracing, and the real query and
 * trending routes over the fixture harness.
 */
async function tracedApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  apps.push(app);
  const nameSpace = `ratelimit-trace-test-${randomUUID()}:`;
  namespaces.push(nameSpace);
  await app.register(rateLimit, {
    max: options.max ?? 10_000,
    timeWindow: 60_000,
    redis: harness.redis,
    nameSpace,
    skipOnError: true,
    allowList: (request) => !request.url.startsWith("/api/"),
  });
  if (options.tracing !== false) {
    registerRequestTracing(app, options.runtime ?? runtime, options.tracingOptions);
  }
  if (options.preHandler) {
    const observe = options.preHandler;
    app.addHook("preHandler", (request, _reply, done) => {
      observe(request);
      done();
    });
  }
  const queue = {
    ...harness.deps.queue,
    // Bound, because they come off a class instance (routes.test.ts does the same).
    enqueueSegment: async (job: SegmentJob) => {
      enqueued.push(job);
      await harness.deps.queue.enqueueSegment(job);
    },
    enqueueDeepen: harness.deps.queue.enqueueDeepen.bind(harness.deps.queue),
    enqueueSample: harness.deps.queue.enqueueSample.bind(harness.deps.queue),
    pendingCount: harness.deps.queue.pendingCount.bind(harness.deps.queue),
    enqueueSummarize: async (_job: SummarizeJob) => {},
  };
  const deps = {
    ...harness.deps,
    queue,
    ...(options.redis ? { redis: options.redis as Redis } : {}),
  };
  await registerQueryRoutes(app, { deps, defaultLanguage: "en" });
  const trendingDeps: TrendingDeps = {
    ...deps,
    trending: {
      sampleCategories: ["science_technology"],
      samplePages: 1,
      sampleRefreshMinutes: 60,
      windowHours: 24,
      halfLifeHours: 8,
    },
    ...(options.settledTrending
      ? {
          queue: {
            name: harness.queue.name,
            enqueueSample: async () => {},
            pendingCount: async () => 0,
          },
        }
      : {}),
  };
  registerTrendingRoute(app, { deps: trendingDeps });
  await app.ready();
  return app;
}

async function readStored(id: string, rt: TraceRuntime = runtime) {
  const read = await rt.readTrace(id);
  expect(read, `trace ${id} should be stored`).not.toBeNull();
  return read!;
}

/**
 * Seed storylines with an untraced search, and return one of their ids.
 *
 * The seed's own cached pages are forgotten first — this query over this window
 * only. A complete page outlives the run that wrote it (24 h on the historical
 * tier), and one left by a previous run names storylines from a database that
 * has since been dropped.
 */
async function seedStoryline(app: FastifyInstance): Promise<string> {
  const canonical = canonicalize(
    { q: "climate", from: new Date(SEED_FROM), to: new Date(SEED_TO) },
    {
      reference: { languages: new Set(["en"]), regions: new Set() },
      defaultLanguage: "en",
      lookbackDays: 30,
      now: NOW,
    },
  );
  if (!canonical.ok) throw new Error("canonicalize refused the seed query");
  const prefix = pageCacheKey(canonical.query.fingerprint, canonical.query.window, null, 0).replace(
    /first:0$/,
    "",
  );
  await purge(`${prefix}*`);
  const read = await app.inject({ method: "GET", url: `/api/v1/timeline?q=climate&${SEED_QS}` });
  const page = TimelinePage.parse(read.json());
  const first = page.items[0] as { storylineId: string } | undefined;
  expect(first, "the seed search should surface a storyline").toBeDefined();
  return first!.storylineId;
}

describe("buildApp with tracing off", () => {
  it("registers no hook, no decorator and no read route", async () => {
    const base = traceConfig();
    const off = await buildApp({ ...base, REQUEST_TRACE_ENABLED: false }, { consumer: false });
    try {
      expect(off.app.hasRequestDecorator("requestTrace")).toBe(false);
      expect(off.app.hasRoute({ method: "GET", url: TRACE_READ_ROUTE })).toBe(false);
    } finally {
      await off.close();
    }
    const on = await buildApp(base, { consumer: false });
    try {
      expect(on.app.hasRequestDecorator("requestTrace")).toBe(true);
      expect(on.app.hasRoute({ method: "GET", url: TRACE_READ_ROUTE })).toBe(true);
      // GET only: an auto-cloned HEAD would be a second bucket over the same reads.
      expect(on.app.hasRoute({ method: "HEAD", url: TRACE_READ_ROUTE })).toBe(false);
    } finally {
      await on.close();
    }
  }, 20_000);
});

describe("an untraced request, with tracing on", () => {
  it("gets no trace header and no stored trace, and its deps are the boot deps", async () => {
    const boot = { db: harness.deps.db, redis: harness.redis };
    const identical: boolean[] = [];
    const app = await tracedApp({
      preHandler: (request) => identical.push(scopedDeps(request, boot) === boot),
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/reference" });
    expect(response.statusCode).toBe(200);
    expect(response.headers[TRACE_ID_HEADER]).toBeUndefined();
    expect(response.headers["cache-control"]).toBeUndefined();
    expect(await traceKeys()).toEqual([]);

    // The boot bag BY IDENTITY untraced; a copy once the request is traced.
    await app.inject({ method: "GET", url: "/api/v1/reference", headers: AUTH });
    expect(identical).toEqual([true, false]);
  });

  it("keeps trending's shared-cache header", async () => {
    const app = await tracedApp({ settledTrending: true });
    const response = await app.inject({ method: "GET", url: "/api/v1/trending" });
    expect(response.headers["cache-control"]).toBe(
      "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
    );
    expect(response.headers[TRACE_ID_HEADER]).toBeUndefined();
  });

  it("issues the same Redis commands in the same order as with tracing absent", async () => {
    const off = await tracedApp({ tracing: false });
    const on = await tracedApp();
    const url = `/api/v1/timeline?q=${uniqueWord()}&${HISTORICAL_QS}`;
    // Warm both: the limiter's script, the reference cache, the page cache.
    for (const app of [off, on]) {
      await app.inject({ method: "GET", url });
      await app.inject({ method: "GET", url });
    }

    // The command stream, captured in the TEST only: a spy on the harness
    // client's own funnel, which the limiter and the routes both write through.
    const capture = async (app: FastifyInstance) => {
      const commands: Array<{ name: string; args: unknown[] }> = [];
      const original = harness.redis.sendCommand;
      const spy = vi
        .spyOn(harness.redis, "sendCommand")
        .mockImplementation(function (this: Redis, command, stream) {
          commands.push({ name: command.name, args: [...command.args] });
          return original.call(this, command, stream);
        });
      try {
        const response = await app.inject({ method: "GET", url });
        return { commands, body: response.body, status: response.statusCode };
      } finally {
        spy.mockRestore();
      }
    };

    const a = await capture(off);
    const b = await capture(on);
    expect(b.commands.map((c) => c.name)).toEqual(a.commands.map((c) => c.name));
    expect(a.commands.map((c) => c.name)).toEqual(["evalsha", "mget", "get"]);
    expect(JSON.stringify(b.commands)).not.toContain(":trace:");
    expect(b.body).toBe(a.body);
    expect(await traceKeys()).toEqual([]);
  });
});

describe("a traced request", () => {
  it("answers a storyline view with a body byte-identical to the untraced one", async () => {
    const app = await tracedApp();
    const storylineId = await seedStoryline(app);
    const url = `/api/v1/timeline?storyline=${storylineId}`;

    const plain = await app.inject({ method: "GET", url });
    const traced = await app.inject({ method: "GET", url, headers: AUTH });

    expect(traced.statusCode).toBe(plain.statusCode);
    expect(traced.body).toBe(plain.body);
    expect(traced.headers["content-type"]).toBe(plain.headers["content-type"]);
    const id = traced.headers[TRACE_ID_HEADER] as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const { trace } = await readStored(id);
    expect(trace).toMatchObject({
      route: "timeline_view",
      queryKeys: ["storyline"],
      viewStorylines: 1,
    });
    // A view is a pure Postgres read.
    expect(trace.touches.some((t) => t.station === "postgres")).toBe(true);
    expect(trace.touches.some((t) => t.station === "redis")).toBe(false);
  });

  it("stores the schema's parse output, so a field the recorder wrongly kept is dropped", async () => {
    // A recorder with a bug: every touch it seals carries a raw key. The draft
    // holds it; the parse output does not; and the parse output is what Redis
    // gets — the backstop that makes a classifier bug a mislabel, not a leak.
    const leaky = (maxTouches: number): TouchRecorder => {
      const real = createTouchRecorder({ maxTouches });
      return new Proxy(real, {
        get(target, property) {
          if (property === "seal") {
            return () => {
              const sealed = target.seal();
              return {
                ...sealed,
                touches: sealed.touches.map((t) => ({
                  ...t,
                  rawKey: "page:v10:leaked-fingerprint",
                })),
              };
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? (value as () => unknown).bind(target) : value;
        },
      });
    };
    const app = await tracedApp({ tracingOptions: { createRecorder: leaky } });

    const response = await app.inject({ method: "GET", url: "/api/v1/reference", headers: AUTH });
    const id = response.headers[TRACE_ID_HEADER] as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const raw = await harness.redis.get(traceKey(harness.queue.name, id));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).touches.length).toBeGreaterThan(0);
    expect(raw).not.toContain("leaked-fingerprint");
  });

  it("is served untraced, silently, with the wrong token", async () => {
    const app = await tracedApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reference",
      headers: { [TRACE_REQUEST_HEADER]: traceAuthorization("w".repeat(40)) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers[TRACE_ID_HEADER]).toBeUndefined();
    expect(await traceKeys()).toEqual([]);
  });

  it("overrides trending's shared-cache header with no-store", async () => {
    const app = await tracedApp({ settledTrending: true });
    const response = await app.inject({ method: "GET", url: "/api/v1/trending", headers: AUTH });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers[TRACE_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("opens thirty traces a minute and serves the thirty-first untraced", async () => {
    const app = await tracedApp({ tracingOptions: { clock: () => NOW.getTime() } });
    const ids: Array<string | undefined> = [];
    for (let i = 0; i < TRACE_OPENS_PER_MINUTE + 1; i += 1) {
      const response = await app.inject({ method: "GET", url: "/api/v1/reference", headers: AUTH });
      expect(response.statusCode).toBe(200);
      ids.push(response.headers[TRACE_ID_HEADER] as string | undefined);
    }
    expect(ids.slice(0, TRACE_OPENS_PER_MINUTE).every((id) => typeof id === "string")).toBe(true);
    expect(ids[TRACE_OPENS_PER_MINUTE]).toBeUndefined();
  });

  it("holds eight traces open at once and serves the ninth untraced", async () => {
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A reference cache that answers only when the test says so, holding the
    // handlers — and their open scopes — in flight.
    const gated = {
      mget: async () => {
        arrivals += 1;
        await gate;
        return [JSON.stringify({ English: "en" }), JSON.stringify({ "United States": "US" })];
      },
    };
    const app = await tracedApp({ redis: gated });
    const inject = () => app.inject({ method: "GET", url: "/api/v1/reference", headers: AUTH });

    const first = Array.from({ length: MAX_OPEN_TRACES }, inject);
    await vi.waitFor(() => expect(arrivals).toBe(MAX_OPEN_TRACES));
    const ninth = inject();
    await vi.waitFor(() => expect(arrivals).toBe(MAX_OPEN_TRACES + 1));
    release();

    const responses = await Promise.all([...first, ninth]);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(responses.slice(0, MAX_OPEN_TRACES).every((r) => r.headers[TRACE_ID_HEADER])).toBe(true);
    expect(responses[MAX_OPEN_TRACES]!.headers[TRACE_ID_HEADER]).toBeUndefined();
    // And the slots come back: the next one is traced again.
    expect((await inject()).headers[TRACE_ID_HEADER]).toBeDefined();
  });

  it("records a cold search as the fixture fill decides it", async () => {
    const app = await tracedApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/timeline?q=${uniqueWord()}`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);

    const { trace } = await readStored(response.headers[TRACE_ID_HEADER] as string);
    expect(trace.route).toBe("timeline_search");
    expect(trace.queryKeys).toEqual(["q"]);
    expect(trace.meta).toMatchObject({ servedFrom: "upstream", ingest: { state: "in_progress" } });
    // `cold-search.json`'s signature, as `trace-examples.test.ts` pins it; the
    // enqueues collapse into one token.
    expect(traceSignature(trace.touches)).toEqual([
      "rate_limit:counted",
      "redis:reference",
      "redis:page_cache",
      "redis:fill_lock",
      "redis:topic_budget",
      "currents:search",
      "redis:fill_lock",
      "queue:segment",
      "redis:pending_ledger",
    ]);
    const queued = trace.touches.filter((t) => t.station === "queue");
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((t) => t.station === "queue" && t.linked)).toBe(true);
  });

  it("stores nothing a reader asked, in the trace or in its job run", async () => {
    const app = await tracedApp();
    const canonical = canonicalize(
      { q: "quokka zebra" },
      {
        reference: { languages: new Set(["en"]), regions: new Set() },
        defaultLanguage: "en",
        lookbackDays: 30,
        now: NOW,
      },
    );
    if (!canonical.ok) throw new Error("canonicalize refused the test query");
    const fingerprint = canonical.query.fingerprint;
    // This topic's own keys only — never `ref:*`, which other suites share.
    for (const pattern of [`page:v*:${fingerprint}:*`, `lock:refresh:${fingerprint}:*`]) {
      await purge(pattern);
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/timeline?q=quokka%20zebra",
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const id = response.headers[TRACE_ID_HEADER] as string;
    expect(id).not.toBe(TRACE_UNSTORED);

    // Run one of the jobs it enqueued, the way a consumer would, so the run is
    // held to the same rule as the request.
    const job = enqueued[0];
    expect(job, "the cold search should defer a segment").toBeDefined();
    const bundles = {
      deps: { ...harness.deps, config: harness.deps.config },
      trendingDeps: harness.deps as unknown as TrendingDeps,
      summarizeDeps: {} as SummarizeJobDeps,
    };
    await traceRuns(bundles as never, runtime, dispatchOver, "bullmq")(job!);

    const stored = await readStored(id);
    expect(stored.runs).toHaveLength(1);
    const serialized = JSON.stringify(stored);
    for (const forbidden of [
      "quokka",
      "zebra",
      fingerprint,
      "page:v",
      "lock:refresh",
      "budget:topic",
      "ratelimit",
      "ingest:pending",
      "127.0.0.1",
      "://",
      "?q=",
      TOKEN,
      "seg_",
      "topup_",
    ]) {
      expect(serialized, `stored trace mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("never writes its id into the page it caches", async () => {
    const app = await tracedApp();
    const word = uniqueWord();
    const url = `/api/v1/timeline?q=${word}&${HISTORICAL_QS}`;
    const traced = await app.inject({ method: "GET", url, headers: AUTH });
    const id = traced.headers[TRACE_ID_HEADER] as string;
    expect(TimelinePage.parse(traced.json()).meta.ingest.state).toBe("complete");

    const { fingerprint } = TimelinePage.parse(traced.json()).topic;
    const keys = await harness.redis.keys(`page:v*:${fingerprint}:*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(await harness.redis.get(key)).not.toContain(id);
    await harness.redis.del(...keys);
  });

  it("is a single limited touch when the limiter answers 429", async () => {
    const app = await tracedApp({ max: 1 });
    await app.inject({ method: "GET", url: "/api/v1/reference" });
    const response = await app.inject({ method: "GET", url: "/api/v1/reference", headers: AUTH });

    expect(response.statusCode).toBe(429);
    const { trace } = await readStored(response.headers[TRACE_ID_HEADER] as string);
    expect(trace.status).toBe(429);
    expect(trace.touches).toEqual([
      expect.objectContaining({
        station: "rate_limit",
        outcome: "limited",
        inferred: true,
        limit: 1,
        remaining: 0,
      }),
    ]);
  });

  it("records a storyline open's plane gates as the harness ships them", async () => {
    const app = await tracedApp();
    const storylineId = await seedStoryline(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/storylines/${storylineId}/refresh`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(202);

    const { trace } = await readStored(response.headers[TRACE_ID_HEADER] as string);
    expect(trace.route).toBe("storyline_open");
    expect(trace.method).toBe("POST");
    expect(trace.planes).toMatchObject({ deepening: "unavailable", summaries: "disabled" });
    expect(["queued", "fresh"]).toContain(trace.planes?.refresh);
  });

  it("answers unchanged when the trace store is down, and says the trace went unstored", async () => {
    const capture = captureLog();
    const closed = new Redis(REDIS_URL, { lazyConnect: true, enableOfflineQueue: false });
    closed.disconnect();
    const app = await tracedApp({ runtime: makeRuntime(closed, capture.log) });

    const plain = await app.inject({ method: "GET", url: "/api/v1/reference" });
    const traced = await app.inject({ method: "GET", url: "/api/v1/reference", headers: AUTH });

    expect(traced.statusCode).toBe(200);
    expect(traced.body).toBe(plain.body);
    expect(traced.headers[TRACE_ID_HEADER]).toBe(TRACE_UNSTORED);
    expect(capture.warn.map((line) => line.message)).toContain(TRACE_UNSTORED_MESSAGE);
  });

  it("answers unchanged when its recorder throws at every turn", async () => {
    const broken = (): TouchRecorder => {
      const boom = () => {
        throw new Error("recorder bug");
      };
      return {
        t0: 0,
        sealed: false,
        refsIssued: 0,
        now: () => 0,
        begin: boom,
        prepend: boom,
        nextRef: boom,
        addOverhead: boom,
        seal: boom,
      };
    };
    const app = await tracedApp({ tracingOptions: { createRecorder: broken } });

    const plain = await app.inject({ method: "GET", url: "/api/v1/reference" });
    const traced = await app.inject({ method: "GET", url: "/api/v1/reference", headers: AUTH });
    expect(traced.statusCode).toBe(200);
    expect(traced.body).toBe(plain.body);
    expect(traced.headers[TRACE_ID_HEADER]).toBe(TRACE_UNSTORED);

    // A cold search goes through every wrapper, the queue's included.
    const search = await app.inject({
      method: "GET",
      url: `/api/v1/timeline?q=${uniqueWord()}`,
      headers: AUTH,
    });
    expect(search.statusCode).toBe(200);
    expect(TimelinePage.parse(search.json()).meta.ingest.state).toBe("in_progress");
  });
});

describe("GET /api/v1/traces/:id", () => {
  it("refuses a malformed id, 404s an unknown one, and serves a stored one no-store", async () => {
    const app = await tracedApp();

    const bad = await app.inject({ method: "GET", url: "/api/v1/traces/not-a-trace" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({
      error: { message: "invalid query", fields: { id: "must be a trace id" } },
    });
    expect(bad.headers["cache-control"]).toBe("no-store");

    const unknown = await app.inject({ method: "GET", url: traceReadPath(randomUUID()) });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: { message: "unknown trace" } });
    expect(unknown.headers["cache-control"]).toBe("no-store");

    const traced = await app.inject({ method: "GET", url: "/api/v1/reference", headers: AUTH });
    const read = await app.inject({
      method: "GET",
      url: traceReadPath(traced.headers[TRACE_ID_HEADER] as string),
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    const body = TraceReadResponse.parse(read.json());
    expect(body.trace.route).toBe("reference");
    // The read route is never itself traced.
    expect(read.headers[TRACE_ID_HEADER]).toBeUndefined();
  });

  it("answers 503 when the store cannot", async () => {
    const closed = new Redis(REDIS_URL, { lazyConnect: true, enableOfflineQueue: false });
    closed.disconnect();
    const app = await tracedApp({ runtime: makeRuntime(closed) });
    const response = await app.inject({ method: "GET", url: traceReadPath(randomUUID()) });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { message: "trace store unavailable" } });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("spends its own bucket, never a reader's", async () => {
    const app = await tracedApp({ max: 100 });
    const url = `/api/v1/timeline?q=${uniqueWord()}&${HISTORICAL_QS}`;
    const traced = await app.inject({ method: "GET", url, headers: AUTH });
    const path = traceReadPath(traced.headers[TRACE_ID_HEADER] as string);

    const remaining = async () =>
      Number((await app.inject({ method: "GET", url })).headers["x-ratelimit-remaining"]);
    const before = await remaining();
    for (let i = 0; i < 3; i += 1) await app.inject({ method: "GET", url: path });
    const after = await remaining();
    // One timeline request apart, whatever the reads did.
    expect(after).toBe(before - 1);

    const statuses: number[] = [];
    let limited: Awaited<ReturnType<FastifyInstance["inject"]>> | undefined;
    for (let i = 3; i < TRACE_READS_PER_MINUTE + 1; i += 1) {
      limited = await app.inject({ method: "GET", url: path });
      statuses.push(limited.statusCode);
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, -1).every((status) => status === 200)).toBe(true);
    // The limiter answers from its own hook, before the handler: still no-store.
    expect(limited?.headers["cache-control"]).toBe("no-store");
    expect(limited?.headers["retry-after"]).toBeDefined();
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
  });

  it("serves GET only, so HEAD is no second bucket over the same reads", async () => {
    const reads: string[] = [];
    const counting: TraceRuntime = {
      ...runtime,
      readTrace: async (id) => {
        reads.push(id);
        return runtime.readTrace(id);
      },
    };
    const app = await tracedApp({ runtime: counting });
    const path = traceReadPath(randomUUID());

    for (let i = 0; i < 3; i += 1) {
      const head = await app.inject({ method: "HEAD", url: path });
      expect(head.statusCode).toBe(404);
    }
    expect(app.hasRoute({ method: "HEAD", url: TRACE_READ_ROUTE })).toBe(false);
    expect(reads).toEqual([]);

    // GET still reads, once per request.
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(404);
    expect(reads).toHaveLength(1);
  });
});
