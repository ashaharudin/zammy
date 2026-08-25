import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import {
  InProcessQuotaGovernor,
  NewsQuotaError,
  type QuotaSnapshot,
} from "@zammy/news-client";
import { RedisQuotaGovernor, decodeObservation } from "./quota-redis.js";

/**
 * The shared quota governor (ARCHITECTURE 5.4, VERCEL-ALL-IN-SCOPE §3.4).
 *
 * `quota.test.ts` in `@zammy/news-client` is the behavioural spec this ports
 * for the burst half: the same sliding-window properties, asserted across TWO
 * governors rather than one, because "two governors do not double the ceiling"
 * is the entire reason this class exists. The daily budget and the interactive
 * reserve are delegated rather than reimplemented, so they are checked here
 * only for still being enforced — their own edge cases stay tested where they
 * are implemented.
 *
 * Against a real Redis, like every other suite that touches it: the Lua is the
 * part a bug lives in (atomicity, score formatting, the inclusive/exclusive
 * boundary) and a fake would assert our idea of Redis rather than Redis.
 */

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
const redis = new Redis(REDIS_URL);

afterAll(async () => {
  await redis.quit();
});

/** A fresh key namespace per test: the window outlives the process by design. */
const provider = (): string => `test-${randomUUID().slice(0, 12)}`;

/** Redis that answers every call with a fault — the fail-open path. */
function brokenRedis(): Redis {
  return {
    eval: () => Promise.reject(new Error("connection is closed")),
  } as unknown as Redis;
}

const snapshot = (over: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
  limit: 1000,
  remaining: 900,
  burstLimit: 60,
  burstRemaining: 55,
  resetTime: null,
  observedAt: new Date(),
  ...over,
});

