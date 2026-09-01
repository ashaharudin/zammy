import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import {
  freshnessTtlMs,
  pageCacheKey,
  readCachedPage,
  writeCachedPage,
} from "./page-cache.js";

/**
 * The Redis page cache (ARCHITECTURE 7.1) and the staleness tiers that set its
 * TTLs (§6.4). Redis is pure cache: a flush — or Redis being down entirely —
 * costs latency and quota, never correctness or an error (§11).
 */

const redis = new Redis(process.env.TEST_REDIS_URL ?? "redis://localhost:6379");

afterAll(async () => {
  await redis.quit();
});

const NOW = new Date("2026-08-10T12:00:00.000Z");

describe("freshnessTtlMs — a recent window needs re-checking far more often", () => {
  it("gives a still-moving window 60 seconds", () => {
    expect(freshnessTtlMs(new Date("2026-08-10T11:30:00Z"), NOW)).toBe(60_000);
  });

  it("gives a same-day window 10 minutes", () => {
    expect(freshnessTtlMs(new Date("2026-08-10T02:00:00Z"), NOW)).toBe(600_000);
  });

  it("gives settled history 24 hours — it does not change", () => {
    expect(freshnessTtlMs(new Date("2026-08-01T12:00:00Z"), NOW)).toBe(86_400_000);
  });
});

describe("pageCacheKey", () => {
  const window = { from: new Date("2026-08-08T00:00:00Z"), to: new Date("2026-08-09T00:00:00Z") };

  it("varies by every §7.1 dimension", () => {
    const base = pageCacheKey("f".repeat(64), window, null, 25);
    expect(pageCacheKey("e".repeat(64), window, null, 25)).not.toBe(base);
    expect(pageCacheKey("f".repeat(64), window, "cursor123", 25)).not.toBe(base);
    expect(pageCacheKey("f".repeat(64), window, null, 50)).not.toBe(base);
    expect(
      pageCacheKey(
        "f".repeat(64),
        { ...window, to: new Date("2026-08-10T00:00:00Z") },
        null,
        25,
      ),
    ).not.toBe(base);
  });

  it("is deterministic — same request, same entry", () => {
    expect(pageCacheKey("f".repeat(64), window, "c", 25)).toBe(
      pageCacheKey("f".repeat(64), window, "c", 25),
    );
  });

  it("cannot reach a page the PREVIOUS shape cached", async () => {
    // What `PAGE_SHAPE_VERSION` is for, tested as a mechanism rather than at a
    // particular number: cached pages are returned without re-validation, so a
    // deploy that changes the wire shape and forgets the bump serves the old
    // shape to a client parsing with the new schema for up to 24 hours.
    //
    // The previous version's key is derived from the current one rather than
    // written out, so this keeps meaning the same thing after the next bump —
    // and the assertion is over `readCachedPage`, not over the two strings,
    // because "different key" is only the half of it that is easy to believe.
    const key = pageCacheKey("f".repeat(64), window, null, 25);
    const previous = key.replace(/^page:v(\d+):/, (_, v: string) => `page:v${Number(v) - 1}:`);
    expect(previous).not.toBe(key);

    await writeCachedPage(redis, previous, { items: ["the old shape"] }, 5_000);
    try {
      expect(await readCachedPage(redis, previous)).not.toBeNull();
      expect(await readCachedPage(redis, key)).toBeNull();
    } finally {
      await redis.del(previous);
    }
  });
});

describe("read/write round-trip", () => {
  it("returns what was written, then expires", async () => {
    const key = `test:page:${randomUUID()}`;
    await writeCachedPage(redis, key, { items: [1, 2, 3] }, 5_000);

    expect(await readCachedPage(redis, key)).toEqual({ items: [1, 2, 3] });
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(1_000);
    expect(ttl).toBeLessThanOrEqual(5_000);
  });

  it("misses as null", async () => {
    expect(await readCachedPage(redis, `test:page:${randomUUID()}`)).toBeNull();
  });

  it("treats a dead Redis as a miss, never an error", async () => {
    // §11: Redis down → skip cache and single-flight; degraded, not down.
    const dead = new Redis("redis://localhost:1", {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    dead.on("error", () => {});

    await expect(writeCachedPage(dead, "test:x", { a: 1 }, 1_000)).resolves.toBeUndefined();
    await expect(readCachedPage(dead, "test:x")).resolves.toBeNull();
    dead.disconnect();
  });
});
