import { describe, expect, it } from "vitest";
import { REDIS_READY_TIMEOUT_MS, waitForRedis } from "./redis-ready.js";

/**
 * The production 500 of 2026-08-26, as a test.
 *
 * `buildServices` connects Redis in the background on purpose (server.ts: "Redis
 * is pure cache: never let a reconnect storm block a request that Postgres could
 * have served"), so a boot that reads Redis has to wait for it first — the
 * drain before its first `SCAN`, the push-mode consumer before its first
 * dispatch. These pin the outcomes; the bug itself was the absence of any wait
 * at all.
 */
describe("waitForRedis", () => {
  const fake = (status: string) => {
    const handlers = new Map<string, Array<() => void>>();
    return {
      status,
      once(event: string, fn: () => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), fn]);
        return this;
      },
      off(event: string, fn: () => void) {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((h) => h !== fn),
        );
        return this;
      },
      emit(event: string) {
        for (const fn of [...(handlers.get(event) ?? [])]) fn();
      },
      listeners: (event: string) => handlers.get(event) ?? [],
    };
  };

  it("returns immediately when the client is already ready", async () => {
    const redis = fake("ready");
    await expect(waitForRedis(redis as never, 10)).resolves.toBeUndefined();
    expect(redis.listeners("ready")).toHaveLength(0);
  });

  it("waits for the ready event, then unsubscribes", async () => {
    const redis = fake("connecting");
    const waited = waitForRedis(redis as never, 1_000);
    redis.emit("ready");
    await expect(waited).resolves.toBeUndefined();
    expect(redis.listeners("ready")).toHaveLength(0);
    expect(redis.listeners("end")).toHaveLength(0);
  });

  it("rejects when the connection ends before becoming ready", async () => {
    const redis = fake("connecting");
    const waited = waitForRedis(redis as never, 1_000);
    redis.emit("end");
    await expect(waited).rejects.toThrow(/ended before it was ready/);
  });

  it("rejects on the timeout, naming the status", async () => {
    const redis = fake("connecting");
    await expect(waitForRedis(redis as never, 5)).rejects.toThrow(/not ready after 5 ms/);
  });

  it("leaves room for a cold Upstash handshake — the measured one is ~800 ms", () => {
    expect(REDIS_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    // And still far inside the route's 300 s maxDuration.
    expect(REDIS_READY_TIMEOUT_MS).toBeLessThan(30_000);
  });
});
