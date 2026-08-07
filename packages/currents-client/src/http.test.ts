import { describe, expect, it, vi } from "vitest";
import {
  CurrentsAuthError,
  CurrentsCallerAbortedError,
  CurrentsCircuitOpenError,
  CurrentsInvalidQueryError,
  CurrentsQuotaError,
  CurrentsSchemaError,
  CurrentsTimeoutError,
  CurrentsUpstreamError,
} from "./errors.js";
import { HttpCurrentsClient } from "./http.js";
import { InProcessQuotaGovernor } from "./quota.js";
import { makeClient, quotaHeaders, rawArticle, stubFetch } from "./test-support.js";

/**
 * The live client's reliability behaviour (ARCHITECTURE 5.3).
 *
 * Every dependency that would make this slow or flaky is injected, so these run
 * offline in milliseconds and spend no quota — which is the whole point of a
 * design built around a 1000-call daily budget.
 */

const okBody = (count = 1) => ({
  status: "ok",
  news: Array.from({ length: count }, (_, index) =>
    rawArticle({
      id: `0000000${index}-0000-4000-8000-000000000000`.slice(-36),
      url: `https://example.com/story-${index}`,
    }),
  ),
});

describe("mandatory User-Agent", () => {
  it("refuses to construct without one", () => {
    // Cloudflare 403s default library UAs and reports it in a way that looks like
    // an auth failure — the probe lost 11 calls to it. A default here would let
    // that reach production silently.
    expect(() =>
      makeClient({ userAgent: "   " }),
    ).toThrow(/CURRENTS_USER_AGENT must be non-empty/);
  });

  it("refuses to construct without an API key", () => {
    expect(() => makeClient({ apiKey: "" })).toThrow(/CURRENTS_API_KEY is required/);
  });

  it("sends the User-Agent and header auth on every request", async () => {
    const { fetch, calls } = stubFetch([
      { body: okBody(), headers: quotaHeaders() },
      { body: { categories: ["technology"] }, headers: quotaHeaders() },
    ]);
    const client = makeClient({ fetch, userAgent: "zammy/0.1 (+https://example.com)" });

    await client.search({ keywords: ["climate"] });
    await client.availableCategories();

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe("zammy/0.1 (+https://example.com)");
      expect(headers["Authorization"]).toBe("test-key");
      // A key in a query string lands in access logs and proxy caches, so it goes
      // in a header even though upstream accepts `?apiKey=` too.
      expect(call.url).not.toContain("test-key");
    }
  });
});

describe("query construction", () => {
  it("space-joins keywords, because comma-joining returns zero results", async () => {
    const { fetch, calls } = stubFetch([{ body: okBody(), headers: quotaHeaders() }]);
    const client = makeClient({ fetch });

    await client.search({ keywords: ["bitcoin", "volcano"] });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("keywords")).toBe("bitcoin volcano");
  });

  it("clamps an oversized page size before calling, and reports the clamp", async () => {
    const { fetch, calls } = stubFetch([{ body: okBody(), headers: quotaHeaders() }]);
    const client = makeClient({ fetch });

    const result = await client.search({ pageSize: 100, pageNumber: 5 });

    // Pre-flight validation should make a tier-limit 400 unreachable
    // (ARCHITECTURE 11) — and a silently narrowed request must still be visible.
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("page_size")).toBe("20");
    expect(url.searchParams.get("page_number")).toBe("5");
    expect(result.adjustments.join(" ")).toMatch(/tier maximum/);
  });

  it("refuses a page past the cap locally instead of re-serving the last one", async () => {
    // Clamping down would hand back page 5's articles under page 6, and a pager
    // would count the same twenty articles as new history indefinitely. Upstream
    // answers this with a 400, so we raise the same error without spending a call.
    const { fetch, calls } = stubFetch([]);
    const client = makeClient({ fetch });

    await expect(
      client.search({ keywords: ["climate"], pageNumber: 6 }),
    ).rejects.toBeInstanceOf(CurrentsInvalidQueryError);
    expect(calls).toHaveLength(0);
  });

  it("pulls a start date forward to the 30-day lookback limit", async () => {
    const { fetch, calls } = stubFetch([{ body: okBody(), headers: quotaHeaders() }]);
    const now = Date.UTC(2026, 7, 4, 12, 0, 0);
    const client = makeClient({ fetch, now: () => now });

    const result = await client.search({ startDate: new Date(Date.UTC(2026, 0, 1)) });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("start_date")).toBe("2026-07-05T12:00:00+00:00");
    expect(result.adjustments.join(" ")).toMatch(/30-day lookback/);
  });
});

