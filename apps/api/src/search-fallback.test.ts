import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import {
  deriveAltKey,
  deriveDedupKey,
  emptyStats,
  NewsInvalidQueryError,
  NewsQuotaError,
  soleContributor,
  type CallOpts,
  type NewsClient,
  type QuotaView,
  type SearchParams,
  type SearchResult,
  type Sighting,
} from "@zammy/news-client";
import { readCoverage, recordCoverage, upsertTopic } from "@zammy/storage";
import type { CanonicalQuery } from "./canonical.js";
import { processSegmentJob } from "./coverage-fill.js";
import { PLANNED_COVERAGE_PROVIDER } from "./coverage-gaps.js";
import {
  ingestJobId,
  parseIngestJob,
  parseIngestJobId,
  pendingIdOf,
  type SearchFallbackJob,
} from "./ingest-queue.js";
import { INGEST_RETENTION_SECONDS } from "./ingest-queue-vercel.js";
import { reserveTopicCall } from "./topic-budget.js";
import {
  FALLBACK_PUBLISH_HOLD_SECONDS,
  processSearchFallbackJob,
  SEARCH_FALLBACK_MIN_SPAN_MS,
  SEARCH_FALLBACK_REACH_MS,
  searchFallbackJob,
} from "./search-fallback.js";
import { readTimeline } from "./timeline-read.js";
import { createTestHarness, type TestHarness } from "./test-support.js";

/**
 * THE SEARCH FALLBACK (ADR-0030): a reader's search Currents refused on quota,
 * asked again of Google News for its leading edge.
 *
 * Three things are under test, in the order a refused search meets them: that
 * both of the Currents fill's paths plan a fallback on a QUOTA refusal of a
 * SEARCH and on nothing else; that the plan is clipped to the reach and snapped
 * so polls collapse; and that the consumer claims coverage only for what it
 * walked to a clean end — never Currents', and never by a frontier.
 *
 * The fallback provider is a stub, for `storyline-deepening.test.ts`'s reason:
 * what the consumer reacts to is whether the answer was capped and what came
 * back, and a stub dictates both. It reproduces the two adapter properties the
 * consumer depends on — `isLastPage` is `rawCount < 100`, and sightings carry the
 * publisher's `sourceDomain`.
 */

/** On the 15-minute grid, so the reach's own edge lands on a grid line too. */
const NOW = new Date("2026-08-10T12:00:00.000Z");
const REACH = new Date(NOW.getTime() - SEARCH_FALLBACK_REACH_MS);
const FALLBACK_PROVIDER = "google-news";

let uuid = 0;

function sighting(input: { domain: string; title: string; published: string }): Sighting {
  uuid += 1;
  const url = `https://news.google.com/rss/articles/CBMi${uuid}`;
  return {
    id: `00000000-0000-4000-8000-${String(900_000 + uuid).padStart(12, "0")}`,
    url,
    provider: FALLBACK_PROVIDER,
    providerSightingId: url,
    dedupKey: deriveDedupKey(url),
    altKey: deriveAltKey(input.domain, input.title, input.published),
    title: input.title,
    description: null,
    author: null,
    imageUrl: null,
    language: "en",
    categories: [],
    sourceCategories: [],
    sourceDomain: input.domain,
    isAggregatorCopy: true,
    publishedIsDateOnly: false,
    published: input.published,
    raw: {},
  };
}

class StubFallbackClient implements NewsClient {
  readonly provider = FALLBACK_PROVIDER;
  readonly limits = {
    maxPageSize: 100,
    maxRetrievableResults: 100,
    maxLookbackDays: 730,
    maxRangeDays: 730,
  };
  readonly queries: SearchParams[] = [];
  readonly priorities: Array<CallOpts["priority"]> = [];
  next: Sighting[] = [];
  nextRawCount: number | null = null;
  /** Per-call raw counts, consumed in order before `nextRawCount` applies. */
  rawCounts: number[] = [];
  /** Thrown instead of answering, when set. */
  fail: Error | null = null;

