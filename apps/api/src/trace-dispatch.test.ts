import { randomBytes, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@zammy/config";
import { traceSignature, type RequestTrace, type TraceEnvironment } from "@zammy/shared/request-trace";
import { upsertTopic } from "@zammy/storage";
import { ingestJobId, type IngestHandler, type SegmentJob } from "./ingest-queue.js";
import { TRACE_UNSTORED_MESSAGE } from "./observations.js";
import { dispatchOver, ingestDispatch } from "./server.js";
import type { SummarizeJobDeps } from "./storyline-summary-job.js";
import { captureLog, createTestHarness, type TestHarness } from "./test-support.js";
import { traceRuns, type DispatchBundles } from "./trace-dispatch.js";
import {
  createTraceRuntime,
  traceJobKey,
  traceRunsKey,
  type TraceRuntime,
} from "./trace-store.js";
import type { TrendingDeps } from "./trending-service.js";

/**
 * The consumer side of tracing (ADR-0029, "The change" 6), over the real harness.
 *
 * What these catch: a lookup that swaps the boot bundles for a copy on EVERY
 * job (the standing cost is one SMEMBERS and nothing else); a thrown job whose
 * error is wrapped, swallowed or replaced on its way out (`createMessageHandler`
 * decides retry-or-give-up on that error's kind); links consumed after a throw
 * (the redelivery would then run unobserved) or kept after an ok run (a later
 * identical job someone else enqueued would be appended to this trace); a job
 * the queue deduplicated for two traces reaching only one of them; a child a run
 * enqueues losing its way back; the drain's runs mislabelled as queue
 * deliveries; and a run the sixteen-run cap trimmed reported as a Redis failure,
 * which would send the operator to debug a Redis that answered every command.
 */

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
const NOW = new Date("2026-08-06T12:00:00.000Z");

const ENVIRONMENT: TraceEnvironment = {
  queue: "bullmq",
  currents: "fixture",
  gnews: false,
  googleNews: "off",
  summaries: false,
  labeler: false,
};

let harness: TestHarness;
let runtime: TraceRuntime;
let bundles: DispatchBundles;
const cleanup: string[] = [];

beforeAll(async () => {
  harness = await createTestHarness({}, NOW);
  // Connected before anything counts commands: a fresh client's first command
  // passes through `sendCommand` twice (queued offline, then flushed after the
  // ready check), which is the client's business and not the dispatch's.
  await harness.redis.ping();
  runtime = runtimeOver(harness.redis);
  const trendingDeps: TrendingDeps = {
    ...harness.deps,
    trending: {
      sampleCategories: ["science_technology"],
      samplePages: 1,
      sampleRefreshMinutes: 60,
      windowHours: 24,
      halfLifeHours: 8,
    },
  };
  bundles = {
    deps: harness.deps as unknown as DispatchBundles["deps"],
    trendingDeps,
    // No summarize job runs here; the bundle is only carried.
    summarizeDeps: { db: harness.deps.db, redis: harness.redis } as SummarizeJobDeps,
  };
});

afterEach(async () => {
  let cursor = "0";
  do {
    const [next, keys] = await harness.redis.scan(
      cursor,
      "MATCH",
      `${harness.queue.name}:trace:*`,
      "COUNT",
      200,
    );
    cursor = next;
    if (keys.length > 0) await harness.redis.del(...keys);
  } while (cursor !== "0");
  if (cleanup.length > 0) await harness.redis.del(...cleanup.splice(0));
});

afterAll(async () => {
  await harness.teardown();
});

function runtimeOver(redis: Redis, log = captureLog().log): TraceRuntime {
  return createTraceRuntime(
    loadConfig({
      DATABASE_URL: "postgres://zammy:zammy@localhost:5432/zammy",
      REDIS_URL,
      CURRENTS_USER_AGENT: "zammy-tests/0.1",
      REQUEST_TRACE_ENABLED: "true",
    } as NodeJS.ProcessEnv),
    { redis, queueName: harness.queue.name, environment: ENVIRONMENT, log },
  );
}

/** A stored request trace for a run to be appended to. */
async function storedTrace(): Promise<string> {
  const id = randomUUID();
  const trace: RequestTrace = {
    v: 1,
    id,
    route: "timeline_search",
    method: "GET",
    queryKeys: ["q"],
    status: 200,
    startedAt: NOW.toISOString(),
    ms: 10,
    overheadMs: 0,
    origin: { instanceSequence: 1, redisAtStart: "ready", environment: ENVIRONMENT },
    meta: null,
    planes: null,
    touches: [],
    elided: null,
  };
  expect(await runtime.putTrace(trace)).toBe(true);
  return id;
}

/** A real topic and a segment job over the fixture corpus, unique to the caller. */
async function segmentJob(): Promise<SegmentJob> {
  const fingerprint = randomBytes(32).toString("hex");
  await upsertTopic(harness.deps.db, {
    fingerprint,
    keywords: ["climate"],
    language: "en",
    country: null,
    category: null,
  });
  cleanup.push(`budget:topic:${fingerprint}:${NOW.toISOString().slice(0, 10)}`);
  return {
    fingerprint,
    from: "2026-08-02T00:00:00.000Z",
    to: "2026-08-02T06:00:00.000Z",
    startPage: 1,
    plane: "search",
  };
}

/** Command names the harness client sent while `fn` ran — observed in the test only. */
async function commandsDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const names: string[] = [];
  const original = harness.redis.sendCommand;
  const spy = vi
    .spyOn(harness.redis, "sendCommand")
    .mockImplementation(function (this: Redis, command, stream) {
      names.push(command.name);
      return original.call(this, command, stream);
    });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return names;
}

