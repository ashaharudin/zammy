import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processSegmentJob } from "./timeline-service.js";
import {
  processSampleJob,
  readTrending,
  type TrendingDeps,
} from "./trending-service.js";
import { deriveDedupKey } from "@zammy/currents-client";
import {
  attachGroup,
  createProvisionalStoryline,
  ingestSightings,
  promoteStoryline,
  setStorylineLabel,
  upsertTopic,
} from "@zammy/storage";
import { fingerprintOf } from "./canonical.js";
import { createTestHarness, type TestHarness } from "./test-support.js";

/**
 * The landing-page cloud (ARCHITECTURE 10.1, post-6c): the first visitor after
 * the last /v2/latest-news snapshot staled triggers ONE background sample call
 * and is served the stored cloud instantly. The window rolls with `now` rather
 * than resetting at midnight (ADR-0008), so nothing here is keyed by day and
 * there is no frozen period to ask about.
 *
 * What the cloud NAMES is storylines (ADR-0013), and that changes what these
 * tests can assume: the sample no longer computes anything the cloud reads, so
 * a cloud can be non-empty before any sample has run, and a sample can succeed
 * while leaving the cloud empty — a page of unrelated latest-news articles is
 * forty provisional storylines-of-one, which is not a story between them.
 */

/** All 100 recorded /v2/latest-news sightings are published 2026-08-11. */
const NOW = new Date("2026-08-11T05:00:00.000Z");

/** A curated slice of the v2 taxonomy that the recorded feed actually carries. */
const CATEGORIES = [
  "economy_business_finance",
  "science_technology",
  "politics_government",
  "society",
  "sport",
  "general",
];

let harness: TestHarness;

/** Unique across a file's stores: one URL is one article, however often seeded. */
let seeded = 0;

afterEach(async () => {
  await harness.teardown();
});

function trendingDeps(h: TestHarness, overrides: Partial<TrendingDeps["trending"]> = {}): TrendingDeps {
  return {
    ...h.deps,
    trending: {
      sampleCategories: CATEGORIES,
      samplePages: 1,
      sampleRefreshMinutes: 60,
      windowHours: 24,
      ...overrides,
    },
  };
}

/**
 * Store articles at chosen ages — the corpus source the sample does not supply
 * (§10.1 source 1), and the only way to put a story at a known distance from
 * `now`. Returns their ids, which are also their group ids: an article stored
 * this way is a group of one until grouping says otherwise.
 */
async function storeArticles(
  h: TestHarness,
  articles: Array<{ title: string; domain: string; ageHours: number }>,
): Promise<string[]> {
  const fingerprint = fingerprintOf({
    keywords: ["seeded"],
    language: "en",
    country: null,
    category: null,
  });
  await upsertTopic(h.deps.db, {
    fingerprint,
    keywords: ["seeded"],
    language: "en",
    country: null,
    category: null,
  });
  const ingested = await ingestSightings(h.deps.db, {
    fingerprint,
    sightings: articles.map((a) => {
      seeded += 1;
      const url = `https://${a.domain}/seeded-${seeded}`;
      return {
        id: randomUUID(),
        url,
        provider: "currents",
        providerSightingId: url,
        dedupKey: deriveDedupKey(url),
        title: a.title,
        description: null,
        author: null,
        imageUrl: null,
        language: "en",
        categories: [],
        sourceCategories: [],
        sourceDomain: a.domain,
        published: new Date(NOW.getTime() - a.ageHours * 3_600_000).toISOString(),
        raw: {},
      };
    }),
  });
  return ingested.createdArticles.map((a) => a.id);
}

/**
 * Hold the freshness lock, so a read elects no sample.
 *
 * The lock IS the cadence (§10.1), and a test about the CACHE needs the cloud
 * to be `complete`: an elected sample leaves a pending job, an in_progress
 * response is deliberately never cached, and the assertion would be about the
 * sampler rather than about the cache.
 */