describe("end-of-results signalling", () => {
  it("uses the RAW count, so a dropped article is not read as the last page", async () => {
    // 20 raw articles of which one is malformed leaves 19 normalized. Treating
    // that as "fewer than pageSize, therefore done" would permanently hide the
    // rest of a topic's history with no error to report it.
    const news = [
      ...okBody(19).news,
      rawArticle({ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", published: "garbage" }),
    ];
    const { fetch } = stubFetch([
      { body: { status: "ok", news }, headers: quotaHeaders() },
    ]);
    const client = makeClient({ fetch });

    const result = await client.search({ keywords: ["climate"], pageSize: 20 });

    expect(result.rawCount).toBe(20);
    expect(result.articles).toHaveLength(19);
    expect(result.normalization.dropped.bad_published).toBe(1);
    expect(result.isLastPage).toBe(false);
  });

  it("signals the last page on a short raw page", async () => {
    const { fetch } = stubFetch([{ body: okBody(6), headers: quotaHeaders() }]);
    const client = makeClient({ fetch });

    const result = await client.search({ keywords: ["climate"], pageSize: 20 });
    expect(result.isLastPage).toBe(true);
  });
});

describe("quota observation", () => {
  it("records the headers on the result and in the governor", async () => {
    const { fetch } = stubFetch([{ body: okBody(), headers: quotaHeaders() }]);
    const governor = new InProcessQuotaGovernor({
      dailyLimit: 1000,
      burstLimit: 60,
      interactiveReserve: 250,
    });
    const client = makeClient({ fetch, quota: governor });

    const result = await client.search({ keywords: ["climate"] });

    expect(result.quota?.remaining).toBe(977);
    expect((await client.quota()).dailyRemaining).toBe(977);
  });

  it("observes headers even on an error response", async () => {
    // A 4xx still spent a call and still carries the rate-limit headers. Skipping
    // the observation would leave our snapshot optimistic exactly when upstream is
    // rejecting us.
    const { fetch } = stubFetch([
      {
        status: 401,
        body: { status: "401", msg: "Invalid token" },
        headers: quotaHeaders({ "x-ratelimit-remaining": "500" }),
      },
    ]);
    const client = makeClient({ fetch });

    await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      CurrentsAuthError,
    );
    expect((await client.quota()).dailyRemaining).toBe(500);
  });

  it("refuses a call locally when the governor is exhausted, spending no fetch", async () => {
    // One response is stubbed and one call is budgeted. The second search must be
    // refused before the network, not by earning a real 429 — which would cost a
    // request to learn something we already knew.
    const { fetch, calls } = stubFetch([{ body: okBody(), headers: quotaHeaders() }]);
    const client = makeClient({
      fetch,
      quota: new InProcessQuotaGovernor({
        dailyLimit: 1,
        burstLimit: 60,
        interactiveReserve: 0,
      }),
      // The stubbed response reports 977 remaining, which must not raise our own
      // exhausted local count.
      quotaBounds: { dailyLimit: 1, burstLimit: 60 },
    });

    await client.search({ keywords: ["x"] });
    await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      CurrentsQuotaError,
    );
    expect(calls).toHaveLength(1);
  });

  it("passes the priority through, so background work respects the reserve", async () => {
    const { fetch } = stubFetch([]);
    const client = makeClient({
      fetch,
      quota: new InProcessQuotaGovernor({
        dailyLimit: 100,
        burstLimit: 60,
        interactiveReserve: 250,
      }),
    });

    await expect(
      client.search({ keywords: ["x"] }, { priority: "background" }),
    ).rejects.toBeInstanceOf(CurrentsQuotaError);
  });
});