describe("traceRuns", () => {
  it("hands an unlinked job the boot bundles by identity, for one SMEMBERS", async () => {
    const seen: DispatchBundles[] = [];
    const ran: string[] = [];
    const over = (b: DispatchBundles): IngestHandler => {
      seen.push(b);
      return async (job) => void ran.push(ingestJobId(job));
    };
    const handler = traceRuns(bundles, runtime, over, "bullmq");
    const job: SegmentJob = { ...(await segmentJob()) };

    const commands = await commandsDuring(() => handler(job));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(bundles);
    expect(ran).toEqual([ingestJobId(job)]);
    expect(commands).toEqual(["smembers"]);
  });

  it("appends a linked segment run to its trace, and consumes the link", async () => {
    const traceId = await storedTrace();
    const job = await segmentJob();
    const jobId = ingestJobId(job);
    await runtime.linkJob(jobId, [{ traceId, ref: "1" }]);

    await traceRuns(bundles, runtime, dispatchOver, "vercel_queue")(job);

    const read = await runtime.readTrace(traceId);
    expect(read?.runs).toHaveLength(1);
    const [run] = read!.runs;
    expect(run).toMatchObject({
      ref: "1",
      job: "segment",
      plane: "search",
      source: "vercel_queue",
      result: "ok",
      sharedWith: 1,
    });
    expect(run?.failure).toBeUndefined();
    expect(traceSignature(run!.touches)).toEqual([
      "redis:fill_lock",
      "redis:topic_budget",
      "currents:search",
      "redis:fill_lock",
    ]);
    expect(await harness.redis.smembers(traceJobKey(harness.queue.name, jobId))).toEqual([]);
  });

  it("rethrows a failed job's own error, records the run, and keeps the link", async () => {
    const traceId = await storedTrace();
    const job = await segmentJob();
    const jobId = ingestJobId(job);
    await runtime.linkJob(jobId, [{ traceId, ref: "2" }]);
    const failure = new Error("upstream rejected our query");

    await expect(
      traceRuns(bundles, runtime, () => async () => Promise.reject(failure), "bullmq")(job),
    ).rejects.toBe(failure);

    const read = await runtime.readTrace(traceId);
    expect(read?.runs).toMatchObject([{ ref: "2", result: "threw", failure: "unknown" }]);
    // Left for the redelivery, which appends another record under the same ref.
    expect(await harness.redis.smembers(traceJobKey(harness.queue.name, jobId))).toEqual([
      `${traceId}|2`,
    ]);
  });

  it("runs the plain handler when the lookup itself fails", async () => {
    const closed = new Redis(REDIS_URL, { lazyConnect: true, enableOfflineQueue: false });
    closed.disconnect();
    const seen: DispatchBundles[] = [];
    const handler = traceRuns(
      bundles,
      runtimeOver(closed),
      (b) => {
        seen.push(b);
        return async () => {};
      },
      "bullmq",
    );

    await handler(await segmentJob());
    expect(seen).toEqual([bundles]);
  });

  it("appends one deduplicated run to every trace that asked for it", async () => {
    const [first, second] = [await storedTrace(), await storedTrace()];
    const job = await segmentJob();
    await runtime.linkJob(ingestJobId(job), [
      { traceId: first, ref: "1" },
      { traceId: second, ref: "3" },
    ]);

    await traceRuns(bundles, runtime, () => async () => {}, "bullmq")(job);

    expect((await runtime.readTrace(first))?.runs).toMatchObject([{ ref: "1", sharedWith: 2 }]);
    expect((await runtime.readTrace(second))?.runs).toMatchObject([{ ref: "3", sharedWith: 2 }]);
  });

  it("is silent about a run the cap trimmed, and warns only on a failed append", async () => {
    const capture = captureLog();
    const rt = runtimeOver(harness.redis, capture.log);
    const traceId = await storedTrace();
    const job = await segmentJob();
    const jobId = ingestJobId(job);
    const noop = traceRuns(bundles, rt, () => async () => {}, "bullmq");

    // Seventeen first runs of distinct refs — a fan-out, not a redelivery — each
    // linked, run and consumed the way a consumer would. Every command succeeds.
    for (let ref = 1; ref <= 17; ref += 1) {
      await rt.linkJob(jobId, [{ traceId, ref: String(ref) }]);
      await noop(job);
    }

    expect(await harness.redis.llen(traceRunsKey(harness.queue.name, traceId))).toBe(16);
    expect(capture.warn.filter((line) => line.message === TRACE_UNSTORED_MESSAGE)).toEqual([]);

    // The other half: an append that really failed is still warned, as `redis`.
    const failing: TraceRuntime = { ...rt, appendRun: async () => "failed" };
    await rt.linkJob(jobId, [{ traceId, ref: "18" }]);
    await traceRuns(bundles, failing, () => async () => {}, "bullmq")(job);
    expect(
      capture.warn
        .filter((line) => line.message === TRACE_UNSTORED_MESSAGE)
        .map((line) => line.fields),
    ).toEqual([{ reason: "redis", count: 1 }]);
  });

  it("links a child the run enqueues under the parent's ref", async () => {
    const traceId = await storedTrace();
    const job = await segmentJob();
    await runtime.linkJob(ingestJobId(job), [{ traceId, ref: "1" }]);
    const child: SegmentJob = { ...job, from: "2026-08-02T06:00:00.000Z" };
    const published: unknown[] = [];

    await traceRuns(
      bundles,
      runtime,
      (b) => async () => {
        // What `onTruncated` does: publish through the run's own queue.
        const queue = b.deps.queue as unknown as { enqueueSegment(j: SegmentJob): Promise<void> };
        await queue.enqueueSegment(child);
        published.push(child);
      },
      "bullmq",
    )(job);

    expect(await harness.redis.smembers(traceJobKey(harness.queue.name, ingestJobId(child)))).toEqual([
      `${traceId}|1.1`,
    ]);
    const [run] = (await runtime.readTrace(traceId))!.runs;
    expect(run?.touches).toMatchObject([{ station: "queue", ref: "1.1", linked: true, outcome: "ok" }]);
    expect(published).toEqual([child]);
  });
});

describe("ingestDispatch", () => {
  it("labels a drained run as the drain's", async () => {
    const traceId = await storedTrace();
    const job = await segmentJob();
    await runtime.linkJob(ingestJobId(job), [{ traceId, ref: "1" }]);

    await ingestDispatch({ ...bundles, tracing: runtime }, "drain")(job);

    expect((await runtime.readTrace(traceId))?.runs).toMatchObject([{ source: "drain", result: "ok" }]);
  });

  it("defaults the source to the queue driver's", async () => {
    const traceId = await storedTrace();
    const job = await segmentJob();
    await runtime.linkJob(ingestJobId(job), [{ traceId, ref: "1" }]);

    await ingestDispatch({ ...bundles, tracing: runtime })(job);

    expect((await runtime.readTrace(traceId))?.runs).toMatchObject([{ source: "bullmq" }]);
  });

  it("is exactly the old dispatch with no runtime: no lookup, the job still runs", async () => {
    const job = await segmentJob();
    const calls = harness.counting.searchCalls;

    const commands = await commandsDuring(() => ingestDispatch(bundles)(job));

    expect(commands).not.toContain("smembers");
    expect(harness.counting.searchCalls).toBe(calls + 1);
  });
});
