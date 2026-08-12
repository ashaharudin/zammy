import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processSegmentJob } from "./timeline-service.js";
import {
  processSampleJob,
  readTrending,
  type TrendingDeps,
} from "./trending-service.js";
import { deriveDedupKey } from "@zammy/currents-client";
import { ingestSightings, upsertTopic } from "@zammy/storage";
import { fingerprintOf } from "./canonical.js";
import { createTestHarness, type TestHarness } from "./test-support.js";

/**
 * The landing-page cloud (ARCHITECTURE 10.1, post-6c): the first visitor
 * after the last /v2/latest-news snapshot staled triggers ONE background
 * sample call and is served the stored cloud instantly. The window rolls with
 * `now` rather than resetting at midnight (ADR-0008), so nothing here is keyed
 * by day and there is no frozen period to ask about.
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
      halfLifeHours: 8,
      baselineWindowDays: 7,
      ...overrides,
    },
  };
}

/**
 * Store articles at chosen ages — the corpus source the sample does not
 * supply (§10.1 source 1), and the only way to put a story at a known
 * distance from `now`.
 */
async function storeArticles(
  h: TestHarness,
  articles: Array<{
    title: string;
    /** Prose the propriety gate reads: the NAME capitalized mid-sentence,
     * everything generic lowercase, or nothing survives §10.3. */
    prose: string;
    domain: string;
    ageHours: number;
  }>,
) {
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
  await ingestSightings(h.deps.db, {
    fingerprint,
    sightings: articles.map((a, index) => ({
      id: randomUUID(),
      url: `https://${a.domain}/seeded-${index}`,
      dedupKey: deriveDedupKey(`https://${a.domain}/seeded-${index}`),
      title: a.title,
      description: a.prose,
      author: null,
      imageUrl: null,
      language: "en",
      categories: [],
      sourceCategories: [],
      sourceDomain: a.domain,
      published: new Date(NOW.getTime() - a.ageHours * 3_600_000).toISOString(),
      raw: {},
    })),
  });
}

describe("the first visitor after the snapshot staled (§10.1)", () => {
  it("queues ONE single-call sample, serves instantly, fills the cloud behind the reader", async () => {
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);

    // The first visitor pays nothing synchronously — the whole §9 posture.
    const first = await readTrending(deps, { language: "en", limit: 50 });
    expect(harness.counting.searchCalls).toBe(0);
    expect(first.windowEnd).toBe(NOW.toISOString());
    expect(first.terms).toEqual([]);
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
      async () =>
        expect(await harness.queue.pendingCount("sample_en")).toBe(0),
      { timeout: 20_000, interval: 250 },
    );

    const done = await readTrending(deps, { language: "en", limit: 50 });
    expect(done.meta.ingest.state).toBe("complete");
    expect(done.terms.length).toBeGreaterThan(0);
    for (const term of done.terms) {
      expect(term.sourceCount).toBeGreaterThanOrEqual(2); // §10.3 gate holds end-to-end
    }

    // ONE /v2/latest-news call — not twelve category slices — as background.
    expect(harness.counting.searchCalls).toBe(1);
    expect(harness.counting.priorities).toEqual(["background"]);

    // A settled cloud caches for the §10.4 ~15 minutes.
    const again = await readTrending(deps, { language: "en", limit: 50 });
    expect(again.meta.servedFrom).toBe("cache");
  }, 30_000);

  it("caches per language, not per limit — a narrow read cannot shrink the cloud", async () => {
    // Reproduced live: `curl '/api/v1/trending?limit=4'` cached a four-term
    // body, and the landing page — which asks for 50 — rendered a four-word
    // cloud for the next fifteen minutes. The cache key names a language, so
    // what it holds has to be the whole ranked list, not one caller's slice.
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);
    harness.queue.startConsumer((job) =>
      job.kind === "sample"
        ? processSampleJob(deps, job)
        : processSegmentJob(harness.deps, job),
    );

    await readTrending(deps, { language: "en", limit: 50 });
    await vi.waitFor(
      async () => expect(await harness.queue.pendingCount("sample_en")).toBe(0),
      { timeout: 20_000, interval: 250 },
    );

    // A caller asking for one term still gets exactly one…
    const narrow = await readTrending(deps, { language: "en", limit: 1 });
    expect(narrow.terms).toHaveLength(1);

    // …and the next reader gets the cloud, from that same cache entry.
    const wide = await readTrending(deps, { language: "en", limit: 50 });
    expect(wide.meta.servedFrom).toBe("cache");
    expect(wide.terms.length).toBeGreaterThan(1);
    // Still a prefix of one ranked list, so the two agree about what is first.
    expect(wide.terms[0]!.term).toBe(narrow.terms[0]!.term);
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
      async () =>
        expect(await harness.queue.pendingCount("sample_en")).toBe(0),
      { timeout: 20_000, interval: 100 },
    );
    expect(harness.counting.searchCalls).toBe(1);

    // Inside the window a read re-elects nothing (cache cleared to prove it
    // is the LOCK holding, not the response cache).
    await harness.redis.del(`${harness.queue.name}:trending:en`);
    await new Promise((r) => setTimeout(r, 80)); // let the 60ms lock expire

    const later = await readTrending(deps, { language: "en", limit: 50 });
    expect(later.meta.ingest.state).toBe("in_progress"); // next snapshot warming
    await vi.waitFor(
      async () =>
        expect(await harness.queue.pendingCount("sample_en")).toBe(0),
      { timeout: 20_000, interval: 100 },
    );
    expect(harness.counting.searchCalls).toBe(2);
  }, 30_000);
});

