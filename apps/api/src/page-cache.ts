import { createHash } from "node:crypto";
import type { Redis } from "ioredis";

/**
 * The Redis page cache (ARCHITECTURE 7.1). Pure cache: every failure path in
 * this file reads as a miss, because Redis being down must cost latency and
 * quota, never correctness or a user-visible error (§11).
 */

/**
 * Staleness tiers (§6.4): how long a cached page whose window ends at
 * `windowEnd` may be served. A still-moving window needs re-checking far more
 * often than settled history, which does not change at all.
 */
export function freshnessTtlMs(windowEnd: Date, now: Date): number {
  const age = now.getTime() - windowEnd.getTime();
  if (age <= 60 * 60 * 1000) return 60_000; // ends within the last hour
  if (age <= 24 * 60 * 60 * 1000) return 600_000; // within the last day
  return 86_400_000; // historical
}

/** page:<fingerprint>:<windowHash>:<cursor>:<limit> (§7.1). */
export function pageCacheKey(
  fingerprint: string,
  window: { from: Date; to: Date },
  cursor: string | null,
  limit: number,
): string {
  const windowHash = createHash("sha256")
    .update(`${window.from.getTime()}-${window.to.getTime()}`)
    .digest("hex")
    .slice(0, 16);
  return `page:${fingerprint}:${windowHash}:${cursor ?? "first"}:${limit}`;
}

export async function readCachedPage<T>(redis: Redis, key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export async function writeCachedPage(
  redis: Redis,
  key: string,
  value: unknown,
  ttlMs: number,
): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), "PX", ttlMs);
  } catch {
    // A page that fails to cache is a page served from Postgres next time.
  }
}
