import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterEach, describe, expect, it } from "vitest";
import {
  FAIL_OPEN_LOG_INTERVAL_MS,
  RATE_LIMIT_FAIL_OPEN,
  isFailOpen,
  watchRateLimitFailOpen,
} from "./rate-limit-fail-open.js";

/**
 * The fail-open watcher, driven through the REAL plugin and the REAL
 * `RedisStore` (MEASUREMENT-RATE-LIMIT-FAIL-OPEN §4 lever 3).
 *
 * The fake below is an ioredis stand-in, not a store stand-in. That matters:
 * `@fastify/rate-limit` builds its own `RedisStore` over whatever `redis` it is
 * handed, and `RedisStore.incr` is what turns a thrown command into the
 * `cb(err)` that `applyRateLimit`'s catch swallows. Substituting the store
 * instead would test a seam this repo does not run; substituting the client
 * exercises the plugin's arithmetic, its header writing and its `skipOnError`
 * branch exactly as production does — deterministically, and without a Redis.
 *
 * `RedisStore`'s constructor only calls `defineCommand` when the command is
 * missing, so defining `rateLimit`/`rateLimitRead` up front is what makes this
 * client "already scripted".
 */
interface FakeRedis {
  defineCommand(name: string, spec: unknown): void;
  rateLimit(...args: unknown[]): void;
  rateLimitRead(...args: unknown[]): void;
}

type StoreAnswer = { error: Error } | { current: number; ttl: number };

/** §3.3's reproduction, verbatim — the error a `reconnecting` client throws. */
const UNWRITEABLE = new Error(
  "Stream isn't writeable and enableOfflineQueue options is false",
);

function fakeRedis(answer: () => StoreAnswer): FakeRedis {
  const respond = (args: unknown[]): void => {
    const cb = args.at(-1) as (err: Error | null, res?: [number, number]) => void;
    const next = answer();
    if ("error" in next) cb(next.error);
    else cb(null, [next.current, next.ttl]);
  };
  return {
    defineCommand() {
      throw new Error("unreachable: the commands are already defined");
    },
    rateLimit: (...args) => respond(args),
    rateLimitRead: (...args) => respond(args),
  };
}

interface Line {
  fields: Record<string, unknown>;
  message: string;
}

interface Harness {
  app: FastifyInstance;
  lines: Line[];
  clock: { advance(ms: number): void };
}

async function build(
  answer: () => StoreAnswer,
  options: { max?: number; redis?: { status: string } } = {},
): Promise<Harness> {
  const app = Fastify({ logger: false });
  const lines: Line[] = [];
  let nowMs = 1_000_000;

  // The registration `server.ts` makes, narrowed to what the signature depends
  // on: the ceiling, the shared store, the allow list, and the posture.
  await app.register(rateLimit, {
    max: options.max ?? 5,
    timeWindow: 60_000,
    allowList: (request) => !request.url.startsWith("/api/"),
    redis: fakeRedis(answer) as never,
    nameSpace: "ratelimit:",
    skipOnError: true,
  });
  watchRateLimitFailOpen(app, {
    log: { warn: (fields, message) => lines.push({ fields: fields as Record<string, unknown>, message }) },
    now: () => nowMs,
    redis: options.redis,
  });
  app.get("/api/v1/reference", async () => ({ ok: true }));
  app.get("/healthz", async () => ({ ok: true }));
  await app.ready();

  return { app, lines, clock: { advance: (ms) => { nowMs += ms; } } };
}

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.app.close();
  harness = null;
});

const get = (app: FastifyInstance, url: string) => app.inject({ method: "GET", url });

