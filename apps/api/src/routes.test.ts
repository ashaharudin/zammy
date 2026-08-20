import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { encodeCursor, TimelinePage, TrendingResponse } from "@zammy/shared";
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
 * Fictional, fixture-era clock, so a rerun cannot inherit a real topic's
 * coverage. The trending keys need no such care: they are scoped to this
 * harness's own queue name, so neither the trending suite nor a local dev
 * server shares them (see trending-service.ts).
 */
const ROUTES_NOW = new Date("2026-08-06T12:00:00.000Z");

async function setup(): Promise<void> {
  harness = await createTestHarness({}, ROUTES_NOW);
  app = Fastify({ logger: false });
  const trendingDeps: TrendingDeps = {
    ...harness.deps,
    trending: {
      sampleCategories: ["science_technology", "politics_government"],
      samplePages: 1,
      sampleRefreshMinutes: 60,
      windowHours: 24,
      halfLifeHours: 8,
    },
  };
  await registerQueryRoutes(app, { deps: harness.deps, defaultLanguage: "en" });
  registerTrendingRoute(app, { deps: trendingDeps });
  registerMetricsRoute(app, harness.metrics);
  await app.ready();

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
    const firstIds = new Set(first.items.map((i) => i.storylineId));
    expect(second.items.every((i) => !firstIds.has(i.storylineId))).toBe(true);
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

  it("400s a stale-generation cursor on the storyline view, never a 500", async () => {
    // A reader mid-scroll in the view when the flag flips holds a v1 (bigint)
    // cursor. The view's cursor guard throws InvalidCursorError BEFORE the
    // storyline is even resolved, and this branch must map it to the same 400
    // the search branch gets — an unmapped throw here is the 500 the guard
    // exists to prevent.
    await setup();
    const v1Cursor = encodeCursor({
      published: "2026-08-05T00:00:00.000Z",
      articleId: "12345",
    });

    const response = await app.inject({
      method: "GET",
      url: `${TIMELINE}?storyline=1b671a64-40d5-491e-99b0-da01ff1f3341&cursor=${encodeURIComponent(v1Cursor)}&limit=3`,
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { fields?: Record<string, string> } };
    expect(body.error.fields?.cursor).toBeDefined();
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
  it("answers with the §10.4 contract and queues a sample", async () => {
    await setup();

    const response = await app.inject({ method: "GET", url: "/api/v1/trending" });

    expect(response.statusCode).toBe(200);
    const body = TrendingResponse.parse(response.json()); // shared contract IS the assertion
    expect(body.language).toBe("en");
    // The response says which 24 hours it describes, ending now (ADR-0008).
    expect(body.windowEnd).toBe(ROUTES_NOW.toISOString());
    expect(Date.parse(body.windowEnd) - Date.parse(body.windowStart)).toBe(24 * 3_600_000);
    // A cold cloud warms behind this very request (§10.1).
    expect(body.meta.ingest.state).toBe("in_progress");
    expect(body.meta.ingest.pendingJobs).toBeGreaterThanOrEqual(1);
  });

  it("ignores a stale ?day= rather than 400ing a bookmark", async () => {
    // The parameter is gone (ADR-0008) and there is no archive to serve. A
    // link saved under the old contract should still land on the live cloud,
    // not on an error page.
    await setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/trending?day=2026-08-01",
    });
    expect(response.statusCode).toBe(200);
    expect(TrendingResponse.parse(response.json()).windowEnd).toBe(ROUTES_NOW.toISOString());
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
