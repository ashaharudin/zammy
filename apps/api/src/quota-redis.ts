import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Config } from "@zammy/config";
import {
  DEFAULT_BURST_WINDOW_MS,
  InProcessQuotaGovernor,
  NewsQuotaError,
  utcDayKey,
  type CallPriority,
  type QuotaBounds,
  type QuotaGovernor,
  type QuotaSnapshot,
  type QuotaView,
} from "@zammy/news-client";

/**
 * The shared half of quota governance (ARCHITECTURE 5.4,
 * VERCEL-ALL-IN-SCOPE §3.4).
 *
 * `InProcessQuotaGovernor` counts in memory, which is correct for one process
 * that stays up and wrong the moment there are several. On Vercel there are
 * always several — the request function and the push-mode consumer scale
 * independently and neither is one instance — so **the 60/60s burst ceiling is
 * breached N times over by N instances, each believing it holds the whole
 * allowance**. That is the day-one problem, and it is the one this class fixes.
 *
 * Two things live in Redis, and only two:
 *
 *   - **The burst window**, as a sorted set of call timestamps scored by when
 *     they happened. Every instance adds to the same set and reads the same
 *     count, so the ceiling is enforced once across the deployment rather than
 *     once per instance.
 *   - **The last observation**, written where any instance can read it. Currents
 *     reports `x-ratelimit-*` on every response and one instance's reading is
 *     the truth for all of them; without this key a cold instance's `/readyz`
 *     reports the full allowance simply because it has not called yet.
 *
 * **What is deliberately NOT here is the day-rolling ledger.** The daily budget
 * and the interactive reserve stay in the in-process delegate, per §0's scoping:
 * the daily count's only real customer is a provider that reports no headers,
 * Currents self-corrects its daily number from headers one call after each cold
 * start (which `quota.ts` itself calls tolerable), and GNews is off by default.
 * **Enabling GNews requires building the Redis daily ledger first** — the
 * deferral and the `GNEWS_ENABLED=false` default are one decision, not two.
 *
 * **Fail-open, always.** Every Redis path here degrades to the in-process
 * counting that exists today, which is the same posture the page cache (§7.1),
 * the single-flight lock (§6.3) and the per-topic budget (§9.4) already take.
 * An Upstash blip must cost us exactly today's behaviour, never "no upstream
 * calls at all" — a governor that failed closed would turn a cache outage into
 * an outage.
 */

/**
 * How long the shared observation survives. A day, because that is the longest
 * it could still describe the current daily window; the same-day guard in
 * `peek` is what actually decides whether it is used, and the TTL is only here
 * so an abandoned provider's key does not outlive the deployment.
 */
const OBSERVATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Never warn more than once a minute about the same outage. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

/**
 * The one line an operator is told to grep for.
 *
 * `deploy/vercel/README.md` and VERCEL-ALL-IN-SCOPE both name this exact string
 * as the signal that the burst ceiling is unenforced, which is why the warn
 * budget below is per-MESSAGE rather than one budget shared by every Redis
 * fault in this file: an outage makes `peek` and `observe` fail too, and a
 * single budget would let a `/readyz` scrape consume the minute and leave the
 * operator running unenforced with only the other message in the log.
 */
const BURST_UNAVAILABLE = "shared burst window unavailable; counting in-process";

/**
 * Take a slot in the shared burst window, atomically.
 *
 * Atomic because the whole point is concurrent instances: a read-then-write
 * from N functions at once would admit N calls into the last free slot, which
 * is the per-instance breach this class exists to stop, merely moved into
 * Redis. Every number is formatted by the caller and passed as an argument —
 * nothing is computed in Lua — so the script has no clock, no randomness and no
 * float formatting of its own to get wrong.
 *
 * Returns `{admitted, oldestScore}`. `oldestScore` is when the window's oldest
 * surviving call happened, which is what the refusal's `resetAt` is built from:
 * a slot frees up exactly one window after it was taken.
 */
