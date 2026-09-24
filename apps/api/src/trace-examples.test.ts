import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@zammy/config";
import { NewsQuotaError } from "@zammy/news-client";
import { TimelinePage } from "@zammy/shared";
import {
  TRACE_ID_HEADER,
  TRACE_REQUEST_HEADER,
  TraceReadResponse,
  traceAuthorization,
  traceSignature,
  type JobKind,
  type PlaneStatuses,
  type RequestTrace,
  type TraceEnvironment,
} from "@zammy/shared/request-trace";
import { canonicalize } from "./canonical.js";
import type { SegmentJob, SummarizeJob } from "./ingest-queue.js";
import { pageCacheKey } from "./page-cache.js";
import { registerQueryRoutes } from "./routes.js";
import { captureLog, createTestHarness, type TestHarness } from "./test-support.js";
import { registerRequestTracing } from "./trace-http.js";
import { createTraceRuntime, type TraceRuntime } from "./trace-store.js";

/**
 * The playback page's built-in examples, held to the code (ADR-0029,
 * "Consequences").
 *
 * The page ships seven hand-written traces so it is never empty, and a
 * hand-written trace is exactly the kind of documentation that goes on
 * describing a path the server stopped taking. So each is pinned twice: to the
 * signature table below (a mis-edit of the JSON fails here), and — for the five
 * paths the fixture harness can drive (the cache hit, the cold search, the 429,
 * the quota refusal and the storyline open) — to what the API RECORDS for the
 * same request. The other two are held to the table only: `cold-instance` needs
 * an instance inside a Redis handshake, and `edge-hit` by definition runs no
 * function. The signature (`traceSignature`, shared by both sides) keeps
 * what the code decides and drops what timing and cache warmth vary, so an
 * example drifting from `coverage-fill.ts`, `timeline-read.ts` or the refresh
 * route fails a test rather than teaching a reader something false.
 *
 * The files belong to the web app (`apps/web/src/playback/examples/`) and are
 * read here off disk, `llms-txt.test.ts`'s precedent: the API's test is the one
 * that can say what the API does.
 */

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const EXAMPLES_DIR = "../../web/src/playback/examples/";

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
const TOKEN = "e".repeat(40);
const AUTH = { [TRACE_REQUEST_HEADER]: traceAuthorization(TOKEN) };
const NOW = new Date("2026-08-06T12:00:00.000Z");
/** A window no other suite asks for (see trace-http.test.ts), for seeding storylines. */
const SEED_FROM = "2026-08-01T06:00:00Z";
const SEED_TO = "2026-08-04T00:00:00Z";
const SEED_QS = `from=${SEED_FROM}&to=${SEED_TO}`;

/**
 * The path each example must follow, as `traceSignature` reduces it: the table
 * ADR-0029's Consequences pins the examples to, and its only home. An example
 * whose JSON strays from its row fails "the example files" below; a server that
 * strays from an example fails "what the API records".
 */
const SIGNATURES: Record<string, string[]> = {
  "cache-hit": ["rate_limit:counted", "redis:reference", "redis:page_cache"],
  "cold-search": [
    "rate_limit:counted",
    "redis:reference",
    "redis:page_cache",
    "redis:fill_lock",
    "redis:topic_budget",
    "currents:search",
    "redis:fill_lock",
    "queue:segment",
    "redis:pending_ledger",
  ],
  // The deepening plane is planned before the reference read, because the
  // Currents top-up may defer to it (ADR-0017, amended).
  "storyline-open": [
    "rate_limit:counted",
    "queue:deepen",
    "redis:reference",
    "queue:topup",
    "queue:summarize",
  ],
  "rate-limited": ["rate_limit:limited"],
  "quota-degraded": [
    "rate_limit:counted",
    "redis:reference",
    "redis:page_cache",
    "redis:fill_lock",
    "redis:topic_budget",
    "currents:search",
    "redis:fill_lock",
    "redis:pending_ledger",
  ],
  "cold-instance": [
    "rate_limit:fail_open",
    "redis:reference",
    "redis:page_cache",
    "redis:fill_lock",
    "redis:pending_ledger",
  ],
  "edge-hit": ["edge:hit"],
};

/** The same, for the job runs an example carries, by job kind. */
const RUN_SIGNATURES: Partial<Record<JobKind, string[]>> = {
  segment: ["redis:fill_lock", "redis:topic_budget", "currents:search", "redis:fill_lock"],
  topup: ["redis:fill_lock", "redis:topic_budget", "currents:search", "redis:fill_lock"],
  deepen: ["redis:deepen_lock", "google_news:search", "redis:deepen_lock"],
  summarize: ["redis:summarize_lock", "gemini:generate", "redis:summarize_lock"],
};

const SLUGS = Object.keys(SIGNATURES);