describe("RedisQuotaGovernor — the burst window is shared", () => {
  it("counts two instances against one ceiling, which in-process counting cannot", async () => {
    // The day-one problem, stated as a test: the request function and the queue
    // consumer are separate instances holding the same Currents key, and
    // in-process counting lets each of them spend the whole 60/60s allowance.
    const shared = provider();
    const options = {
      redis,
      provider: shared,
      dailyLimit: 1000,
      burstLimit: 3,
      interactiveReserve: 0,
    };
    const requestPath = new RedisQuotaGovernor(options);
    const consumer = new RedisQuotaGovernor(options);

    await requestPath.reserve("interactive");
    await requestPath.reserve("interactive");
    await consumer.reserve("interactive");

    // The fourth call is the breach. It is refused on whichever instance makes
    // it, because the window belongs to the key rather than to the process.
    await expect(consumer.reserve("interactive")).rejects.toThrow(/across all instances/);
    await expect(requestPath.reserve("interactive")).rejects.toThrow(/across all instances/);

    // What the same pair of governors would have done before this class: two
    // in-process counters, each admitting the full three.
    const before = [
      new InProcessQuotaGovernor({ dailyLimit: 1000, burstLimit: 3, interactiveReserve: 0 }),
      new InProcessQuotaGovernor({ dailyLimit: 1000, burstLimit: 3, interactiveReserve: 0 }),
    ];
    for (const governor of before) {
      for (let i = 0; i < 3; i += 1) await governor.reserve("interactive");
    }
  });

  it("slides rather than tumbles, across instances", async () => {
    // The boundary case `quota.test.ts` pins for one process. It has to hold
    // across two, and it is where a Lua off-by-one would hide: the reserve path
    // expires `score <= cutoff` and the read path counts `score > cutoff`, so
    // one of them treating the boundary as the other does would report a slot
    // that is not free.
    let now = 1_700_000_000_000;
    const shared = provider();
    const options = {
      redis,
      provider: shared,
      dailyLimit: 1000,
      burstLimit: 3,
      interactiveReserve: 0,
      now: () => now,
    };
    const a = new RedisQuotaGovernor(options);
    const b = new RedisQuotaGovernor(options);

    const first = now;
    await a.reserve("interactive");
    now += 1_000;
    await b.reserve("interactive");
    now += 1_000;
    await a.reserve("interactive");

    now = first + 59_000;
    await expect(b.reserve("interactive")).rejects.toThrow(/across all instances/);

    // Past the first call's expiry, exactly one slot frees up — and it frees up
    // for whichever instance asks, not for the one that took it.
    now = first + 60_001;
    await expect(b.reserve("interactive")).resolves.toBeUndefined();
    await expect(a.reserve("interactive")).rejects.toThrow(/across all instances/);
  });

  it("says when a slot frees up, counting from the oldest call in the window", async () => {
    const now = 1_700_000_000_000;
    const governor = new RedisQuotaGovernor({
      redis,
      provider: provider(),
      dailyLimit: 1000,
      burstLimit: 1,
      interactiveReserve: 0,
      now: () => now,
    });

    await governor.reserve("interactive");
    await expect(governor.reserve("interactive")).rejects.toMatchObject({
      resetAt: new Date(now + 60_000),
    });
  });

  it("uses the provider's own window, not one shared shape", async () => {
    // GNews Free is 1/s. A governor that assumed the Currents minute would hold
    // its supplement back for sixty times too long.
    let now = 1_700_000_000_000;
    const governor = new RedisQuotaGovernor({
      redis,
      provider: provider(),
      dailyLimit: 100,
      burstLimit: 1,
      interactiveReserve: 0,
      burstWindowMs: 1_000,
      now: () => now,
    });

    await governor.reserve("interactive");
    await expect(governor.reserve("interactive")).rejects.toBeInstanceOf(NewsQuotaError);
    now += 1_001;
    await expect(governor.reserve("interactive")).resolves.toBeUndefined();
  });

  it("keeps two providers' budgets apart", async () => {
    const currents = new RedisQuotaGovernor({
      redis,
      provider: provider(),
      dailyLimit: 1000,
      burstLimit: 1,
      interactiveReserve: 0,
    });
    const gnews = new RedisQuotaGovernor({
      redis,
      provider: provider(),
      dailyLimit: 100,
      burstLimit: 1,
      interactiveReserve: 0,
    });

    await currents.reserve("interactive");
    await expect(currents.reserve("interactive")).rejects.toBeInstanceOf(NewsQuotaError);
    // Spending one provider's burst must not touch the other's.
    await expect(gnews.reserve("interactive")).resolves.toBeUndefined();
  });
});

describe("RedisQuotaGovernor — the daily budget is still the delegate's", () => {
  it("refuses once the day is spent, exactly as the in-process governor does", async () => {
    const governor = new RedisQuotaGovernor({
      redis,
      provider: provider(),
      dailyLimit: 2,
      burstLimit: 60,
      interactiveReserve: 0,
    });

    await governor.reserve("interactive");
    await governor.reserve("interactive");
    await expect(governor.reserve("interactive")).rejects.toThrow(/daily quota exhausted/);
  });

  it("still holds back the interactive reserve from background work", async () => {
    const governor = new RedisQuotaGovernor({
      redis,
      provider: provider(),
      dailyLimit: 300,
      burstLimit: 60,
      interactiveReserve: 250,
    });

    for (let i = 0; i < 50; i += 1) await governor.reserve("background");

    await expect(governor.reserve("background")).rejects.toThrow(/interactive reserve/);
    await expect(governor.reserve("interactive")).resolves.toBeUndefined();
  });
});