const RESERVE_BURST = `
local cutoff = ARGV[1]
local limit = tonumber(ARGV[2])
local score = ARGV[3]
local member = ARGV[4]
local windowMs = ARGV[5]

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
local used = redis.call('ZCARD', KEYS[1])
if used >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, math.floor(tonumber(oldest[2]) or 0)}
end

redis.call('ZADD', KEYS[1], score, member)
redis.call('PEXPIRE', KEYS[1], windowMs)
return {1, 0}
`;

/**
 * Write the observation, but never backwards.
 *
 * Responses can be observed out of order — two instances calling concurrently
 * finish in whatever order the network decides — and `observe` is only ever
 * allowed to RAISE our idea of usage (`quota.ts`). A last-write-wins `SET`
 * would let a stale reading loosen the shared number, which is the one
 * direction this key must not move.
 *
 * The comparison is on a `<observedAtMs>|<json>` prefix rather than on a
 * decoded field, so the script needs no `cjson`: string ops only, which is the
 * subset every Redis-compatible server agrees on. Upstash is the one we
 * actually deploy against and the reason not to assume the full library.
 */
const WRITE_OBSERVATION = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local sep = string.find(existing, '|', 1, true)
  if sep then
    local previous = tonumber(string.sub(existing, 1, sep - 1))
    if previous and previous > tonumber(ARGV[1]) then return 0 end
  end
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

/**
 * Read both shared facts without touching either. `ZCOUNT` rather than the
 * expire-then-count `reserve` does, because `peek` is called by `/readyz` and a
 * health check must never mutate the thing it reports on.
 */
const READ_SHARED = `
local used = redis.call('ZCOUNT', KEYS[1], ARGV[1], '+inf')
local observation = redis.call('GET', KEYS[2])
return {used, observation or ''}
`;

export interface QuotaLogger {
  warn(fields: object, message: string): void;
}

export interface RedisQuotaOptions extends QuotaBounds {
  redis: Redis;
  /**
   * Provider name, and the key namespace with it. Never shared between
   * providers: each has its own budget, its own tier and its own reset, so one
   * key holding "the quota" would make Currents' spend refuse a GNews call.
   */
  provider: string;
  /** Defaults to `DEFAULT_BURST_WINDOW_MS`; GNews Free is a second, not a minute. */
  burstWindowMs?: number;
  now?: () => number;
  log?: QuotaLogger;
  /**
   * What this governor falls open to, and what owns the daily budget. Injected
   * for the tests; nothing in production passes one.
   */
  fallback?: QuotaGovernor;
}

export class RedisQuotaGovernor implements QuotaGovernor {
  private readonly redis: Redis;
  private readonly bounds: QuotaBounds;
  private readonly burstWindowMs: number;
  private readonly now: () => number;
  private readonly log: QuotaLogger | undefined;
  private readonly provider: string;
  private readonly local: QuotaGovernor;
  private readonly burstKey: string;
  private readonly observationKey: string;
  /**
   * Per-message, and absent means "never warned" — not "warned at the epoch".
   * A numeric field initialised to 0 silently swallows the FIRST line of an
   * outage under any injected clock below the interval, which is every test
   * that fakes `now` and would be the one line that mattered.
   */
  private readonly lastWarnedAt = new Map<string, number>();

  constructor(options: RedisQuotaOptions) {
    this.redis = options.redis;
    this.bounds = options;
    this.burstWindowMs = options.burstWindowMs ?? DEFAULT_BURST_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log;
    this.provider = options.provider;
    this.local =
      options.fallback ??
      new InProcessQuotaGovernor({
        dailyLimit: options.dailyLimit,
        burstLimit: options.burstLimit,
        interactiveReserve: options.interactiveReserve,
        burstWindowMs: this.burstWindowMs,
        ...(options.now ? { now: options.now } : {}),
      });
    // §7.1's key convention: <purpose>:<scope>:<what>.
    this.burstKey = `quota:${options.provider}:burst`;
    this.observationKey = `quota:${options.provider}:observed`;
  }

