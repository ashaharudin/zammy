import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { deriveDedupKey, type Sighting } from "@zammy/currents-client";
import { ingestSightings, recordCoverage, upsertTopic } from "@zammy/storage";
import type { CanonicalQuery } from "./canonical.js";
import { groupCreatedArticles } from "./grouping-service.js";
import { readTimeline } from "./timeline-service.js";
import { createTestHarness, type TestHarness } from "./test-support.js";

/**
 * Article grouping end to end (ARCHITECTURE 14.3): syndicated coverage in,
 * one timeline slot out — write-time grouping, per-topic representative,
 * group-positioned time.
 *
 * Synthetic sightings rather than a recorded payload, deliberately and against
 * the §12 default: the recorded fixtures contain 42 DISTINCT stories, which is
 * exactly the case grouping must leave alone. There is no captured payload of
 * one story across several outlets, so the alternative to constructing one is
 * not testing the feature. The fixture-backed guarantee that matters is the
 * other direction, and `timeline-service.test.ts` still asserts it: 42 distinct
 * articles stay 42 slots with grouping on.
 */

const NOW = new Date("2026-08-11T22:00:00.000Z");
const WINDOW = {
  from: new Date("2026-08-11T00:00:00.000Z"),
  to: new Date("2026-08-12T00:00:00.000Z"),
};

let harness: TestHarness;

afterEach(async () => {
  await harness.teardown();
});

let uuid = 0;
function sighting(overrides: {
  domain: string;
  title: string;
  published: string;
  path?: string;
}): Sighting {
  uuid += 1;
  const url = `https://${overrides.domain}${overrides.path ?? "/rate-decision"}`;
  return {
    id: `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`,
    url,
    dedupKey: deriveDedupKey(url),
    title: overrides.title,
    description: null,
    author: null,
    imageUrl: null,
    language: "en",
    categories: [],
    sourceCategories: [],
    sourceDomain: overrides.domain,
    published: overrides.published,
    raw: {},
  };
}

/** One story on three outlets, plus an unrelated story from the same day. */
const SYNDICATED = [
  sighting({
    domain: "contentfarm.example",
    title: "Bank of Canada holds interest rate steady",
    published: "2026-08-11T09:00:00.000Z",
  }),
  sighting({
    domain: "bbc.co.uk",
    title: "Bank of Canada holds interest rate",
    published: "2026-08-11T14:00:00.000Z",
  }),
  sighting({
    domain: "smalltown.example",
    title: "Bank of Canada holds its interest rate steady",
    published: "2026-08-11T18:00:00.000Z",
  }),
  sighting({
    domain: "ferrynews.example",
    title: "Ferry service suspended after storm damage",
    published: "2026-08-11T12:00:00.000Z",
    path: "/ferry",
  }),
];

/**
 * Ingest, group, and mark the window covered so the read is served from the
 * store — this exercises the read path, not the planner.
 */
async function seed(config: Partial<TestHarness["deps"]["config"]> = {}) {
  harness = await createTestHarness(config, NOW);
  const fingerprint = randomBytes(32).toString("hex");
  const query: CanonicalQuery = {
    fingerprint,
    keywords: ["rate"],
    language: "en",
    country: null,
    category: null,
    window: { ...WINDOW },
  };

  await upsertTopic(harness.deps.db, { fingerprint, keywords: ["rate"], language: "en" });
  const ingested = await ingestSightings(harness.deps.db, {
    fingerprint,
    sightings: SYNDICATED,
  });
  await groupCreatedArticles(
    {
      db: harness.deps.db,
      config: harness.deps.config.grouping,
      metrics: harness.metrics,
    },
    ingested.createdArticles,
  );
  await recordCoverage(harness.deps.db, fingerprint, WINDOW);

  return query;
}

