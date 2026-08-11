import { afterEach, describe, expect, it, vi } from "vitest";
import { processSegmentJob } from "./timeline-service.js";
import {
  processSampleJob,
  readTrending,
  type TrendingDeps,
} from "./trending-service.js";
import { createTestHarness, type TestHarness } from "./test-support.js";

/**
 * The landing-page cloud (ARCHITECTURE 10.1, post-6c): the first visitor
 * after the last /v2/latest-news snapshot staled triggers ONE background
 * sample call and is served the stored cloud instantly; a closed day is
 * frozen and free.
 */

/** All 100 recorded /v2/latest-news sightings are published 2026-08-11. */
const NOW = new Date("2026-08-11T05:00:00.000Z");
const DAY = "2026-08-11";

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
      appTimezone: "UTC",
      sampleCategories: CATEGORIES,
      samplePages: 1,
      sampleRefreshMinutes: 60,
      baselineWindowDays: 7,
      ...overrides,
    },
  };
}

/** Sample-keyed Redis state outlives ephemeral test databases; clear it. */
async function purgeTrendingKeys(h: TestHarness, day: string, language: string) {
  await h.redis.del(`lock:sample:${day}:${language}`, `trending:${day}:${language}`);
}

describe("the first visitor after the snapshot staled (§10.1)", () => {
  it("queues ONE single-call sample, serves instantly, fills the cloud behind the reader", async () => {
    harness = await createTestHarness({}, NOW);
    await purgeTrendingKeys(harness, DAY, "en");
    const deps = trendingDeps(harness);

    // The first visitor pays nothing synchronously — the whole §9 posture.
    const first = await readTrending(deps, { language: "en", limit: 50 });
    expect(harness.counting.searchCalls).toBe(0);
    expect(first.day).toBe(DAY);
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
        expect(await harness.queue.pendingCount(`sample_${DAY}_en`)).toBe(0),
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

  it("re-elects a sample once the freshness window passes — cost scales with the clock, not readers", async () => {
    harness = await createTestHarness({}, NOW);
    await purgeTrendingKeys(harness, DAY, "en");
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
        expect(await harness.queue.pendingCount(`sample_${DAY}_en`)).toBe(0),
      { timeout: 20_000, interval: 100 },
    );
    expect(harness.counting.searchCalls).toBe(1);

    // Inside the window a read re-elects nothing (cache cleared to prove it
    // is the LOCK holding, not the response cache).
    await harness.redis.del(`trending:${DAY}:en`);
    await new Promise((r) => setTimeout(r, 80)); // let the 60ms lock expire

    const later = await readTrending(deps, { language: "en", limit: 50 });
    expect(later.meta.ingest.state).toBe("in_progress"); // next snapshot warming
    await vi.waitFor(
      async () =>
        expect(await harness.queue.pendingCount(`sample_${DAY}_en`)).toBe(0),
      { timeout: 20_000, interval: 100 },
    );
    expect(harness.counting.searchCalls).toBe(2);
  }, 30_000);
});

describe("closed days are frozen (§10.1)", () => {
  it("requesting yesterday triggers no sample and spends nothing", async () => {
    harness = await createTestHarness({}, NOW);
    await purgeTrendingKeys(harness, "2026-08-10", "en");
    const deps = trendingDeps(harness);

    const closed = await readTrending(deps, { day: "2026-08-10", language: "en", limit: 50 });

    expect(harness.counting.searchCalls).toBe(0);
    expect(closed.terms).toEqual([]);
    expect(closed.meta.ingest).toEqual({ state: "complete", pendingJobs: 0 });
    expect(await harness.redis.exists("lock:sample:2026-08-10:en")).toBe(0);
  });
});
