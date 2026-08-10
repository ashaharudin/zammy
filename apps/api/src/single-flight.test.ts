import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { isHeld, release, tryAcquire } from "./single-flight.js";

/**
 * The single-flight election (ARCHITECTURE 6.3): N concurrent users searching a
 * trending keyword must produce ONE upstream call. With a 60/60s burst limit
 * this is a hard requirement, not an optimization. Tested against the compose
 * Redis — the semantics under test ARE Redis semantics (SET NX PX, expiry).
 */

const redis = new Redis(process.env.TEST_REDIS_URL ?? "redis://localhost:6379");
const key = () => `test:lock:${randomUUID()}`;

afterAll(async () => {
  await redis.quit();
});

describe("tryAcquire / release", () => {
  it("elects exactly one holder", async () => {
    const k = key();
    const winner = await tryAcquire(redis, k, 5_000);
    const loser = await tryAcquire(redis, k, 5_000);

    expect(winner).not.toBeNull();
    expect(loser).toBeNull();
    expect(await isHeld(redis, k)).toBe(true);
  });

  it("release frees the lock for the next acquirer", async () => {
    const k = key();
    const token = (await tryAcquire(redis, k, 5_000))!;
    await release(redis, k, token);

    expect(await isHeld(redis, k)).toBe(false);
    expect(await tryAcquire(redis, k, 5_000)).not.toBeNull();
  });

  it("release with a stale token does NOT free someone else's lock", async () => {
    // The failure this guards: holder A stalls past its TTL, B acquires, then
    // A's belated release must not evict B — that would re-admit the
    // duplicate-call stampede the lock exists to prevent.
    const k = key();
    const staleToken = (await tryAcquire(redis, k, 5_000))!;
    await redis.del(k); // simulate expiry
    const current = (await tryAcquire(redis, k, 5_000))!;

    await release(redis, k, staleToken);

    expect(await isHeld(redis, k)).toBe(true);
    await release(redis, k, current);
  });

  it("expires on its own — a crashed holder cannot jam the topic", async () => {
    const k = key();
    await tryAcquire(redis, k, 100);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await tryAcquire(redis, k, 5_000)).not.toBeNull();
  });
});
