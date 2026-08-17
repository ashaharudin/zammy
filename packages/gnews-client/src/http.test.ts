import { describe, expect, it } from "vitest";
import { InProcessQuotaGovernor, NewsInvalidQueryError, NewsQuotaError } from "@zammy/news-client";
import { isLastPage } from "./http.js";
import { makeClient, okBody, rawArticle, stubFetch } from "./test-support.js";

/**
 * The live GNews client. Retries, the breaker and deadlines are the shared
 * transport's and are tested there, so what is asserted here is the part that is
 * GNews-shaped: the wire encoding, the queries it must refuse rather than answer,
 * the end-of-results signal it uniquely gives us, and the quota loop it has to
 * run without any rate-limit headers.
 */

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("query construction", () => {
  it("space-joins keywords into q, matching how a topic asks Currents", async () => {
    const { fetch, calls } = stubFetch([{ body: okBody() }]);
    await makeClient({ fetch }).search({ keywords: ["climate", "policy"] });

    expect(query(calls[0]!.url).get("q")).toBe("climate policy");
  });

  it("maps our names onto GNews's", async () => {
    const { fetch, calls } = stubFetch([{ body: okBody() }]);
    await makeClient({ fetch }).search({
      keywords: ["x"],
      language: "en",
      country: "gb",
      pageNumber: 2,
      pageSize: 10,
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-08-08T00:00:00.000Z"),
    });

    const params = query(calls[0]!.url);
    expect(params.get("lang")).toBe("en");
    expect(params.get("country")).toBe("gb");
    expect(params.get("page")).toBe("2");
    expect(params.get("max")).toBe("10");
    expect(params.get("from")).toBe("2026-08-01T00:00:00.000Z");
    expect(params.get("to")).toBe("2026-08-08T00:00:00.000Z");
  });

  it("always sorts by publishedAt, because the coverage frontier assumes it", async () => {
    // With sortby=relevance, "the oldest article this page reached" stops
    // meaning anything, and the span we record as covered becomes a fiction.
    const { fetch, calls } = stubFetch([{ body: okBody() }]);
    await makeClient({ fetch }).search({ keywords: ["x"] });

    expect(query(calls[0]!.url).get("sortby")).toBe("publishedAt");
  });

  it("opts in to nullable fields, which GNews otherwise omits entirely", async () => {
    // Default behaviour drops articles with no image or description. We render
    // both as absent anyway, so opting in is strictly more coverage.
    const { fetch, calls } = stubFetch([{ body: okBody() }]);
    await makeClient({ fetch }).search({ keywords: ["x"] });

    expect(query(calls[0]!.url).get("nullable")).toBe("description,content,image");
  });

  it("sends the key as a header, never in the query string", async () => {
    // Both work; a key in a query string ends up in access logs and proxy caches.
    const { fetch, calls } = stubFetch([{ body: okBody() }]);
    await makeClient({ fetch }).search({ keywords: ["x"] });

    expect(calls[0]!.url).not.toContain("test-key");
    expect((calls[0]!.init.headers as Record<string, string>)["X-Api-Key"]).toBe("test-key");
  });

  it("clamps page size to the tier maximum", async () => {
    const { fetch, calls } = stubFetch([{ body: okBody() }]);
    const result = await makeClient({ fetch }).search({ keywords: ["x"], pageSize: 50 });

    expect(query(calls[0]!.url).get("max")).toBe("10");
    expect(result.adjustments).toContainEqual(expect.stringContaining("pageSize 50 → 10"));
  });
});