  /**
   * Pre-flight: take a slot in the shared window, ask the delegate, and **give
   * the slot back if the delegate says no.**
   *
   * The window must count calls that HAPPEN. Charging it for calls that were
   * then refused is not a conservative rounding error, it is a feedback loop:
   * every refusal writes a *fresh* timestamp, so a steady stream of refusals
   * keeps the window permanently full and the ceiling never drains. The shape
   * that makes this concrete is the one the interactive reserve exists to
   * prevent, inverted — past `INTERACTIVE_RESERVE` the consumer's background
   * calls are all refused, `transport.ts` reserves once per ATTEMPT, and sixty
   * refusals in a minute would pin `quota:currents:burst` at its ceiling and
   * refuse a live user search with 250 daily calls unspent and not one upstream
   * call made. An earlier version of this method did exactly that.
   *
   * The order is still shared-first, because the alternative — delegate first —
   * records a DAY's spend for a call the window then refuses, and the day does
   * not expire. Shared-first plus a release is the only arrangement where
   * neither counter charges for a call that was never made.
   *
   * Two things the release is not: it is not a lock (nothing waits on it), and
   * it is not required for correctness of the ceiling — a release that fails
   * leaves one slot held for at most one window, which is the bounded version
   * of the bug above rather than the unbounded one.
   *
   * The delegate is still asked second and unconditionally, for the daily
   * budget, the interactive reserve, and to keep its in-memory window warm so
   * falling open lands on a governor that knows what this instance has done.
   * Note it CAN be the sole refuser — its `observed` clamp reads a
   * `burstRemaining` upstream reported, which accounts for spend by clients
   * that are not us — so this is a real path, not a theoretical one.
   */
  async reserve(priority: CallPriority): Promise<void> {
    const now = this.now();
    const gate = await this.gateBurst(now);
    if (gate && !gate.admitted) {
      throw new NewsQuotaError(
        `burst limit of ${this.bounds.burstLimit} calls per ` +
          `${this.burstWindowMs}ms reached across all instances`,
        // `oldest` is 0 only when the window refused against an empty set,
        // which needs a burst limit of zero — config forbids it, but this class
        // is exported and takes the bound directly. Report a full window from
        // now rather than a date in 1970.
        new Date((gate.oldest || now) + this.burstWindowMs),
      );
    }
    try {
      await this.local.reserve(priority);
    } catch (error) {
      if (gate) await this.releaseBurst(gate.member);
      throw error;
    }
  }

  /**
   * Fold the observation in locally, then publish it.
   *
   * Locally first and unconditionally: the shared write is an optimisation for
   * everyone else, and this process must learn what upstream said whether or
   * not Redis is reachable.
   */
  async observe(snapshot: QuotaSnapshot): Promise<void> {
    await this.local.observe(snapshot);
    try {
      const observedAt = snapshot.observedAt.getTime();
      await this.redis.eval(
        WRITE_OBSERVATION,
        1,
        this.observationKey,
        String(observedAt),
        `${observedAt}|${JSON.stringify(encodeSnapshot(snapshot))}`,
        String(OBSERVATION_TTL_MS),
      );
    } catch (error) {
      this.warn(error, "quota observation not shared");
    }
  }