  async search(params: SearchParams, opts: CallOpts = {}): Promise<SearchResult> {
    this.queries.push(params);
    this.priorities.push(opts.priority);
    if (this.fail) throw this.fail;
    const rawCount = this.rawCounts.shift() ?? this.nextRawCount ?? this.next.length;
    return {
      sightings: this.next,
      requestedAt: new Date(),
      rawCount,
      isLastPage: rawCount < 100,
      completeness: soleContributor(FALLBACK_PROVIDER, rawCount < 100),
      pageSize: 100,
      normalization: { ...emptyStats(), received: rawCount, kept: this.next.length },
      quota: null,
      adjustments: [],
    };
  }

  async quota(): Promise<QuotaView> {
    return {
      dailyRemaining: Number.POSITIVE_INFINITY,
      burstRemaining: Number.POSITIVE_INFINITY,
      resetAt: null,
      observed: null,
    };
  }

  async close(): Promise<void> {}
}

const iso = (spans: Array<{ from: Date; to: Date }>) =>
  spans.map((s) => `${s.from.toISOString()}/${s.to.toISOString()}`);

let harness: TestHarness;
let stub: StubFallbackClient;
let fingerprint: string;

beforeAll(async () => {
  harness = await createTestHarness({}, NOW);
});

afterAll(async () => {
  await harness.teardown();
});

beforeEach(async () => {
  await sql`
    truncate storylines, storyline_groups, storyline_days, storyline_bridges,
             storyline_coverage, articles, topic_articles, topic_coverage,
             topics, sightings cascade
  `.execute(harness.deps.db);
  vi.restoreAllMocks();
  stub = new StubFallbackClient();
  harness.deps.searchFallback = stub;
  // Fresh per test: the budget counters and locks are Redis-held and keyed by it.
  fingerprint = randomBytes(32).toString("hex");
});

/** The queue's segment publishes, observed without replacing the real queue. */
function watchEnqueues() {
  return vi.spyOn(harness.queue, "enqueueSegment");
}

function fallbackJobsIn(spy: ReturnType<typeof watchEnqueues>): SearchFallbackJob[] {
  return spy.mock.calls
    .map(([job]) => job)
    .filter((job): job is SearchFallbackJob => job.kind === "fallback");
}

describe("the plan: clipped to the reach, snapped to the grid", () => {
  it("keeps only the leading six days of a refused span, on grid lines", () => {
    const job = searchFallbackJob(
      fingerprint,
      { from: new Date("2026-07-20T00:00:00.000Z"), to: new Date("2026-08-10T12:07:30.000Z") },
      new Date("2026-08-10T12:07:30.000Z"),
    );
    // `to` down to the last grid line; the reach's edge UP to the next one, so
    // the clip can only tighten six days, never exceed it.
    expect(job).toEqual({
      kind: "fallback",
      fingerprint,
      from: "2026-08-04T12:15:00.000Z",
      to: "2026-08-10T12:00:00.000Z",
    });
  });

  it("keeps a refused span's own start when it is inside the reach", () => {
    const job = searchFallbackJob(
      fingerprint,
      { from: new Date("2026-08-08T03:21:00.000Z"), to: NOW },
      NOW,
    );
    expect(job?.from).toBe("2026-08-08T03:21:00.000Z");
  });

  it("owes nothing for a span wholly past the reach, or narrower than one grid step", () => {
    expect(
      searchFallbackJob(
        fingerprint,
        { from: new Date("2026-07-20T00:00:00.000Z"), to: new Date("2026-08-01T00:00:00.000Z") },
        NOW,
      ),
    ).toBeNull();
    expect(
      searchFallbackJob(
        fingerprint,
        // All of it after the last grid line: `to` snaps down past `from`.
        { from: new Date(NOW.getTime() + 60_000), to: new Date(NOW.getTime() + 5 * 60_000) },
        new Date(NOW.getTime() + 5 * 60_000),
      ),
    ).toBeNull();
  });

  it("gives polls inside one quarter-hour one address, and the next quarter-hour another", () => {
    const refused = { from: new Date("2026-08-01T00:00:00.000Z"), to: NOW };
    const at = (ms: number) => {
      const now = new Date(NOW.getTime() + ms);
      return ingestJobId(searchFallbackJob(fingerprint, { ...refused, to: now }, now)!);
    };
    expect(at(1_500)).toBe(at(14 * 60_000));
    expect(at(1_500)).not.toBe(at(15 * 60_000 + 1_500));
  });
});