async function holdSampleLock(h: TestHarness, language = "en"): Promise<void> {
  await h.redis.set(`${h.queue.name}:lock:sample:${language}`, "1", "PX", 600_000);
}

/**
 * A labelled, promoted storyline over stored articles.
 *
 * Built through the storage API rather than by driving the linker, for the
 * reason the storage suite does the same: what these tests are about is the
 * service — the lock, the cache, the window — and a linker that declined to
 * attach two synthetic headlines would make its token thresholds the subject.
 */
async function seedStoryline(
  h: TestHarness,
  label: string,
  articles: Array<{ title: string; domain: string; ageHours: number }>,
): Promise<string> {
  const groups = await storeArticles(h, articles);
  const created = await createProvisionalStoryline(h.deps.db, {
    groupId: groups[0]!,
    timeZone: "UTC",
  });
  for (const groupId of groups.slice(1)) {
    await attachGroup(h.deps.db, { storylineId: created.id, groupId, timeZone: "UTC" });
  }
  await promoteStoryline(h.deps.db, { storylineId: created.id });
  await setStorylineLabel(h.deps.db, {
    storylineId: created.id,
    label,
    labelAt: NOW,
    labelGroupCount: groups.length,
    labelSource: "test",
  });
  return created.id;
}

describe("the first visitor after the snapshot staled (§10.1)", () => {
  it("queues ONE single-call sample, serves instantly, and never blocks the reader", async () => {
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);

    // The first visitor pays nothing synchronously — the whole §9 posture.
    const first = await readTrending(deps, { language: "en", limit: 50 });
    expect(harness.counting.searchCalls).toBe(0);
    expect(first.windowEnd).toBe(NOW.toISOString());
    expect(first.storylines).toEqual([]);
    expect(first.meta.ingest.state).toBe("in_progress");
    expect(first.meta.ingest.pendingJobs).toBe(1);

    // Visitor two hits the held lock and the deduped jobId: still one sample.
    const second = await readTrending(deps, { language: "en", limit: 50 });
    expect(second.meta.ingest.pendingJobs).toBe(1);

    harness.queue.startConsumer((job) =>
      job.kind === "sample"
        ? processSampleJob(deps, job)
        : processSegmentJob(harness.deps, job),
    );
    await vi.waitFor(
      async () => expect(await harness.queue.pendingCount("sample_en")).toBe(0),
      { timeout: 20_000, interval: 250 },
    );

    const done = await readTrending(deps, { language: "en", limit: 50 });
    expect(done.meta.ingest.state).toBe("complete");

    // ONE /v2/latest-news call — not twelve category slices — as background.
    expect(harness.counting.searchCalls).toBe(1);
    expect(harness.counting.priorities).toEqual(["background"]);
  }, 30_000);

  it("caches per language, not per limit — a narrow read cannot shrink the cloud", async () => {
    // Reproduced live under the term cloud: `curl '/api/v1/trending?limit=4'`
    // cached a four-word body, and the landing page — which asks for 50 —
    // rendered a four-word cloud for the next fifteen minutes. The cache key
    // names a language, so what it holds has to be the whole list.
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);
    await holdSampleLock(harness);
    await seedStoryline(harness, "Kelowna Evacuations", [
      { title: "Evacuations Near Kelowna Ordered", domain: "a.com", ageHours: 8 },
      { title: "Smoke Covers Kelowna By Dawn", domain: "b.com", ageHours: 9 },
    ]);
    await seedStoryline(harness, "Truro Verdict", [
      { title: "Verdict Delivered In The Truro Case", domain: "a.com", ageHours: 3 },
      { title: "Appeal Expected After The Truro Ruling", domain: "b.com", ageHours: 4 },
    ]);

    // A caller asking for one storyline still gets exactly one…
    const narrow = await readTrending(deps, { language: "en", limit: 1 });
    expect(narrow.storylines).toHaveLength(1);

    // …and the next reader gets the whole cloud, from that same cache entry.
    const wide = await readTrending(deps, { language: "en", limit: 50 });
    expect(wide.meta.servedFrom).toBe("cache");
    expect(wide.storylines).toHaveLength(2);
    // Still a prefix of one list, so the two agree about what leads.
    expect(wide.storylines[0]!.label).toBe(narrow.storylines[0]!.label);
    // And what leads is the most recently updated arc (ADR-0013).
    expect(wide.storylines.map((s) => s.label)).toEqual([
      "Truro Verdict",
      "Kelowna Evacuations",
    ]);
  }, 30_000);

  it("re-elects a sample once the freshness window passes — cost scales with the clock, not readers", async () => {
    harness = await createTestHarness({}, NOW);
    // 60ms freshness window: "an hour" at test speed.
    const deps = trendingDeps(harness, { sampleRefreshMinutes: 0.001 });

    harness.queue.startConsumer((job) =>
      job.kind === "sample"
        ? processSampleJob(deps, job)
        : processSegmentJob(harness.deps, job),
    );

    await readTrending(deps, { language: "en", limit: 50 });
    await vi.waitFor(
      async () => expect(await harness.queue.pendingCount("sample_en")).toBe(0),
      { timeout: 20_000, interval: 100 },
    );
    expect(harness.counting.searchCalls).toBe(1);

    // The cache is cleared to prove it is the LOCK holding the cadence, not
    // the response cache.
    await harness.redis.del(`${harness.queue.name}:trending:en`);
    await new Promise((r) => setTimeout(r, 80)); // let the 60ms lock expire

    const later = await readTrending(deps, { language: "en", limit: 50 });
    expect(later.meta.ingest.state).toBe("in_progress"); // next snapshot warming
    await vi.waitFor(
      async () => expect(await harness.queue.pendingCount("sample_en")).toBe(0),
      { timeout: 20_000, interval: 100 },
    );
    expect(harness.counting.searchCalls).toBe(2);
  }, 30_000);
});

