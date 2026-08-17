import { describe, expect, it } from "vitest";
import {
  NewsAuthError,
  NewsInvalidQueryError,
  NewsQuotaError,
  NewsUpstreamError,
} from "@zammy/news-client";
import { mapErrorResponse } from "./map-error.js";

/**
 * A pure function, and the highest-value test target in the adapter: it is where
 * GNews and Currents disagree most, and where getting it wrong is most expensive.
 *
 * The 403 is the case worth the most care. The identical status means "Cloudflare
 * banned this client" on Currents and "your day's budget is gone" on GNews, so a
 * shared mapping would either send someone to check a healthy API key or leave the
 * budget looking full while every remaining call earns the same refusal.
 */

const json = (status: number, body: unknown, headers?: Record<string, string>) => ({
  status,
  bodyText: JSON.stringify(body),
  ...(headers ? { headers: new Headers(headers) } : {}),
});

describe("403 — the status that means something else here", () => {
  it("is a quota error, not a block and not an auth failure", () => {
    const error = mapErrorResponse(
      json(403, { errors: ["You have reached your daily quota limit"] }),
    );

    expect(error).toBeInstanceOf(NewsQuotaError);
    expect(error.kind).toBe("quota");
    expect(error.message).toContain("daily quota");
  });

  it("flags the daily budget as spent, so the governor stops spending calls", () => {
    // Without this the next call sails through pre-flight and earns the same
    // 403 — and GNews sends no rate-limit headers, so this response is the only
    // signal the governor will ever get.
    const error = mapErrorResponse(json(403, { errors: ["quota"] })) as NewsQuotaError;
    expect(error.exhaustsDailyBudget).toBe(true);
  });

  it("reports the next 00:00 UTC reset, so callers can stop asking", () => {
    const error = mapErrorResponse(json(403, { errors: ["quota"] })) as NewsQuotaError;
    const resetAt = error.resetAt!;

    expect(resetAt.getTime()).toBeGreaterThan(Date.now());
    expect(resetAt.getUTCHours()).toBe(0);
    expect(resetAt.getUTCMinutes()).toBe(0);
    expect(resetAt.getUTCSeconds()).toBe(0);
  });
});

describe("429 — pacing, not exhaustion", () => {
  it("is a quota error that leaves the daily budget intact", () => {
    // The distinction matters: treating a "you are going too fast" blip as an
    // empty budget would ground the provider until midnight over one burst.
    const error = mapErrorResponse(
      json(429, { errors: ["Too many requests"] }),
    ) as NewsQuotaError;

    expect(error).toBeInstanceOf(NewsQuotaError);
    expect(error.exhaustsDailyBudget).toBe(false);
    expect(error.retryable).toBe(true);
  });

  it("honours Retry-After when one is sent", () => {
    const error = mapErrorResponse(
      json(429, { errors: ["slow down"] }, { "retry-after": "30" }),
    ) as NewsQuotaError;

    expect(error.resetAt).not.toBeNull();
  });
});

describe("the two documented error body shapes", () => {
  it("reads the general array form", () => {
    const error = mapErrorResponse(json(401, { errors: ["Invalid api key"] }));

    expect(error).toBeInstanceOf(NewsAuthError);
    expect(error.message).toContain("Invalid api key");
  });

  it("reads the per-attribute map form and keeps the field names", () => {
    const error = mapErrorResponse(
      json(400, { errors: { q: "This field is required" } }),
    ) as NewsInvalidQueryError;

    expect(error).toBeInstanceOf(NewsInvalidQueryError);
    expect(error.fieldErrors).toEqual({ q: "This field is required" });
    // Surfacing the field verbatim turns a parameter mistake into a one-line
    // diagnosis instead of a hunt.
    expect(error.message).toContain("q: This field is required");
  });

  it("falls back to the raw body when the shape is unrecognised", () => {
    const error = mapErrorResponse({ status: 500, bodyText: "<html>gateway</html>" });

    expect(error).toBeInstanceOf(NewsUpstreamError);
    expect(error.message).toContain("gateway");
  });
});

describe("retry posture", () => {
  it("never retries a 400 — our bug, and a retry costs a quota token", () => {
    expect(mapErrorResponse(json(400, { errors: ["bad"] })).retryable).toBe(false);
  });

  it("never retries a 401", () => {
    expect(mapErrorResponse(json(401, { errors: ["bad key"] })).retryable).toBe(false);
  });

  it("retries a 5xx", () => {
    expect(mapErrorResponse(json(503, { errors: ["maintenance"] })).retryable).toBe(true);
  });

  it("treats an undocumented 4xx as our bug rather than a transient fault", () => {
    const error = mapErrorResponse(json(418, { errors: ["teapot"] }));
    expect(error).toBeInstanceOf(NewsInvalidQueryError);
    expect(error.retryable).toBe(false);
  });
});