describe("retries", () => {
  it("retries a 5xx and succeeds, at most twice", async () => {
    const { fetch, calls } = stubFetch([
      { status: 502, body: "bad gateway" },
      { status: 502, body: "bad gateway" },
      { body: okBody(), headers: quotaHeaders() },
    ]);
    const client = makeClient({ fetch });

    const result = await client.search({ keywords: ["climate"] });

    expect(calls).toHaveLength(3);
    expect(result.articles).toHaveLength(1);
  });

  it("gives up after two retries", async () => {
    const { fetch, calls } = stubFetch([
      { status: 500, body: "x" },
      { status: 500, body: "x" },
      { status: 500, body: "x" },
    ]);
    const client = makeClient({ fetch });

    await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      CurrentsUpstreamError,
    );
    expect(calls).toHaveLength(3);
  });

  it("retries a network fault", async () => {
    const { fetch, calls } = stubFetch([
      { throws: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) },
      { body: okBody(), headers: quotaHeaders() },
    ]);
    const client = makeClient({ fetch });

    await client.search({ keywords: ["x"] });
    expect(calls).toHaveLength(2);
  });

  it("never retries a 400 — that is our bug, and a retry costs a quota token", async () => {
    const { fetch, calls } = stubFetch([
      {
        status: 400,
        body: {
          status: "400",
          msg: "Bad request",
          details: { errors: { page_size: "Max page_size for Free tier is 20" } },
        },
      },
    ]);
    const client = makeClient({ fetch });

    await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      CurrentsInvalidQueryError,
    );
    expect(calls).toHaveLength(1);
  });

  it("never retries a 401", async () => {
    const { fetch, calls } = stubFetch([
      { status: 401, body: { status: "401", msg: "Invalid token" } },
    ]);
    const client = makeClient({ fetch });

    await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      CurrentsAuthError,
    );
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 429 whose reset is further away than the backoff", async () => {
    // On the Free tier a daily 429 can reset hours out. Retrying it burns a quota
    // token to be told the same thing.
    const { fetch, calls } = stubFetch([
      {
        status: 429,
        body: { status: "429", msg: "Too many requests" },
        headers: { "x-ratelimit-reset-time": "2099-01-01T00:00:00+00:00" },
      },
    ]);
    const client = makeClient({ fetch });

    await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      CurrentsQuotaError,
    );
    expect(calls).toHaveLength(1);
  });

  it("does retry a 429 that resets immediately", async () => {
    const { fetch, calls } = stubFetch([
      { status: 429, body: { status: "429", msg: "slow down" } },
      { body: okBody(), headers: quotaHeaders() },
    ]);
    const client = makeClient({ fetch });

    await client.search({ keywords: ["x"] });
    expect(calls).toHaveLength(2);
  });

  it("uses exponential backoff with full jitter", async () => {
    const delays: number[] = [];
    const { fetch } = stubFetch([
      { status: 500, body: "x" },
      { status: 500, body: "x" },
      { body: okBody(), headers: quotaHeaders() },
    ]);
    const client = makeClient({
      fetch,
      backoffBaseMs: 100,
      random: () => 1, // full jitter at its ceiling, so the schedule is assertable
      sleep: async (ms) => void delays.push(ms),
    });

    await client.search({ keywords: ["x"] });

    expect(delays).toEqual([100, 200]);
  });

  it("caps the backoff", async () => {
    const delays: number[] = [];
    const { fetch } = stubFetch([
      { status: 500, body: "x" },
      { status: 500, body: "x" },
      { body: okBody(), headers: quotaHeaders() },
    ]);
    const client = makeClient({
      fetch,
      backoffBaseMs: 5_000,
      backoffMaxMs: 2_000,
      random: () => 1,
      sleep: async (ms) => void delays.push(ms),
    });

    await client.search({ keywords: ["x"] });
    expect(delays).toEqual([2_000, 2_000]);
  });
});

describe("deadlines", () => {
  it("maps our own timeout to CurrentsTimeoutError", async () => {
    const { fetch } = stubFetch([
      { throws: Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }) },
      { throws: Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }) },
      { throws: Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }) },
    ]);
    const client = makeClient({ fetch });

    await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      CurrentsTimeoutError,
    );
  });

  it("does not retry when the caller withdraws", async () => {
    // The caller's 1200ms fill budget running out is a decision, not a fault.
    const controller = new AbortController();
    const { fetch, calls } = stubFetch([
      {
        throws: Object.assign(new Error("aborted"), { name: "AbortError" }),
      },
    ]);
    const client = makeClient({ fetch });
    controller.abort();

    await expect(
      client.search({ keywords: ["x"] }, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(CurrentsCallerAbortedError);
    expect(calls).toHaveLength(1);
  });

  it("honours a per-call timeout override", async () => {
    const { fetch } = stubFetch([{ body: okBody(), headers: quotaHeaders() }]);
    const client = makeClient({ fetch });

    const result = await client.search({ keywords: ["x"] }, { timeoutMs: 50 });
    expect(result.articles).toHaveLength(1);
  });
});

