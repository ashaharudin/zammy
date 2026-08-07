import { describe, expect, it } from "vitest";
import { CurrentsQuotaError } from "./errors.js";
import { InProcessQuotaGovernor, parseQuotaHeaders } from "./quota.js";
import { quotaHeaders } from "./test-support.js";

/**
 * Quota governance (ARCHITECTURE 5.4). The probe found `x-ratelimit-*` on every
 * response, so this code observes rather than guesses — but a governor that
 * trusts headers unconditionally has two failure modes worth testing: a missing
 * header read as "unlimited", and concurrent dispatch overshooting in the gap
 * between two observations.
 */

const bounds = { dailyLimit: 1000, burstLimit: 60 };

describe("parseQuotaHeaders", () => {
  it("reads the headers upstream actually sends", () => {
    const snapshot = parseQuotaHeaders(new Headers(quotaHeaders()), bounds)!;

    expect(snapshot.limit).toBe(1000);
    expect(snapshot.remaining).toBe(977);
    expect(snapshot.burstLimit).toBe(60);
    expect(snapshot.burstRemaining).toBe(59);
    expect(snapshot.resetTime?.toISOString()).toBe("2026-08-05T00:00:00.000Z");
  });

  it("returns null when the headers are absent — not a snapshot claiming plenty", () => {
    expect(parseQuotaHeaders(new Headers({ "content-type": "application/json" }), bounds))
      .toBeNull();
  });

  it("bounds an observed limit by config, so a plan change stays a config change", () => {
    const snapshot = parseQuotaHeaders(
      new Headers(quotaHeaders({ "x-ratelimit-limit": "50000", "x-ratelimit-remaining": "49000" })),
      bounds,
    )!;

    expect(snapshot.limit).toBe(1000);
    expect(snapshot.remaining).toBe(1000);
  });

  it("falls back to the config bound when only some headers arrive", () => {
    const snapshot = parseQuotaHeaders(
      new Headers({ "x-ratelimit-remaining": "12" }),
      bounds,
    )!;

    expect(snapshot.limit).toBe(1000);
    expect(snapshot.remaining).toBe(12);
    // No burst header, so the bound applies rather than "unlimited".
    expect(snapshot.burstLimit).toBe(60);
    expect(snapshot.burstRemaining).toBe(60);
  });

  it("tolerates an unparseable reset time", () => {
    const snapshot = parseQuotaHeaders(
      new Headers(quotaHeaders({ "x-ratelimit-reset-time": "soon" })),
      bounds,
    )!;
    expect(snapshot.resetTime).toBeNull();
  });
});

describe("InProcessQuotaGovernor — daily budget", () => {
  it("refuses locally once the budget is spent, rather than earning a 429", async () => {
    const governor = new InProcessQuotaGovernor({
      dailyLimit: 2,
      burstLimit: 60,
      interactiveReserve: 0,
    });

    await governor.reserve("interactive");
    await governor.reserve("interactive");
    await expect(governor.reserve("interactive")).rejects.toBeInstanceOf(
      CurrentsQuotaError,
    );
  });

  it("holds back the interactive reserve from background work", async () => {
    // The failure mode this prevents only appears on the busiest day: a queued
    // backfill draining the pool a live search needed.
    const governor = new InProcessQuotaGovernor({
      dailyLimit: 300,
      burstLimit: 60,
      interactiveReserve: 250,
    });

    for (let i = 0; i < 50; i += 1) await governor.reserve("background");

    await expect(governor.reserve("background")).rejects.toThrow(
      /interactive reserve/,
    );
    // The reserve is for interactive work, so interactive work still runs.
    await expect(governor.reserve("interactive")).resolves.toBeUndefined();
  });

  it("folds observed headers in, absorbing spend by other processes", async () => {
    const governor = new InProcessQuotaGovernor({
      dailyLimit: 1000,
      burstLimit: 60,
      interactiveReserve: 0,
    });

    await governor.observe({
      limit: 1000,
      remaining: 3,
      burstLimit: 60,
      burstRemaining: 60,
      resetTime: null,
      observedAt: new Date(),
    });

    expect((await governor.peek()).dailyRemaining).toBe(3);
  });

  it("counts calls made since the last observation, so concurrency cannot overshoot", async () => {
    const governor = new InProcessQuotaGovernor({
      dailyLimit: 1000,
      burstLimit: 60,
      interactiveReserve: 0,
    });

    await governor.observe({
      limit: 1000,
      remaining: 2,
      burstLimit: 60,
      burstRemaining: 60,
      resetTime: null,
      observedAt: new Date(),
    });

    // Two calls dispatched before any new header arrives must exhaust the budget
    // the header reported, not wait for a refreshed observation to say so.
    await governor.reserve("interactive");
    await governor.reserve("interactive");
    await expect(governor.reserve("interactive")).rejects.toBeInstanceOf(
      CurrentsQuotaError,
    );
  });

  it("resets at midnight UTC and discards yesterday's observation", async () => {
    let now = Date.UTC(2026, 7, 4, 23, 59, 0);
    const governor = new InProcessQuotaGovernor({
      dailyLimit: 1,
      burstLimit: 60,
      interactiveReserve: 0,
      now: () => now,
    });

    await governor.reserve("interactive");
    await expect(governor.reserve("interactive")).rejects.toBeInstanceOf(
      CurrentsQuotaError,
    );

    now = Date.UTC(2026, 7, 5, 0, 0, 1);
    await expect(governor.reserve("interactive")).resolves.toBeUndefined();
  });

  it("reports when the daily window reopens", async () => {
    const governor = new InProcessQuotaGovernor({
      dailyLimit: 1,
      burstLimit: 60,
      interactiveReserve: 0,
      now: () => Date.UTC(2026, 7, 4, 12, 0, 0),
    });

    await governor.reserve("interactive");
    await expect(governor.reserve("interactive")).rejects.toMatchObject({
      resetAt: new Date("2026-08-05T00:00:00.000Z"),
    });
  });
});

describe("InProcessQuotaGovernor — burst window", () => {
  it("enforces the 60-per-60s limit", async () => {
    const governor = new InProcessQuotaGovernor({
      dailyLimit: 1000,
      burstLimit: 3,
      interactiveReserve: 0,
      now: () => 1_000_000,
    });

    await governor.reserve("interactive");
    await governor.reserve("interactive");
    await governor.reserve("interactive");
    await expect(governor.reserve("interactive")).rejects.toThrow(/burst limit/);
  });

  it("slides rather than tumbles, so a window boundary cannot admit double", async () => {
    // A tumbling counter would let 3 calls through at t=59s and 3 more at t=61s —
    // 6 inside a 60s span, which is exactly what upstream would stall us for.
    let now = 1_000_000;
    const governor = new InProcessQuotaGovernor({
      dailyLimit: 1000,
      burstLimit: 3,
      interactiveReserve: 0,
      burstWindowMs: 60_000,
      now: () => now,
    });

    for (let i = 0; i < 3; i += 1) {
      now += 1_000;
      await governor.reserve("interactive");
    }

    // 58s after the first call: all three are still inside the window.
    now = 1_001_000 + 58_000;
    await expect(governor.reserve("interactive")).rejects.toThrow(/burst limit/);

    // Past the first call's expiry, exactly one slot frees up.
    now = 1_001_000 + 60_001;
    await expect(governor.reserve("interactive")).resolves.toBeUndefined();
    await expect(governor.reserve("interactive")).rejects.toThrow(/burst limit/);
  });
});