describe("the job's address", () => {
  it("round-trips through its content address and its wire payload", () => {
    const job: SearchFallbackJob = {
      kind: "fallback",
      fingerprint,
      from: REACH.toISOString(),
      to: NOW.toISOString(),
    };
    expect(parseIngestJobId(ingestJobId(job), NOW)).toEqual(job);
    expect(parseIngestJob(JSON.parse(JSON.stringify(job)))).toEqual(job);
    // Counted under the topic the refused reader is polling.
    expect(pendingIdOf(job)).toBe(fingerprint);
  });

  it("cannot collide with a segment over the same span", () => {
    const fallback = ingestJobId({
      kind: "fallback",
      fingerprint,
      from: REACH.toISOString(),
      to: NOW.toISOString(),
    });
    const segment = ingestJobId({
      fingerprint,
      from: REACH.toISOString(),
      to: NOW.toISOString(),
      startPage: 1,
      plane: "search",
    });
    expect(fallback).not.toBe(segment);
  });
});

/** A reader's search over the last ten days, reaching the present. */
const recentQuery = (): CanonicalQuery => ({
  fingerprint,
  keywords: ["hurricane", "fausto"],
  language: "en",
  country: null,
  category: null,
  window: { from: new Date(NOW.getTime() - 10 * 86_400_000), to: NOW },
});

