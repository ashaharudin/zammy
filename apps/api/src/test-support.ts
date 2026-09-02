import { randomUUID } from "node:crypto";
import pg from "pg";
import { Redis } from "ioredis";
import {
  FixtureCurrentsClient,
  FixtureStore,
  type CallOpts,
  type CurrentsClient,
  type LatestNewsParams,
  type SearchParams,
  type SearchResult,
} from "@zammy/currents-client";
import { createDb, migrateToLatest } from "@zammy/storage";
import { BullMqIngestQueue } from "./ingest-queue-bullmq.js";
import type { IngestQueue } from "./ingest-queue.js";
import { Metrics } from "./metrics.js";
import { storylineBar } from "./storyline-bar.js";
import type { CoverageFillDeps } from "./coverage-fill.js";
import type { StorylineDeepeningDeps } from "./storyline-deepening.js";
import type { StorylineRefreshDeps } from "./storyline-refresh.js";
import type { TimelineSearchDeps } from "./timeline-read.js";

/**
 * Integration harness for the query service: a real ephemeral Postgres, the
 * real compose Redis, the fixture-backed client, and a uniquely-named queue.
 * Everything the planner orchestrates is real except the upstream — and the
 * fixture client replays real captured payloads, so even that is honest
 * (ARCHITECTURE 4.1, 12).
 */

const PG_ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://zammy:zammy@localhost:5432/zammy";
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
const FIXTURES_DIR = new URL("../../../fixtures/", import.meta.url).pathname;

/**
 * Everything the four planner modules take, as one object — the shape a server
 * process builds and therefore the honest thing to hand an integration test.
 *
 * Written as the INTERSECTION rather than as a list of its own, so a module that
 * grows a dependency cannot be satisfied here by accident: adding a field to one
 * of the four is what makes the harness owe it. `deepening` is mutable and
 * optional because `storyline-deepening.test.ts` installs its stub on a built
 * harness and one case deletes it again.
 */
export type HarnessDeps = TimelineSearchDeps &
  CoverageFillDeps &
  StorylineRefreshDeps &
  StorylineDeepeningDeps & {
    /**
     * The client and the queue at the width the harness actually holds them,
     * widening the narrow views the four modules declare.
     *
     * Deliberate, and the same move `buildServices` makes with `satisfies`: a
     * test spreads `harness.deps` into a `TrendingDeps` (which wants
     * `latestNews` and `enqueueSample`) or a route options bag (which wants
     * `availableLanguages`), and a spread of the intersection alone would have
     * lost both. The modules' own narrowing is unaffected — it is enforced at
     * their signatures, which is where it belongs.
     */
    currents: CountingClient;
    queue: IngestQueue;
  };

export interface TestHarness {
  deps: HarnessDeps;
  counting: CountingClient;
  redis: Redis;
  queue: IngestQueue;
  metrics: Metrics;
  /** The clock behind `deps.now()`. Advance it to age the world on purpose. */
  clock: TestClock;
  teardown: () => Promise<void>;
}

/**
 * The one clock the harness runs on, and the reason the sync-fill deadline
 * reads `deps.now()` rather than `Date.now()`: time passes here only when a
 * test says so, so "how many upstream calls fit the deadline" is a property of
 * the plan and not of how loaded the machine was. Anchored to a fixed instant
 * when one is given, otherwise to the real clock — a test that never advances
 * it sees exactly the behaviour it saw before this existed.
 */
export interface TestClock {
  now: () => Date;
  advance: (ms: number) => void;
}

export function createTestClock(fixed?: Date): TestClock {
  let offsetMs = 0;
  return {
    now: () => new Date((fixed ? fixed.getTime() : Date.now()) + offsetMs),
    advance: (ms: number) => {
      offsetMs += ms;
    },
  };
}

/** The client's real limits, which the PLANNER reads whether or not it fetches. */
const FIXTURE_LIMITS = {
  maxPageSize: 20,
  maxRetrievableResults: 100,
  maxLookbackDays: 30,
  maxRangeDays: 7,
} as const;

/**
 * A migrated ephemeral database, and the drop that ends it.
 *
 * Shared by both harnesses because it is the one expensive thing they agree
 * about, and because the DROP is the half that is easy to get subtly wrong —
 * `WITH (FORCE)` is what stops a lingering backend turning teardown into the
 * 57P01 race.
 */
