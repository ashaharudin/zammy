import { randomUUID } from "node:crypto";
import { Command, Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "@zammy/config";
import { NewsQuotaError } from "@zammy/news-client";
import type { TraceEnvironment } from "@zammy/shared/request-trace";
import type { GenerateResult, TextGenerator } from "./gemini.js";
import { ingestJobId, type IngestQueue, type SegmentJob } from "./ingest-queue.js";
import { buildServices } from "./server.js";
import { captureLog, createTestHarness, type TestHarness } from "./test-support.js";
import {
  PASS_THROUGH_KEYS,
  TRACED_KEYS,
  TouchPlugin,
  createTouchScope,
  traceGenerator,
  traceNewsClient,
  traceQueue,
  traceRedis,
} from "./trace-deps.js";
import { createTouchRecorder, type TouchRecorder } from "./trace-recorder.js";
import { createTraceRuntime, traceJobKey, type TraceRuntime } from "./trace-store.js";

/**
 * The traced copies of a dependency bag, against the real Postgres and Redis
 * (ADR-0029, "The change" 3).
 *
 * The bar these hold is IDENTITY: whatever the raw member returns, the traced
 * one returns — the same value, the same error instance, the same promise —
 * because a traced request must be the same request. What they catch: a Redis
 * proxy that chains into the command's promise (an extra tick and a handler
 * between every command and its caller), a Kysely plugin that rewrites a node
 * or ends the shared pool, a news wrapper that wraps an upstream error in one of
 * its own (the consumer's retry policy reads its `kind`), a job link written
 * AFTER the publish (the in-process worker can start the job before the link
 * lands), a job object altered on its way to the queue (its id is its dedup),
 * and a new dependency that nobody decided whether to trace.
 */

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
const FIXTURES_DIR = new URL("../../../fixtures/", import.meta.url).pathname;

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
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    DATABASE_URL: "postgres://zammy:zammy@localhost:5432/zammy",
    REDIS_URL,
    CURRENTS_MODE: "fixture",
    CURRENTS_USER_AGENT: "zammy-tests/0.1",
    FIXTURES_DIR,
    REQUEST_TRACE_ENABLED: "true",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

let harness: TestHarness;
let runtime: TraceRuntime;
/** Keys a case wrote directly, deleted by explicit name at the end. */
const written: string[] = [];

beforeAll(async () => {
  harness = await createTestHarness();
  runtime = createTraceRuntime(traceConfig(), {
    redis: harness.redis,
    queueName: harness.queue.name,
    environment: ENVIRONMENT,
    log: captureLog().log,
  });
});

afterAll(async () => {
  if (written.length > 0) await harness.redis.del(...written);
  await harness.teardown();
});

function recorder(): TouchRecorder {
  return createTouchRecorder({ maxTouches: 240 });
}

/** A key only this run uses, remembered for cleanup. */
function key(prefix: string): string {
  const name = `${prefix}${harness.queue.name}:${randomUUID()}`;
  written.push(name);
  return name;
}

describe("traceRedis", () => {
  it("returns exactly what the raw client returns, one touch per command", async () => {
    const rec = recorder();
    const proxy = traceRedis(harness.redis, rec, harness.queue.name);

    const run = async (client: Redis) => {
      const k = key("trace-deps-test:");
      const counter = key("trace-deps-test:");
      const lock = key("lock:refresh:");
      return [
        await client.set(k, "v"),
        await client.get(k),
        await client.mget(k, `${k}:absent`),
        await client.incr(counter),
        await client.eval("return 7", 0),
        await client.set(lock, "token", "PX", 5_000, "NX"),
        await client.set(lock, "token", "PX", 5_000, "NX"),
      ];
    };
    const raw = await run(harness.redis);
    const traced = await run(proxy);

    expect(traced).toEqual(raw);
    expect(raw).toEqual(["OK", "v", ["v", null], 1, 7, "OK", null]);
    expect(proxy.status).toBe(harness.redis.status);

    const touches = rec.seal().touches;
    expect(touches.map((t) => (t.station === "redis" ? [t.command, t.key, t.outcome] : null))).toEqual([
      ["SET", "other", "ok"],
      ["GET", "other", "ok"],
      ["MGET", "other", "ok"],
      ["INCR", "other", "ok"],
      ["EVAL", "other", "ok"],
      ["SET", "fill_lock", "acquired"],
      ["SET", "fill_lock", "held"],
    ]);
    // Classes only: not one byte of any key.
    expect(JSON.stringify(touches)).not.toContain("trace-deps-test");
    expect(JSON.stringify(touches)).not.toContain(harness.queue.name);
  });

  it("returns the command's own promise, never a chained one", async () => {
    // The identity case the Redis wrapper exists to keep. `sendCommand` hands
    // back `command.promise` itself; a wrapper that returned `.then(...)` of it
    // would put its own handler between every command and its caller.
    const proxy = traceRedis(harness.redis, recorder(), harness.queue.name);
    const command = new Command("get", [key("trace-deps-test:")]);
    const returned = proxy.sendCommand(command);
    expect(returned).toBe(command.promise);
    await expect(returned).resolves.toBeNull();
  });

  it("rejects exactly as a client that is not connected does, and records not_ready", async () => {
    const make = () => new Redis(REDIS_URL, { lazyConnect: true, enableOfflineQueue: false });
    const raw = make();
    const coldForProxy = make();
    const rec = recorder();
    const proxy = traceRedis(coldForProxy, rec, harness.queue.name);
    try {
      const rawError = await raw.get("ref:languages").catch((error: unknown) => error);
      const command = new Command("get", ["ref:languages"]);
      const returned = proxy.sendCommand(command) as Promise<unknown>;
      const proxyError = await returned.catch((error: unknown) => error);

      expect(proxyError).toBeInstanceOf(Error);
      expect((proxyError as Error).message).toBe((rawError as Error).message);
      // The same instance the command itself rejected with.
      expect(await command.promise.catch((error: unknown) => error)).toBe(proxyError);
      expect(rec.seal().touches).toMatchObject([
        { station: "redis", command: "GET", key: "reference", outcome: "not_ready" },
      ]);
    } finally {
      raw.disconnect();
      coldForProxy.disconnect();
    }
  });
});

describe("TouchPlugin", () => {
  it("records a select's table and never its parameter", async () => {
    const rec = recorder();
    const db = harness.deps.db.withPlugin(new TouchPlugin(rec));
    const rows = await db
      .selectFrom("articles")
      .select("id")
      .where("title", "=", "quokka-distinctive-parameter")
      .execute();

    expect(rows).toEqual([]);
    const touches = rec.seal().touches;
    expect(touches).toMatchObject([
      { station: "postgres", operation: "select", tables: ["articles"], outcome: "ok" },
    ]);
    expect(JSON.stringify(touches)).not.toContain("quokka");
  });

  it("records statements inside a transaction, and returns the same rows untraced", async () => {
    const rec = recorder();
    const db = harness.deps.db.withPlugin(new TouchPlugin(rec));
    const count = (client: typeof db) =>
      client.selectFrom("topics").select((eb) => eb.fn.countAll().as("n")).execute();

    const traced = await db.transaction().execute(async (trx) => {
      await sql`select 1`.execute(trx);
      return count(trx);
    });

    expect(traced).toEqual(await count(harness.deps.db));
    expect(rec.seal().touches.map((t) => (t.station === "postgres" ? t.operation : null))).toEqual([
      "raw",
      "select",
    ]);
  });

  it("leaves a failed statement open, since Kysely never reports the throw", async () => {
    const rec = recorder();
    const db = harness.deps.db.withPlugin(new TouchPlugin(rec));
    await expect(sql`select 'quokka'::int`.execute(db)).rejects.toThrow();
    expect(rec.seal().touches).toMatchObject([{ station: "postgres", ms: null, outcome: "open" }]);
  });

  it("never ends the pool it shares with the boot db", async () => {
    const db = harness.deps.db.withPlugin(new TouchPlugin(recorder()));
    await sql`select 1`.execute(db);
    // Still querying through the untraced handle.
    const { rows } = await sql<{ one: number }>`select 1 as one`.execute(harness.deps.db);
    expect(rows).toEqual([{ one: 1 }]);
  });
});

describe("traceNewsClient", () => {
  it("rethrows the upstream's own error instance and records the refusal", async () => {
    const quota = new NewsQuotaError("burst window spent");
    const client = {
      provider: "stub",
      limits: { maxPageSize: 20 },
      search: async () => {
        throw quota;
      },
    };
    const rec = recorder();
    const traced = traceNewsClient(client, "currents", rec);

    const thrown = await traced.search().catch((error: unknown) => error);
    expect(thrown).toBe(quota);
    expect(traced.provider).toBe("stub");
    expect(traced.limits).toBe(client.limits);
    expect(rec.seal().touches).toMatchObject([
      {
        station: "currents",
        call: "search",
        priority: "interactive",
        outcome: "refused",
        failure: "quota",
      },
    ]);
  });

  it("keeps CountingClient's getter and counters working through the proxy", async () => {
    const rec = recorder();
    const traced = traceNewsClient(harness.counting, "currents", rec);
    expect(traced.limits).toEqual(harness.counting.limits);
    const before = harness.counting.referenceCalls;

    const languages = await traced.availableLanguages({ priority: "background" });

    expect(languages).toEqual(await harness.counting.availableLanguages());
    expect(harness.counting.referenceCalls - before).toBe(2);
    expect(rec.seal().touches).toMatchObject([
      { station: "currents", call: "available_languages", priority: "background", outcome: "ok" },
    ]);
  });
});

describe("traceGenerator", () => {
  const generator = (result: () => Promise<GenerateResult>): TextGenerator => ({
    generate: () => result(),
  });

  it("records ok, answered, unreachable and a throw, and returns or rethrows what it got", async () => {
    const rec = recorder();
    const answered: GenerateResult = { ok: false, reason: "blocked", failure: "answered" };
    const unreachable: GenerateResult = { ok: false, reason: "429", failure: "unreachable" };
    const boom = new Error("socket hang up");

    const ask = (result: GenerateResult, purpose: "label" | "summary") =>
      traceGenerator(generator(async () => result), rec, purpose).generate({ prompt: "p" });
    expect(await ask({ ok: true, text: "A Label" }, "label")).toEqual({ ok: true, text: "A Label" });
    expect(await ask(answered, "summary")).toBe(answered);
    expect(await ask(unreachable, "summary")).toBe(unreachable);
    await expect(
      traceGenerator(
        generator(async () => {
          throw boom;
        }),
        rec,
        "label",
      ).generate({ prompt: "p" }),
    ).rejects.toBe(boom);

    expect(
      rec
        .seal()
        .touches.map((t) => (t.station === "gemini" ? [t.purpose, t.outcome, t.failure ?? null] : null)),
    ).toEqual([
      ["label", "ok", null],
      ["summary", "refused", "answered"],
      ["summary", "failed", "unreachable"],
      ["label", "failed", "unknown"],
    ]);
  });
});

describe("traceQueue", () => {
  const job: SegmentJob = {
    fingerprint: "c".repeat(64),
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-02T00:00:00.000Z",
    startPage: 1,
    plane: "search",
  };

  /** A queue that records what reached it, and when. */
  function spyQueue(events: string[]) {
    const received: unknown[] = [];
    const queue = {
      name: harness.queue.name,
      enqueueSegment: async (j: SegmentJob) => {
        events.push("publish");
        received.push(j);
      },
      pendingCount: async () => 3,
    };
    return { queue, received };
  }

  it("links the job to the trace BEFORE publishing it, and publishes it untouched", async () => {
    const events: string[] = [];
    const traceId = randomUUID();
    const rec = recorder();
    const observed: TraceRuntime = {
      ...runtime,
      linkJob: async (jobId, links) => {
        events.push("link");
        return runtime.linkJob(jobId, links);
      },
    };
    const scope = createTouchScope({ recorder: rec, runtime: observed, traceId, parentLinks: null });
    const { queue, received } = spyQueue(events);
    const input = { ...job };

    await traceQueue(queue, scope, observed).enqueueSegment(input);
    written.push(traceJobKey(harness.queue.name, ingestJobId(job)));

    expect(events).toEqual(["link", "publish"]);
    expect(received[0]).toBe(input);
    expect(received[0]).toEqual(job);
    expect(ingestJobId(received[0] as SegmentJob)).toBe(ingestJobId(job));

    const jobKey = traceJobKey(harness.queue.name, ingestJobId(job));
    expect(await harness.redis.smembers(jobKey)).toEqual([`${traceId}|1`]);
    const pttl = await harness.redis.pttl(jobKey);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(runtime.ttlMs);

    const sealed = rec.seal();
    expect(sealed.touches).toMatchObject([
      { station: "queue", job: "segment", plane: "search", ref: "1", linked: true, outcome: "ok" },
    ]);
    expect(sealed.overheadMs).toBeGreaterThan(0);
  });

  it("publishes anyway when the link fails, and says the job is unlinked", async () => {
    const events: string[] = [];
    const rec = recorder();
    const failing: TraceRuntime = { ...runtime, linkJob: async () => false };
    const scope = createTouchScope({
      recorder: rec,
      runtime: failing,
      traceId: randomUUID(),
      parentLinks: null,
    });
    const { queue, received } = spyQueue(events);

    await traceQueue(queue, scope, failing).enqueueSegment(job);

    expect(received).toEqual([job]);
    expect(rec.seal().touches).toMatchObject([{ station: "queue", linked: false, outcome: "ok" }]);
  });

  it("rethrows a failed publish unchanged and records it failed", async () => {
    const rec = recorder();
    const scope = createTouchScope({ recorder: rec, runtime, traceId: null, parentLinks: null });
    const refused = new Error("queue down");
    const queue = {
      name: "q",
      enqueueSegment: async (_job: SegmentJob): Promise<void> => Promise.reject(refused),
    };

    await expect(traceQueue(queue, scope, runtime).enqueueSegment(job)).rejects.toBe(refused);
    expect(rec.seal().touches).toMatchObject([{ station: "queue", linked: false, outcome: "failed" }]);
  });

  it("reads the pending count as the ledger touch it is, and passes the name through", async () => {
    const rec = recorder();
    const scope = createTouchScope({ recorder: rec, runtime, traceId: null, parentLinks: null });
    const { queue } = spyQueue([]);
    const traced = traceQueue(queue, scope, runtime);

    expect(traced.name).toBe(harness.queue.name);
    expect(await traced.pendingCount()).toBe(3);
    expect(rec.seal().touches).toMatchObject([
      { station: "redis", command: "ZCARD", key: "pending_ledger", outcome: "ok" },
    ]);
  });

  it("nests a run's children under each parent ref, dropping a parent already four deep", () => {
    const scope = createTouchScope({
      recorder: recorder(),
      runtime,
      traceId: null,
      parentLinks: [
        { traceId: "a", ref: "2" },
        { traceId: "b", ref: "1.1.1.1" },
      ],
    });
    expect(scope.linksFor("3")).toEqual([{ traceId: "a", ref: "2.3" }]);
  });
});

describe("createTouchScope.wrap", () => {
  it("replaces every traced member of the real bundles and passes the rest by identity", async () => {
    // The exhaustiveness pin: every key of every bag `buildServices` really
    // builds is in one list or the other, so a dependency added later is a
    // decision rather than a station the trace silently never sees.
    const services = await buildServices(
      traceConfig({ GEMINI_API_KEY: "test-key-never-used", GOOGLE_NEWS_ENABLED: "true" }),
      captureLog().log,
    );
    try {
      const known = new Set<string>([...TRACED_KEYS, ...PASS_THROUGH_KEYS]);
      const traced = new Set<string>(TRACED_KEYS);
      const scope = createTouchScope({
        recorder: recorder(),
        runtime: services.tracing!,
        traceId: randomUUID(),
        parentLinks: null,
      });
      for (const [name, bag] of [
        ["deps", services.deps],
        ["trendingDeps", services.trendingDeps],
        ["summarizeDeps", services.summarizeDeps],
      ] as const) {
        const keys = Object.keys(bag);
        expect(
          keys.filter((k) => !known.has(k)),
          `${name} has keys no list names`,
        ).toEqual([]);
        const wrapped = scope.wrap(bag) as unknown as Record<string, unknown>;
        const original = bag as unknown as Record<string, unknown>;
        for (const k of keys) {
          if (traced.has(k)) expect(wrapped[k], `${name}.${k}`).not.toBe(original[k]);
          else expect(wrapped[k], `${name}.${k}`).toBe(original[k]);
        }
      }
      // The deepening client and the labeler's model were really there to wrap.
      expect(Object.keys(services.deps)).toContain("deepening");
      const labeler = (scope.wrap(services.deps) as { labeler: { generator: unknown } }).labeler;
      expect(labeler.generator).not.toBe(services.deps.labeler?.generator);
      expect(labeler.generator).not.toBeNull();
      // One traced db for the three bags, not three.
      const [a, b] = [scope.wrap(services.deps), scope.wrap(services.summarizeDeps)];
      expect(a.db).toBe(b.db);
    } finally {
      await services.close();
    }
  });

  it("leaves a queue that is not an object, and a missing member, alone", () => {
    const scope = createTouchScope({ recorder: recorder(), runtime, traceId: null, parentLinks: null });
    const bag = { db: undefined, queue: null as unknown as IngestQueue, now: () => new Date() };
    const wrapped = scope.wrap(bag);
    expect(wrapped.db).toBeUndefined();
    expect(wrapped.queue).toBeNull();
    expect(wrapped.now).toBe(bag.now);
  });
});
