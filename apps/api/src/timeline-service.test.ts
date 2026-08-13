import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CurrentsQuotaError,
  type CallOpts,
  type SearchParams,
  type SearchResult,
} from "@zammy/currents-client";
import { readCoverage, recordCoverage, upsertTopic } from "@zammy/storage";
import type { CanonicalQuery } from "./canonical.js";
import { subtractCoverage } from "./coverage-gaps.js";
import { refreshLockKey, tryAcquire } from "./single-flight.js";
import { processSegmentJob, readTimeline } from "./timeline-service.js";
import { createTestHarness, type TestHarness } from "./test-support.js";

/**
 * The query planner (ARCHITECTURE 6.3): how a page gets filled. Offline
 * throughout — the fixture client replays the recorded payloads, including the
 * 100-result truncation the subdivision logic exists for. The two §12 race
 * tests live here: a reader must never block on the ingest lock, and
 * `hasMore` / `ingest.state` must answer their different questions.
 */

const NOW = new Date("2026-08-10T12:00:00.000Z");

/** Whole fixture span, pre-snapped to the 15-minute grid. */
const WINDOW = {
  from: new Date("2026-08-01T00:00:00.000Z"),
  to: new Date("2026-08-06T00:00:00.000Z"),
};

// Fresh fingerprints per test: Redis (page cache, locks, pending sets) is
// shared and persistent, so a fixed fingerprint would let one test — or a
// previous run — poison the next through leftover keys.
let climateFingerprint: string;
let broadFingerprint: string;

beforeEach(() => {
  climateFingerprint = randomBytes(32).toString("hex");
  broadFingerprint = randomBytes(32).toString("hex");
});

const climateQuery = (): CanonicalQuery => ({
  fingerprint: climateFingerprint,
  keywords: ["climate"],
  language: "en",
  country: null,
  category: null,
  window: { ...WINDOW },
});

/** Keywordless: matches all 180 recorded sightings, so it MUST truncate (§6.3). */
const broadQuery = (): CanonicalQuery => ({
  fingerprint: broadFingerprint,
  keywords: [],
  language: "en",
  country: null,
  category: null,
  window: { ...WINDOW },
});

let harness: TestHarness;

afterEach(async () => {
  await harness.teardown();
});

describe("cold search — the synchronous fill", () => {
  it("fetches, collapses, records coverage, and serves from Postgres", async () => {
    harness = await createTestHarness({}, NOW);

    const result = await readTimeline(harness.deps, climateQuery(), { limit: 25 });

    // 16 recorded sightings match "climate"; one short page completes the
    // gap. The response must come from OUR store, deduplicated — never from
    // the raw upstream page (§6.3 step 6).
    expect(harness.counting.searchCalls).toBe(1);
    expect(result.meta.servedFrom).toBe("upstream");
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThanOrEqual(16);
    // One slot per story, each headlining a distinct URL (§14.3).
    expect(new Set(result.items.map((i) => i.article.url)).size).toBe(result.items.length);

    // Everything arrived synchronously, so the topic is complete and quiet.
    expect(result.meta.ingest).toEqual({ state: "complete", pendingJobs: 0 });
    expect(result.meta.degraded).toBeNull();
    expect(result.page.hasMore).toBe(false);

    // Coverage now spans the whole clamped window: the next reader must not
    // re-ask (§7.2).
    const covered = await readCoverage(harness.deps.db, climateQuery().fingerprint);
    const gaps = subtractCoverage(WINDOW, covered, { now: NOW, lookbackDays: 30 });
    expect(gaps).toEqual([]);
  });

  it("User B pays nothing: identical request → zero upstream calls", async () => {
    harness = await createTestHarness({}, NOW);

    await readTimeline(harness.deps, climateQuery(), { limit: 25 });
    const calls = harness.counting.searchCalls;

    const cached = await readTimeline(harness.deps, climateQuery(), { limit: 25 });
    expect(harness.counting.searchCalls).toBe(calls);
    expect(cached.meta.servedFrom).toBe("cache");

    // A different limit misses the page cache but hits recorded coverage:
    // still zero calls, served straight from the store (§6.3 step 2).
    const stored = await readTimeline(harness.deps, climateQuery(), { limit: 10 });
    expect(harness.counting.searchCalls).toBe(calls);
    expect(stored.meta.servedFrom).toBe("store");
  });
});