async function createEphemeralDb(): Promise<{
  db: ReturnType<typeof createDb>;
  drop: () => Promise<void>;
}> {
  const dbName = `zammy_api_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: PG_ADMIN_URL, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }

  const dbUrl = new URL(PG_ADMIN_URL);
  dbUrl.pathname = `/${dbName}`;
  const db = createDb(dbUrl.toString());
  await migrateToLatest(db);

  return {
    db,
    drop: async () => {
      const cleanup = new pg.Pool({ connectionString: PG_ADMIN_URL, max: 1 });
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/**
 * Grouping and storylines ON, as they ship (§14.3, ADR-0011) — a planner test
 * that passes only with the feature disabled has not tested the planner.
 *
 * The linker's bar is `storylineBar()`, which is the bar production runs and no
 * longer a second copy of it. This function used to re-declare all fourteen
 * fields, so it was free to drift from `createLinkerConfig` without a test going
 * red — and a harness test asserting formation behaviour against a drifted bar
 * is the failure `wiring.ts`'s header is about, arriving through the test suite
 * instead of through a sweep.
 *
 * A function rather than a constant so no test can mutate the next test's
 * config through a shared nested object.
 */
function shippedGroupingConfig(): HarnessDeps["config"]["grouping"] {
  return {
    enabled: true,
    threshold: 0.5,
    timeZone: "UTC",
    linker: storylineBar(),
  };
}

export async function createTestHarness(
  configOverrides: Partial<HarnessDeps["config"]> = {},
  now?: Date,
): Promise<TestHarness> {
  const { db, drop } = await createEphemeralDb();

  const store = new FixtureStore(FIXTURES_DIR);
  await store.load();
  const clock = createTestClock(now);
  const fixtureClient = new FixtureCurrentsClient(
    store,
    FIXTURE_LIMITS,
    { dailyLimit: 1000, burstLimit: 60 },
    // **The harness clock reaches the client too, not just `deps.now()`.**
    //
    // The client clamps to `maxLookbackDays` before it touches the store, so a
    // client left on the wall clock silently narrows every window the fixtures
    // are dated over as those dates age — while the planner above it, reading
    // the pinned clock, plans and records the FULL span. The two disagree, and
    // the disagreement is invisible: the fetch just returns less. On 2026-09-01
    // it turned the truncation cases into completions, because a corpus of 180
    // came back as 98 and the fifth page was short.
    //
    // A test that pins `now` is asking for one world at one instant, and this
    // is the other half of granting that. Passing the same clock is also what
    // makes the fixture path match live, where `HttpCurrentsClient` has always
    // clamped against `this.transport.now()`.
    { now: () => clock.now().getTime() },
  );
  const counting = new CountingClient(fixtureClient, clock);

  const redis = new Redis(REDIS_URL);
  const queue = new BullMqIngestQueue(REDIS_URL, {
    queueName: `test-planner-${randomUUID()}`,
  });

  const metrics = new Metrics({ quota: () => counting.quota() });
  const deps: HarnessDeps = {
    db,
    redis,
    currents: counting,
    queue,
    metrics,
    config: {
      syncFillDeadlineMs: 1200,
      maxSyncUpstreamCalls: 5,
      lookbackDays: 30,
      minSegmentMs: 60 * 60 * 1000,
      // Non-binding by default: the recorded fixture is denser than a real
      // topic, and only the §9.4 tests are ABOUT the cap.
      perTopicDailyCallCap: 10_000,
      grouping: shippedGroupingConfig(),
      ...configOverrides,
    },
    now: () => clock.now(),
  };

  return {
    deps,
    counting,
    redis,
    queue,
    metrics,
    clock,
    teardown: async () => {
      await queue.obliterate();
      await queue.close();
      await redis.quit();
      await db.destroy();
      await drop();
    },
  };
}

/**
 * The READ-path harness: a real database, the real Redis, and an upstream and a
 * queue that REFUSE.
 *
 * Reading a timeline may fetch — §6.3 says so, and `readTimeline`'s deps say so
 * — but the read path's own behaviour is what happens over a window whose
 * coverage is already recorded: which slot leads, which member heads it, how a
 * cursor pages, what a storyline view returns. Those tests used to be handed the
 * full planner harness, which meant loading the fixture corpus off disk and
 * standing up a BullMQ queue for every one of them.
 *
 * Neither is built here, and the refusals are the point rather than a saving. A
 * read test that accidentally leaves a gap in its window no longer replays a
 * fixture and quietly asserts about a page that upstream half-wrote; it throws.
 * "This read fetched nothing" stops being a claim and becomes the harness.
 *
 * `readStorylineView` needs none of it and takes `StorylineViewDeps` — three
 * fields — which is the other half of what the split bought.
 */
export interface ReadTestHarness {
  /**
   * `TimelineSearchDeps` and not `HarnessDeps`: the narrow pair the read path
   * declares is exactly what a refusing client and a refusing queue can
   * satisfy, and it is the type-level statement that this harness cannot drive
   * the refresh planner or the deepening plane.
   */
  deps: TimelineSearchDeps;
  redis: Redis;
  clock: TestClock;
  teardown: () => Promise<void>;
}

export async function createReadHarness(
  configOverrides: Partial<CoverageFillDeps["config"]> = {},
  now?: Date,
): Promise<ReadTestHarness> {
  const { db, drop } = await createEphemeralDb();
  const clock = createTestClock(now);
  const redis = new Redis(REDIS_URL);

  const deps: TimelineSearchDeps = {
    db,
    redis,
    currents: new RefusingCurrentsClient(),
    queue: refusingQueue(),
    config: {
      // Present because the type wants them and unreachable because nothing
      // here fetches. A read test that makes one of these matter has stopped
      // being a read test.
      syncFillDeadlineMs: 1200,
      maxSyncUpstreamCalls: 5,
      lookbackDays: 30,
      minSegmentMs: 60 * 60 * 1000,
      perTopicDailyCallCap: 10_000,
      grouping: shippedGroupingConfig(),
      ...configOverrides,
    },
    now: () => clock.now(),
  };

  return {
    deps,
    redis,
    clock,
    teardown: async () => {
      await redis.quit();
      await db.destroy();
      await drop();
    },
  };
}

/**
 * The two queue members the read path declares: one that throws, one that
 * answers honestly.
 *
 * `readTimeline` always asks for `pendingCount`, because
 * `meta.ingest.pendingJobs` is part of every response, and a harness with no
 * queue behind it has nothing outstanding by construction.
 */
function refusingQueue(): Pick<IngestQueue, "enqueueSegment" | "pendingCount"> {
  return {
    enqueueSegment: (): never => {
      throw new Error(
        "read harness: the read path enqueued a segment; seed coverage, or use createTestHarness",
      );
    },
    pendingCount: async () => 0,
  };
}

/**
 * The upstream client a read-path test holds: one that cannot answer.
 *
 * `limits` are real, because the PLANNER reads them with or without a fetch —
 * gap slicing is done against `maxRangeDays` (§2's 7-day ceiling) before
 * anything decides whether to call. Everything else throws.
 */
class RefusingCurrentsClient {
  readonly provider = "refusing";
  readonly limits = FIXTURE_LIMITS;

  search(): never {
    throw new Error(
      "read harness: the read path reached upstream; seed coverage, or use createTestHarness",
    );
  }
  latestNews(): never {
    throw new Error("read harness: the read path reached upstream");
  }
  quota(): never {
    throw new Error("read harness: no quota to report");
  }
  async close(): Promise<void> {}
}

/**
 * Drop every Redis key a topic can leave behind. Canonical fingerprints are
 * deterministic BY DESIGN (§6.2), so a test that searches real keywords
 * collides with its own previous runs through the shared Redis unless it
 * cleans up first.
 */
export async function purgeTopicKeys(redis: Redis, fingerprint: string): Promise<void> {
  // Pending-job registries are queue-scoped and test queues are uniquely
  // named, so they never collide across runs and need no purging here.
  const patterns = [
    // Both key generations: pre-shape-version keys put the fingerprint first,
    // versioned ones (§7.1, ADR-0009) put it after `v<shape>`.
    `page:${fingerprint}:*`,
    `page:v*:${fingerprint}:*`,
    `lock:refresh:${fingerprint}:*`,
    "ref:languages",
    "ref:regions",
    // Nothing writes `ref:categories` any more (ADR-0020), and it is purged
    // anyway: the reference suite still SETS it, to prove a cache an older
    // build left three keys in still counts as a hit, and a shared dev Redis
    // can be holding one from a pre-G8 run. Purging a key no production path
    // writes is what keeps that test honest about which state it set up.
    "ref:categories",
  ];
  for (const pattern of patterns) {
    const keys = pattern.includes("*") ? await redis.keys(pattern) : [pattern];
    if (keys.length > 0) await redis.del(...keys);
  }
}

/**
 * Pass-through client that counts (and can slow down) upstream calls. Wraps at
 * the client seam — the same boundary the second provider went in behind
 * (ARCHITECTURE 5.6) — so the planner under test cannot tell the difference.
 */
export class CountingClient implements CurrentsClient {
  readonly provider = "counting";
  searchCalls = 0;
  /** Quota priority of each search call, in order (§9.4). */
  priorities: Array<CallOpts["priority"]> = [];
  /** Date span of each search call, ms — the per-call range ceiling's witness. */
  ranges: number[] = [];
  /** Start date of each search call — the lookback horizon's witness. */
  starts: Date[] = [];
  /**
   * Artificial per-call latency, for exercising the wall-clock deadline. It is
   * charged to the harness clock rather than slept through: the fill's deadline
   * reads that clock, so a test buys a precise number of calls instead of
   * betting that real ones land before a real deadline.
   */
  delayMs = 0;

  constructor(
    private readonly inner: CurrentsClient,
    private readonly clock: TestClock,
  ) {}

  get limits() {
    return this.inner.limits;
  }

  async search(params: SearchParams, opts?: CallOpts): Promise<SearchResult> {
    this.searchCalls += 1;
    this.priorities.push(opts?.priority);
    if (params.startDate) this.starts.push(params.startDate);
    if (params.startDate && params.endDate) {
      this.ranges.push(params.endDate.getTime() - params.startDate.getTime());
    }
    if (this.delayMs > 0) this.clock.advance(this.delayMs);
    return this.inner.search(params, opts);
  }

  /** Counted with search: both spend the same upstream quota. */
  async latestNews(params?: LatestNewsParams, opts?: CallOpts): Promise<SearchResult> {
    this.searchCalls += 1;
    this.priorities.push(opts?.priority);
    return this.inner.latestNews(params, opts);
  }
  /**
   * The `/available/*` calls, counted apart from `search`.
   *
   * They spend the same quota and were nonetheless invisible here, which is what
   * let a request path advertised as spending NOTHING reach three of them through
   * a cold reference cache (`cachedReference`). A claim about upstream spend needs
   * a witness for every call that spends.
   */
  referenceCalls = 0;

  availableLanguages(opts?: CallOpts) {
    this.referenceCalls += 1;
    return this.inner.availableLanguages(opts);
  }
  availableRegions(opts?: CallOpts) {
    this.referenceCalls += 1;
    return this.inner.availableRegions(opts);
  }
  availableCategories(opts?: CallOpts) {
    this.referenceCalls += 1;
    return this.inner.availableCategories(opts);
  }
  quota() {
    return this.inner.quota();
  }
  close() {
    return this.inner.close();
  }
}

