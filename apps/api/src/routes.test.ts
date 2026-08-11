import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { TimelinePage, TrendingResponse } from "@zammy/shared";
import { canonicalize } from "./canonical.js";
import { registerMetricsRoute } from "./metrics.js";
import { registerQueryRoutes, registerTrendingRoute } from "./routes.js";
import type { TrendingDeps } from "./trending-service.js";
import { createTestHarness, purgeTopicKeys, type TestHarness } from "./test-support.js";

/**
 * The public HTTP surface (ARCHITECTURE 6.1), exercised end-to-end but
 * offline: Fastify → canonicalizer → planner → fixture client → Postgres.
 * Responses are validated against the SHARED contract schema — the same Zod
 * the browser build imports, so this test failing means the front end breaks.
 */

let harness: TestHarness;
let app: FastifyInstance;

afterEach(async () => {
  await app.close();
  await harness.teardown();
});

/**
 * Fictional, fixture-era clock. A real-clock harness would share its
 * trending day — and therefore the sample lock — with whatever the trending
 * suite or a local dev server is doing on the actual calendar day, and those
 * collide through the one Redis everything here deliberately shares.
 */
const ROUTES_NOW = new Date("2026-08-06T12:00:00.000Z");

async function setup(): Promise<void> {
  harness = await createTestHarness({}, ROUTES_NOW);
  app = Fastify({ logger: false });
  const trendingDeps: TrendingDeps = {
    ...harness.deps,
    trending: {
      appTimezone: "UTC",
      sampleCategories: ["science_technology", "politics_government"],
      samplePages: 1,
      sampleRefreshMinutes: 60,
      baselineWindowDays: 7,
    },
  };
  await registerQueryRoutes(app, { deps: harness.deps, defaultLanguage: "en" });
  registerTrendingRoute(app, { deps: trendingDeps });
  registerMetricsRoute(app, harness.metrics);
  await app.ready();

  // Day-keyed Redis state (sample lock, trending cache) outlives ephemeral
  // test databases; clear this suite's fictional day so reruns start fresh.
  const today = ROUTES_NOW.toISOString().slice(0, 10);
  await harness.redis.del(`lock:sample:${today}:en`, `trending:${today}:en`);

  // Deterministic fingerprints collide with previous runs via shared Redis.
  const canonical = canonicalize(
    { q: "climate" },
    {
      reference: {
        languages: new Set(["en"]),
        regions: new Set(),
        categories: new Set(),
      },
      defaultLanguage: "en",
      lookbackDays: 30,
      now: new Date(),
    },
  );
  if (canonical.ok) await purgeTopicKeys(harness.redis, canonical.query.fingerprint);
}

const TIMELINE = "/api/v1/timeline";
const QS = "from=2026-08-01T00:00:00Z&to=2026-08-06T00:00:00Z";

describe("GET /api/v1/timeline", () => {
  it("answers a keyword search with the full §6.1 contract", async () => {
    await setup();

    const response = await app.inject({ method: "GET", url: `${TIMELINE}?q=climate&${QS}` });

    expect(response.statusCode).toBe(200);
    const body = TimelinePage.parse(response.json()); // the shared contract IS the assertion
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.topic.keywords).toEqual(["climate"]);
    expect(body.topic.coverage).not.toBeNull();
    expect(body.meta.servedFrom).toBe("upstream");
    expect(body.meta.ingest.state).toBe("complete");
  });

  it("pages by cursor through the same contract", async () => {
    await setup();
    await app.inject({ method: "GET", url: `${TIMELINE}?q=climate&${QS}&limit=100` });

    const first = TimelinePage.parse(
      (await app.inject({ method: "GET", url: `${TIMELINE}?q=climate&${QS}&limit=3` })).json(),
    );
    expect(first.page.hasMore).toBe(true);

    const second = TimelinePage.parse(
      (
        await app.inject({
          method: "GET",
          url: `${TIMELINE}?q=climate&${QS}&limit=3&cursor=${encodeURIComponent(first.page.nextCursor!)}`,
        })
      ).json(),
    );
    const firstIds = new Set(first.items.map((i) => i.groupId));
    expect(second.items.every((i) => !firstIds.has(i.groupId))).toBe(true);
  });

  it("rejects bad input with field-level 400s, spending zero quota", async () => {
    await setup();
    const calls = harness.counting.searchCalls;

    const cases: Array<[string, string]> = [
      [`${TIMELINE}?${QS}`, "q"], // missing entirely
      [`${TIMELINE}?q=%20%20&${QS}`, "q"], // whitespace only
      [`${TIMELINE}?q=climate&language=xx&${QS}`, "language"],
      [`${TIMELINE}?q=climate&country=zz&${QS}`, "country"],
      [`${TIMELINE}?q=climate&limit=1000&${QS}`, "limit"],
      [`${TIMELINE}?q=climate&cursor=%21%21garbage&${QS}`, "cursor"],
    ];

    for (const [url, field] of cases) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
      const body = response.json() as { error: { fields?: Record<string, string> } };
      expect(body.error.fields?.[field], `${url} should flag ${field}`).toBeDefined();
    }

    // Pre-flight validation exists so a bad request never reaches upstream (§6.2).
    expect(harness.counting.searchCalls).toBe(calls);
  });
});

