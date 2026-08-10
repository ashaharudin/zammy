import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { TimelinePage } from "@zammy/shared";
import { canonicalize } from "./canonical.js";
import { registerQueryRoutes } from "./routes.js";
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

async function setup(): Promise<void> {
  harness = await createTestHarness();
  app = Fastify({ logger: false });
  await registerQueryRoutes(app, { deps: harness.deps, defaultLanguage: "en" });
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
    const firstIds = new Set(first.items.map((i) => i.id));
    expect(second.items.every((i) => !firstIds.has(i.id))).toBe(true);
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
