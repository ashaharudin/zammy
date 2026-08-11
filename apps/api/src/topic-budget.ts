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
): Promise<boolean> {
  const key = `budget:topic:${fingerprint}:${now.toISOString().slice(0, 10)}`;
  try {
    const used = await redis.incr(key);
    if (used === 1) await redis.expire(key, COUNTER_TTL_SECONDS);
    return used <= cap;
  } catch {
    return true;
  }
}
