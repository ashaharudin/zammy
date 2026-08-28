import { describe, expect, it } from "vitest";
import {
  InProcessQuotaGovernor,
  NewsBlockedError,
  NewsInvalidQueryError,
  NewsQuotaError,
  NewsSchemaError,
  NewsUpstreamError,
} from "@zammy/news-client";
import { isLastPage } from "./http.js";
import { ITEMS_PER_QUERY } from "./raw.js";
import { cappedFeed, feed, item, makeClient, stubFetch } from "./test-support.js";

/**
 * The live client. Retries, the breaker and deadlines belong to the shared
 * transport and are tested there; what is asserted here is what is
 * Google-News-shaped — the `after:`/`before:` encoding, the wall where other
 * providers have a cursor, the queries that must be refused rather than
 * answered, and a quota loop with nothing at all to run on.
 */

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

function q(url: string): string {
  return query(url).get("q") ?? "";
}

describe("query construction", () => {
  it("space-joins keywords, matching how a topic asks Currents", async () => {
    const { fetch, calls } = stubFetch([{}]);
    await makeClient({ fetch }).search({ keywords: ["jason", "arday"] });

    expect(q(calls[0]!.url)).toBe("jason arday");
  });

  it("sends the hl/gl/ceid triple as one consistent set", async () => {
    // The three are not independent: hl is <lang>-<COUNTRY>, gl is the country,
    // ceid is <COUNTRY>:<lang>. A set that disagrees with itself returns a
    // different, quieter result set.
    const { fetch, calls } = stubFetch([{}]);
    await makeClient({ fetch }).search({ keywords: ["x"] });

    const params = query(calls[0]!.url);
    expect(params.get("hl")).toBe("en-CA");
    expect(params.get("gl")).toBe("CA");
    expect(params.get("ceid")).toBe("CA:en");
  });

  it("lets a search override the locale", async () => {
    const { fetch, calls } = stubFetch([{}]);
    await makeClient({ fetch }).search({ keywords: ["x"], language: "fr", country: "fr" });

    const params = query(calls[0]!.url);
    expect(params.get("hl")).toBe("fr-FR");
    expect(params.get("ceid")).toBe("FR:fr");
  });

  it("always sends an explicit User-Agent", async () => {
    // PROBE-FINDINGS 2: a default library UA cost the Currents probe its first
    // 11 calls to a Cloudflare 403. There is no key here, so the UA is the only
    // thing identifying this client at all.
    const { fetch, calls } = stubFetch([{}]);
    await makeClient({ fetch }).search({ keywords: ["x"] });

    expect((calls[0]!.init.headers as Record<string, string>)["User-Agent"]).toBe(
      "zammy-test/0.0",
    );
  });

  it("refuses to construct with an empty User-Agent", () => {
    expect(() => makeClient({ userAgent: "  " })).toThrow(/GOOGLE_NEWS_USER_AGENT/);
  });
});