describe("watchRateLimitFailOpen", () => {
  it("warns when the store throws and the request is served uncounted", async () => {
    harness = await build(() => ({ error: UNWRITEABLE }));

    const response = await get(harness.app, "/api/v1/reference");

    // The request is NOT rejected — `skipOnError` is the deliberate posture and
    // this change must not alter it.
    expect(response.statusCode).toBe(200);
    // §2.1's signature, straight off the wire.
    expect(response.headers["x-ratelimit-limit"]).toBe("5");
    expect(response.headers["x-ratelimit-remaining"]).toBe("5");
    expect(response.headers["x-ratelimit-reset"]).toBe("0");

    expect(harness.lines).toHaveLength(1);
    expect(harness.lines[0]?.message).toBe(RATE_LIMIT_FAIL_OPEN);
    expect(harness.lines[0]?.fields).toMatchObject({
      limit: 5,
      remaining: 5,
      reset: 0,
      method: "GET",
      url: "/api/v1/reference",
      failOpen: 1,
    });
  });

  /**
   * The mutation this kills is "warn on every rate-limited response". A counted
   * request leaves `remaining` at `max - current`, and `INCR` cannot return 0,
   * so the healthy path must be silent however many times it is driven.
   */
  it("stays silent when the store answers", async () => {
    let current = 0;
    harness = await build(() => ({ current: (current += 1), ttl: 60_000 }));

    for (let i = 0; i < 5; i += 1) {
      const response = await get(harness.app, "/api/v1/reference");
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-ratelimit-remaining"]).toBe(String(5 - (i + 1)));
    }

    expect(harness.lines).toEqual([]);
  });

  /** A 429 is the limiter working. It must never read as a fail-open. */
  it("stays silent when the ceiling is enforced", async () => {
    let current = 0;
    harness = await build(() => ({ current: (current += 1), ttl: 60_000 }));

    let limited = false;
    for (let i = 0; i < 20 && !limited; i += 1) {
      limited = (await get(harness.app, "/api/v1/reference")).statusCode === 429;
    }

    expect(limited).toBe(true);
    expect(harness.lines).toEqual([]);
  });

  /**
   * `allowList` short-circuits before any header is written, so a healthy
   * health check carries no rate-limit headers at all. Reading "no headers" as
   * "remaining equals limit" would put a warn on every `/healthz` scrape — and
   * on Vercel that is a cron-driven, permanent stream.
   */
  it("stays silent on routes the allow list exempts", async () => {
    harness = await build(() => ({ error: UNWRITEABLE }));

    const response = await get(harness.app, "/healthz");

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-ratelimit-limit"]).toBeUndefined();
    expect(harness.lines).toEqual([]);
  });

  /**
   * The discipline the quota governor set, and the reason this is a throttle
   * rather than a bare `log.warn`: §4.1 measures one reader at 26 requests a
   * minute, so an outage would otherwise write 26 identical lines a minute per
   * instance into the only log Hobby has.
   */
  it("writes one line per instance for a sustained outage, not one per request", async () => {
    harness = await build(() => ({ error: UNWRITEABLE }));

    for (let i = 0; i < 40; i += 1) {
      expect((await get(harness.app, "/api/v1/reference")).statusCode).toBe(200);
    }

    expect(harness.lines).toHaveLength(1);
    // And the line still says how wide the opening was, which is the whole
    // point of counting the suppressed ones rather than dropping them.
    expect(harness.lines[0]?.fields.failOpen).toBe(1);
  });

  /**
   * ...but it is an interval, not a latch. An instance living for hours across
   * a blip that heals and returns must not report the first minute and then be
   * indistinguishable from a healthy one.
   */
  it("speaks again after the interval, carrying the running total", async () => {
    harness = await build(() => ({ error: UNWRITEABLE }));

    for (let i = 0; i < 3; i += 1) await get(harness.app, "/api/v1/reference");
    expect(harness.lines).toHaveLength(1);

    // LITERAL, not `FAIL_OPEN_LOG_INTERVAL_MS - 1`: the symbolic form moves with
    // the constant, so shortening the interval to 5s would leave this green
    // while `deploy/vercel/README.md` went on promising an operator "one line a
    // minute per instance". The number is operator-facing, so it is pinned.
    harness.clock.advance(59_999);
    await get(harness.app, "/api/v1/reference");
    expect(harness.lines).toHaveLength(1);

    harness.clock.advance(1);
    await get(harness.app, "/api/v1/reference");
    expect(harness.lines).toHaveLength(2);
    // 5 uncounted requests so far, only 2 of them logged.
    expect(harness.lines[1]?.fields.failOpen).toBe(5);
    expect(FAIL_OPEN_LOG_INTERVAL_MS).toBe(60_000);
  });

  /**
   * Pinned for the same reason the interval above is: `deploy/vercel/README.md`
   * quotes this string verbatim as the operator's grep target. Every other test
   * compares against the exported constant, which is right — and leaves the
   * constant itself free to drift away from the documentation that names it.
   */
  it("keeps the message an operator was told to grep for", () => {
    expect(RATE_LIMIT_FAIL_OPEN).toBe(
      "rate limit fail-open; this instance is not counting requests against the ceiling",
    );
  });

  /**
   * The field that narrows down which mechanism reached this path, the headers
   * being identical for all of them. `ready` is a cold start that healed,
   * `reconnecting`/`close`/`end` is an instance still unusable when we looked,
   * and `connecting` is ambiguous between a handshake in flight and one timing
   * out — see the module comment, which has the measurements.
   */
  it("carries the client's status verbatim, whatever it is", async () => {
    // Plumbing only: the status is injected, so this pins the field and not the
    // claim in its name. That a REAL outage reads `reconnecting` is asserted in
    // `server.test.ts` against a real client; that a real cold start reads
    // `ready` rather than `connecting` is measured in the module comment, and is
    // why `ready` is one of the values here.
    for (const status of ["ready", "connecting", "reconnecting", "end"]) {
      harness = await build(() => ({ error: UNWRITEABLE }), { redis: { status } });
      await get(harness.app, "/api/v1/reference");
      expect(harness.lines[0]?.fields.redisStatus).toBe(status);
      await harness.app.close();
      harness = null;
    }
  });

  /** Optional, and its absence costs the consequence nothing. */
  it("still names the consequence with no client handed in", async () => {
    harness = await build(() => ({ error: UNWRITEABLE }));

    await get(harness.app, "/api/v1/reference");

    expect(harness.lines[0]?.message).toBe(RATE_LIMIT_FAIL_OPEN);
    expect(harness.lines[0]?.fields.redisStatus).toBeUndefined();
  });

  /**
   * A ceiling of zero makes a COUNTED request come back `limit: 0,
   * remaining: 0` — the only configuration in which the signature lies.
   * `@zammy/config` pins `RATE_LIMIT_PER_MINUTE` at `min(1)` so production
   * cannot reach it, but `isFailOpen` is exported and the guard is what keeps
   * the reading honest for a caller that does.
   */
  it("does not read a zero ceiling as a fail-open", async () => {
    let current = 0;
    harness = await build(() => ({ current: (current += 1), ttl: 60_000 }), { max: 0 });

    const response = await get(harness.app, "/api/v1/reference");

    expect(response.statusCode).toBe(429);
    expect(response.headers["x-ratelimit-limit"]).toBe("0");
    expect(response.headers["x-ratelimit-remaining"]).toBe("0");
    expect(harness.lines).toEqual([]);
  });
});

describe("isFailOpen", () => {
  it("reads the one arithmetic the counted path cannot produce", () => {
    // `INCR` returns >= 1, so `remaining` is at most `max - 1` when counted.
    expect(isFailOpen(60, 60)).toBe(true);
    expect(isFailOpen("60", "60")).toBe(true);
    expect(isFailOpen(60, 59)).toBe(false);
    expect(isFailOpen(60, 0)).toBe(false);
    // EQUALITY, not `>=`. The plugin clamps `remaining` at `max` so the two
    // are indistinguishable through it today, and this is where the predicate's
    // own contract is pinned: `remaining > limit` is a header nothing here
    // writes, so it is a source this reading knows nothing about rather than a
    // fail-open it has recognised.
    expect(isFailOpen(60, 61)).toBe(false);
    // No limiter ran: `allowList` matched.
    expect(isFailOpen(undefined, undefined)).toBe(false);
    expect(isFailOpen(60, undefined)).toBe(false);
    // A zero ceiling counts and still reports `remaining === limit`.
    expect(isFailOpen(0, 0)).toBe(false);
    // Header values arrive as whatever was set; nonsense is not a signal.
    expect(isFailOpen("many", "many")).toBe(false);
  });
});