describe("grouping, end to end", () => {
  it("shows syndicated coverage as one slot with the rest as related", async () => {
    const query = await seed();

    const result = await readTimeline(harness.deps, query, { limit: 25 });

    // Four articles, two stories. Every row is still in the store — the
    // wordcloud's df_domains breadth signal counts them (§10.3) — and the
    // timeline shows two slots.
    expect(harness.counting.searchCalls).toBe(0);
    expect(result.items).toHaveLength(2);

    const group = result.items.find((item) => item.related.length > 0);
    expect(group?.related).toHaveLength(2);
    expect([group?.article.sourceDomain, ...(group?.related ?? []).map((r) => r.sourceDomain)])
      .toEqual(expect.arrayContaining(["bbc.co.uk", "contentfarm.example", "smalltown.example"]));
  });

  it("headlines the group with its tier-1 source, not its earliest article", async () => {
    const query = await seed();

    const result = await readTimeline(harness.deps, query, { limit: 25 });
    const group = result.items.find((item) => item.related.length > 0);

    // The 09:00 content farm got there first; the BBC's 14:00 piece holds the
    // headline anyway. Authority is a property of the domain, not of time.
    expect(group?.article.sourceDomain).toBe("bbc.co.uk");
  });

  it("shows the group's time, with the latest coverage as the updated stamp", async () => {
    const query = await seed();

    const result = await readTimeline(harness.deps, query, { limit: 25 });
    const group = result.items.find((item) => item.related.length > 0);

    // Positioned and timestamped at 09:00 — the earliest member — even though
    // the headline article was published at 14:00. Showing "5 hours ago" in a
    // slot sitting below rows from 3 hours ago reads as a bug (§14.3).
    expect(group?.published).toBe("2026-08-11T09:00:00.000Z");
    expect(group?.updatedAt).toBe("2026-08-11T18:00:00.000Z");
    expect(Date.parse(group!.published)).toBeLessThan(Date.parse(group!.article.published));

    // …and the group therefore sits BELOW the 12:00 ferry story.
    expect(result.items[0]?.related).toHaveLength(0);
    expect(result.items[1]?.related).toHaveLength(2);
  });

  it("leaves the unrelated story alone", async () => {
    const query = await seed();

    const result = await readTimeline(harness.deps, query, { limit: 25 });
    const ferry = result.items.find((item) => item.article.sourceDomain === "ferrynews.example");

    expect(ferry?.related).toEqual([]);
    expect(ferry?.published).toBe(ferry?.updatedAt);
  });

  it("is switchable off, and then every article is its own slot", async () => {
    // §14.3 left "whether to build it at all" open. Shipping it with a way
    // back means the answer can still be no in production, without a
    // migration: the rows are untouched either way.
    const query = await seed({
      grouping: { enabled: false, threshold: 0.5, timeZone: "UTC" },
    });

    const result = await readTimeline(harness.deps, query, { limit: 25 });

    expect(result.items).toHaveLength(4);
    expect(result.items.every((item) => item.related.length === 0)).toBe(true);
  });
});

describe("an article that arrived before its story's coverage", () => {
  /**
   * The live case (2026-08-11) this exists for. Ingest order matters and is
   * the whole point, so the articles arrive in the order they really did:
   *
   *   1. the Daily Mail piece, when nothing related exists yet
   *   2. two Independent pieces, which group with each other
   *   3. the BBC piece, which matches BOTH — the Independent group at 0.750
   *      and the Daily Mail at 0.538
   *
   * Best-match sends the BBC article to the Independent group. Before
   * adoption, the Daily Mail piece stayed a separate slot forever.
   */
  const harper = (domain: string, title: string, published: string) =>
    sighting({ domain, title, published, path: `/${domain}-${published.slice(11, 16)}` });

  async function ingestHarperCluster() {
    harness = await createTestHarness({}, NOW);
    const fingerprint = randomBytes(32).toString("hex");
    await upsertTopic(harness.deps.db, { fingerprint, keywords: ["harper"], language: "en" });

    const arrivals = [
      harper("dailymail.com", "Every police chief is urging PM to stop release of PC Harper's killers", "2026-08-11T20:06:00.000Z"),
      harper("independent.co.uk", "Police leaders call on Burnham to prevent early release of Pc Harper's killers", "2026-08-11T20:36:00.000Z"),
      harper("independent.co.uk", "Fifty police chiefs call on Burnham to prevent early release of Pc Harper's killers", "2026-08-11T21:27:00.000Z"),
      harper("bbc.co.uk", "Police chiefs call for PM to prevent early release of PC Harper's killers", "2026-08-11T21:21:00.000Z"),
    ];

    // One at a time: a single batch would hand them all to grouping together,
    // and the bug only exists across separate arrivals.
    for (const arrival of arrivals) {
      const ingested = await ingestSightings(harness.deps.db, {
        fingerprint,
        sightings: [arrival],
      });
      await groupCreatedArticles(
        { db: harness.deps.db, config: harness.deps.config.grouping },
        ingested.createdArticles,
      );
    }

    await recordCoverage(harness.deps.db, fingerprint, WINDOW);
    return {
      fingerprint,
      keywords: ["harper"],
      language: "en",
      country: null,
      category: null,
      window: { ...WINDOW },
    } satisfies CanonicalQuery;
  }

  it("is adopted into the group once a later article matches both", async () => {
    const query = await ingestHarperCluster();

    const result = await readTimeline(harness.deps, query, { limit: 25 });

    expect(result.items).toHaveLength(1);
    const slot = result.items[0]!;
    expect(slot.related).toHaveLength(3);
    expect(
      [slot.article.sourceDomain, ...slot.related.map((r) => r.sourceDomain)].sort(),
    ).toEqual(["bbc.co.uk", "dailymail.com", "independent.co.uk", "independent.co.uk"]);
  });

  it("keeps the group where the earliest member put it, headlined by tier 1", async () => {
    const query = await ingestHarperCluster();

    const slot = (await readTimeline(harness.deps, query, { limit: 25 })).items[0]!;

    // Adoption pulls in an article published EARLIER than the group's other
    // members, so the group's position must follow it down (§7.3 keyset).
    expect(slot.published).toBe("2026-08-11T20:06:00.000Z");
    expect(slot.article.sourceDomain).toBe("bbc.co.uk");
  });
});