function examplePath(slug: string): string {
  return here(`${EXAMPLES_DIR}${slug}.json`);
}

/** An example's `response`, parsed with the wire schema — drift in shape fails here. */
function example(slug: string): TraceReadResponse {
  const file = JSON.parse(readFileSync(examplePath(slug), "utf8")) as {
    slug?: unknown;
    response?: unknown;
  };
  expect(file.slug).toBe(slug);
  return TraceReadResponse.parse(file.response);
}

describe("the example files", () => {
  it("exist, one per slug", () => {
    const missing = SLUGS.filter((slug) => !existsSync(examplePath(slug)));
    expect(missing, `missing under apps/web/src/playback/examples/`).toEqual([]);
  });

  for (const slug of SLUGS) {
    it(`${slug} parses and follows the path the table pins`, () => {
      const response = example(slug);
      expect(traceSignature(response.trace.touches)).toEqual(SIGNATURES[slug]);
      for (const run of response.runs) {
        expect(traceSignature(run.touches), `${slug} run ${run.ref} (${run.job})`).toEqual(
          RUN_SIGNATURES[run.job],
        );
      }
    });
  }
});

// ── the recorded paths ──────────────────────────────────────────────────────

const ENVIRONMENT: TraceEnvironment = {
  queue: "bullmq",
  currents: "fixture",
  gnews: false,
  googleNews: "off",
  summaries: false,
  labeler: false,
};

let harness: TestHarness;
let runtime: TraceRuntime;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  // One sync call, so a default-window search defers the rest of its window and
  // enqueues — the cold-search path as production takes it on a new topic.
  harness = await createTestHarness({ maxSyncUpstreamCalls: 1 }, NOW);
  runtime = createTraceRuntime(
    loadConfig({
      DATABASE_URL: "postgres://zammy:zammy@localhost:5432/zammy",
      REDIS_URL,
      CURRENTS_USER_AGENT: "zammy-tests/0.1",
      REQUEST_TRACE_ENABLED: "true",
      REQUEST_TRACE_TOKEN: TOKEN,
    } as NodeJS.ProcessEnv),
    {
      redis: harness.redis,
      queueName: harness.queue.name,
      environment: ENVIRONMENT,
      log: captureLog().log,
    },
  );
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const pattern of [`${harness.queue.name}:trace:*`, "ratelimit-trace-examples-*"]) {
    let cursor = "0";
    do {
      const [next, keys] = await harness.redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
      cursor = next;
      if (keys.length > 0) await harness.redis.del(...keys);
    } while (cursor !== "0");
  }
});

afterAll(async () => {
  await harness.teardown();
});

/** A keyword nobody else searches, so no shared page cache or lock can answer for it. */
function uniqueWord(): string {
  const letters = randomUUID()
    .replaceAll("-", "")
    .replace(/[0-9]/g, (digit) => "ghijklmnop"[Number(digit)]!);
  return `zx${letters}`.slice(0, 16);
}

/** The real limiter, tracing and the real query routes, over the fixture harness. */
async function app(
  options: { max?: number; quotaRefused?: boolean } = {},
): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  apps.push(instance);
  await instance.register(rateLimit, {
    max: options.max ?? 10_000,
    timeWindow: 60_000,
    redis: harness.redis,
    nameSpace: `ratelimit-trace-examples-${randomUUID()}:`,
    skipOnError: true,
    allowList: (request) => !request.url.startsWith("/api/"),
  });
  registerRequestTracing(instance, runtime);
  const currents = options.quotaRefused
    ? {
        // The Currents client as its governor answers when the burst window is
        // spent: the reference lists still answer, the search is refused.
        provider: harness.counting.provider,
        get limits() {
          return harness.counting.limits;
        },
        search: async () => {
          throw new NewsQuotaError("burst window spent");
        },
        latestNews: async () => {
          throw new NewsQuotaError("burst window spent");
        },
        availableLanguages: () => harness.counting.availableLanguages(),
        availableRegions: () => harness.counting.availableRegions(),
        availableCategories: () => harness.counting.availableCategories(),
        quota: () => harness.counting.quota(),
        close: () => Promise.resolve(),
      }
    : harness.deps.currents;
  await registerQueryRoutes(instance, {
    deps: {
      ...harness.deps,
      currents: currents as typeof harness.deps.currents,
      queue: {
        ...harness.deps.queue,
        enqueueSegment: (job: SegmentJob) => harness.deps.queue.enqueueSegment(job),
        enqueueDeepen: harness.deps.queue.enqueueDeepen.bind(harness.deps.queue),
        pendingCount: harness.deps.queue.pendingCount.bind(harness.deps.queue),
        enqueueSummarize: async (_job: SummarizeJob) => {},
      },
    },
    defaultLanguage: "en",
  });
  await instance.ready();
  return instance;
}

