import { describe, expect, it, vi } from "vitest";
import {
  NewsAuthError,
  NewsCircuitOpenError,
  NewsInvalidQueryError,
} from "@zammy/news-client";
import { createMessageHandler, drainableFrom, type DeliveryMetadata } from "./vercel-queue.js";
import { MAX_INGEST_DELIVERIES } from "./ingest-queue-vercel.js";
import type { IngestJob, SegmentJob } from "./ingest-queue.js";

/**
 * The push-mode consumer's own behaviour, with no platform and no database.
 *
 * Everything asserted here is a way the queue could go wrong SILENTLY, which is
 * what makes it worth pinning: a job that runs but is never settled leaves the
 * topic reading `in_progress` until the fifteen-minute stale prune; a job that is
 * settled before it runs turns at-least-once into at-most-once; and a payload
 * that cannot be parsed spins until retention expires unless something decides
 * to drop it.
 */

const segment: SegmentJob = {
  fingerprint: "f".repeat(64),
  from: "2026-08-08T00:00:00.000Z",
  to: "2026-08-09T00:00:00.000Z",
  startPage: 1,
  plane: "search",
};

const delivery = (over: Partial<DeliveryMetadata> = {}): DeliveryMetadata => ({
  messageId: "msg-1",
  deliveryCount: 1,
  ...over,
});

const silent = { info: () => {}, warn: () => {} };

function drainable(dispatch: (job: IngestJob) => Promise<void>) {
  const settled: IngestJob[] = [];
  return {
    settled,
    drainable: {
      queue: { settle: async (job: IngestJob) => void settled.push(job) },
      dispatch,
    },
  };
}