describe("GET /api/v1/reference", () => {
  it("serves the upstream reference values verbatim — junk included", async () => {
    await setup();

    const response = await app.inject({ method: "GET", url: "/api/v1/reference" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      languages: Record<string, string>;
      regions: Record<string, string>;
      categories: string[];
    };
    expect(body.languages.English).toBe("en");
    expect(Object.values(body.regions)).toContain("US");
    // Junk categories survive the wire layer on purpose: filtering belongs to
    // the UI picker, because a stored sighting may legitimately carry one.
    expect(body.categories).toContain("crap");
    expect(body.categories).toContain("technology");
  });
});

describe("GET /api/v1/trending", () => {
  it("answers with the §10.4 contract and queues the day's sample", async () => {
    await setup();

    const response = await app.inject({ method: "GET", url: "/api/v1/trending" });

    expect(response.statusCode).toBe(200);
    const body = TrendingResponse.parse(response.json()); // shared contract IS the assertion
    expect(body.language).toBe("en");
    // A fresh day: the cloud warms behind this very request (§10.1).
    expect(body.meta.ingest.state).toBe("in_progress");
    expect(body.meta.ingest.pendingJobs).toBeGreaterThanOrEqual(1);
  });

  it("rejects a malformed day without touching anything", async () => {
    await setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/trending?day=not-a-day",
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /metrics", () => {
  it("exposes the §12 counters in Prometheus text format", async () => {
    await setup();
    await app.inject({ method: "GET", url: `${TIMELINE}?q=climate&${QS}` });

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("zammy_upstream_calls_total 1");
    // ROUTES_NOW is 12h after the window's end: the "recent" tier (§6.4).
    expect(response.body).toContain('zammy_page_cache_reads_total{tier="recent",result="miss"}');
    expect(response.body).toContain("zammy_quota_daily_remaining");
  });
});

describe("GET /api/v1/topics/:fingerprint", () => {
  it("describes a topic once it exists", async () => {
    await setup();
    const timeline = TimelinePage.parse(
      (await app.inject({ method: "GET", url: `${TIMELINE}?q=climate&${QS}` })).json(),
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/topics/${timeline.topic.fingerprint}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      fingerprint: string;
      keywords: string[];
      articleCount: number;
      coverage: { from: string; to: string } | null;
      summary: string | null;
    };
    expect(body.fingerprint).toBe(timeline.topic.fingerprint);
    expect(body.keywords).toEqual(["climate"]);
    expect(body.articleCount).toBeGreaterThan(0);
    expect(body.coverage).not.toBeNull();
    expect(body.summary).toBeNull();
  });

  it("404s an unknown topic and 400s a malformed fingerprint", async () => {
    await setup();

    expect(
      (await app.inject({ method: "GET", url: `/api/v1/topics/${"0".repeat(64)}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/topics/not-a-fingerprint" }))
        .statusCode,
    ).toBe(400);
  });
});
