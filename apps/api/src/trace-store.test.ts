import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "@zammy/config";
import type { JobRun, RequestTrace, TraceEnvironment } from "@zammy/shared/request-trace";
import { TRACE_UNSTORED_MESSAGE } from "./observations.js";
import { captureLog } from "./test-support.js";
import {
  TRACE_LINK_DEADLINE_MS,
  TRACE_READY_WAIT_MS,
  TRACE_WARN_INTERVAL_MS,
  TRACE_WRITE_DEADLINE_MS,
  TraceStoreUnavailable,
  createTraceRuntime,
  traceJobKey,
  traceKey,
  traceRunsKey,
  type TraceRuntime,
} from "./trace-store.js";

/**
 * The trace store against the real compose Redis (ADR-0029, "The change" 5–7).
 *
 * What these catch: a trace or link written without a TTL (a diagnostic that
 * lives forever in a 256 MB cache, and on Upstash a billed key forever), a key
 * that is not scoped by the queue's name (a test run reading the dev server's
 * traces), a future-version or corrupted record answered as if it were
 * readable, an unbounded run list, and — the two that matter on a cold
 * instance — a trace write that gives up instantly on a client still shaking
 * hands, and a job link that WAITS for one, which would put up to a second and
 * a half in front of every traced publish.
 */

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
const TOKEN = "t".repeat(32);

const ENVIRONMENT: TraceEnvironment = {
  queue: "bullmq",
  currents: "fixture",
  gnews: false,
  googleNews: "off",
  summaries: false,
  labeler: false,
};

function traceConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: "postgres://zammy:zammy@localhost:5432/zammy",
    REDIS_URL,
    CURRENTS_USER_AGENT: "zammy-tests/0.1",
    REQUEST_TRACE_ENABLED: "true",
    REQUEST_TRACE_TOKEN: TOKEN,
    ...overrides,
  } as NodeJS.ProcessEnv);
}

function record(id: string, overrides: Partial<RequestTrace> = {}): RequestTrace {
  return {
    v: 1,
    id,
    route: "timeline_search",
    method: "GET",
    queryKeys: ["q"],
    status: 200,
    startedAt: "2026-09-01T12:00:00.000Z",
    ms: 9.8,
    overheadMs: 0,
    origin: { instanceSequence: 1, redisAtStart: "ready", environment: ENVIRONMENT },
    meta: null,
    planes: null,
    touches: [
      { station: "redis", at: 1, ms: 1, outcome: "hit", command: "GET", key: "page_cache" },
    ],
    elided: null,
    ...overrides,
  };
}

function run(ref: string, startedAt: string): JobRun {
  return {
    v: 1,
    ref,
    job: "segment",
    plane: "search",
    source: "bullmq",
    startedAt,
    ms: 10,
    overheadMs: 0,
    result: "ok",
    sharedWith: 1,
    origin: { instanceSequence: 2, redisAtStart: "ready", environment: ENVIRONMENT },
    touches: [],
    elided: null,
  };
}