describe("createMessageHandler", () => {
  it("dispatches the job and settles it once", async () => {
    const seen: IngestJob[] = [];
    const { settled, drainable: d } = drainable(async (job) => void seen.push(job));

    await createMessageHandler(d, silent)(segment, delivery());

    expect(seen).toEqual([segment]);
    expect(settled).toEqual([segment]);
  });

  it("settles only after the work is done, never before", async () => {
    // The property that keeps at-least-once honest. If the settle happened
    // first, a handler that then threw would leave a gap nothing is tracking
    // and nothing is going to fill.
    const order: string[] = [];
    const { drainable: d } = drainable(async () => {
      order.push("dispatch");
    });
    d.queue.settle = async () => void order.push("settle");

    await createMessageHandler(d, silent)(segment, delivery());

    expect(order).toEqual(["dispatch", "settle"]);
  });

  it("rethrows while retries remain, so the platform redelivers", async () => {
    const { settled, drainable: d } = drainable(async () => {
      throw new Error("transient upstream failure");
    });
    const handle = createMessageHandler(d, silent);

    await expect(handle(segment, delivery({ deliveryCount: 1 }))).rejects.toThrow(
      "transient upstream failure",
    );
    // Still outstanding: a job that will be attempted again is pending work.
    expect(settled).toEqual([]);
  });

  it("settles and gives up on the last delivery rather than spinning", async () => {
    // There is no dead-letter queue. Swallowing the error acknowledges the
    // message; settling is what stops the topic reading as warming. The gap the
    // job named is re-planned by the next reader who finds it unfilled.
    const { settled, drainable: d } = drainable(async () => {
      throw new Error("permanently broken");
    });
    const warn = vi.fn();

    await expect(
      createMessageHandler(d, { info: () => {}, warn })(
        segment,
        delivery({ deliveryCount: MAX_INGEST_DELIVERIES }),
      ),
    ).resolves.toBeUndefined();

    expect(settled).toEqual([segment]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("drops a payload it cannot read instead of retrying it forever", async () => {
    const { settled, drainable: d } = drainable(async () => {
      throw new Error("should never be dispatched");
    });
    const warn = vi.fn();

    await expect(
      createMessageHandler(d, { info: () => {}, warn })({ nonsense: true }, delivery()),
    ).resolves.toBeUndefined();

    // Nothing to settle: an unparseable payload has no job identity, so there
    // is no pending entry it could correspond to.
    expect(settled).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("drops a revoked key on the first delivery instead of spending the budget", async () => {
    // Three deliveries over ~610s cannot make a wrong API key right, and the two
    // repeats bury the cause in the log. An operator fixes this on a timescale
    // no retry budget reaches.
    const { settled, drainable: d } = drainable(async () => {
      throw new NewsAuthError("upstream rejected the API key (401)");
    });
    const warn = vi.fn();

    await expect(
      createMessageHandler(d, { info: () => {}, warn })(
        segment,
        delivery({ deliveryCount: 1 }),
      ),
    ).resolves.toBeUndefined();

    // Settled, not just swallowed: an unsettled entry nobody will attempt again
    // holds the topic at `in_progress` until the fifteen-minute stale prune.
    expect(settled).toEqual([segment]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("keeps retrying a 400, which heals across deliveries", async () => {
    // The production case of 2026-08-26, and the reason `invalid_query` is not
    // on the drop list despite `retryable: false`. `clampSearchParams` runs per
    // request against a fresh `now`, so that lookback violation really did
    // succeed on its second delivery — dropping it would convert a self-healing
    // retry into permanent loss. It is also the 4xx catch-all, so a proxy's 408
    // arrives wearing this kind.
    const { settled, drainable: d } = drainable(async () => {
      throw new NewsInvalidQueryError("upstream rejected our query (400)", {
        date_range: "Max lookback is 30 days",
      });
    });

    await expect(
      createMessageHandler(d, silent)(segment, delivery({ deliveryCount: 1 })),
    ).rejects.toThrow("upstream rejected our query");
    expect(settled).toEqual([]);
  });

  it("keeps retrying an open circuit, which the retryable flag would have dropped", async () => {
    // The reason the consumer reads a kind list and not `retryable`.
    // `NewsCircuitOpenError` is flagged non-retryable because an IMMEDIATE
    // retry is pointless — the cooldown is 30s and a redelivery is 305s away,
    // so it is one of the retries the budget exists for.
    const { settled, drainable: d } = drainable(async () => {
      throw new NewsCircuitOpenError("circuit open", new Date("2026-08-26T00:00:30Z"));
    });

    await expect(
      createMessageHandler(d, silent)(segment, delivery({ deliveryCount: 1 })),
    ).rejects.toThrow("circuit open");
    expect(settled).toEqual([]);
  });

  it("routes a sample to the same dispatch a segment takes", async () => {
    // One mapping, in `ingestDispatch`. Two copies of that discriminant is one
    // place for a sample to start being processed as a segment on exactly one
    // of the two consumers.
    const seen: IngestJob[] = [];
    const { settled, drainable: d } = drainable(async (job) => void seen.push(job));

    await createMessageHandler(d, silent)({ kind: "sample", language: "en" }, delivery());

    expect(seen).toEqual([{ kind: "sample", language: "en" }]);
    expect(settled).toEqual([{ kind: "sample", language: "en" }]);
  });
});

/**
 * The boot's Redis wait — the drain's production 500 of 2026-08-26, caught in
 * the one other place it could still happen.
 *
 * `buildServices` connects its client in the background on purpose (server.ts:
 * "Redis is pure cache: never let a reconnect storm block a request that
 * Postgres could have served"), so this boot has to wait for it before a
 * delivery can reach `tryAcquire`. What these pin is ORDERING, which is exactly
 * what the rest of this file cannot: every other test here is handed a
 * `Drainable` that already exists.
 *
 * The bug was never a wrong wait, it was the absence of one, so a fake client
 * that stays `connecting` is the whole apparatus. `waitForRedis` itself is
 * pinned in `redis-ready.test.ts`.
 */
describe("drainableFrom", () => {
  /** ioredis' `status` plus the two events the wait subscribes to. */
  const fakeRedis = (status: string) => {
    const handlers = new Map<string, Array<() => void>>();
    return {
      status,
      once(event: string, fn: () => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), fn]);
        return this;
      },
      off(event: string, fn: () => void) {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((h) => h !== fn),
        );
        return this;
      },
      emit(event: string) {
        for (const fn of [...(handlers.get(event) ?? [])]) fn();
      },
    };
  };

  const services = (redis: object, close: () => Promise<void> = async () => {}) => ({
    redis,
    queue: { settle: async () => {}, name: "ingest" },
    deps: {},
    trendingDeps: {},
    close,
  });

  it("does not hand back a drainable while Redis is still connecting", async () => {
    // The race itself. With `enableOfflineQueue: false` a command written now
    // throws `Stream isn't writeable` rather than waiting, and the handlers only
    // survive it today because both make a Postgres round trip first.
    const redis = fakeRedis("connecting");
    let settledTo: unknown = null;
    const booting = drainableFrom(services(redis) as never).then((d) => (settledTo = d));

    // Several turns of the microtask queue: enough for anything that was not
    // actually waiting on the connection to have resolved.
    await Promise.resolve();
    await Promise.resolve();
    expect(settledTo).toBeNull();

    redis.emit("ready");
    await booting;
    expect(settledTo).not.toBeNull();
  });

  it("returns a drainable over the services' own queue once Redis is ready", async () => {
    const built = services(fakeRedis("ready"));
    const drainable = await drainableFrom(built as never);

    // The same queue object, not a second one: this consumer settles into the
    // pending registry the read path polls.
    expect(drainable.queue).toBe(built.queue);
    expect(typeof drainable.dispatch).toBe("function");
  });

  it("fails the boot, naming Redis, when the connection ends before it is ready", async () => {
    // Rejecting HERE rather than later is the point of the whole change. A boot
    // that fails is dropped by `bootOnce` and retried on the next delivery, and
    // the log line says redis; a boot that succeeded onto a dead client fails
    // instead inside `tryAcquire`, three lines from "segment ... is locked;
    // retrying later" — which is a different problem with a different fix.
    const redis = fakeRedis("connecting");
    const booting = drainableFrom(services(redis) as never);
    redis.emit("end");

    await expect(booting).rejects.toThrow(/redis connection ended before it was ready/);
  });

  it("closes the services when the wait fails, so a retried boot does not leak", async () => {
    // `buildServices` unwinds its OWN failures; this wait is a layer above it,
    // and `bootOnce` drops a failed boot so the next delivery builds a fresh
    // pool and client. Without this close the previous pair stay open with
    // nothing referencing them — a DATABASE_POOL_MAX-sized pool per retry,
    // against a free-tier connection budget (server.ts:172).
    const redis = fakeRedis("connecting");
    const closed = vi.fn(async () => {});
    const booting = drainableFrom(services(redis, closed) as never);
    redis.emit("end");

    await expect(booting).rejects.toThrow(/ended before it was ready/);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("does not close the services on the happy path", async () => {
    // The mirror of the above: closing a healthy boot would tear down the pool
    // the dispatch is about to use.
    const closed = vi.fn(async () => {});
    await drainableFrom(services(fakeRedis("ready"), closed) as never);
    expect(closed).not.toHaveBeenCalled();
  });

  it("reports the wait's failure, not the close's", async () => {
    // A `pool.end()` that rejects on a half-open connection must not become the
    // reason the boot failed — the operator needs "redis", not whatever the
    // teardown made of it.
    const redis = fakeRedis("connecting");
    const booting = drainableFrom(
      services(redis, async () => {
        throw new Error("pool teardown exploded");
      }) as never,
    );
    redis.emit("end");

    await expect(booting).rejects.toThrow(/ended before it was ready/);
  });
});