describe("the sample is a write path, so it groups what it creates (§14.3)", () => {
  it("tokenizes every article it ingests, making it groupable and a candidate", async () => {
    // The sampler shipped for one release ingesting straight into `articles`
    // with no grouping pass. An article stored without tokens can never join a
    // group AND is invisible as a candidate to everything ingested after it —
    // and this is the most syndication-dense source we have, one latest-news
    // page spanning every category and outlet. It matters more now than it did:
    // grouping is what runs the linker, so an untokenized article cannot reach
    // a storyline, which is the only thing the cloud can name.
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);

    await processSampleJob(deps, { kind: "sample", language: "en" });

    const rows = await harness.deps.db
      .selectFrom("articles")
      .select(["id", "title", "title_tokens", "group_id"])
      .execute();

    expect(rows.length).toBeGreaterThan(0);
    const untokenized = rows.filter(
      // A headline of pure stopwords legitimately tokenizes to nothing; every
      // other article must carry the tokens the next arrival matches against.
      (row) => row.title_tokens.length === 0 && row.title.split(/\s+/).length > 3,
    );
    expect(untokenized).toEqual([]);
    // Every article is in a group, its own until something joins it.
    expect(rows.every((row) => row.group_id !== null)).toBe(true);

    // And every group is in a storyline, provisional until a second joins it —
    // which is what makes the sample a candidate source rather than a dead end.
    const orphans = await harness.deps.db
      .selectFrom("articles")
      .leftJoin("storyline_groups", "storyline_groups.group_id", "articles.group_id")
      .select("articles.id")
      .where("storyline_groups.storyline_id", "is", null)
      .execute();
    expect(orphans).toEqual([]);
  }, 30_000);

  it("clears the cache it invalidated, so the next poll sees what the sample grew", async () => {
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);
    await holdSampleLock(harness);
    await seedStoryline(harness, "Kelowna Evacuations", [
      { title: "Evacuations Near Kelowna Ordered", domain: "a.com", ageHours: 8 },
      { title: "Smoke Covers Kelowna By Dawn", domain: "b.com", ageHours: 9 },
    ]);

    // A settled, non-empty cloud caches for the §10.4 ~15 minutes…
    await readTrending(deps, { language: "en", limit: 50 });
    expect((await readTrending(deps, { language: "en", limit: 50 })).meta.servedFrom).toBe(
      "cache",
    );

    // …and the sample's own tail drops it rather than letting a reader wait out
    // the TTL to see the storylines it just fed.
    await processSampleJob(deps, { kind: "sample", language: "en" });
    expect((await readTrending(deps, { language: "en", limit: 50 })).meta.servedFrom).toBe(
      "store",
    );
  }, 30_000);
});