describe("queries GNews cannot express are refused locally", () => {
  it("refuses a category filter rather than answering unfiltered", async () => {
    // The dangerous case: /search has no category parameter, so answering would
    // silently drop the filter and fill a category-scoped topic with articles
    // that do not belong to it.
    const { fetch, calls } = stubFetch([]);

    await expect(
      makeClient({ fetch }).search({ keywords: ["x"], category: "business" }),
    ).rejects.toBeInstanceOf(NewsInvalidQueryError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a domain filter for the same reason", async () => {
    const { fetch, calls } = stubFetch([]);

    await expect(
      makeClient({ fetch }).search({ keywords: ["x"], domain: "bbc.co.uk" }),
    ).rejects.toBeInstanceOf(NewsInvalidQueryError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a keyword-less sweep, since q is required", async () => {
    const { fetch, calls } = stubFetch([]);

    await expect(makeClient({ fetch }).search({})).rejects.toBeInstanceOf(
      NewsInvalidQueryError,
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses a q over 200 characters before spending the call", async () => {
    const { fetch, calls } = stubFetch([]);

    await expect(
      makeClient({ fetch }).search({ keywords: ["a".repeat(201)] }),
    ).rejects.toBeInstanceOf(NewsInvalidQueryError);
    expect(calls).toHaveLength(0);
  });

  it("tags refusals with the provider, so a fan-out log says who sat out", async () => {
    const { fetch } = stubFetch([]);

    await expect(makeClient({ fetch }).search({})).rejects.toMatchObject({
      provider: "gnews",
    });
  });

  it("tags a clamp refusal too, so a log line can attribute it", async () => {
    // The clamp refuses a page past the retrievable cap. It runs before the
    // query is built, so it is the refusal most likely to escape the tagging
    // block and reach `meta.degraded` as `provider: "unknown"`.
    const { fetch, calls } = stubFetch([]);

    await expect(
      makeClient({ fetch }).search({ keywords: ["x"], pageSize: 10, pageNumber: 99 }),
    ).rejects.toMatchObject({ provider: "gnews" });
    expect(calls).toHaveLength(0);
  });
});

describe("end of results", () => {
  it("ends on a short page", () => {
    expect(isLastPage(3, 10, 1, null)).toBe(true);
  });

  it("ends when totalArticles is exhausted, even on a full page", () => {
    // The signal Currents cannot give us: a full final page is ambiguous there
    // and certain here.
    expect(isLastPage(10, 10, 2, 20)).toBe(true);
  });

  it("keeps going on a full page with more to come", () => {
    expect(isLastPage(10, 10, 1, 55)).toBe(false);
  });

  it("falls back to the short-page rule when no total is given", () => {
    expect(isLastPage(10, 10, 1, null)).toBe(false);
  });

  it("reports it end to end", async () => {
    const { fetch } = stubFetch([
      { body: okBody([rawArticle()], 1) },
    ]);
    const result = await makeClient({ fetch }).search({ keywords: ["x"] });

    expect(result.isLastPage).toBe(true);
    expect(result.rawCount).toBe(1);
    expect(result.sightings).toHaveLength(1);
  });
});

describe("quota without any rate-limit headers", () => {
  it("reports no snapshot rather than fabricating one", async () => {
    // A parser inventing "plenty remaining" would make a quota bug invisible.
    const { fetch } = stubFetch([{ body: okBody() }]);
    const result = await makeClient({ fetch }).search({ keywords: ["x"] });

    expect(result.quota).toBeNull();
  });

  it("counts locally, so the tier budget binds with nothing observed", async () => {
    const governor = new InProcessQuotaGovernor({
      dailyLimit: 2,
      burstLimit: 60,
      interactiveReserve: 0,
    });
    const { fetch, calls } = stubFetch([{ body: okBody() }, { body: okBody() }]);
    const client = makeClient({ fetch, quota: governor });

    await client.search({ keywords: ["x"] });
    await client.search({ keywords: ["x"] });
    await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(NewsQuotaError);

    expect(calls).toHaveLength(2);
  });

  it("learns the day is spent from a 403 and stops calling", async () => {
    // The whole quota loop for this provider: no headers, so the 403 is the only
    // correction the governor will ever get. Without it, every remaining call of
    // the day would be spent rediscovering the same refusal.
    const governor = new InProcessQuotaGovernor({
      dailyLimit: 100,
      burstLimit: 60,
      interactiveReserve: 0,
    });
    const { fetch, calls } = stubFetch([
      { status: 403, body: { errors: ["You have reached your daily quota limit"] } },
    ]);
    const client = makeClient({ fetch, quota: governor, maxRetries: 0 });

    await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(NewsQuotaError);
    expect((await client.quota()).dailyRemaining).toBe(0);

    // The second call is refused locally: no fetch, no wasted request.
    await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(NewsQuotaError);
    expect(calls).toHaveLength(1);
  });

  it("does NOT ground the day on a 429, which only means slow down", async () => {
    const governor = new InProcessQuotaGovernor({
      dailyLimit: 100,
      burstLimit: 60,
      interactiveReserve: 0,
    });
    const { fetch } = stubFetch([
      { status: 429, body: { errors: ["Too many requests"] } },
      { body: okBody() },
    ]);
    const client = makeClient({ fetch, quota: governor });

    await client.search({ keywords: ["x"] });
    expect((await client.quota()).dailyRemaining).toBeGreaterThan(0);
  });
});

describe("top headlines", () => {
  it("sends a single category from the GNews taxonomy", async () => {
    const { fetch, calls } = stubFetch([{ body: okBody() }]);
    await makeClient({ fetch }).topHeadlines({ category: "technology", language: "en" });

    const params = query(calls[0]!.url);
    expect(calls[0]!.url).toContain("/top-headlines");
    expect(params.get("category")).toBe("technology");
    expect(params.get("lang")).toBe("en");
  });

  it("refuses a Currents v2 category name locally, spending no call", async () => {
    // The likeliest mistake: the two taxonomies share no values, so
    // "science_technology" is a 400 here and worth catching for free.
    const { fetch, calls } = stubFetch([]);

    await expect(
      makeClient({ fetch }).topHeadlines({ category: "science_technology" }),
    ).rejects.toBeInstanceOf(NewsInvalidQueryError);
    expect(calls).toHaveLength(0);
  });
});

describe("response handling", () => {
  it("tolerates undocumented extra fields rather than failing", async () => {
    const { fetch } = stubFetch([
      { body: { totalArticles: 1, articles: [rawArticle({ sentiment: "positive" })], nextPage: "x" } },
    ]);
    const result = await makeClient({ fetch }).search({ keywords: ["x"] });

    expect(result.sightings).toHaveLength(1);
  });

  it("counts a normalization drop without shortening the page signal", async () => {
    // rawCount, not sightings.length: one malformed article must never read as
    // the end of a topic's history.
    // A FULL page of ten, one of them malformed. rawCount is 10 and the walk
    // continues; had `sightings.length` been the signal it would read 9, look
    // short, and end the walk — permanently hiding the rest of the window.
    const articles = Array.from({ length: 10 }, (_, i) =>
      rawArticle({
        id: `a${i}`,
        url: `https://example.com/a${i}`,
        ...(i === 4 ? { title: "" } : {}),
      }),
    );
    const { fetch } = stubFetch([{ body: okBody(articles, 99) }]);
    const result = await makeClient({ fetch }).search({ keywords: ["x"] });

    expect(result.rawCount).toBe(10);
    expect(result.sightings).toHaveLength(9);
    expect(result.normalization.dropped.no_title).toBe(1);
    expect(result.isLastPage).toBe(false);
  });

  it("redacts the API key from anything upstream echoes back", async () => {
    const { fetch } = stubFetch([
      { status: 400, body: { errors: ["bad key test-key in request"] } },
    ]);

    await expect(makeClient({ fetch }).search({ keywords: ["x"] })).rejects.toMatchObject({
      message: expect.stringContaining("[redacted]"),
    });
  });
});
