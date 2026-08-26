// Named, not default: ioredis is CJS and the default import resolves to a
// namespace rather than the class (server.ts says the same).
import type { Redis } from "ioredis";

/**
 * How long a boot will wait for Redis to finish connecting.
 *
 * Upstash's TLS handshake was measured at ~800 ms from a cold instance, and
 * Phase 3 saw it fail outright with `connect ETIMEDOUT` under a burst. Ten
 * seconds is generous against both and still leaves the 300 s ceiling
 * essentially untouched — and the point of the bound is not speed, it is that
 * an unreachable Redis becomes a named failure instead of a function that sits
 * there until `maxDuration` kills it.
 */
export const REDIS_READY_TIMEOUT_MS = 10_000;

/**
 * Wait for a shared Redis client to be usable.
 *
 * **Why this exists, and why it is not in `buildServices`.** `buildServices`
 * builds its client with `lazyConnect: true`, `enableOfflineQueue: false` and a
 * deliberately un-awaited `redis.connect()` (server.ts) — "Redis is pure cache:
 * never let a reconnect storm block a request that Postgres could have served".
 * For the request path that is correct and worth keeping: a read that misses the
 * cache still answers from Postgres, and awaiting the handshake would put
 * ~800 ms in front of every cold timeline read.
 *
 * It is wrong for the two boots that treat Redis as INPUT rather than as cache,
 * and each of those awaits this instead — the wait belongs to the caller that
 * needs it, not to the builder every caller shares:
 *
 *   - `drain.ts` — `listOutstanding` is the first thing the pass does, a `SCAN`
 *     issued microseconds after the boot returns.
 *   - `vercel-queue.ts` — the push-mode consumer, whose dispatch reaches
 *     `tryAcquire` on the segment path.
 *
 * With the offline queue disabled ioredis does not wait for the stream — it
 * throws `Stream isn't writeable and enableOfflineQueue options is false`.
 *
 * Measured in production 2026-08-26: the drain's first four invocations, two
 * scheduled and two manual, all 500, while `/readyz` reported `redis.ok: true`
 * from the warm request function and `/api/keepalive` answered 200 because it
 * touches only Postgres. The unit tests never saw it — they drive a real local
 * Redis over loopback, which is ready before the first command is written.
 *
 * `error` is deliberately not a rejection: ioredis retries, and a transient
 * handshake error followed by a successful retry is a working connection. Only
 * the timeout and a closed-for-good connection end the wait.
 */
export async function waitForRedis(
  redis: Pick<Redis, "status" | "once" | "off">,
  timeoutMs: number = REDIS_READY_TIMEOUT_MS,
): Promise<void> {
  if (redis.status === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      redis.off("ready", onReady);
      redis.off("end", onEnd);
    };
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error("redis connection ended before it was ready"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`redis was not ready after ${timeoutMs} ms (status: ${redis.status})`));
    }, timeoutMs);
    redis.once("ready", onReady);
    redis.once("end", onEnd);
  });
}
