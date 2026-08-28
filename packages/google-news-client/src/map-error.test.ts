import { describe, expect, it } from "vitest";
import {
  NewsAuthError,
  NewsBlockedError,
  NewsInvalidQueryError,
  NewsQuotaError,
  NewsUpstreamError,
} from "@zammy/news-client";
import { mapErrorResponse } from "./map-error.js";

/**
 * A pure function, and the highest-value test target in the package for the
 * reason ADR-0012 gives: the same status code means different things to
 * different providers, and nothing downstream may branch on a status code.
 *
 * Here the taxonomy is narrower than anywhere else, because there is no key.
 */

function map(status: number, bodyText = "", headers?: Headers) {
  return mapErrorResponse({ status, bodyText, ...(headers ? { headers } : {}) });
}

describe("there is no credential, so there is no auth failure", () => {
  it("maps a 403 with an HTML block page to blocked", () => {
    // PROBE-FINDINGS 2: Cloudflare 403'd the Currents probe's first 11 calls
    // over a default library User-Agent, and reading that as an auth failure
    // sends you looking at a key instead of at the request headers.
    const error = map(403, "<html>error code: 1010</html>");

    expect(error).toBeInstanceOf(NewsBlockedError);
    expect(error).not.toBeInstanceOf(NewsAuthError);
  });

  it("maps a 403 with a JSON body to blocked as well", () => {
    // The Currents mapping treats a JSON 403 as auth, because there a key
    // exists to be refused. Here every body is non-JSON — the endpoint speaks
    // RSS — so the body shape cannot distinguish anything, and inventing an
    // auth branch would only ever misdirect.
    expect(map(403, '{"error":"forbidden"}')).toBeInstanceOf(NewsBlockedError);
  });

  it("maps a 401 to blocked, not auth — nothing here authenticates", () => {
    // A 401 would mean something in FRONT of Google is challenging us: a proxy,
    // a captive portal, a corporate gateway. The remedy is the request, not a
    // credential that does not exist.
    expect(map(401, "Unauthorized")).toBeInstanceOf(NewsBlockedError);
  });

  it("names the User-Agent, which is the only thing identifying this client", () => {
    expect(map(403, "").message).toContain("GOOGLE_NEWS_USER_AGENT");
    expect(map(403, "").message).toContain("NOT an authentication failure");
  });

  it("never retries a block, which would spend calls learning the same thing", () => {
    expect(map(403).retryable).toBe(false);
  });
});

describe("a 403 is NOT daily exhaustion here, unlike GNews", () => {
  it("does not report a spent budget", () => {
    // GNews documents that status verbatim as "you have reached your daily
    // quota limit". Google News documents nothing, publishes no ceiling and
    // sends no rate-limit header, so reading a 403 that way would be an
    // invention — and the transport would fold a `remaining: 0` into the
    // governor on the strength of it, grounding the provider until midnight.
    const error = map(403, "blocked");

    expect(error).not.toBeInstanceOf(NewsQuotaError);
  });
});

describe("429 paces, it does not ground the day", () => {
  it("is retryable and does not claim the daily budget is gone", () => {
    const error = map(429, "Too many requests");

    expect(error).toBeInstanceOf(NewsQuotaError);
    expect(error.retryable).toBe(true);
    expect((error as NewsQuotaError).exhaustsDailyBudget).toBe(false);
  });

  it("honours a Retry-After if one turns up, though none is documented", () => {
    const error = map(429, "", new Headers({ "retry-after": "30" }));

    expect((error as NewsQuotaError).resetAt).toBeInstanceOf(Date);
  });

  it("reports no reset when nothing said one", () => {
    expect((map(429) as NewsQuotaError).resetAt).toBeNull();
  });
});

describe("the rest", () => {
  it("maps a 404 to our bug, because a query matching nothing answers 200", () => {
    const error = map(404, "Not Found");

    expect(error).toBeInstanceOf(NewsInvalidQueryError);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("GOOGLE_NEWS_BASE_URL");
  });

  it("maps a 5xx to a retryable upstream error", () => {
    const error = map(503, "Service Unavailable");

    expect(error).toBeInstanceOf(NewsUpstreamError);
    expect(error.retryable).toBe(true);
  });

  it("maps any other 4xx to our bug, never to a retry", () => {
    // Each retry on an endpoint with no published budget is a call spent
    // finding out what the unpublished one is.
    const error = map(418, "teapot");

    expect(error).toBeInstanceOf(NewsInvalidQueryError);
    expect(error.retryable).toBe(false);
  });

  it("truncates a long body rather than putting a block page in a log line", () => {
    expect(map(500, "x".repeat(500)).message.length).toBeLessThan(300);
  });
});
