import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

/**
 * Single-flight election (ARCHITECTURE 6.3): a short-TTL Redis lock elects one
 * fetcher per (fingerprint, segment); losers serve what the store has rather
 * than waiting — the lock deduplicates UPSTREAM CALLS, never readers (§6.5).
 *
 * Every operation degrades to "not held / not acquired" when Redis is down:
 * the cost is a possible duplicate upstream call, which idempotent ingestion
 * absorbs (§7.4). Blocking reads on a cache outage would be strictly worse.
 */

/**
 * Try to become the fetcher. Returns a holder token, or null if someone else
 * already holds the segment (or Redis is unreachable).
 */
export async function tryAcquire(
  redis: Redis,
  key: string,
  ttlMs: number,
): Promise<string | null> {
  const token = randomUUID();
  try {
    const outcome = await redis.set(key, token, "PX", ttlMs, "NX");
    return outcome === "OK" ? token : null;
  } catch {
    return null;
  }
}

/**
 * Release, only if we still hold it. The token comparison runs server-side:
 * a holder that stalled past its TTL must not evict whoever took over, or the
 * stampede the lock prevents comes right back.
 */
export async function release(redis: Redis, key: string, token: string): Promise<void> {
  try {
    await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1,
      key,
      token,
    );
  } catch {
    // Held until TTL — safe, just slower for the next acquirer.
  }
}

/**
 * There is no `isHeld` here any more, and the reason is worth a line: it
 * documented itself as feeding `meta.ingest.state` (§6.1) and had not done so
 * for some time — that field is `pendingCount` plus the fill's own
 * `lockLostToPeer`, which is what the acquirer already knows from `tryAcquire`
 * returning null. Its only callers were its own tests, which now read the key
 * directly. A "who holds this?" probe is the wrong question for a caller to be
 * able to ask anyway: the answer is stale the instant it returns, and the
 * single-flight contract is that you either hold a token or you do not.
 */

/** Lock key per §7.1: lock:refresh:<fingerprint>:<segment>. */
export function refreshLockKey(fingerprint: string, segment: { from: Date; to: Date }): string {
  return `lock:refresh:${fingerprint}:${segment.from.getTime()}-${segment.to.getTime()}`;
}