/**
 * A logger that keeps what it was told, for the tests that assert on §12's
 * numbers.
 *
 * It exists because ADR-0015 deleted `/metrics`, which is where those tests
 * used to read them. The counters were a registry an assertion could query
 * directly; the replacement is a structured log field, so a test that wants the
 * number has to be handed somewhere for the line to land. That is the whole of
 * this — it observes, it does not stub: `deps.log` is optional everywhere, and a
 * test that omits it sees exactly the behaviour it saw before this existed.
 *
 * Deliberately NOT wired into `createTestHarness`. A test asserting on a log
 * line should be visibly the kind of test that does, and the ones that are not
 * about observability should keep proving the code runs with no logger at all —
 * which is what the four planner modules' `log?` promises and what a function
 * entrypoint that hands in only `warn` relies on.
 */
export interface CapturedLine {
  fields: Record<string, unknown>;
  message: string;
}

export interface LogCapture {
  log: {
    info: (fields: object, message: string) => void;
    warn: (fields: object, message: string) => void;
  };
  /** Every captured `info` line, in the order it was written. */
  info: CapturedLine[];
  /** Every captured `warn` line, in the order it was written. */
  warn: CapturedLine[];
  /**
   * The fields of the `info` lines written under one message, in order.
   *
   * Messages are matched EXACTLY and callers pass the exported constant rather
   * than a literal, so a reworded message is a compile-or-nothing change rather
   * than a test that quietly stops matching — which is the failure this whole
   * exercise is about.
   */
  under: (message: string) => Record<string, unknown>[];
}

export function captureLog(): LogCapture {
  const info: CapturedLine[] = [];
  const warn: CapturedLine[] = [];
  return {
    log: {
      info: (fields, message) => void info.push({ fields: { ...fields }, message }),
      warn: (fields, message) => void warn.push({ fields: { ...fields }, message }),
    },
    info,
    warn,
    under: (message) => info.filter((line) => line.message === message).map((line) => line.fields),
  };
}