  /**
   * Best knowledge, local and shared merged — and a REPORT, never a decision.
   *
   * Note what this does not do: it never feeds the shared observation back into
   * the delegate. It would look like an improvement (a cold instance inheriting
   * what upstream last said instead of starting optimistic) and it is a trap.
   * `observe` only raises usage, so adopting a stale snapshot whose
   * `burstRemaining` was 0 would refuse this instance's calls — and refusing
   * calls means never earning the response that would correct it. A cold
   * instance would wedge itself shut. The shared BURST WINDOW is what enforces
   * the ceiling here; the snapshot only has to be readable.
   */
  async peek(): Promise<QuotaView> {
    const local = await this.local.peek();
    const shared = await this.readShared(this.now());
    if (!shared) return local;

    // Whichever reading is newer wins, because a snapshot is a moment and the
    // later moment is simply more true. A snapshot from a previous UTC day is
    // discarded rather than compared, for the reason `rollDay` discards one:
    // its `remaining` describes a budget that has already reset.
    const observed =
      shared.observation &&
      (!local.observed ||
        shared.observation.observedAt.getTime() > local.observed.observedAt.getTime())
        ? shared.observation
        : local.observed;

    return {
      // Still local, and still the deferred half of §3.4. Nothing shares the
      // day's count, so this number is this instance's count narrowed by
      // whatever headers it has seen — right for Currents one call after a cold
      // start, and the reason GNews stays off.
      dailyRemaining: local.dailyRemaining,
      burstRemaining: Math.min(
        local.burstRemaining,
        Math.max(0, this.bounds.burstLimit - shared.used),
      ),
      resetAt: observed?.resetTime ?? local.resetAt,
      observed,
    };
  }

  /** Null means Redis did not answer — the caller falls open. */
  private async gateBurst(
    now: number,
  ): Promise<{ admitted: boolean; oldest: number; member: string } | null> {
    // Unique per call: two calls in the same millisecond are two calls, and a
    // ZSET member keyed on the timestamp alone would silently collapse them
    // into one — under-counting exactly when the burst is worst. It is also
    // what `releaseBurst` needs to give back the right slot rather than
    // whichever one happens to share a timestamp.
    const member = `${now}:${randomUUID()}`;
    try {
      const result = (await this.redis.eval(
        RESERVE_BURST,
        1,
        this.burstKey,
        // Inclusive cutoff, matching the in-process window exactly: a call AT
        // the boundary has expired, a call after it has not.
        String(now - this.burstWindowMs),
        String(this.bounds.burstLimit),
        String(now),
        member,
        String(this.burstWindowMs),
      )) as [number, number];
      return { admitted: result[0] === 1, oldest: result[1], member };
    } catch (error) {
      this.warn(error, BURST_UNAVAILABLE);
      return null;
    }
  }

  /**
   * Give a slot back, because the call it was taken for is not going to happen.
   *
   * Unconditional `ZREM` rather than a read-modify-write: the member is unique
   * to this call, so removing it cannot touch anyone else's slot and there is
   * nothing to race against. Failure is swallowed for the reason `reserve`
   * gives — a held slot expires with the window.
   */
  private async releaseBurst(member: string): Promise<void> {
    try {
      await this.redis.zrem(this.burstKey, member);
    } catch (error) {
      this.warn(error, "shared burst slot not released; it expires with the window");
    }
  }

  /** Null means Redis did not answer — the caller reports local knowledge only. */
  private async readShared(
    now: number,
  ): Promise<{ used: number; observation: QuotaSnapshot | null } | null> {
    try {
      const result = (await this.redis.eval(
        READ_SHARED,
        2,
        this.burstKey,
        this.observationKey,
        // Exclusive, because `ZREMRANGEBYSCORE` above already removed the
        // boundary itself: counting it here would report a slot the reserve
        // path has already freed.
        `(${now - this.burstWindowMs}`,
      )) as [number, string];
      const observation = decodeObservation(result[1]);
      return {
        used: result[0],
        observation:
          observation && utcDayKey(observation.observedAt.getTime()) === utcDayKey(now)
            ? observation
            : null,
      };
    } catch (error) {
      this.warn(error, "shared quota state unavailable; reporting in-process counts");
      return null;
    }
  }

  /**
   * One line per outage rather than one per call. The failure mode being logged
   * is "Redis is down", which produces a line on every upstream call for as long
   * as it lasts — and on Hobby the platform log is the only observability the
   * quota governor has (§7), so drowning it is a real cost.
   */
  private warn(error: unknown, message: string): void {
    const now = this.now();
    const previous = this.lastWarnedAt.get(message);
    if (previous !== undefined && now - previous < FAILURE_LOG_INTERVAL_MS) return;
    this.lastWarnedAt.set(message, now);
    this.log?.warn({ err: error, provider: this.provider }, message);
  }
}