/** Every key this suite wrote, found by SCAN and deleted by explicit name. */
async function purgeTraceKeys(redis: Redis, queueName: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${queueName}:trace:*`, "COUNT", 100);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
}

/** A TCP server that accepts and never speaks: a Redis handshake that never completes. */
async function silentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

let redis: Redis;
let queueName: string;
let runtime: TraceRuntime;

beforeAll(() => {
  redis = new Redis(REDIS_URL);
});

afterAll(async () => {
  await redis.quit();
});

afterEach(async () => {
  await purgeTraceKeys(redis, queueName);
});

function freshRuntime(config: Config = traceConfig()): TraceRuntime {
  queueName = `trace-store-test-${randomUUID()}`;
  runtime = createTraceRuntime(config, {
    redis,
    queueName,
    environment: ENVIRONMENT,
    log: captureLog().log,
  });
  return runtime;
}

describe("createTraceRuntime", () => {
  it("takes its bounds from config and never exceeds the shared ceiling", () => {
    const rt = freshRuntime(traceConfig({ REQUEST_TRACE_TTL_SECONDS: "7200" }));
    expect(rt.ttlMs).toBe(7_200_000);
    expect(rt.maxTouches).toBe(240);
    expect(rt.token).toBe(TOKEN);
    expect(rt.defaultSource).toBe("bullmq");
    expect(freshRuntime(traceConfig({ INGEST_QUEUE_DRIVER: "vercel" })).defaultSource).toBe(
      "vercel_queue",
    );
  });

  it("counts every request and run from one, per process", () => {
    const rt = freshRuntime();
    expect([rt.nextSequence(), rt.nextSequence(), rt.nextSequence()]).toEqual([1, 2, 3]);
    expect(rt.origin(3, "connecting")).toEqual({
      instanceSequence: 3,
      redisAtStart: "connecting",
      environment: ENVIRONMENT,
    });
  });
});

describe("putTrace and readTrace", () => {
  it("stores a trace under a queue-scoped key with the configured TTL, and reads it back", async () => {
    const rt = freshRuntime();
    const id = randomUUID();
    expect(await rt.putTrace(record(id))).toBe(true);

    const key = traceKey(queueName, id);
    expect(key).toBe(`${queueName}:trace:${id}`);
    const pttl = await redis.pttl(key);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(rt.ttlMs);

    const read = await rt.readTrace(id);
    expect(read?.trace).toEqual(record(id));
    expect(read?.runs).toEqual([]);
    // Computed from the record, never read back with PTTL.
    expect(read?.expiresAt).toBe(
      new Date(Date.parse("2026-09-01T12:00:00.000Z") + rt.ttlMs).toISOString(),
    );
  });

  it("answers null for an id it never stored", async () => {
    const rt = freshRuntime();
    expect(await rt.readTrace(randomUUID())).toBeNull();
  });

  it("answers null for a record from a version it cannot read, or one that is not JSON", async () => {
    const rt = freshRuntime();
    const future = randomUUID();
    const v2 = JSON.stringify({ ...record(future), v: 2 });
    await redis.set(traceKey(queueName, future), v2, "PX", 60_000);
    expect(await rt.readTrace(future)).toBeNull();

    const garbled = randomUUID();
    await redis.set(traceKey(queueName, garbled), "{not json", "PX", 60_000);
    expect(await rt.readTrace(garbled)).toBeNull();
  });

  it("never reads another queue's traces", async () => {
    const rt = freshRuntime();
    const id = randomUUID();
    await rt.putTrace(record(id));
    const other = createTraceRuntime(traceConfig(), {
      redis,
      queueName: `${queueName}-other`,
      environment: ENVIRONMENT,
      log: captureLog().log,
    });
    expect(await other.readTrace(id)).toBeNull();
  });

  it("throws TraceStoreUnavailable, not null, when Redis cannot answer", async () => {
    freshRuntime();
    const closed = new Redis(REDIS_URL, { lazyConnect: true, enableOfflineQueue: false });
    closed.disconnect();
    const blind = createTraceRuntime(traceConfig(), {
      redis: closed,
      queueName,
      environment: ENVIRONMENT,
      log: captureLog().log,
    });
    await expect(blind.readTrace(randomUUID())).rejects.toBeInstanceOf(TraceStoreUnavailable);
  });

  it("gives up a write on a client that never becomes ready, inside its bound", async () => {
    freshRuntime();
    const silent = await silentServer();
    const cold = new Redis(`redis://127.0.0.1:${silent.port}`, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 2,
    });
    void cold.connect().catch(() => {});
    try {
      const rt = createTraceRuntime(traceConfig(), {
        redis: cold,
        queueName,
        environment: ENVIRONMENT,
        log: captureLog().log,
      });
      const started = Date.now();
      expect(await rt.putTrace(record(randomUUID()))).toBe(false);
      const elapsed = Date.now() - started;
      // It WAITED for the handshake — a cold instance's first trace is worth
      // 1.5 s of a traced request — and then stopped.
      expect(elapsed).toBeGreaterThanOrEqual(TRACE_READY_WAIT_MS - 50);
      expect(elapsed).toBeLessThan(TRACE_READY_WAIT_MS + TRACE_WRITE_DEADLINE_MS + 200);
    } finally {
      cold.disconnect();
      await silent.close();
    }
  });
});

