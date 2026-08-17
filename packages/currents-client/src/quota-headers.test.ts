import { describe, expect, it } from "vitest";
import { parseQuotaHeaders } from "./quota-headers.js";
import { quotaHeaders } from "./test-support.js";

/**
 * The probe found `x-ratelimit-*` on every Currents response, so this code
 * observes rather than guesses. A parser that trusts headers unconditionally has
 * one failure mode worth testing above all others: a missing header read as
 * "unlimited", which turns a degraded observation path into a quota overrun.
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