describe("circuit breaker", () => {
  it("opens after consecutive transport failures and then fails fast", async () => {
    const { fetch, calls } = stubFetch(
      Array.from({ length: 6 }, () => ({ status: 500 as number, body: "x" })),
    );
    const client = makeClient({
      fetch,
      maxRetries: 0,
      breaker: { threshold: 3, cooldownMs: 30_000, now: () => 1_000 },
      now: () => 1_000,
    });

    for (let i = 0; i < 3; i += 1) {
      await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(
        CurrentsUpstreamError,
      );
    }

    // Fourth call must not reach the network at all: while open we serve stale
    // rather than making users wait for a call we expect to fail.
    await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      CurrentsCircuitOpenError,
    );
    expect(calls).toHaveLength(3);
  });

  it("still degrades as an upstream failure, so callers need no new branch", async () => {
    const { fetch } = stubFetch([{ status: 500, body: "x" }]);
    const client = makeClient({
      fetch,
      maxRetries: 0,
      breaker: { threshold: 1, cooldownMs: 30_000 },
    });

    await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      CurrentsUpstreamError,
    );
    const error = await client.search({ keywords: ["x"] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CurrentsCircuitOpenError);
    // Subclass of CurrentsUpstreamError on purpose: same degradation, distinct metric.
    expect(error).toBeInstanceOf(CurrentsUpstreamError);
    expect((error as CurrentsCircuitOpenError).kind).toBe("circuit_open");
  });

  it("does NOT open on a 401 — upstream is up, our key is wrong", async () => {
    const { fetch, calls } = stubFetch(
      Array.from({ length: 4 }, () => ({
        status: 401 as number,
        body: { status: "401", msg: "Invalid token" },
      })),
    );
    const client = makeClient({
      fetch,
      maxRetries: 0,
      breaker: { threshold: 2, cooldownMs: 30_000 },
    });

    for (let i = 0; i < 4; i += 1) {
      await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(
        CurrentsAuthError,
      );
    }
    // Suppressing these would replace a precise diagnosis with a vague one.
    expect(calls).toHaveLength(4);
  });

  it("lets one probe through after the cooldown and closes on success", async () => {
    let now = 1_000;
    const { fetch } = stubFetch([
      { status: 500, body: "x" },
      { body: okBody(), headers: quotaHeaders() },
    ]);
    const client = makeClient({
      fetch,
      maxRetries: 0,
      breaker: { threshold: 1, cooldownMs: 30_000, now: () => now },
      now: () => now,
    });

    await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      CurrentsUpstreamError,
    );
    await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      CurrentsCircuitOpenError,
    );

    now += 30_001;
    await expect(client.search({ keywords: ["x"] })).resolves.toMatchObject({
      rawCount: 1,
    });
  });
});

describe("response validation and secrecy", () => {
  it("rejects a 200 whose body is not JSON", async () => {
    const { fetch } = stubFetch([
      { body: "<html>blocked</html>", headers: { "content-type": "text/html" } },
    ]);
    const client = makeClient({ fetch });

    await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      CurrentsSchemaError,
    );
  });

  it("tolerates undocumented extra fields rather than failing", async () => {
    // Upstream already shipped one undocumented field (`source_category`), so it
    // will ship another.
    const { fetch } = stubFetch([
      {
        body: {
          status: "ok",
          news: [rawArticle({ some_new_field: "surprise" })],
          also_new: true,
        },
        headers: quotaHeaders(),
      },
    ]);
    const client = makeClient({ fetch });

    const result = await client.search({ keywords: ["x"] });
    expect(result.articles).toHaveLength(1);
  });

  it("redacts the API key from anything upstream echoes back", async () => {
    const { fetch } = stubFetch([
      { status: 400, body: { status: "400", msg: "bad key super-secret-key in query" } },
    ]);
    const client = makeClient({ fetch, apiKey: "super-secret-key" });

    const error = await client.search({ keywords: ["x"] }).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain("super-secret-key");
    expect((error as Error).message).toContain("[redacted]");
  });

  it("reports normalization drops to the logger", async () => {
    const warn = vi.fn();
    const { fetch } = stubFetch([
      {
        body: {
          status: "ok",
          news: [rawArticle(), rawArticle({ published: "nope" })],
        },
        headers: quotaHeaders(),
      },
    ]);
    const client = makeClient({ fetch, logger: { warn } });

    await client.search({ keywords: ["x"] });

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ received: 2, kept: 1 }),
      expect.stringContaining("dropped malformed articles"),
    );
  });
});

describe("latestNews", () => {
  it("calls the latest-news endpoint with just a language", async () => {
    const { fetch, calls } = stubFetch([{ body: okBody(3), headers: quotaHeaders() }]);
    const client = makeClient({ fetch });

    const result = await client.latestNews("en");

    expect(calls[0]!.url).toContain("/latest-news?language=en");
    expect(result.articles).toHaveLength(3);
  });
});

describe("baseUrl handling", () => {
  it("tolerates a trailing slash in configuration", async () => {
    const { fetch, calls } = stubFetch([{ body: okBody(), headers: quotaHeaders() }]);
    const client = new HttpCurrentsClient({
      baseUrl: "https://api.currentsapi.services/v1/",
      apiKey: "test-key",
      userAgent: "zammy-test/0.0",
      limits: { maxPageSize: 20, maxRetrievableResults: 100, maxLookbackDays: 30 },
      quotaBounds: { dailyLimit: 1000, burstLimit: 60 },
      quota: new InProcessQuotaGovernor({
        dailyLimit: 1000,
        burstLimit: 60,
        interactiveReserve: 0,
      }),
      fetch,
    });

    await client.search({ keywords: ["x"] });
    expect(calls[0]!.url).toMatch(
      /^https:\/\/api\.currentsapi\.services\/v1\/search\?/,
    );
  });
});