describe("linkJob, linksForJob and consumeLinks", () => {
  it("writes a job's links with the TTL, and reads them back parsed and sorted", async () => {
    const rt = freshRuntime();
    const [a, b] = [randomUUID(), randomUUID()].sort() as [string, string];
    expect(
      await rt.linkJob("seg_search_abc_1_2_p1", [
        { traceId: b, ref: "2" },
        { traceId: a, ref: "1.1" },
      ]),
    ).toBe(true);

    const key = traceJobKey(queueName, "seg_search_abc_1_2_p1");
    expect(key).toBe(`${queueName}:trace:job:seg_search_abc_1_2_p1`);
    const pttl = await redis.pttl(key);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(rt.ttlMs);

    expect(await rt.linksForJob("seg_search_abc_1_2_p1")).toEqual([
      { traceId: a, ref: "1.1" },
      { traceId: b, ref: "2" },
    ]);
  });

  it("drops members it cannot read and caps a job at eight traces", async () => {
    const rt = freshRuntime();
    const key = traceJobKey(queueName, "job");
    const ids: string[] = Array.from({ length: 10 }, () => randomUUID());
    await redis.sadd(
      key,
      "garbage",
      `${randomUUID().toUpperCase()}|1`,
      `${randomUUID()}|0`,
      ...ids.map((id) => `${id}|1`),
    );
    const links = await rt.linksForJob("job");
    expect(links).toHaveLength(8);
    expect(links.every((link) => ids.includes(link.traceId) && link.ref === "1")).toBe(true);
  });

  it("answers no links for a job nobody traced", async () => {
    const rt = freshRuntime();
    expect(await rt.linksForJob("seg_nobody")).toEqual([]);
    expect(await rt.linkJob("seg_nobody", [])).toBe(false);
  });

  it("consumes exactly the links it is given", async () => {
    const rt = freshRuntime();
    const [kept, gone] = [randomUUID(), randomUUID()];
    await rt.linkJob("job", [
      { traceId: kept, ref: "1" },
      { traceId: gone, ref: "3" },
    ]);
    await rt.consumeLinks("job", [{ traceId: gone, ref: "3" }]);
    expect(await rt.linksForJob("job")).toEqual([{ traceId: kept, ref: "1" }]);
  });

  it("fails a link fast on a client that is not ready, rather than waiting for it", async () => {
    freshRuntime();
    const silent = await silentServer();
    const cold = new Redis(`redis://127.0.0.1:${silent.port}`, {
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    void cold.connect().catch(() => {});
    try {
      const rt = createTraceRuntime(traceConfig(), {
        redis: cold,
        queueName,
        environment: ENVIRONMENT,
        log: captureLog().log,
      });
      const started = Date.now();
      expect(await rt.linkJob("job", [{ traceId: randomUUID(), ref: "1" }])).toBe(false);
      expect(await rt.linksForJob("job")).toEqual([]);
      expect(Date.now() - started).toBeLessThan(TRACE_LINK_DEADLINE_MS * 2);
    } finally {
      cold.disconnect();
      await silent.close();
    }
  });
});

describe("appendRun", () => {
  it("appends runs with the TTL and reads them sorted by start, then ref", async () => {
    const rt = freshRuntime();
    const id = randomUUID();
    await rt.putTrace(record(id));
    await rt.appendRun(id, run("2", "2026-09-01T12:00:02.000Z"));
    await rt.appendRun(id, run("1", "2026-09-01T12:00:03.000Z"));
    await rt.appendRun(id, run("1", "2026-09-01T12:00:02.000Z"));

    const pttl = await redis.pttl(traceRunsKey(queueName, id));
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(rt.ttlMs);

    const read = await rt.readTrace(id);
    expect(read?.runs.map((r) => [r.startedAt.slice(17, 19), r.ref])).toEqual([
      ["02", "1"],
      ["02", "2"],
      ["03", "1"],
    ]);
  });

  it("drops a run it cannot parse and keeps the rest", async () => {
    const rt = freshRuntime();
    const id = randomUUID();
    await rt.putTrace(record(id));
    await rt.appendRun(id, run("1", "2026-09-01T12:00:02.000Z"));
    const future = JSON.stringify({ ...run("2", "x"), v: 2 });
    await redis.rpush(traceRunsKey(queueName, id), "{not json", future);
    const read = await rt.readTrace(id);
    expect(read?.runs.map((r) => r.ref)).toEqual(["1"]);
  });

  it("keeps sixteen runs, and calls the seventeenth capped rather than failed", async () => {
    const rt = freshRuntime();
    const id = randomUUID();
    await rt.putTrace(record(id));
    for (let i = 1; i <= 16; i += 1) {
      expect(await rt.appendRun(id, run(String(i), "2026-09-01T12:00:02.000Z"))).toBe("stored");
    }
    // Redis took it and the trim dropped it: the designed omission, which the
    // dispatch must not report as a Redis failure.
    expect(await rt.appendRun(id, run("17", "2026-09-01T12:00:02.000Z"))).toBe("capped");
    expect(await redis.llen(traceRunsKey(queueName, id))).toBe(16);
    // The FIRST sixteen, so the trim removed the newcomer and nothing already there.
    const refs = (await rt.readTrace(id))?.runs.map((r) => Number(r.ref)).sort((a, b) => a - b);
    expect(refs).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it("answers failed, without throwing, when Redis cannot take the run", async () => {
    freshRuntime();
    const closed = new Redis(REDIS_URL, { lazyConnect: true, enableOfflineQueue: false });
    closed.disconnect();
    const blind = createTraceRuntime(traceConfig(), {
      redis: closed,
      queueName,
      environment: ENVIRONMENT,
      log: captureLog().log,
    });
    expect(await blind.appendRun(randomUUID(), run("1", "2026-09-01T12:00:02.000Z"))).toBe(
      "failed",
    );
  });
});

describe("warnUnstored", () => {
  it("warns once a minute, and says how many it folded in", () => {
    let now = 0;
    const capture = captureLog();
    const rt = createTraceRuntime(traceConfig(), {
      redis,
      queueName: `trace-store-test-${randomUUID()}`,
      environment: ENVIRONMENT,
      log: capture.log,
      clock: () => now,
    });
    rt.warnUnstored({ reason: "redis" });
    rt.warnUnstored({ reason: "redis" });
    now += TRACE_WARN_INTERVAL_MS;
    rt.warnUnstored({ reason: "schema", paths: ["touches.0.key"] });

    const lines = capture.warn.filter((line) => line.message === TRACE_UNSTORED_MESSAGE);
    expect(lines.map((line) => line.fields)).toEqual([
      { reason: "redis", count: 1 },
      { reason: "schema", paths: ["touches.0.key"], count: 2 },
    ]);
  });
});