describe("RedisQuotaGovernor — fail-open", () => {
  it("degrades to in-process counting rather than refusing the call", async () => {
    // §3.4's decided posture: an Upstash blip costs us exactly the behaviour we
    // had before this class, never "no upstream calls at all" (§11: degraded,
    // not down). The refusal that eventually arrives is the LOCAL window's —
    // the message is the discriminator, and it is the point: the ceiling is
    // still enforced, just once per instance again.
    const warnings: string[] = [];
    const governor = new RedisQuotaGovernor({
      redis: brokenRedis(),
      provider: provider(),
      dailyLimit: 1000,
      burstLimit: 2,
      interactiveReserve: 0,
      log: { warn: (_fields, message) => void warnings.push(message) },
    });

    await expect(governor.reserve("interactive")).resolves.toBeUndefined();
    await expect(governor.reserve("interactive")).resolves.toBeUndefined();
    const refusal = await governor.reserve("interactive").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(NewsQuotaError);
    expect((refusal as Error).message).toMatch(/burst limit of 2 calls/);
    expect((refusal as Error).message).not.toMatch(/across all instances/);

    // The outage is worth a line, and worth exactly one: Redis being down
    // produces a fault on every upstream call, and on Hobby the platform log is
    // the only place the quota governor is visible at all (§7).
    expect(warnings).toHaveLength(1);
  });

  it("reports what it knows when the shared state cannot be read", async () => {
    const governor = new RedisQuotaGovernor({
      redis: brokenRedis(),
      provider: provider(),
      dailyLimit: 10,
      burstLimit: 5,
      interactiveReserve: 0,
    });

    await governor.reserve("interactive");
    await expect(governor.peek()).resolves.toMatchObject({
      dailyRemaining: 9,
      burstRemaining: 4,
    });
  });

  it("keeps observing locally when the shared write fails", async () => {
    const governor = new RedisQuotaGovernor({
      redis: brokenRedis(),
      provider: provider(),
      dailyLimit: 1000,
      burstLimit: 60,
      interactiveReserve: 0,
    });

    await governor.observe(snapshot({ remaining: 4 }));
    // Sharing the reading is an optimisation for the other instances; learning
    // it is not optional for this one.
    await expect(governor.peek()).resolves.toMatchObject({ dailyRemaining: 4 });
  });
});

