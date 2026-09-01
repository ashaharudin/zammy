import { describe, expect, it } from "vitest";
import { collectPages } from "./paging.js";
import { emptyStats } from "./normalize.js";
import { soleContributor, type CallOpts, type NewsClient, type SearchResult } from "./client.js";
import type { SearchParams } from "./search-params.js";
import type { QuotaView } from "./quota.js";

/**
 * Paging (ARCHITECTURE 6.3 step 4).
 *
 * The assertion that matters most is the distinction between "upstream ran out of
 * sightings" and "the 100-result cap cut us off". They look identical from a single
 * response — both are just a full page — and conflating them permanently hides
 * history behind the cap with no error anywhere to report it.
 */

const limits = {
  maxPageSize: 20,
  maxRetrievableResults: 100,
  maxLookbackDays: 30,
  maxRangeDays: 7,
};

/** A client whose page sizes are scripted, so page-boundary logic is exact. */
function scriptedClient(rawCounts: number[], errorAt?: number): NewsClient & {
  requests: SearchParams[];
} {
  const requests: SearchParams[] = [];

  const client: NewsClient & { requests: SearchParams[] } = {
    requests,
    provider: "scripted",
    limits,
    async search(params: SearchParams, _opts?: CallOpts): Promise<SearchResult> {
      requests.push(params);
      const index = requests.length - 1;
      if (errorAt === index) throw new Error(`page ${index + 1} failed`);

      const rawCount = rawCounts[index] ?? 0;
      const pageSize = params.pageSize ?? limits.maxPageSize;
      const stats = emptyStats();
      stats.received = rawCount;
      stats.kept = rawCount;

      return {
        sightings: Array.from({ length: rawCount }, (_, item) => ({
          id: "00000000-0000-4000-8000-000000000000",
          provider: "scripted",
          providerSightingId: `p${index}-${item}`,
          url: `https://example.com/p${index}-${item}`,
          dedupKey: `${index}-${item}`.padStart(64, "0"),
          altKey: null,
          title: "t",
          description: null,
          author: null,
          imageUrl: null,
          language: "en",
          categories: [],
          sourceCategories: [],
          sourceDomain: "example.com",
          published: "2026-08-04T00:00:00.000Z",
          raw: {},
        })),
        requestedAt: new Date(),
        rawCount,
        isLastPage: rawCount < pageSize,
        // Its own completeness and nobody else's, as any single
        // (non-composite) client reports (ADR-0019). The pager reads the shared
        // plan's `isLastPage`, not this; the interface requires it.
        completeness: soleContributor("scripted", rawCount < pageSize),
        pageSize,
        normalization: stats,
        quota: null,
        adjustments: [],
      };
    },
    async quota(): Promise<QuotaView> {
      return { dailyRemaining: 1000, burstRemaining: 60, resetAt: null, observed: null };
    },
    async close() {},
  };

  return client;
}

describe("stopping at the true end of results", () => {
  it("pages until a short page and reports end_of_results", async () => {
    const client = scriptedClient([20, 20, 7]);

    const result = await collectPages(client, { keywords: ["climate"] });

    expect(result.pages).toBe(3);
    expect(result.rawCount).toBe(47);
    expect(result.stoppedBy).toBe("end_of_results");
    expect(result.nextPageNumber).toBeNull();
    expect(client.requests.map((request) => request.pageNumber)).toEqual([1, 2, 3]);
  });

  it("treats an immediately empty page as the end", async () => {
    const client = scriptedClient([0]);

    const result = await collectPages(client, { keywords: ["nothing"] });

    expect(result.pages).toBe(1);
    expect(result.sightings).toHaveLength(0);
    expect(result.stoppedBy).toBe("end_of_results");
  });
});