/**
 * Forget the seed search's cached pages — only this query over this window. A
 * complete page outlives the run that wrote it (24 h on the historical tier),
 * and a page from a previous run names storylines from a database that has
 * since been dropped.
 */
async function forgetSeedPages(): Promise<void> {
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
  let cursor = "0";
  do {
    const [next, keys] = await harness.redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200);
    cursor = next;
    if (keys.length > 0) await harness.redis.del(...keys);
  } while (cursor !== "0");
}

async function recorded(response: { headers: Record<string, unknown> }): Promise<RequestTrace> {
  const id = response.headers[TRACE_ID_HEADER];
  expect(typeof id, "the request should have been traced and stored").toBe("string");
  const read = await runtime.readTrace(id as string);
  expect(read).not.toBeNull();
  return read!.trace;
}

describe("what the API records, against the examples", () => {
  it("records a cache hit the way cache-hit.json draws it", async () => {
    const server = await app();
    // One day that closed days before NOW: complete, and so cached.
    const url = `/api/v1/timeline?q=${uniqueWord()}&from=2026-08-02T00:00:00Z&to=2026-08-03T00:00:00Z`;
    const first = await server.inject({ method: "GET", url });
    expect(TimelinePage.parse(first.json()).meta.ingest.state).toBe("complete");

    const trace = await recorded(await server.inject({ method: "GET", url, headers: AUTH }));

    expect(trace.meta?.servedFrom).toBe("cache");
    expect(traceSignature(trace.touches)).toEqual(traceSignature(example("cache-hit").trace.touches));
  });

  it("records a cold search the way cold-search.json draws it", async () => {
    const server = await app();
    const trace = await recorded(
      await server.inject({ method: "GET", url: `/api/v1/timeline?q=${uniqueWord()}`, headers: AUTH }),
    );

    // The number of enqueues may differ from the example's four; consecutive
    // queue tokens collapse, so the signature does not.
    expect(traceSignature(trace.touches)).toEqual(traceSignature(example("cold-search").trace.touches));
  });

  it("records a limited request the way rate-limited.json draws it", async () => {
    const server = await app({ max: 1 });
    await server.inject({ method: "GET", url: "/api/v1/reference" });
    const trace = await recorded(
      await server.inject({ method: "GET", url: `/api/v1/timeline?q=${uniqueWord()}`, headers: AUTH }),
    );

    expect(trace.status).toBe(429);
    expect(traceSignature(trace.touches)).toEqual(traceSignature(example("rate-limited").trace.touches));
  });

  it("records a quota-refused search the way quota-degraded.json draws it", async () => {
    const server = await app({ quotaRefused: true });
    const trace = await recorded(
      await server.inject({ method: "GET", url: `/api/v1/timeline?q=${uniqueWord()}`, headers: AUTH }),
    );

    expect(trace.meta?.degraded).toBe("quota");
    expect(traceSignature(trace.touches)).toEqual(
      traceSignature(example("quota-degraded").trace.touches),
    );
  });

  it("records a storyline open as its planes decided; the example is the all-queued form", async () => {
    const server = await app();
    await forgetSeedPages();
    const seed = TimelinePage.parse(
      (await server.inject({ method: "GET", url: `/api/v1/timeline?q=climate&${SEED_QS}` })).json(),
    );
    const storylineId = (seed.items[0] as { storylineId: string } | undefined)?.storylineId;
    expect(storylineId, "the seed search should surface a storyline").toBeDefined();

    const trace = await recorded(
      await server.inject({
        method: "POST",
        url: `/api/v1/storylines/${storylineId}/refresh`,
        headers: AUTH,
      }),
    );

    const planes = trace.planes as PlaneStatuses;
    expect(planes).not.toBeNull();
    const expected = ["rate_limit:counted"];
    // Planned first (ADR-0017, amended), so its enqueue precedes the reference read.
    if (planes.deepening === "queued") expected.push("queue:deepen");
    expected.push("redis:reference");
    if (planes.refresh === "queued") {
      const queued = trace.touches.find((t) => t.station === "queue");
      expect(["segment", "topup"]).toContain(queued?.station === "queue" ? queued.job : null);
      expected.push(`queue:${queued?.station === "queue" ? queued.job : "topup"}`);
    }
    if (planes.summaries === "queued") expected.push("queue:summarize");
    expect(traceSignature(trace.touches)).toEqual(expected);

    const drawn = example("storyline-open");
    expect(drawn.trace.planes).toEqual({ refresh: "queued", deepening: "queued", summaries: "queued" });
    expect(traceSignature(drawn.trace.touches)).toEqual([
      "rate_limit:counted",
      "queue:deepen",
      "redis:reference",
      "queue:topup",
      "queue:summarize",
    ]);
  });
});