describe("trigger 1 — the read's own fill is refused on quota", () => {
  it("queues the fallback for the leading edge, and the reader is told it is coming", async () => {
    const enqueues = watchEnqueues();
    const search = harness.counting.search.bind(harness.counting);
    harness.counting.search = async () => {
      throw new NewsQuotaError("daily limit exhausted");
    };
    try {
      const result = await readTimeline(harness.deps, recentQuery(), { limit: 25 });

      expect(result.meta.degraded).toBe("quota");
      // Two 7-day gaps were planned; only the newer one reaches inside the reach.
      expect(fallbackJobsIn(enqueues)).toEqual([
        { kind: "fallback", fingerprint, from: REACH.toISOString(), to: NOW.toISOString() },
      ]);
      // Nothing else is queued — a degraded read still enqueues no Currents IOUs.
      expect(enqueues.mock.calls.length).toBe(1);
      // Counted under the reader's own topic, so their poll waits for it.
      expect(result.meta.ingest).toEqual({ state: "in_progress", pendingJobs: 1 });
    } finally {
      harness.counting.search = search;
    }
  });

  it("publishes one address once per dedup window, however often the reader polls", async () => {
    const enqueues = watchEnqueues();
    const search = harness.counting.search.bind(harness.counting);
    harness.counting.search = async () => {
      throw new NewsQuotaError("daily limit exhausted");
    };
    try {
      await readTimeline(harness.deps, recentQuery(), { limit: 25 });
      // A poll a moment later re-plans the same refused gap. Publishing again
      // would be swallowed by the queue's dedup yet re-add a ledger entry
      // nothing will ever settle.
      await readTimeline(harness.deps, recentQuery(), { limit: 25 });
      expect(fallbackJobsIn(enqueues)).toHaveLength(1);
    } finally {
      harness.counting.search = search;
    }
  });

  it("plans nothing once Google News has covered the span, so the reader reads complete", async () => {
    // The fallback landed: its own coverage now spans the reach.
    await upsertTopic(harness.deps.db, { fingerprint, keywords: ["fausto", "hurricane"], language: "en" });
    await recordCoverage(harness.deps.db, fingerprint, FALLBACK_PROVIDER, {
      from: new Date(REACH.getTime() - 3_600_000),
      to: NOW,
    });
    const enqueues = watchEnqueues();
    const search = harness.counting.search.bind(harness.counting);
    harness.counting.search = async () => {
      throw new NewsQuotaError("daily limit exhausted");
    };
    try {
      const result = await readTimeline(harness.deps, recentQuery(), { limit: 25 });
      expect(result.meta.degraded).toBe("quota");
      expect(enqueues).not.toHaveBeenCalled();
      expect(result.meta.ingest).toEqual({ state: "complete", pendingJobs: 0 });
    } finally {
      harness.counting.search = search;
    }
  });

  it("falls back for a gap the read truncated before a later gap was refused", async () => {
    const enqueues = watchEnqueues();
    const search = harness.counting.search.bind(harness.counting);
    const calls = harness.deps.config.maxSyncUpstreamCalls;
    // Room for the newer gap's five pages AND a call on the older one.
    harness.deps.config.maxSyncUpstreamCalls = 10;
    harness.counting.search = async (params: SearchParams, opts?: CallOpts) => {
      // The older gap is refused; the newer one answers full pages to the cap.
      if (params.endDate && params.endDate.getTime() < NOW.getTime()) {
        throw new NewsQuotaError("daily limit exhausted");
      }
      const result = await search(params, opts);
      return {
        ...result,
        isLastPage: false,
        completeness: soleContributor(PLANNED_COVERAGE_PROVIDER, false),
      };
    };
    try {
      const result = await readTimeline(harness.deps, recentQuery(), { limit: 25 });
      expect(result.meta.degraded).toBe("quota");
      // The truncated newer gap is owed too, and it is the one inside the reach.
      expect(fallbackJobsIn(enqueues)).toEqual([
        { kind: "fallback", fingerprint, from: REACH.toISOString(), to: NOW.toISOString() },
      ]);
    } finally {
      harness.counting.search = search;
      harness.deps.config.maxSyncUpstreamCalls = calls;
    }
  });

  it("still plans a span Google News covered only in part", async () => {
    await upsertTopic(harness.deps.db, { fingerprint, keywords: ["fausto", "hurricane"], language: "en" });
    await recordCoverage(harness.deps.db, fingerprint, FALLBACK_PROVIDER, {
      from: new Date(NOW.getTime() - 86_400_000),
      to: NOW,
    });
    const enqueues = watchEnqueues();
    const search = harness.counting.search.bind(harness.counting);
    harness.counting.search = async () => {
      throw new NewsQuotaError("daily limit exhausted");
    };
    try {
      await readTimeline(harness.deps, recentQuery(), { limit: 25 });
      // The consumer subtracts the covered day; the planner must not skip the rest.
      expect(fallbackJobsIn(enqueues)).toHaveLength(1);
    } finally {
      harness.counting.search = search;
    }
  });

  it("holds an address exactly as long as the queue dedups it", () => {
    expect(FALLBACK_PUBLISH_HOLD_SECONDS).toBe(INGEST_RETENTION_SECONDS);
  });

  it("queues nothing when the fallback is off — the read is exactly what it was", async () => {
    delete harness.deps.searchFallback;
    const enqueues = watchEnqueues();
    const search = harness.counting.search.bind(harness.counting);
    harness.counting.search = async () => {
      throw new NewsQuotaError("daily limit exhausted");
    };
    try {
      const result = await readTimeline(harness.deps, recentQuery(), { limit: 25 });
      expect(result.meta.degraded).toBe("quota");
      expect(enqueues).not.toHaveBeenCalled();
      expect(result.meta.ingest).toEqual({ state: "complete", pendingJobs: 0 });
    } finally {
      harness.counting.search = search;
    }
  });

  it("does not fall back on a failure that is not quota", async () => {
    const enqueues = watchEnqueues();
    const search = harness.counting.search.bind(harness.counting);
    harness.counting.search = async () => {
      throw new Error("upstream 503");
    };
    try {
      const result = await readTimeline(harness.deps, recentQuery(), { limit: 25 });
      expect(result.meta.degraded).toBe("upstream");
      expect(fallbackJobsIn(enqueues)).toEqual([]);
    } finally {
      harness.counting.search = search;
    }
  });
});

