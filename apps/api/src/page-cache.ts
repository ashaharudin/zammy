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

/** The same tiers as names, for the cache-hit-ratio-by-tier metric (§12). */
export function freshnessTier(windowEnd: Date, now: Date): "hot" | "recent" | "historical" {
  const ttl = freshnessTtlMs(windowEnd, now);
  return ttl === 60_000 ? "hot" : ttl === 600_000 ? "recent" : "historical";
}

/**
 * The serialized page's SHAPE generation. Cached pages are returned as-is —
 * no re-validation on read, by design (§7.1: a cache never costs correctness
 * work) — so a deploy that changes the wire shape must change the key, or a
 * client parsing with the new schema chokes on a page cached by the old
 * build for up to the historical tier's 24h TTL.
 *
 *   2 — slots are storylines; entries carry `storylineId` and `coverage` (ADR-0009)
 *   3 — the second section renamed `coverage` → `moreCoverage`: the bare word
 *       already names fetched time spans (CONTEXT.md)
 *   4 — entries carry `storylinePhrase` (ADR-0010)
 *   5 — entries carry `storyline` (UUID slots, label, span) and pages carry
 *       `storylines`; `storylineId` widens from a bigint to a UUID under
 *       STORYLINES_V2 (ADR-0011)
 *   6 — surfaced storylines carry `size`: whole-life article count, rendered
 *       as the pill's bucket glyph with the exact figure in its title (S8)
 *   7 — surfaced storylines carry `dormant`: the pill says when a match has
 *       been quiet since March rather than leaving the reader to wonder (S8's
 *       verdict, ADR-0011's Lifecycle)
 *   8 — `storylinePhrase` removed with the day-bounded model it named (S9)
 *
 * The bump stops a page cached by an older BUILD reaching a client parsing with
 * the new schema. It briefly also had to keep the two MODELS apart, since both
 * wrote shape 5 — the key carried a `model` segment for exactly as long as
 * there were two. Migration 0012 left one, so the segment went with it.
 */
const PAGE_SHAPE_VERSION = 8;

/** page:v<shape>:<fingerprint>:<windowHash>:<cursor>:<limit> (§7.1). */
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
  return `page:v${PAGE_SHAPE_VERSION}:${fingerprint}:${windowHash}:${cursor ?? "first"}:${limit}`;
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