describe("truncation — a full final page means hidden history, not success", () => {
  it("records the fetched frontier as covered and enqueues ONLY the remainder", async () => {
    harness = await createTestHarness({}, NOW);

    const result = await readTimeline(harness.deps, broadQuery(), { limit: 100 });

    // 180 recorded sightings > the 100-result cap: five full pages fetched.
    // Those five calls are not thrown away — coverage advances to the oldest
    // sighting seen, and one remainder job carries the rest (§6.3 step 4).
    expect(harness.counting.searchCalls).toBe(5);
    expect(result.meta.ingest.state).toBe("in_progress");
    expect(result.meta.ingest.pendingJobs).toBe(1);

    const covered = await readCoverage(harness.deps.db, broadQuery().fingerprint);
    expect(covered.length).toBe(1);
    expect(covered[0]!.to.getTime()).toBeGreaterThanOrEqual(WINDOW.to.getTime());
    expect(covered[0]!.from.getTime()).toBeGreaterThan(WINDOW.from.getTime());

    // §12 race: everything STORED fits the page (hasMore false) while more is
    // still ARRIVING (in_progress). Conflating these tells the user "that's
    // everything" mid-ingest — the two flags must be independently true.
    expect(result.page.hasMore).toBe(false);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("the consumer walks the frontier to full coverage without refetching", async () => {
    harness = await createTestHarness({}, NOW);

    await readTimeline(harness.deps, broadQuery(), { limit: 100 });
    harness.queue.startConsumer((job) => processSegmentJob(harness.deps, job));

    await vi.waitFor(
      async () =>
        expect(await harness.queue.pendingCount(broadQuery().fingerprint)).toBe(0),
      { timeout: 20_000, interval: 250 },
    );

    const covered = await readCoverage(harness.deps.db, broadQuery().fingerprint);
    const gaps = subtractCoverage(WINDOW, covered, { now: NOW, lookbackDays: 30 });
    expect(gaps).toEqual([]);

    // The efficiency claim: 180 sightings at 20/page is 9 productive calls
    // plus an end-of-results page. Halving-and-refetching burned ~15 on the
    // same fixture — every call must advance the frontier, none may re-buy.
    expect(harness.counting.searchCalls).toBeLessThanOrEqual(11);

    const result = await readTimeline(harness.deps, broadQuery(), { limit: 100 });
    expect(result.meta.ingest.state).toBe("complete");
    // The frontier reached past the cap: more unique articles than one
    // truncated query could ever return (~42 of the first 100 slots).
    expect(result.items.length).toBeGreaterThan(42);
  }, 30_000);

  it("falls back to halving when the frontier cannot advance (timestamp pileup)", async () => {
    harness = await createTestHarness({}, NOW);

    // 100 sightings sharing ONE published instant: the oldest-seen frontier
    // equals the segment end, so recording it would cover zero width and the
    // remainder would loop forever. Only subdivision can make progress here.
    const search = harness.counting.search.bind(harness.counting);
    harness.counting.search = async (params: SearchParams, opts?: CallOpts) => {
      const result = await search(
        { ...params, keywords: ["climate"] },
        opts,
      );
      return {
        ...result,
        rawCount: 20,
        isLastPage: false,
        sightings: result.sightings.slice(0, 1).map((s, i) => ({
          ...s,
          id: `00000000-0000-4000-8000-${String(harness.counting.searchCalls).padStart(4, "0")}${String(i).padStart(8, "0")}`,
          url: `https://pileup.example/${harness.counting.searchCalls}-${i}`,
          published: WINDOW.to.toISOString(),
        })),
      };
    };

    const result = await readTimeline(harness.deps, broadQuery(), { limit: 100 });

    // Degenerate frontier → the §6.3 halving fallback, both halves queued.
    expect(result.meta.ingest.pendingJobs).toBe(2);

    harness.counting.search = search;
  });
});

describe("the deadline is wall-clock, not a call count", () => {
  it("defers the rest of the plan when calls are slow", async () => {
    harness = await createTestHarness({ syncFillDeadlineMs: 500 }, NOW);
    harness.counting.delayMs = 300;

    const result = await readTimeline(harness.deps, broadQuery(), { limit: 25 });

    // 300ms/call against a 500ms deadline: call 1 at t≈0, call 2 at t≈300,
    // call 3 would start past the deadline → deferred with a resume page.
    expect(harness.counting.searchCalls).toBe(2);
    expect(result.meta.ingest.state).toBe("in_progress");
    expect(result.meta.ingest.pendingJobs).toBe(1);
    expect(result.items.length).toBeGreaterThan(0); // paint what we have (§6.5)
  });

  it("always affords the floor of one call, however tight the deadline", async () => {
    harness = await createTestHarness({ syncFillDeadlineMs: 1 }, NOW);
    harness.counting.delayMs = 50;

    const result = await readTimeline(harness.deps, climateQuery(), { limit: 25 });

    // The first synchronous call is the only content a cold topic can have
    // (§11); a deadline that forbids it would make every cold search empty.
    expect(harness.counting.searchCalls).toBe(1);
    expect(result.items.length).toBeGreaterThan(0);
  });
});

describe("§12 race: a reader never blocks on someone else's ingest lock", () => {
  it("serves the store immediately and reports in_progress", async () => {
    harness = await createTestHarness({}, NOW);
    const query = climateQuery();

    // Simulate User A mid-fill: hold the newest-gap lock externally.
    const [gap] = subtractCoverage(query.window, [], { now: NOW, lookbackDays: 30 });
    const token = await tryAcquire(
      harness.redis,
      refreshLockKey(query.fingerprint, gap!),
      10_000,
    );
    expect(token).not.toBeNull();

    const started = Date.now();
    const result = await readTimeline(harness.deps, query, { limit: 25 });
    const elapsed = Date.now() - started;

    // No upstream call (the election was lost), no waiting (the lock
    // deduplicates calls, not readers — §6.5 point 2), and the truth told.
    expect(harness.counting.searchCalls).toBe(0);
    expect(elapsed).toBeLessThan(500);
    expect(result.meta.servedFrom).toBe("store");
    expect(result.meta.ingest.state).toBe("in_progress");
    expect(result.items).toEqual([]);
  });
});

describe("quota exhaustion is a designed-for state, not an incident", () => {
  it("serves what the store has and flags meta.degraded", async () => {
    harness = await createTestHarness({}, NOW);
    harness.counting.delayMs = 0;

    // Warm the topic honestly first, then cut the quota.
    await readTimeline(harness.deps, climateQuery(), { limit: 25 });
    const search = harness.counting.search.bind(harness.counting);
    harness.counting.search = async (_p: SearchParams, _o?: CallOpts): Promise<SearchResult> => {
      throw new CurrentsQuotaError("daily limit exhausted");
    };

    // A wider window forces a new gap, whose fill now hits the quota wall.
    const wider = {
      ...climateQuery(),
      window: { from: new Date("2026-07-20T00:00:00.000Z"), to: WINDOW.to },
    };
    const result = await readTimeline(harness.deps, wider, { limit: 25 });

    expect(result.meta.degraded).toBe("quota");
    expect(result.items.length).toBeGreaterThan(0); // never a hard error with local data (§11)
    expect(result.meta.servedFrom).toBe("store");

    harness.counting.search = search;
  });
});

describe("refresh-on-read (§6.4) — freshness is repaired by the next reader", () => {
  /** A window that reaches the present: NOW sits on the 15-minute grid. */
  const liveWindow = () => ({ from: new Date(WINDOW.from), to: new Date(NOW) });

  it("serves a covered window with a sliver inside the tier as fresh: zero calls, nothing enqueued", async () => {
    harness = await createTestHarness({}, NOW);
    const query = { ...climateQuery(), window: liveWindow() };

    // Covered until 30s ago — inside the 60s tier for a window ending now.
    await upsertTopic(harness.deps.db, {
      fingerprint: query.fingerprint,
      keywords: query.keywords,
      language: query.language,
      country: null,
      category: null,
    });
    await recordCoverage(harness.deps.db, query.fingerprint, {
      from: WINDOW.from,
      to: new Date(NOW.getTime() - 30_000),
    });

    const result = await readTimeline(harness.deps, query, { limit: 25 });

    expect(harness.counting.searchCalls).toBe(0);
    expect(result.meta.stale).toBe(false);
    expect(result.meta.servedFrom).toBe("store");
    expect(result.meta.ingest).toEqual({ state: "complete", pendingJobs: 0 });
  });

  it("serves a stale trailing sliver instantly, flags stale, and enqueues one background top-up", async () => {
    harness = await createTestHarness({}, NOW);

    // Warm the topic honestly: coverage ends 2026-08-06, 4.5 days before NOW.
    await readTimeline(harness.deps, climateQuery(), { limit: 25 });
    expect(harness.counting.searchCalls).toBe(1);

    const live = { ...climateQuery(), window: liveWindow() };
    const result = await readTimeline(harness.deps, live, { limit: 25 });

    // The reader gets the stored timeline instantly — the sliver is repaired
    // BEHIND them, never in front of them (§6.4).
    expect(harness.counting.searchCalls).toBe(1);
    expect(result.meta.stale).toBe(true);
    expect(result.meta.servedFrom).toBe("store");
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.meta.ingest.state).toBe("in_progress");
    expect(result.meta.ingest.pendingJobs).toBe(1);

    // The top-up closes the gap; the reader after them sees the fresher result.
    harness.queue.startConsumer((job) => processSegmentJob(harness.deps, job));
    await vi.waitFor(
      async () =>
        expect(await harness.queue.pendingCount(live.fingerprint)).toBe(0),
      { timeout: 20_000, interval: 250 },
    );

    const repaired = await readTimeline(harness.deps, live, { limit: 25 });
    expect(repaired.meta.stale).toBe(false);
    expect(repaired.meta.ingest.state).toBe("complete");
    const covered = await readCoverage(harness.deps.db, live.fingerprint);
    expect(covered.at(-1)?.to.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
  }, 30_000);

  it("a stale response is never cached, even when the top-up lands mid-read", async () => {
    harness = await createTestHarness({}, NOW);
    await readTimeline(harness.deps, climateQuery(), { limit: 25 });

    // The consumer is in-process and a fixture top-up takes milliseconds, so
    // it can finish BEFORE the reader counts pending jobs. That makes the
    // stale read look settled (state "complete") — but caching it would
    // freeze stale:true and hide the repaired timeline for the whole TTL.
    const racingDeps = {
      ...harness.deps,
      queue: {
        enqueueSegment: async () => {},
        pendingCount: async () => 0,
      } as unknown as typeof harness.deps.queue,
    };
    const live = { ...climateQuery(), window: liveWindow() };
    const first = await readTimeline(racingDeps, live, { limit: 25 });
    expect(first.meta.stale).toBe(true);
    expect(first.meta.ingest.state).toBe("complete");

    const second = await readTimeline(racingDeps, live, { limit: 25 });
    expect(second.meta.servedFrom).not.toBe("cache");
  });

  it("polling readers do not multiply top-ups: dedup by the sliver's leading edge", async () => {
    harness = await createTestHarness({}, NOW);
    await readTimeline(harness.deps, climateQuery(), { limit: 25 });

    const live = { ...climateQuery(), window: liveWindow() };
    await readTimeline(harness.deps, live, { limit: 25 });

    // A poll 5s later re-canonicalizes: same sliver start, later window end.
    // Without leading-edge dedup every 1.5s poll would mint a fresh job.
    const laterNow = new Date(NOW.getTime() + 5_000);
    const laterDeps = { ...harness.deps, now: () => laterNow };
    const poll = await readTimeline(
      laterDeps,
      { ...live, window: { from: live.window.from, to: new Date(NOW.getTime() + 15 * 60_000) } },
      { limit: 25 },
    );

    expect(poll.meta.stale).toBe(true);
    expect(poll.meta.ingest.pendingJobs).toBe(1);
    expect(harness.counting.searchCalls).toBe(1); // warm-up only; never a sync spend
  });
});

describe("call priority (§9.4) — queued work draws as background", () => {
  it("sync fills are interactive; segment jobs run under the interactive reserve", async () => {
    harness = await createTestHarness({}, NOW);

    await readTimeline(harness.deps, climateQuery(), { limit: 25 });
    expect(harness.counting.priorities).toEqual(["interactive"]);

    // The same fill machinery, driven by the queue consumer instead of a
    // waiting reader, must identify itself as background — that flag is the
    // entire mechanism by which the reserve protects live searches.
    await processSegmentJob(harness.deps, {
      fingerprint: climateFingerprint,
      from: WINDOW.to.toISOString(),
      to: NOW.toISOString(),
      startPage: 1,
      kind: "topup",
    });
    expect(harness.counting.priorities.slice(1)).toEqual(["background"]);
  });
});

describe("per-topic daily cap (§9.4) — one curious user cannot drain the pool", () => {
  it("stops the sync fill at the cap and enqueues nothing more for the day", async () => {
    harness = await createTestHarness({ perTopicDailyCallCap: 3 }, NOW);

    // The broad query needs 5 calls before it even truncates; the cap must
    // bind first. The topic stops deepening — no error, no queued IOUs that
    // would burn tomorrow's budget on today's enthusiasm.
    const result = await readTimeline(harness.deps, broadQuery(), { limit: 100 });

    expect(harness.counting.searchCalls).toBe(3);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.meta.ingest).toEqual({ state: "complete", pendingJobs: 0 });

    // ...and resumes tomorrow: the counter is keyed by UTC day.
    const tomorrow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const nextDay = { ...harness.deps, now: () => tomorrow };
    await readTimeline(nextDay, broadQuery(), { limit: 100 });
    expect(harness.counting.searchCalls).toBeGreaterThan(3);
  });

  it("a queued job against an exhausted topic completes without spending or covering", async () => {
    harness = await createTestHarness({ perTopicDailyCallCap: 1 }, NOW);
    await readTimeline(harness.deps, climateQuery(), { limit: 25 }); // spends the 1
    expect(harness.counting.searchCalls).toBe(1);

    await processSegmentJob(harness.deps, {
      fingerprint: climateFingerprint,
      from: WINDOW.to.toISOString(),
      to: NOW.toISOString(),
      startPage: 1,
      kind: "topup",
    });

    // No call, no error (an error would just churn BullMQ retries against the
    // same wall), and no coverage claim — the gap stays visibly unfetched so
    // tomorrow's reader repairs it (§7.2).
    expect(harness.counting.searchCalls).toBe(1);
    const covered = await readCoverage(harness.deps.db, climateFingerprint);
    expect(covered.at(-1)?.to.getTime()).toBeLessThanOrEqual(WINDOW.to.getTime());
  });
});

describe("metrics (§12) — the numbers that make the design observable", () => {
  const value = async (
    name: string,
    labels: Record<string, string> = {},
  ): Promise<number> => {
    const metrics = (await harness.metrics.registry.getMetricsAsJSON()) as Array<{
      name: string;
      values: Array<{ value: number; labels: Record<string, string>; metricName?: string }>;
    }>;
    for (const metric of metrics) {
      const match = metric.values?.find(
        (v) =>
          (v.metricName ?? metric.name) === name &&
          Object.entries(labels).every(([k, val]) => v.labels[k] === val),
      );
      if (match) return match.value;
    }
    return Number.NaN;
  };

  it("counts cache tiers, upstream spend, truncation, and reads by source", async () => {
    harness = await createTestHarness({}, NOW);

    await readTimeline(harness.deps, climateQuery(), { limit: 25 }); // miss → upstream
    await readTimeline(harness.deps, climateQuery(), { limit: 25 }); // hit
    await readTimeline(harness.deps, broadQuery(), { limit: 100 }); // miss → truncates

    // Cache hit ratio BY TIER: both windows end >24h before NOW → historical.
    expect(await value("zammy_page_cache_reads_total", { tier: "historical", result: "miss" })).toBe(2);
    expect(await value("zammy_page_cache_reads_total", { tier: "historical", result: "hit" })).toBe(1);

    // The key efficiency number: upstream calls per user request (§12).
    expect(await value("zammy_upstream_calls_total")).toBe(6); // 1 climate + 5 broad

    // unique-articles-per-upstream-call = created / calls; a fall means
    // upstream duplication is worsening (baseline ~8 of 20).
    expect(await value("zammy_articles_created_total")).toBeGreaterThan(0);
    expect(await value("zammy_sightings_received_total")).toBeGreaterThanOrEqual(100);

    // A rising truncation rate means timelines are silently thinning (§11).
    expect(await value("zammy_truncated_segments_total")).toBe(1);

    // p95 by servedFrom needs reads labeled by source.
    expect(await value("zammy_timeline_read_seconds_count", { served_from: "upstream" })).toBe(2);
    expect(await value("zammy_timeline_read_seconds_count", { served_from: "cache" })).toBe(1);
  });
});

describe("the 7-day per-call range ceiling (observed live 2026-08-11)", () => {
  const DAY = 86_400_000;

  it("slices a wide cold search into fetchable segments — no call over the ceiling, no 400", async () => {
    harness = await createTestHarness({}, NOW);
    // ~26 days: upstream's probe-era single-call answer no longer exists.
    const wide = {
      ...climateQuery(),
      window: { from: new Date("2026-07-11T12:00:00.000Z"), to: WINDOW.to },
    };

    const result = await readTimeline(harness.deps, wide, { limit: 25 });

    expect(result.meta.degraded).toBeNull();
    expect(result.items.length).toBeGreaterThan(0);
    expect(harness.counting.ranges.length).toBeGreaterThanOrEqual(4); // ceil(26/7)
    for (const range of harness.counting.ranges) {
      expect(range).toBeLessThanOrEqual(7 * DAY);
    }

    // Empty slices record coverage too (§11: "we asked" ≠ "nothing there"),
    // so the whole clamped window ends up covered.
    const covered = await readCoverage(harness.deps.db, wide.fingerprint);
    const gaps = subtractCoverage(wide.window, covered, { now: NOW, lookbackDays: 30 });
    expect(gaps).toEqual([]);
  });

  it("a wide legacy job is sliced by the consumer — deploys must not strand queued work", async () => {
    harness = await createTestHarness({}, NOW);
    await upsertTopic(harness.deps.db, {
      fingerprint: climateFingerprint,
      keywords: ["climate"],
      language: "en",
      country: null,
      category: null,
    });

    // A 16-day segment, as a job enqueued before the ceiling existed.
    await processSegmentJob(harness.deps, {
      fingerprint: climateFingerprint,
      from: "2026-07-25T00:00:00.000Z",
      to: NOW.toISOString(),
      startPage: 1,
    });

    for (const range of harness.counting.ranges) {
      expect(range).toBeLessThanOrEqual(7 * DAY);
    }
    const covered = await readCoverage(harness.deps.db, climateFingerprint);
    expect(covered[0]?.from.toISOString()).toBe("2026-07-25T00:00:00.000Z");
    expect(covered.at(-1)?.to.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
  });

  it("a topic idle past the ceiling takes the sync fill, not a stale top-up", async () => {
    harness = await createTestHarness({}, NOW);
    const live = { ...climateQuery(), window: { from: new Date("2026-07-20T00:00:00.000Z"), to: NOW } };
    await upsertTopic(harness.deps.db, {
      fingerprint: live.fingerprint,
      keywords: live.keywords,
      language: live.language,
      country: null,
      category: null,
    });
    await recordCoverage(harness.deps.db, live.fingerprint, {
      from: new Date("2026-07-20T00:00:00.000Z"),
      to: new Date("2026-07-25T00:00:00.000Z"),
    });

    const result = await readTimeline(harness.deps, live, { limit: 25 });

    // 16 missing days is missing HISTORY, not staleness: the reader gets the
    // newest slice synchronously instead of a stale flag over week-old data.
    expect(result.meta.stale).toBe(false);
    expect(harness.counting.searchCalls).toBeGreaterThanOrEqual(1);
    for (const range of harness.counting.ranges) {
      expect(range).toBeLessThanOrEqual(7 * DAY);
    }
  });
});

describe("cursor plumbing through the service", () => {
  it("pages with an opaque cursor and never repeats an article", async () => {
    harness = await createTestHarness({}, NOW);
    await readTimeline(harness.deps, climateQuery(), { limit: 100 });

    const first = await readTimeline(harness.deps, climateQuery(), { limit: 3 });
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).toBeTypeOf("string");

    const second = await readTimeline(harness.deps, climateQuery(), {
      limit: 3,
      cursorString: first.page.nextCursor!,
    });

    const firstIds = new Set(first.items.map((i) => i.storylineId));
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.items.every((i) => !firstIds.has(i.storylineId))).toBe(true);
  });
});
