import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Make `@fastify/rate-limit`'s fail-open path visible
 * (MEASUREMENT-RATE-LIMIT-FAIL-OPEN §3.3, §4 lever 3).
 *
 * `server.ts` registers the limiter with `skipOnError: true`, which is the
 * deliberate posture — Redis down costs us the ceiling, never the request, the
 * same trade §3.4's governor and the page cache take. Nothing here changes
 * that. What it changes is that the trade stops being silent.
 *
 * The plugin's own catch is the whole of its error handling:
 *
 * ```js
 * } catch (err) {
 *   if (!params.skipOnError) { throw err }
 * }
 * ```
 *
 * No log, no hook, no counter — so an instance holding an unusable Redis client
 * serves every request uncounted and says nothing. §3.2 is what that costs:
 * two long-lived instances, one of them blind, an effective ceiling of
 * `max ÷ (healthy fraction of the fleet)`, and 22 missing 429s that took
 * replaying archived log rows through the plugin's own Lua to find.
 *
 * ## Why the response headers rather than the plugin's internals
 *
 * `applyRateLimit` initialises `current = 0`, overwrites it only from the
 * store's answer, and reports `remaining: Math.max(0, max - current)`. The
 * store's `INCR` cannot return 0 — a counted request is `current >= 1` — so
 * **`remaining === max` happens if and only if the store threw and
 * `skipOnError` swallowed it.** Not a heuristic: it is the one arithmetic the
 * counted path cannot produce, it is what §2.1 verified against production, and
 * it is the number `server.ts`'s own registration comment already names.
 *
 * That leaves this reading the limiter's public output — three documented
 * response headers — instead of reaching into `@fastify/rate-limit`'s private
 * paths. The alternatives both buy the underlying error's name at the cost of
 * that coupling: wrapping the ioredis client to intercept the `rateLimit`
 * command binds us to a command name `RedisStore` chose, and a custom `store`
 * means reimplementing Lua the package does not export. The cause is one grep
 * away in the platform log either way (`buildServices` logs `redis error`, and
 * §3.3 names `Stream isn't writeable …` as the shape to expect); the
 * *consequence* is what nothing recorded, and the consequence is exactly what
 * the headers state.
 *
 * `reset` is carried as a field rather than tested. `remaining === max` is
 * already exact, and a second conjunct that cannot independently be false is a
 * liability, not a belt-and-braces.
 */

/**
 * The one line an operator greps for, phrased as the consequence.
 *
 * "Redis threw" is the cause and says nothing about what it cost; the thing
 * worth waking up to is that this instance admitted a request without counting
 * it, so the deployment-wide ceiling is not `max` any more. Same register as
 * the quota governor's `shared burst window unavailable; counting in-process`,
 * which is the precedent this follows in shape and in discipline.
 */
export const RATE_LIMIT_FAIL_OPEN =
  "rate limit fail-open; this instance is not counting requests against the ceiling";

/**
 * One line per outage rather than one per request, matching
 * `quota-redis.ts`'s `FAILURE_LOG_INTERVAL_MS` exactly.
 *
 * The failure being logged is "Redis is unusable", which on the request path
 * produces a hit on *every* request for as long as it lasts. §4.1 measures one
 * ordinary reader at 26 requests a minute and bounds a low-latency one at ~46,
 * so an unthrottled line would spend a poll window writing forty copies of the
 * same fact into the only observability Hobby has (§7).
 *
 * An interval rather than a once-ever latch, for the reason the governor uses
 * one: an instance on Vercel can live for hours across a blip that heals and
 * returns, and a latch would report the first minute of that and then go quiet
 * for the rest — indistinguishable in the log from a fleet that is fine.
 */
export const FAIL_OPEN_LOG_INTERVAL_MS = 60_000;

/** The narrowest logger this needs; Fastify's own satisfies it. */
export interface FailOpenLogger {
  warn(fields: object, message: string): void;
}

export interface FailOpenWatchOptions {
  /** Defaults to the instance's own logger. */
  log?: FailOpenLogger;
  now?: () => number;
}

/**
 * Did this reply come back uncounted?
 *
 * `undefined` headers mean the limiter never ran for this route — `allowList`
 * matched, which is every non-`/api/` URL including the health checks — and
 * that is not a fail-open. The `limit > 0` guard covers the one configuration
 * where the signature would lie: with a ceiling of zero, a *counted* request is
 * immediately over the limit and is served 429 with `remaining: 0`, which equals
 * the limit. `RATE_LIMIT_PER_MINUTE` is `min(1)` in `@zammy/config` so
 * production cannot reach it, but the reading is the thing being exported here
 * and it should not be true for a request the limiter demonstrably counted.
 */
export function isFailOpen(limit: unknown, remaining: unknown): boolean {
  const max = toCount(limit);
  const left = toCount(remaining);
  if (max === null || left === null || max <= 0) return false;
  return left === max;
}

function toCount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Watch every reply for the fail-open signature and warn, throttled.
 *
 * `onResponse` rather than `onSend`: the reading is the same either way — the
 * limiter's hook runs at `onRequest`, long before both — and `onResponse` fires
 * after the bytes are on the wire, so an outage cannot add its own logging to
 * the latency of the requests it is already degrading.
 *
 * Returns nothing and decorates nothing: the counter below is per-instance
 * state, which is the unit the ceiling is broken in.
 */
export function watchRateLimitFailOpen(
  app: FastifyInstance,
  options: FailOpenWatchOptions = {},
): void {
  const log = options.log ?? app.log;
  const now = options.now ?? Date.now;

  /** Cumulative for the life of this instance, so a resumed line says how bad it got. */
  let failOpen = 0;
  let lastWarnedAt: number | null = null;

  app.addHook("onResponse", async (request, reply: FastifyReply) => {
    const limit = reply.getHeader("x-ratelimit-limit");
    const remaining = reply.getHeader("x-ratelimit-remaining");
    if (!isFailOpen(limit, remaining)) return;

    failOpen += 1;
    const at = now();
    if (lastWarnedAt !== null && at - lastWarnedAt < FAIL_OPEN_LOG_INTERVAL_MS) return;
    lastWarnedAt = at;

    log.warn(
      {
        limit,
        remaining,
        // Zero on this path by construction (the plugin's `ttl` is never
        // assigned when the store throws), so it is the corroborating half of
        // §2.1's signature rather than a duration anyone should read.
        reset: reply.getHeader("x-ratelimit-reset"),
        method: request.method,
        url: request.url,
        // How many requests this instance has served uncounted since boot,
        // INCLUDING the ones the throttle above kept out of the log — the
        // number that says whether this is a blip or half the traffic.
        failOpen,
      },
      RATE_LIMIT_FAIL_OPEN,
    );
  });
}
