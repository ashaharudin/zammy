import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { encodeCursor, TimelinePage, TrendingResponse } from "@zammy/shared";
import { readTopic } from "@zammy/storage";
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

  it("answers a bookmarked ?category= link instead of 400ing it", async () => {
    // ADR-0020 retired the category CHOICE, and the failure mode it had to
    // avoid is this one: `canonicalize` used to validate a category against the
    // reference list and a miss became "invalid query". Had the taxonomy simply
    // stopped being populated, every `?category=technology` bookmark ever
    // shared would answer 400 — a harder failure than the filter being removed.
    //
    // What must happen instead is a usable search, and specifically the SAME
    // search as without the parameter: the schema strips what it does not name,
    // so the two requests are one topic, one fingerprint, one accumulating
    // coverage. Asserted through the HTTP surface rather than the canonicalizer
    // because the strip happens in the shared Zod contract, which a unit test of
    // `canonicalize` never reaches.
    await setup();

    const plain = await app.inject({ method: "GET", url: `${TIMELINE}?q=climate&${QS}` });
    const stale = await app.inject({
      method: "GET",
      url: `${TIMELINE}?q=climate&category=technology&${QS}`,
    });

    expect(stale.statusCode).toBe(200);
    const staleBody = TimelinePage.parse(stale.json());
    expect(staleBody.items.length).toBeGreaterThan(0);
    expect(staleBody.topic.fingerprint).toBe(TimelinePage.parse(plain.json()).topic.fingerprint);
  });

  it("does not mint a category-scoped topic from a stale link", async () => {
    // The other half of the same guarantee, and the one a strip could get
    // wrong quietly: the request degrades to the unfiltered topic, so nothing
    // is stored under a category the reader can no longer see or clear, and
    // no fetch is planned with a filter half the ingest cannot express.
    await setup();

    const response = await app.inject({
      method: "GET",
      url: `${TIMELINE}?q=climate&category=technology&${QS}`,
    });

    const fingerprint = TimelinePage.parse(response.json()).topic.fingerprint;
    expect(await readTopic(harness.deps.db, fingerprint)).toMatchObject({ category: null });
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

describe("POST /api/v1/storylines/:id/refresh", () => {
  interface RefreshBody {
    storyline: string;
    queued: boolean;
    keywords: string[];
    fingerprint?: string;
  }

  const refresh = (id: string): string => `/api/v1/storylines/${id}/refresh`;

  it("accepts a storyline a reader opened and says what it queued", async () => {
    await setup();
    // A read is how storylines come to exist here: grouping and its storyline
    // layer run on the write path (§14.3), so the fixture's own articles are
    // what a reader would have clicked.
    const read = await app.inject({ method: "GET", url: `${TIMELINE}?q=climate&${QS}` });
    const storylineId = (TimelinePage.parse(read.json()).items[0] as { storylineId: string })
      .storylineId;

    const response = await app.inject({ method: "POST", url: refresh(storylineId) });

    expect(response.statusCode).toBe(202);
    const body = response.json() as RefreshBody;
    expect(body.storyline).toBe(storylineId);
    // Whatever it decided, it decided it from the arc's own vocabulary — the
    // request carried a UUID and nothing else.
    expect(body.keywords.length).toBeGreaterThan(0);
    expect(body.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refreshes in the default language when the arc's own is not a query code", async () => {
    await setup();
    const read = await app.inject({ method: "GET", url: `${TIMELINE}?q=climate&${QS}` });
    const storylineId = (TimelinePage.parse(read.json()).items[0] as { storylineId: string })
      .storylineId;
    // `articles.language` is upstream's ARTICLE field and `/available/languages`
    // is what a query may be narrowed BY; they are not the same vocabulary (the
    // reference table holds {"Malay": "msa"} against ISO-639-1 elsewhere,
    // PROBE-FINDINGS 6). A 400 here would be silent — the caller has no error
    // path — and permanent for the arc, so the language is dropped instead.
    await sql`
      update articles set language = 'zz-not-a-code'
      where group_id in (select group_id from storyline_groups where storyline_id = ${storylineId}::uuid)
    `.execute(harness.deps.db);

    const response = await app.inject({ method: "POST", url: refresh(storylineId) });

    expect(response.statusCode).toBe(202);
    const body = response.json() as RefreshBody;
    expect(body.keywords.length).toBeGreaterThan(0);
    const topic = await readTopic(harness.deps.db, body.fingerprint!);
    expect(topic?.language).toBe("en"); // the route's defaultLanguage
  });

  it("spends no upstream call, even with the reference cache cold", async () => {
    await setup();
    const read = await app.inject({ method: "GET", url: `${TIMELINE}?q=climate&${QS}` });
    const storylineId = (TimelinePage.parse(read.json()).items[0] as { storylineId: string })
      .storylineId;
    // A cold `ref:*` is the ordinary state, not an exotic one — dev Redis evicts
    // under volatile-lru. `loadReference` answers a miss with three INTERACTIVE
    // upstream calls, which on a path advertised as spending nothing would let a
    // reader clicking through the cloud drain the day's quota invisibly, at the
    // same moment the per-IP limiter fails open. So this path reads the cache and
    // stops there.
    await harness.redis.del("ref:languages", "ref:regions", "ref:categories");
    const calls = harness.counting.searchCalls;
    const reference = harness.counting.referenceCalls;

    const response = await app.inject({ method: "POST", url: refresh(storylineId) });

    expect(response.statusCode).toBe(202);
    expect(harness.counting.searchCalls).toBe(calls);
    expect(harness.counting.referenceCalls).toBe(reference);
  });

  it("is a 404 for a UUID this database has never held", async () => {
    await setup();

    const response = await app.inject({
      method: "POST",
      url: refresh("1b671a64-40d5-491e-99b0-da01ff1f3341"),
    });

    expect(response.statusCode).toBe(404);
  });

  it("refuses anything that is not a storyline UUID", async () => {
    await setup();

    // `?storyline=` stopped accepting a bigint with migration 0012 and so does
    // this: a label's words are never an identity (ADR-0011, ADR-0016).
    const response = await app.inject({ method: "POST", url: refresh("12345") });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { fields?: Record<string, string> } };
    expect(body.error.fields?.id).toBeDefined();
  });
});

describe("GET /api/v1/reference", () => {
  interface ReferenceBody {
    languages: Record<string, string>;
    regions: Record<string, string>;
    categories?: string[];
  }

  it("serves the upstream reference values verbatim", async () => {
    await setup();

    const response = await app.inject({ method: "GET", url: "/api/v1/reference" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ReferenceBody;
    expect(body.languages.English).toBe("en");
    expect(Object.values(body.regions)).toContain("US");
  });

  it("no longer offers the category taxonomy, and spends no call learning it", async () => {
    // ADR-0020. The chip is gone, so a list of things nobody can pick is an
    // OFFER — the next person to see it on the wire would reasonably build the
    // control back. Two upstream calls now, not three: `availableCategories()`
    // is still on the client interface and still parses the taxonomy out of a
    // recorded 400 body, and it is simply not asked.
    await setup();
    await harness.redis.del("ref:languages", "ref:regions", "ref:categories");
    const before = harness.counting.referenceCalls;

    const body = (
      await app.inject({ method: "GET", url: "/api/v1/reference" })
    ).json() as ReferenceBody;

    expect(body.categories).toBeUndefined();
    expect(harness.counting.referenceCalls - before).toBe(2);
    expect(await harness.redis.get("ref:categories")).toBeNull();
  });

  it("spells the names a picker draws, whatever upstream typed", async () => {
    await setup();

    const body = (
      await app.inject({ method: "GET", url: "/api/v1/reference" })
    ).json() as ReferenceBody;

    expect(body.regions["United States"]).toBe("US");
    expect(body.regions).not.toHaveProperty("United State");
    expect(body.languages["Vietnamese"]).toBe("vi");
    expect(body.languages).not.toHaveProperty("Vietnamise");
    // Codes are the half that travels and the half this must not touch.
    expect(Object.values(body.regions)).toContain("US");
    expect(Object.values(body.languages)).toContain("vi");
  });

  it("repairs the names on the way OUT, so a warm cache is not stuck with them", async () => {
    await setup();

    // The cache as an instance that deployed BEFORE the fix left it: upstream's
    // body, typos and all, with 24h still to run. Repairing on the way IN would
    // pass every other test in this file and serve "United State" until the TTL
    // expired — which is the whole reason the repair sits where it sits.
    await harness.deps.redis.set(
      "ref:regions",
      JSON.stringify({ Canada: "CA", "United State": "US" }),
      "PX",
      60_000,
    );
    await harness.deps.redis.set("ref:languages", JSON.stringify({ Vietnamise: "vi" }), "PX", 60_000);
    // A `ref:categories` an older build left behind, with its TTL still running.
    // The read no longer asks for that key, so a cache warmed by a pre-ADR-0020
    // instance must still count as a HIT — requiring three keys where two are
    // used would turn every such instance's next deploy into a refetch.
    await harness.deps.redis.set("ref:categories", JSON.stringify(["technology"]), "PX", 60_000);
    const before = harness.counting.referenceCalls;

    const body = (
      await app.inject({ method: "GET", url: "/api/v1/reference" })
    ).json() as ReferenceBody;

    expect(body.regions).toEqual({ Canada: "CA", "United States": "US" });
    expect(body.languages).toEqual({ Vietnamese: "vi" });
    expect(body.categories).toBeUndefined();
    // Still the cached body, not a refetch: the repair is a rename, not a reload.
    expect(harness.counting.referenceCalls).toBe(before);
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