describe("date windowing through after:/before:", () => {
  it("puts the window in q, because there are no date parameters", async () => {
    const { fetch, calls } = stubFetch([{}]);
    await makeClient({ fetch }).search({
      keywords: ["jason", "arday"],
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-08-08T00:00:00.000Z"),
    });

    const params = query(calls[0]!.url);
    expect(params.get("after")).toBeNull();
    expect(params.get("before")).toBeNull();
    expect(q(calls[0]!.url)).toMatch(/^jason arday after:\d{4}-\d{2}-\d{2} before:/);
  });

  it("pads a day outward, because Google resolves the bound in US Pacific time", async () => {
    // Measured 2026-08-28: `after:2026-08-20 before:2026-08-22` returned items
    // spanning 2026-08-20T07:00Z … 2026-08-22T07:00Z — midnight PDT at both
    // ends, and inclusive at the top. A naive `after:<utc day>` would skip the
    // first seven hours the caller asked for, and the caller would record that
    // span as covered. Under-fetching is the failure this codebase treats as
    // the worst available (ARCHITECTURE 11), so the padding errs outward.
    const { fetch, calls } = stubFetch([{}]);
    await makeClient({ fetch }).search({
      keywords: ["x"],
      startDate: new Date("2026-08-20T00:00:00.000Z"),
      endDate: new Date("2026-08-22T00:00:00.000Z"),
    });

    expect(q(calls[0]!.url)).toBe("x after:2026-08-19 before:2026-08-23");
  });

  it("pads in February too, when the offset is PST rather than PDT", async () => {
    // The second measurement: `after:2025-02-01 before:2025-02-03` returned
    // 2025-02-01T08:00Z … 2025-02-03T08:00Z. A day of padding covers either
    // offset without this adapter having to model Google's timezone.
    const { fetch, calls } = stubFetch([{}]);
    await makeClient({ fetch }).search({
      keywords: ["x"],
      startDate: new Date("2025-02-01T00:00:00.000Z"),
      endDate: new Date("2025-02-03T00:00:00.000Z"),
    });

    expect(q(calls[0]!.url)).toBe("x after:2025-01-31 before:2025-02-04");
  });

  it("sends only the bound it was given", async () => {
    const { fetch, calls } = stubFetch([{}]);
    await makeClient({ fetch }).search({
      keywords: ["x"],
      startDate: new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(q(calls[0]!.url)).toBe("x after:2026-08-19");
  });

  it("reaches the 573 days actually probed, unclamped", async () => {
    // The entire reason this provider is worth having, and the deepest point
    // anyone has measured: a 2025-02-01 window answered on 2026-08-28, 573 days
    // later, with 20 items from 17 publisher domains. Currents' verified
    // lookback is 30 days and exactly 30 already 400s.
    const { fetch, calls } = stubFetch([{}]);
    const result = await makeClient({ fetch }).search({
      keywords: ["x"],
      startDate: new Date("2025-02-01T00:00:00.000Z"),
      endDate: new Date("2025-02-03T00:00:00.000Z"),
    });

    expect(q(calls[0]!.url)).toContain("after:2025-01-31");
    // No adjustment, i.e. the window was not quietly pulled forward.
    expect(result.adjustments).toEqual([]);
  });
});

describe("the 100-item wall", () => {
  it("is a short feed that ends a window", () => {
    expect(isLastPage(20)).toBe(true);
    expect(isLastPage(0)).toBe(true);
    expect(isLastPage(ITEMS_PER_QUERY - 1)).toBe(true);
  });

  it("is never 'finished' at exactly the cap", () => {
    // A full 100 means the cap cut us off. Reading it as the end of the window
    // would record coverage over a span two thirds of which was never seen —
    // five weekly slices of one arc gave 433 items where the unsliced query
    // gave 92.
    expect(isLastPage(ITEMS_PER_QUERY)).toBe(false);
  });

  it("surfaces the cap end to end, with rawCount at exactly 100", async () => {
    const { fetch } = stubFetch([{ body: cappedFeed() }]);
    const result = await makeClient({ fetch }).search({ keywords: ["x"] });

    expect(result.rawCount).toBe(ITEMS_PER_QUERY);
    expect(result.isLastPage).toBe(false);
    expect(result.sightings).toHaveLength(ITEMS_PER_QUERY);
  });

  it("ends the window on a short feed", async () => {
    const { fetch } = stubFetch([{ body: feed([item(), item({ guid: "CBM2" })]) }]);
    const result = await makeClient({ fetch }).search({ keywords: ["x"] });

    expect(result.rawCount).toBe(2);
    expect(result.isLastPage).toBe(true);
  });

  it("reports the size that actually applied, not the one asked for", async () => {
    // `SearchResult.pageSize` is documented as the number needed to interpret
    // `isLastPage`, so it has to be the wall. The widening is surfaced as an
    // adjustment rather than absorbed — every other clamp here narrows.
    const { fetch } = stubFetch([{}]);
    const result = await makeClient({ fetch }).search({ keywords: ["x"], pageSize: 20 });

    expect(result.pageSize).toBe(ITEMS_PER_QUERY);
    expect(result.adjustments).toContainEqual(expect.stringContaining("pageSize 20 → 100"));
  });
});

describe("queries this endpoint cannot express are refused locally", () => {
  it("refuses a second page, which would return the first one again", async () => {
    // There is no offset parameter. Answering would make a pager re-ingest one
    // page forever and count it as new history — the precise failure
    // `clampSearchParams` refuses rather than clamps.
    const { fetch, calls } = stubFetch([]);

    await expect(
      makeClient({ fetch }).search({ keywords: ["x"], pageNumber: 2 }),
    ).rejects.toBeInstanceOf(NewsInvalidQueryError);
    expect(calls).toHaveLength(0);
  });

  it("is refused by the shared clamp as well, at the default page size", async () => {
    // maxPageSize == maxRetrievableResults == 100, so `clampSearchParams`
    // computes exactly one retrievable page. Two independent guards over the
    // same failure, deliberately.
    const { fetch, calls } = stubFetch([]);

    await expect(
      makeClient({ fetch }).search({ keywords: ["x"], pageSize: 100, pageNumber: 2 }),
    ).rejects.toMatchObject({ fieldErrors: { page_number: expect.any(String) } });
    expect(calls).toHaveLength(0);
  });

  it("refuses a category filter rather than answering unfiltered", async () => {
    const { fetch, calls } = stubFetch([]);

    await expect(
      makeClient({ fetch }).search({ keywords: ["x"], category: "business" }),
    ).rejects.toBeInstanceOf(NewsInvalidQueryError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a domain filter, because none was verified", async () => {
    // An unverified filter is worse than no filter: silently ignored, a
    // domain-scoped topic fills with every other outlet and nothing reports it.
    const { fetch, calls } = stubFetch([]);

    await expect(
      makeClient({ fetch }).search({ keywords: ["x"], domain: "cbc.ca" }),
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

  it("tags every refusal with the provider, so a log line can attribute it", async () => {
    const { fetch } = stubFetch([]);

    await expect(makeClient({ fetch }).search({})).rejects.toMatchObject({
      provider: "google-news",
    });
  });

  it("tags a clamp refusal too, which runs before the query is even built", async () => {
    const { fetch } = stubFetch([]);

    await expect(
      makeClient({ fetch }).search({ keywords: ["x"], pageSize: 100, pageNumber: 9 }),
    ).rejects.toMatchObject({ provider: "google-news" });
  });
});

describe("quota, with nothing to read it from", () => {
  it("reports null rather than fabricating a snapshot", async () => {
    // There is no rate-limit header AND no published ceiling — worse than
    // GNews, which at least has a documented number. A parser inventing
    // "plenty remaining" would make a quota bug invisible forever.
    const { fetch } = stubFetch([{}]);
    const result = await makeClient({ fetch }).search({ keywords: ["x"] });

    expect(result.quota).toBeNull();
  });

  it("never once learns a real number from upstream", async () => {
    // Asserted across a whole call rather than on one field: `observed` staying
    // null is what makes the self-imposed budget the only ceiling there is.
    const { fetch } = stubFetch([{}]);
    const client = makeClient({ fetch });
    await client.search({ keywords: ["x"] });

    expect((await client.quota()).observed).toBeNull();
  });

  it("counts locally, so the invented budget actually binds", async () => {
    const governor = new InProcessQuotaGovernor({
      dailyLimit: 2,
      burstLimit: 60,
      interactiveReserve: 0,
    });
    const { fetch, calls } = stubFetch([{}, {}]);
    const client = makeClient({ fetch, quota: governor });

    await client.search({ keywords: ["x"] });
    await client.search({ keywords: ["x"] });
    await expect(client.search({ keywords: ["x"] })).rejects.toBeInstanceOf(NewsQuotaError);

    expect(calls).toHaveLength(2);
  });

  it("does not ground the day on a 429, which only means slow down", async () => {
    // And unlike GNews there is no status that DOES mean the day is spent, so
    // nothing here may ever set `exhaustsDailyBudget`.
    const governor = new InProcessQuotaGovernor({
      dailyLimit: 100,
      burstLimit: 60,
      interactiveReserve: 0,
    });
    const { fetch } = stubFetch([{ status: 429, body: "slow down" }, {}]);
    const client = makeClient({ fetch, quota: governor });

    await client.search({ keywords: ["x"] });
    expect((await client.quota()).dailyRemaining).toBeGreaterThan(0);
  });
});

describe("response handling", () => {
  it("counts a normalization drop without shortening the page signal", async () => {
    // rawCount, not sightings.length. A FULL feed of 100 with one malformed
    // item: rawCount is 100 and the walk continues. Had `sightings.length` been
    // the signal it would read 99, look short, and turn "the cap cut us off,
    // subdivide" into "this window is finished" — permanently hiding the rest
    // of a topic's history behind a span recorded as covered.
    const items = Array.from({ length: ITEMS_PER_QUERY }, (_, i) =>
      item({
        guid: `CBM${i}`,
        link: `https://news.google.com/rss/articles/CBM${i}?oc=5`,
        ...(i === 42 ? { pubDate: "nonsense" } : {}),
      }),
    );
    const { fetch } = stubFetch([{ body: feed(items) }]);
    const result = await makeClient({ fetch }).search({ keywords: ["x"] });

    expect(result.rawCount).toBe(ITEMS_PER_QUERY);
    expect(result.sightings).toHaveLength(ITEMS_PER_QUERY - 1);
    expect(result.normalization.dropped.bad_published).toBe(1);
    expect(result.isLastPage).toBe(false);
  });

  it("reads a truncated feed as the items that survived it", async () => {
    const truncated = feed([item(), item({ guid: "CBM2" })]).replace("</channel></rss>", "");
    const { fetch } = stubFetch([{ body: truncated }]);
    const result = await makeClient({ fetch }).search({ keywords: ["x"] });

    expect(result.rawCount).toBe(2);
    expect(result.sightings).toHaveLength(2);
  });

  it("treats a 200 that is not a feed as a schema error, not a fault to retry", async () => {
    const { fetch, calls } = stubFetch([{ body: "<!doctype html><html>nope</html>" }]);

    await expect(makeClient({ fetch }).search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      NewsSchemaError,
    );
    expect(calls).toHaveLength(1);
  });

  it("reads an empty channel as an empty, finished window", async () => {
    const { fetch } = stubFetch([{ body: feed([]) }]);
    const result = await makeClient({ fetch }).search({ keywords: ["x"] });

    expect(result.rawCount).toBe(0);
    expect(result.isLastPage).toBe(true);
  });
});

describe("errors", () => {
  it("maps a 403 with a non-JSON body to blocked, never to auth", async () => {
    // PROBE-FINDINGS 2 taken verbatim. There is no key here, so an auth
    // diagnosis would send someone hunting a credential that does not exist —
    // the remedy is the User-Agent or the egress IP.
    const { fetch } = stubFetch([
      { status: 403, body: "<html>error code: 1010</html>", headers: {} },
    ]);

    const error = await makeClient({ fetch })
      .search({ keywords: ["x"] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NewsBlockedError);
    expect((error as NewsBlockedError).message).toContain("NOT an authentication failure");
  });

  it("does not retry a block, which would spend calls learning the same thing", async () => {
    const { fetch, calls } = stubFetch([{ status: 403, body: "blocked" }]);

    await expect(makeClient({ fetch }).search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      NewsBlockedError,
    );
    expect(calls).toHaveLength(1);
  });

  it("maps a 500 to a retryable upstream error", async () => {
    const { fetch } = stubFetch([
      { status: 500, body: "boom" },
      { status: 500, body: "boom" },
      { status: 500, body: "boom" },
    ]);

    await expect(makeClient({ fetch }).search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      NewsUpstreamError,
    );
  });

  it("maps a 404 to our bug, since a query matching nothing answers 200", async () => {
    const { fetch } = stubFetch([{ status: 404, body: "not found" }]);

    await expect(makeClient({ fetch }).search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      NewsInvalidQueryError,
    );
  });

  it("tags upstream errors with the provider", async () => {
    const { fetch } = stubFetch([{ status: 403, body: "blocked" }]);

    await expect(makeClient({ fetch }).search({ keywords: ["x"] })).rejects.toMatchObject({
      provider: "google-news",
    });
  });
});