describe("the sample is a write path, so it groups what it creates (§14.3)", () => {
  it("tokenizes every article it ingests, making it groupable and a candidate", async () => {
    // The sampler shipped for one release ingesting straight into `articles`
    // with no grouping pass. An article stored without tokens can never join
    // a group AND is invisible as a candidate to everything ingested after
    // it — and this is the most syndication-dense source we have, one
    // latest-news page spanning every category and outlet.
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
  }, 30_000);
});

describe("the window rolls (§10.1, ADR-0008)", () => {
  it("covers the last TREND_WINDOW_HOURS from now, and drops what has aged out", async () => {
    harness = await createTestHarness({}, NOW);
    const deps = trendingDeps(harness);

    // Two stories, both stored, both breadth-gated by two outlets each. The
    // fresh one broke 8-9 hours ago, which at 05:00 UTC is YESTERDAY'S
    // calendar day — the case the frozen-day design got wrong and the reason
    // the landing page went thin every morning. The stale one is 30 hours old:
    // outside the rolling window, and outside any reading of "today".
    await storeArticles(harness, [
      {
        title: "Evacuations Near Kelowna Ordered",
        prose: "Officials in Kelowna ordered the evacuation.",
        domain: "a.com",
        ageHours: 8,
      },
      {
        title: "Smoke Covers Kelowna By Dawn",
        prose: "Crews worked through the night in Kelowna.",
        domain: "b.com",
        ageHours: 9,
      },
      {
        title: "Verdict Delivered In The Truro Case",
        prose: "The hearing in Truro ended without comment.",
        domain: "a.com",
        ageHours: 30,
      },
      {
        title: "Appeal Expected After The Truro Ruling",
        prose: "Lawyers left Truro on the same afternoon.",
        domain: "b.com",
        ageHours: 31,
      },
    ]);

    await processSampleJob(deps, { kind: "sample", language: "en" });
    const cloud = await readTrending(deps, { language: "en", limit: 50 });
    const emitted = new Set(cloud.terms.map((t) => t.term));

    expect(emitted.has("kelowna")).toBe(true);
    expect(emitted.has("truro")).toBe(false);

    // The response says which 24 hours it describes, and there is no `day`.
    const start = new Date(cloud.windowStart).getTime();
    const end = new Date(cloud.windowEnd).getTime();
    expect(end).toBe(NOW.getTime());
    expect(end - start).toBe(24 * 3_600_000);
  }, 30_000);
});