describe("the cap is not the end", () => {
  it("reports `cap` when five full pages come back", async () => {
    // 5 × 20 = the tier's 100-result ceiling. Upstream has more to give; the only
    // way to reach it is to subdivide the window (ARCHITECTURE 6.3), so calling
    // this "complete" would silently thin the timeline forever.
    const client = scriptedClient([20, 20, 20, 20, 20]);

    const result = await collectPages(client, { keywords: ["climate"] });

    expect(result.pages).toBe(5);
    expect(result.rawCount).toBe(100);
    expect(result.stoppedBy).toBe("cap");
    // Nothing to resume: the cap is not a cursor, it is a wall.
    expect(result.nextPageNumber).toBeNull();
  });

  it("never asks for a page past the cap", async () => {
    const client = scriptedClient([20, 20, 20, 20, 20, 20]);

    await collectPages(client, { keywords: ["climate"] });

    expect(client.requests).toHaveLength(5);
    expect(Math.max(...client.requests.map((r) => r.pageNumber ?? 0))).toBe(5);
  });

  it("recomputes the page ceiling for a smaller page size", async () => {
    const client = scriptedClient(Array.from({ length: 30 }, () => 10));

    const result = await collectPages(client, { pageSize: 10 });

    // 100-result cap at 10 per page is 10 pages, not 5.
    expect(result.pages).toBe(10);
    expect(result.stoppedBy).toBe("cap");
  });
});

describe("the caller's call budget", () => {
  it("stops at maxCalls and reports where to resume", async () => {
    // This is the deadline-bounded synchronous fill: paint what one or two calls
    // return, then let the queue finish the plan (ARCHITECTURE 6.3 step 5, 6.5).
    const client = scriptedClient([20, 20, 20, 20, 20]);

    const result = await collectPages(client, { keywords: ["climate"] }, {
      maxCalls: 2,
    });

    expect(result.pages).toBe(2);
    expect(result.stoppedBy).toBe("call_budget");
    expect(result.nextPageNumber).toBe(3);
  });

  it("resumes from a given start page", async () => {
    const client = scriptedClient([20, 20, 5]);

    const result = await collectPages(client, { keywords: ["climate"] }, {
      startPage: 3,
    });

    expect(client.requests[0]!.pageNumber).toBe(3);
    expect(result.stoppedBy).toBe("end_of_results");
  });

  it("always makes at least one call, even with a budget of zero", async () => {
    const client = scriptedClient([20, 20]);

    const result = await collectPages(client, {}, { maxCalls: 0 });

    expect(result.pages).toBe(1);
    expect(result.stoppedBy).toBe("call_budget");
  });
});

describe("failures", () => {
  it("throws when the FIRST page fails — there is nothing to show", async () => {
    // The one case with no fallback content, which is why it gets the guaranteed
    // synchronous call and a plain error state (ARCHITECTURE 11).
    const client = scriptedClient([20], 0);

    await expect(collectPages(client, { keywords: ["x"] })).rejects.toThrow(
      /page 1 failed/,
    );
  });

  it("keeps earlier pages when a LATER page fails", async () => {
    // The gap simply remains, and the next reader repairs it. Discarding the pages
    // we already paid for would be worse in every way.
    const client = scriptedClient([20, 20, 20], 2);

    const result = await collectPages(client, { keywords: ["x"] });

    expect(result.pages).toBe(2);
    expect(result.sightings).toHaveLength(40);
    expect(result.stoppedBy).toBe("error");
    expect(result.nextPageNumber).toBe(3);
    expect(result.error).toBeInstanceOf(Error);
  });
});

describe("aggregation across pages", () => {
  it("counts distinct dedup keys for the unique-per-call metric", async () => {
    const client = scriptedClient([20, 5]);

    const result = await collectPages(client, {});

    // The scripted client emits unique keys, so this is the ceiling case. On real
    // data the probe baseline is ~8 unique per 20 (ARCHITECTURE 12).
    expect(result.rawCount).toBe(25);
    expect(result.uniqueArticles).toBe(25);
  });

  it("sums normalization stats across pages", async () => {
    const client = scriptedClient([20, 20, 3]);

    const result = await collectPages(client, {});

    expect(result.normalization.received).toBe(43);
    expect(result.normalization.kept).toBe(43);
  });

  it("clamps an oversized page size before the first call", async () => {
    const client = scriptedClient([20, 3]);

    await collectPages(client, { pageSize: 500 });

    expect(client.requests[0]!.pageSize).toBe(20);
  });
});
