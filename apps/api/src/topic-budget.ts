import type { Redis } from "ioredis";

/**
 * Per-topic daily call cap (ARCHITECTURE 9.4). Demand-driven ingestion means
 * users can drive spend, so one curious user deep-backfilling an obscure
 * keyword must not drain the shared pool: the topic simply stops deepening
 * for the day and resumes tomorrow.
 *
 * Redis-held so every process shares one count — the same reason the quota
 * snapshot lives there (§5.4).
 */

/** Counter keys outlive their UTC day by enough to never expire mid-use. */
const COUNTER_TTL_SECONDS = 48 * 60 * 60;

/**
 * Take one call's worth of today's budget for a topic. False means the cap is
 * spent — the caller must not make the upstream call.
 *
 * Fails OPEN on Redis errors: an unenforced cap costs at worst a day of one
 * topic's over-spend, while failing closed would turn a cache outage into
 * "no upstream calls at all" (§11: degraded, not down).
 */
export async function reserveTopicCall(
  redis: Redis,
  fingerprint: string,
  cap: number,
  now: Date,
  /**
   * Counted on its own when given (ADR-0030's search fallback). Absent is the
   * Currents fill's counter, keyed exactly as it always was, so no deployment's
   * in-flight count moves.
   */
  provider?: string,
): Promise<boolean> {
  const subject = provider === undefined ? fingerprint : `${fingerprint}:${provider}`;
  return reserveDailyCall(redis, `budget:topic:${subject}`, cap, now);
}

/**
 * Take one call's worth of today's budget for the search fallback (ADR-0030) —
 * a pool across every topic, which is a different thing from the per-topic cap
 * above and is taken IN ADDITION to it.
 *
 * The per-topic cap stops one topic draining a pool; this stops one plane
 * draining a provider another plane depends on. Google News' daily ceiling is
 * one number we invented, spent by the deepening plane and by this one, and
 * without a share of its own a burst of refused searches would starve every
 * storyline open of its deepening fetch for the rest of the day.
 *
 * Fails open for the reason the per-topic cap does: the provider's own governor
 * still holds the overall ceiling behind it.
 */
export async function reserveFallbackCall(
  redis: Redis,
  provider: string,
  cap: number,
  now: Date,
): Promise<boolean> {
  return reserveDailyCall(redis, `budget:fallback:${provider}`, cap, now);
}

/** One counter per key per UTC day, with the fail-open both callers want. */
async function reserveDailyCall(
  redis: Redis,
  prefix: string,
  cap: number,
  now: Date,
): Promise<boolean> {
  const key = `${prefix}:${now.toISOString().slice(0, 10)}`;
  try {
    const used = await redis.incr(key);
    if (used === 1) await redis.expire(key, COUNTER_TTL_SECONDS);
    return used <= cap;
  } catch {
    return true;
  }
}
