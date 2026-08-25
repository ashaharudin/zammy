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
import type { TimelineDeps } from "./timeline-service.js";

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

export interface TestHarness {
  deps: TimelineDeps;
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

export async function createTestHarness(
  configOverrides: Partial<TimelineDeps["config"]> = {},
  now?: Date,
): Promise<TestHarness> {
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

  const store = new FixtureStore(FIXTURES_DIR);
  await store.load();
  const fixtureClient = new FixtureCurrentsClient(
    store,
    { maxPageSize: 20, maxRetrievableResults: 100, maxLookbackDays: 30, maxRangeDays: 7 },
    { dailyLimit: 1000, burstLimit: 60 },
  );
  const clock = createTestClock(now);
  const counting = new CountingClient(fixtureClient, clock);

  const redis = new Redis(REDIS_URL);
  const queue = new BullMqIngestQueue(REDIS_URL, {
    queueName: `test-planner-${randomUUID()}`,
  });

  const metrics = new Metrics({ quota: () => counting.quota() });
  const deps: TimelineDeps = {
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
      // Grouping and storylines ON, as they ship (§14.3, ADR-0011) — a
      // planner test that passes only with the feature disabled has not
      // tested the planner. The linker's rules are the measured defaults
      // (docs/STORYLINE-LINKING.md).
      grouping: {
        enabled: true,
        threshold: 0.5,
        timeZone: "UTC",
        linker: {
          enabled: true,
          rules: {
            anchorMaxShare: 0.002,
            anchorDfFloor: 10,
            massThreshold: 20,
            dormancyDays: 90,
            dormantStrictness: 1.5,
          },
          mergeBridges: 2,
          // Off by default: the gate needs a model, and a test that wants it
          // says so (see storyline-linker.test.ts).
          coherenceGate: false,
          // The shipped default. A test that wants the narrowed retrieval says
          // so, the same way it would say so about the gate.
          narrowRetrieval: false,
          // Likewise unbounded, the shipped default: `bridgePairs` takes the
          // full cross-product. A test that wants the bound says so.
          maxBridgingQualifiers: undefined,
          storyDf: { windowDays: 14, timeZone: "UTC" },
          timeZone: "UTC",
        },
      },
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
  get coverageProvider(): string {
    return this.inner.coverageProvider;
  }
  searchCalls = 0;
  /** Quota priority of each search call, in order (§9.4). */
  priorities: Array<CallOpts["priority"]> = [];
  /** Date span of each search call, ms — the per-call range ceiling's witness. */
  ranges: number[] = [];
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
  availableLanguages(opts?: CallOpts) {
    return this.inner.availableLanguages(opts);
  }
  availableRegions(opts?: CallOpts) {
    return this.inner.availableRegions(opts);
  }
  availableCategories(opts?: CallOpts) {
    return this.inner.availableCategories(opts);
  }
  quota() {
    return this.inner.quota();
  }
  close() {
    return this.inner.close();
  }
}