describe("trigger 2 — a deferred segment is refused below the interactive reserve", () => {
  const job = (plane: "search" | "deepening") => ({
    fingerprint,
    from: "2026-08-03T00:00:00.000Z",
    to: NOW.toISOString(),
    startPage: 1,
    plane,
  });

  async function refuseBackground<T>(run: () => Promise<T>): Promise<T> {
    const search = harness.counting.search.bind(harness.counting);
    harness.counting.search = async (params: SearchParams, opts?: CallOpts) => {
      if (opts?.priority === "background") throw new NewsQuotaError("below the reserve");
      return search(params, opts);
    };
    try {
      return await run();
    } finally {
      harness.counting.search = search;
    }
  }

  it("queues the fallback for the refused slice and everything older, then rethrows", async () => {
    await upsertTopic(harness.deps.db, { fingerprint, keywords: ["hurricane", "fausto"], language: "en" });
    const enqueues = watchEnqueues();

    await refuseBackground(async () => {
      // Rethrown: the Currents job's own redelivery is untouched.
      await expect(processSegmentJob(harness.deps, job("search"))).rejects.toBeInstanceOf(
        NewsQuotaError,
      );
    });

    expect(fallbackJobsIn(enqueues)).toEqual([
      { kind: "fallback", fingerprint, from: REACH.toISOString(), to: NOW.toISOString() },
    ]);
  });

  it("does not fall back for a storyline refresh's deepening-plane top-up", async () => {
    await upsertTopic(harness.deps.db, { fingerprint, keywords: ["hurricane", "fausto"], language: "en" });
    const enqueues = watchEnqueues();

    await refuseBackground(async () => {
      await expect(processSegmentJob(harness.deps, job("deepening"))).rejects.toBeInstanceOf(
        NewsQuotaError,
      );
    });

    expect(fallbackJobsIn(enqueues)).toEqual([]);
  });
});