/** Dates as epoch milliseconds: JSON has no date, and an ISO string sorts worse. */
interface WireSnapshot {
  limit: number;
  remaining: number;
  burstLimit: number;
  burstRemaining: number;
  resetTime: number | null;
  observedAt: number;
}

function encodeSnapshot(snapshot: QuotaSnapshot): WireSnapshot {
  return {
    limit: snapshot.limit,
    remaining: snapshot.remaining,
    burstLimit: snapshot.burstLimit,
    burstRemaining: snapshot.burstRemaining,
    resetTime: snapshot.resetTime?.getTime() ?? null,
    observedAt: snapshot.observedAt.getTime(),
  };
}

/**
 * Decode, or decide we know nothing. Every failure path returns null rather
 * than throwing, because this is a cache read: a key written by an older build,
 * a truncated value, a hand-edited one — none of them may take the request path
 * down, and all of them mean the same thing here.
 */
export function decodeObservation(raw: string): QuotaSnapshot | null {
  const separator = raw.indexOf("|");
  if (separator < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(separator + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const wire = parsed as Partial<WireSnapshot>;
  const counts = [wire.limit, wire.remaining, wire.burstLimit, wire.burstRemaining];
  if (counts.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    return null;
  }

  // Dates are checked for REPRESENTABILITY, not merely for being numbers. A
  // finite epoch outside the Date range — 1e16 is finite and 24 hours past the
  // maximum — constructs an Invalid Date rather than throwing, and an Invalid
  // Date is a live grenade: it survives every `typeof` check, reaches
  // `health.ts`'s `resetAt?.toISOString()`, and takes `/readyz` down with a
  // RangeError. Exactly the outcome this function's contract forbids.
  const observedAt = epochDate(wire.observedAt);
  if (!observedAt) return null;
  const resetTime = wire.resetTime === null || wire.resetTime === undefined
    ? null
    : epochDate(wire.resetTime);
  if (wire.resetTime !== null && wire.resetTime !== undefined && !resetTime) return null;

  return {
    limit: wire.limit as number,
    remaining: wire.remaining as number,
    burstLimit: wire.burstLimit as number,
    burstRemaining: wire.burstRemaining as number,
    resetTime,
    observedAt,
  };
}

/** A number the Date constructor can actually represent, or nothing. */
function epochDate(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The governors `buildServices` hands to `createNewsClient`, one per provider.
 *
 * Built for both providers even though GNews is off by default, because the
 * asymmetry would be the surprise: the class is per-provider by construction
 * and a second governor costs a key prefix. What enabling GNews still needs is
 * the daily ledger this phase deferred, NOT this wiring.
 *
 * In fixture mode neither is reached — `createCurrentsClient` returns the
 * fixture client, which makes no upstream call and therefore has no budget to
 * govern — so these are inert on previews by construction rather than by a
 * branch on environment (ARCHITECTURE 4.1).
 */
export function createQuotaGovernors(
  config: Config,
  redis: Redis,
  log: QuotaLogger,
): Record<string, QuotaGovernor> {
  return {
    currents: new RedisQuotaGovernor({
      redis,
      log,
      provider: "currents",
      dailyLimit: config.CURRENTS_DAILY_CALL_LIMIT,
      burstLimit: config.CURRENTS_BURST_CALL_LIMIT,
      interactiveReserve: config.INTERACTIVE_RESERVE,
    }),
    gnews: new RedisQuotaGovernor({
      redis,
      log,
      provider: "gnews",
      dailyLimit: config.GNEWS_DAILY_CALL_LIMIT,
      burstLimit: config.GNEWS_BURST_CALL_LIMIT,
      interactiveReserve: config.GNEWS_INTERACTIVE_RESERVE,
      burstWindowMs: config.GNEWS_BURST_WINDOW_MS,
    }),
  };
}
