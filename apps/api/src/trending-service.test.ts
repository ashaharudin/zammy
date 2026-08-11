import { afterEach, describe, expect, it, vi } from "vitest";
import { processSegmentJob } from "./timeline-service.js";
import {
  processSampleJob,
  readTrending,
  type TrendingDeps,
} from "./trending-service.js";
import { createTestHarness, type TestHarness } from "./test-support.js";

/**
 * The landing-page cloud (ARCHITECTURE 10.1): the first visitor of the day
 * triggers the breadth sample and is served the stored cloud instantly; the
 * sample runs behind them through the same queue machinery as §6.5; a closed
 * day is frozen and free.
 */

/** Inside the recorded sample's span: 76 of its 80 articles are 2026-08-05. */
const NOW = new Date("2026-08-05T20:00:00.000Z");
const DAY = "2026-08-05";

let harness: TestHarness;

afterEach(async () => {
  await harness.teardown();
});

function trendingDeps(h: TestHarness): TrendingDeps {
  return {
    ...h.deps,
    trending: {
      appTimezone: "UTC",
      sampleCategories: ["technology", "politics"],
      samplePagesPerCategory: 2,
      baselineWindowDays: 7,
    },
  };
}

/** Day-keyed Redis state outlives ephemeral test databases; clear it. */
async function purgeTrendingKeys(h: TestHarness, day: string, language: string) {
  await h.redis.del(
    `lock:daily-sample:${day}:${language}`,
    `trending:${day}:${language}`,
    `ingest:pending:sample_${day}_${language}`,
  );
}

describe("first visitor of the day (§10.1)", () => {
  it("queues ONE sample, serves instantly, and fills the cloud behind the reader", async () => {
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

    // Visitor two hits the taken lock and the deduped jobId: still one sample.
    const second = await readTrending(deps, { language: "en", limit: 50 });
    expect(second.meta.ingest.pendingJobs).toBe(1);

    // Drain: the consumer routes sample jobs to the trending processor.
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
      expect(term.uniqueArticles).toBeGreaterThanOrEqual(1);
    }

    // The sample drew as background — 1-2 pages per category, never more.
    expect(harness.counting.searchCalls).toBeGreaterThanOrEqual(2);
    expect(harness.counting.searchCalls).toBeLessThanOrEqual(4);
    expect(harness.counting.priorities.every((p) => p === "background")).toBe(true);

    // A settled cloud caches for the §10.4 ~15 minutes.
    const again = await readTrending(deps, { language: "en", limit: 50 });
    expect(again.meta.servedFrom).toBe("cache");
  }, 30_000);
});

describe("closed days are frozen (§10.1)", () => {
  it("requesting yesterday triggers no sample and spends nothing", async () => {
    harness = await createTestHarness({}, NOW);
    await purgeTrendingKeys(harness, "2026-08-04", "en");
    const deps = trendingDeps(harness);

    const closed = await readTrending(deps, { day: "2026-08-04", language: "en", limit: 50 });

    expect(harness.counting.searchCalls).toBe(0);
    expect(closed.terms).toEqual([]);
    expect(closed.meta.ingest).toEqual({ state: "complete", pendingJobs: 0 });
    expect(await harness.redis.exists("lock:daily-sample:2026-08-04:en")).toBe(0);
  });
});