describe("RedisQuotaGovernor — the observation is shared", () => {
  it("lets an instance that has called nothing report what upstream last said", async () => {
    // Without this key, a cold instance's /readyz reports the full allowance
    // purely because it has not spent any of it yet — which reads as health and
    // is the opposite of information.
    const shared = provider();
    const options = {
      redis,
      provider: shared,
      dailyLimit: 1000,
      burstLimit: 60,
      interactiveReserve: 0,
    };
    const caller = new RedisQuotaGovernor(options);
    const cold = new RedisQuotaGovernor(options);

    const observedAt = new Date();
    await caller.observe(snapshot({ remaining: 12, observedAt }));

    const view = await cold.peek();
    expect(view.observed?.remaining).toBe(12);
    expect(view.observed?.observedAt).toEqual(observedAt);
  });

  it("never lets a stale reading overwrite a newer one", async () => {
    // Two instances calling concurrently finish in whatever order the network
    // decides, and `observe` is only ever allowed to raise our idea of usage.
    // A last-write-wins SET would let the slower response loosen the budget.
    const shared = provider();
    const options = {
      redis,
      provider: shared,
      dailyLimit: 1000,
      burstLimit: 60,
      interactiveReserve: 0,
    };
    const fast = new RedisQuotaGovernor(options);
    const slow = new RedisQuotaGovernor(options);
    const cold = new RedisQuotaGovernor(options);

    const late = new Date();
    const early = new Date(late.getTime() - 5_000);
    await fast.observe(snapshot({ remaining: 3, observedAt: late }));
    await slow.observe(snapshot({ remaining: 900, observedAt: early }));

    expect((await cold.peek()).observed?.remaining).toBe(3);
  });

  it("narrows the reported burst by the shared window without mutating it", async () => {
    const shared = provider();
    const now = 1_700_000_000_000;
    const options = {
      redis,
      provider: shared,
      dailyLimit: 1000,
      burstLimit: 4,
      interactiveReserve: 0,
      now: () => now,
    };
    const busy = new RedisQuotaGovernor(options);
    const cold = new RedisQuotaGovernor(options);

    await busy.reserve("interactive");
    await busy.reserve("interactive");
    await busy.reserve("interactive");

    // The cold instance has spent nothing, so its own count says 4. The shared
    // window says 1, and that is the number that matters.
    expect((await cold.peek()).burstRemaining).toBe(1);
    // Reading it twice gives the same answer: /readyz must not spend budget.
    expect((await cold.peek()).burstRemaining).toBe(1);
    await expect(cold.reserve("interactive")).resolves.toBeUndefined();
    await expect(cold.reserve("interactive")).rejects.toThrow(/across all instances/);
  });

  it("discards an observation from a day that has already reset", async () => {
    // A snapshot's `remaining` describes the budget of the day it was taken in.
    // Carrying yesterday's across midnight would report a spent day that has
    // already reopened — the reason `rollDay` drops one.
    const shared = provider();
    const yesterday = Date.UTC(2026, 7, 24, 23, 59, 0);
    const writer = new RedisQuotaGovernor({
      redis,
      provider: shared,
      dailyLimit: 1000,
      burstLimit: 60,
      interactiveReserve: 0,
      now: () => yesterday,
    });
    await writer.observe(snapshot({ remaining: 1, observedAt: new Date(yesterday) }));

    const today = new RedisQuotaGovernor({
      redis,
      provider: shared,
      dailyLimit: 1000,
      burstLimit: 60,
      interactiveReserve: 0,
      now: () => Date.UTC(2026, 7, 25, 0, 0, 1),
    });
    const view = await today.peek();
    expect(view.observed).toBeNull();
    expect(view.dailyRemaining).toBe(1000);
  });

  it("does not let a shared observation wedge a cold instance shut", async () => {
    // The trap `peek`'s comment names. Feeding the shared snapshot back into the
    // delegate looks like an improvement, and a reading whose `burstRemaining`
    // was 0 would then refuse this instance's calls — and refusing calls means
    // never earning the response that would correct it. The shared WINDOW is
    // what enforces the ceiling; the snapshot is only ever reported.
    const shared = provider();
    const options = {
      redis,
      provider: shared,
      dailyLimit: 1000,
      burstLimit: 60,
      interactiveReserve: 0,
    };
    await new RedisQuotaGovernor(options).observe(
      snapshot({ burstRemaining: 0, remaining: 800 }),
    );

    await expect(
      new RedisQuotaGovernor(options).reserve("interactive"),
    ).resolves.toBeUndefined();
  });
});

describe("decodeObservation", () => {
  it("reads back what the governor wrote", async () => {
    const shared = provider();
    const observedAt = new Date("2026-08-25T10:00:00.000Z");
    const resetTime = new Date("2026-08-26T00:00:00.000Z");
    await new RedisQuotaGovernor({
      redis,
      provider: shared,
      dailyLimit: 1000,
      burstLimit: 60,
      interactiveReserve: 0,
    }).observe(snapshot({ remaining: 7, resetTime, observedAt }));

    const raw = await redis.get(`quota:${shared}:observed`);
    expect(decodeObservation(raw ?? "")).toEqual({
      limit: 1000,
      remaining: 7,
      burstLimit: 60,
      burstRemaining: 55,
      resetTime,
      observedAt,
    });
  });

  it("reads anything it cannot understand as no information at all", () => {
    // A key written by an older build, a truncated value, a hand-edited one:
    // this is a cache read, and none of them may take the request path down.
    expect(decodeObservation("")).toBeNull();
    expect(decodeObservation("no separator here")).toBeNull();
    expect(decodeObservation("123|not json")).toBeNull();
    expect(decodeObservation("123|null")).toBeNull();
    expect(decodeObservation('123|{"limit":1000}')).toBeNull();
    expect(decodeObservation('123|{"limit":"lots","remaining":1}')).toBeNull();
  });
});