describe("the window rolls (§10.1, ADR-0008)", () => {
  it("covers the last TREND_WINDOW_HOURS from now, and drops what has aged out", async () => {
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);

    // Two storylines, both breadth-gated by two outlets each. The fresh one
    // moved 8–9 hours ago, which at 05:00 UTC is YESTERDAY'S calendar day —
    // the case the frozen-day design got wrong and the reason the landing page
    // went thin every morning. The stale one last moved 30 hours ago: outside
    // the rolling window, and outside any reading of "today".
    await seedStoryline(harness, "Kelowna Evacuations", [
      { title: "Evacuations Near Kelowna Ordered", domain: "a.com", ageHours: 8 },
      { title: "Smoke Covers Kelowna By Dawn", domain: "b.com", ageHours: 9 },
    ]);
    await seedStoryline(harness, "Truro Verdict", [
      { title: "Verdict Delivered In The Truro Case", domain: "a.com", ageHours: 30 },
      { title: "Appeal Expected After The Truro Ruling", domain: "b.com", ageHours: 31 },
    ]);

    const cloud = await readTrending(deps, { language: "en", limit: 50 });
    expect(cloud.storylines.map((s) => s.label)).toEqual(["Kelowna Evacuations"]);

    // The response says which 24 hours it describes, and there is no `day`.
    const start = new Date(cloud.windowStart).getTime();
    const end = new Date(cloud.windowEnd).getTime();
    expect(end).toBe(NOW.getTime());
    expect(end - start).toBe(24 * 3_600_000);
  }, 30_000);

  it("rolls without a recompute: a storyline that gains an article moves at once", async () => {
    // Under the term cloud the aggregate was replaced by the sampler, so a
    // late-arriving article waited for the next sample to count. The cloud is a
    // query now (ADR-0013): the window's contents ARE the answer.
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);
    const kelowna = await seedStoryline(harness, "Kelowna Evacuations", [
      { title: "Evacuations Near Kelowna Ordered", domain: "a.com", ageHours: 20 },
      { title: "Smoke Covers Kelowna By Dawn", domain: "b.com", ageHours: 21 },
    ]);
    await seedStoryline(harness, "Truro Verdict", [
      { title: "Verdict Delivered In The Truro Case", domain: "a.com", ageHours: 3 },
      { title: "Appeal Expected After The Truro Ruling", domain: "b.com", ageHours: 4 },
    ]);

    const before = await readTrending(deps, { language: "en", limit: 50 });
    expect(before.storylines.map((s) => s.label)).toEqual([
      "Truro Verdict",
      "Kelowna Evacuations",
    ]);

    // One more article on the older arc, published minutes ago.
    const [fresh] = await storeArticles(harness, [
      { title: "Kelowna Evacuation Order Widened", domain: "c.com", ageHours: 0.2 },
    ]);
    await attachGroup(harness.deps.db, {
      storylineId: kelowna,
      groupId: fresh!,
      timeZone: "UTC",
    });

    // Cache cleared, no sample run, nothing recomputed: the order has changed.
    await harness.redis.del(`${harness.queue.name}:trending:en`);
    const after = await readTrending(deps, { language: "en", limit: 50 });
    expect(after.storylines.map((s) => s.label)).toEqual([
      "Kelowna Evacuations",
      "Truro Verdict",
    ]);
    expect(after.storylines[0]!.windowArticles).toBe(3);
  }, 30_000);
});
