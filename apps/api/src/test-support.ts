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
import { IngestQueue } from "./ingest-queue.js";
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
  teardown: () => Promise<void>;
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
    { maxPageSize: 20, maxRetrievableResults: 100, maxLookbackDays: 30 },
    { dailyLimit: 1000, burstLimit: 60 },
  );
  const counting = new CountingClient(fixtureClient);

  const redis = new Redis(REDIS_URL);
  const queue = new IngestQueue(REDIS_URL, {
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
      ...configOverrides,
    },
    now: now ? () => now : () => new Date(),
  };

  return {
    deps,
    counting,
    redis,
    queue,
    metrics,
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
    `page:${fingerprint}:*`,
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
 * the CurrentsClient seam — the same boundary a second provider would use
 * (ARCHITECTURE 5.6) — so the planner under test cannot tell the difference.
 */
export class CountingClient implements CurrentsClient {
  searchCalls = 0;
  /** Quota priority of each search call, in order (§9.4). */
  priorities: Array<CallOpts["priority"]> = [];
  /** Artificial per-call latency, for exercising the wall-clock deadline. */
  delayMs = 0;

  constructor(private readonly inner: CurrentsClient) {}

  get limits() {
    return this.inner.limits;
  }

  async search(params: SearchParams, opts?: CallOpts): Promise<SearchResult> {
    this.searchCalls += 1;
    this.priorities.push(opts?.priority);
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
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