describe("the consumer — what it asks, what it keeps, what it may claim", () => {
  const span = { from: new Date("2026-08-08T00:00:00.000Z"), to: new Date("2026-08-10T00:00:00.000Z") };
  const job = (over: Partial<{ from: Date; to: Date }> = {}): SearchFallbackJob => ({
    kind: "fallback",
    fingerprint,
    from: (over.from ?? span.from).toISOString(),
    to: (over.to ?? span.to).toISOString(),
  });
  const seedTopic = () =>
    upsertTopic(harness.deps.db, { fingerprint, keywords: ["fausto", "hurricane"], language: "en" });

  it("asks the topic's own words as a background call, folds them in as a SEARCH, and claims only its own coverage", async () => {
    await seedTopic();
    stub.next = [
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: "2026-08-09T09:00:00.000Z" }),
      sighting({ domain: "b.example", title: "Fausto strengthens off Hawaii", published: "2026-08-09T10:00:00.000Z" }),
    ];

    await processSearchFallbackJob(harness.deps, job());

    expect(stub.queries).toHaveLength(1);
    expect(stub.queries[0]).toMatchObject({
      keywords: ["fausto", "hurricane"],
      language: "en",
      startDate: span.from,
      endDate: span.to,
      pageNumber: 1,
    });
    expect(stub.priorities).toEqual(["background"]);

    const planes = await harness.deps.db
      .selectFrom("sightings")
      .select(["plane", "provider"])
      .distinct()
      .execute();
    expect(planes).toEqual([{ plane: "search", provider: FALLBACK_PROVIDER }]);

    expect(iso(await readCoverage(harness.deps.db, fingerprint, FALLBACK_PROVIDER))).toEqual(
      iso([span]),
    );
    // The Currents gap is still Currents' to fill.
    expect(await readCoverage(harness.deps.db, fingerprint, PLANNED_COVERAGE_PROVIDER)).toEqual([]);
  });

  it("halves a capped span rather than claiming any of it — Google News is not newest-first", async () => {
    await seedTopic();
    const enqueues = watchEnqueues();
    stub.next = [
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: "2026-08-09T09:00:00.000Z" }),
    ];
    stub.nextRawCount = 100;
    // The whole reach: wide enough that its halves are still different
    // questions on the wire.
    const wide = { from: REACH, to: NOW };

    await processSearchFallbackJob(harness.deps, job(wide));

    expect(await readCoverage(harness.deps.db, fingerprint, FALLBACK_PROVIDER)).toEqual([]);
    const mid = new Date((REACH.getTime() + NOW.getTime()) / 2);
    expect(fallbackJobsIn(enqueues)).toEqual([
      job({ from: REACH, to: mid }),
      job({ from: mid, to: NOW }),
    ]);
  });

  it("stops halving at three days — below that Google News cannot be asked a different question", async () => {
    await seedTopic();
    const enqueues = watchEnqueues();
    stub.nextRawCount = 100;
    // Three days: its halves would reach the wire as a window within a day of
    // their parent's, since the bounds are dates padded a day outward.
    const narrowest = { from: new Date(NOW.getTime() - SEARCH_FALLBACK_MIN_SPAN_MS), to: NOW };

    await processSearchFallbackJob(harness.deps, job(narrowest));

    expect(iso(await readCoverage(harness.deps.db, fingerprint, FALLBACK_PROVIDER))).toEqual(
      iso([narrowest]),
    );
    expect(fallbackJobsIn(enqueues)).toEqual([]);
  });

  it("accepts a capped two-day span unsplit — the floor is three days, not an hour", async () => {
    // Pins the floor's SIZE, which a case written against the constant cannot:
    // any floor under two days would halve this span, and at three it is
    // accepted as asked.
    await seedTopic();
    const enqueues = watchEnqueues();
    stub.nextRawCount = 100;
    const twoDays = { from: new Date(NOW.getTime() - 2 * 86_400_000), to: NOW };

    await processSearchFallbackJob(harness.deps, job(twoDays));

    expect(fallbackJobsIn(enqueues)).toEqual([]);
    expect(iso(await readCoverage(harness.deps.db, fingerprint, FALLBACK_PROVIDER))).toEqual(
      iso([twoDays]),
    );
  });

  it("claims each gap it walked to a clean end, and neither the capped one nor what lay between", async () => {
    await seedTopic();
    const enqueues = watchEnqueues();
    // Covered near the reach's far edge already, so the job's span holds two
    // gaps: a wide newer one, and a narrow older one.
    const early = {
      from: new Date(REACH.getTime() + 6 * 3_600_000),
      to: new Date(REACH.getTime() + 12 * 3_600_000),
    };
    await recordCoverage(harness.deps.db, fingerprint, FALLBACK_PROVIDER, early);
    // Newest-first: the wide gap comes back capped, the narrow one short.
    stub.rawCounts = [100, 3];

    await processSearchFallbackJob(harness.deps, job({ from: REACH, to: NOW }));

    expect(
      stub.queries.map((q) => `${q.startDate?.toISOString()}/${q.endDate?.toISOString()}`),
    ).toEqual(
      iso([
        { from: early.to, to: NOW },
        { from: REACH, to: early.from },
      ]),
    );
    // The short gap joins the covered block; the capped one is claimed by no one
    // and is halved instead.
    expect(iso(await readCoverage(harness.deps.db, fingerprint, FALLBACK_PROVIDER))).toEqual(
      iso([{ from: REACH, to: early.to }]),
    );
    expect(fallbackJobsIn(enqueues)).toHaveLength(2);
  });

  it("asks nothing of a span this provider already walked", async () => {
    await seedTopic();
    await recordCoverage(harness.deps.db, fingerprint, FALLBACK_PROVIDER, span);

    await processSearchFallbackJob(harness.deps, job());

    expect(stub.queries).toEqual([]);
  });

  it("is not satisfied by CURRENTS coverage of the span", async () => {
    await seedTopic();
    await recordCoverage(harness.deps.db, fingerprint, PLANNED_COVERAGE_PROVIDER, span);

    await processSearchFallbackJob(harness.deps, job());

    expect(stub.queries).toHaveLength(1);
  });

  it("re-clips a job that sat past its reach, against the clock at delivery", async () => {
    await seedTopic();
    const early = { from: new Date(NOW.getTime() - 5 * 86_400_000), to: NOW };
    harness.clock.advance(2 * 86_400_000);
    try {
      await processSearchFallbackJob(harness.deps, job(early));
      const deliveredReach = new Date(NOW.getTime() + 2 * 86_400_000 - SEARCH_FALLBACK_REACH_MS);
      expect(stub.queries[0]?.startDate).toEqual(deliveredReach);
    } finally {
      harness.clock.advance(-2 * 86_400_000);
    }
  });

  it("drops a job wholly past its reach by delivery without spending", async () => {
    await seedTopic();
    harness.clock.advance(10 * 86_400_000);
    try {
      await processSearchFallbackJob(harness.deps, job());
      expect(stub.queries).toEqual([]);
    } finally {
      harness.clock.advance(-10 * 86_400_000);
    }
  });

  it("stops at the plane's daily share without calling", async () => {
    await seedTopic();
    const cap = harness.deps.config.searchFallbackDailyCallCap;
    // A share already spent by someone else today: the counter is shared.
    harness.deps.config.searchFallbackDailyCallCap = 0;
    try {
      await processSearchFallbackJob(harness.deps, job());
      expect(stub.queries).toEqual([]);
      expect(await readCoverage(harness.deps.db, fingerprint, FALLBACK_PROVIDER)).toEqual([]);
    } finally {
      harness.deps.config.searchFallbackDailyCallCap = cap;
    }
  });

  it("counts against the topic's daily cap on its OWN counter, never the Currents one", async () => {
    await seedTopic();
    const cap = harness.deps.config.perTopicDailyCallCap;
    harness.deps.config.perTopicDailyCallCap = 0;
    try {
      await processSearchFallbackJob(harness.deps, job());
      expect(stub.queries).toEqual([]);
    } finally {
      harness.deps.config.perTopicDailyCallCap = cap;
    }

    // A call it does make leaves the Currents counter where it was: one call
    // allowed there still answers yes.
    await processSearchFallbackJob(harness.deps, job({ from: REACH, to: span.from }));
    expect(stub.queries).toHaveLength(1);
    expect(await reserveTopicCall(harness.redis, fingerprint, 1, NOW)).toBe(true);
  });

  it("drops a query the provider refuses locally, and a refusal on its own quota", async () => {
    await seedTopic();
    stub.fail = new NewsInvalidQueryError("category cannot be expressed");
    await expect(processSearchFallbackJob(harness.deps, job())).resolves.toBeUndefined();

    // A spent day does not recover inside the redelivery budget, so no retry.
    stub.fail = new NewsQuotaError("google news day spent");
    await expect(processSearchFallbackJob(harness.deps, job())).resolves.toBeUndefined();
    expect(await readCoverage(harness.deps.db, fingerprint, FALLBACK_PROVIDER)).toEqual([]);

    // Anything else is the queue's to retry.
    stub.fail = new Error("socket hang up");
    await expect(processSearchFallbackJob(harness.deps, job())).rejects.toThrow("socket hang up");
  });

  it("drops a job delivered after the flag went off, or for a topic nobody holds", async () => {
    await processSearchFallbackJob(harness.deps, job());
    expect(stub.queries).toEqual([]);

    await seedTopic();
    delete harness.deps.searchFallback;
    await expect(processSearchFallbackJob(harness.deps, job())).resolves.toBeUndefined();
    expect(stub.queries).toEqual([]);
  });
});

