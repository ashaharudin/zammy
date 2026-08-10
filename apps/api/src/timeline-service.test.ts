import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CurrentsQuotaError,
  type CallOpts,
  type SearchParams,
  type SearchResult,
} from "@zammy/currents-client";
import { readCoverage } from "@zammy/storage";
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
    expect(new Set(result.items.map((i) => i.url)).size).toBe(result.items.length);

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
  it("subdivides the segment and reports in_progress, hasMore stays honest", async () => {
    harness = await createTestHarness({}, NOW);

    const result = await readTimeline(harness.deps, broadQuery(), { limit: 100 });

    // 180 recorded sightings > the 100-result cap: five full pages, then the
    // segment splits in half and both halves go to the queue (§6.3 step 4).
    expect(harness.counting.searchCalls).toBe(5);
    expect(result.meta.ingest.state).toBe("in_progress");
    expect(result.meta.ingest.pendingJobs).toBe(2);

    // §12 race: everything STORED fits the page (hasMore false) while more is
    // still ARRIVING (in_progress). Conflating these tells the user "that's
    // everything" mid-ingest — the two flags must be independently true.
    expect(result.page.hasMore).toBe(false);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("the queue consumer drains the subdivision to full coverage", async () => {
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

    const result = await readTimeline(harness.deps, broadQuery(), { limit: 100 });
    expect(result.meta.ingest.state).toBe("complete");
    // The subdivision reached past the cap: more unique articles than one
    // truncated query could ever return (~42 of the first 100 slots).
    expect(result.items.length).toBeGreaterThan(42);
  }, 30_000);
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

    const firstIds = new Set(first.items.map((i) => i.id));
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.items.every((i) => !firstIds.has(i.id))).toBe(true);
  });
});
