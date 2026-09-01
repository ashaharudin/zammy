import { describe, expect, it, vi } from "vitest";
import {
  NewsInvalidQueryError,
  NewsQuotaError,
  NewsUpstreamError,
  emptyStats,
  soleContributor,
  type CallOpts,
  type ClientLimits,
  type QuotaSnapshot,
  type QuotaView,
  type SearchParams,
  type SearchResult,
  type Sighting,
} from "@zammy/news-client";
import type { CurrentsClient } from "@zammy/currents-client";
import type { GnewsClient } from "@zammy/gnews-client";
import { CompositeNewsClient, narrowestLimits } from "./composite.js";

/**
 * The composite's job is to add breadth without costing correctness, and the two
 * are in genuine tension. Most of what follows guards the same invariant from
 * different angles: a supplement must never be able to end the shared walk,
 * claim a span it did not fetch, or fail a call the primary answered.
 */

const CURRENTS_LIMITS: ClientLimits = {
  maxPageSize: 20,
  maxRetrievableResults: 100,
  maxLookbackDays: 30,
  maxRangeDays: 7,
};

const GNEWS_LIMITS: ClientLimits = {
  maxPageSize: 10,
  maxRetrievableResults: 100,
  maxLookbackDays: 30,
  maxRangeDays: 30,
};

function sighting(provider: string, path: string): Sighting {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    provider,
    providerSightingId: path,
    url: `https://example.com/${path}`,
    dedupKey: path.padStart(64, "0"),
    altKey: null,
    title: `story ${path}`,
    description: null,
    author: null,
    imageUrl: null,
    language: "en",
    categories: [],
    sourceCategories: [],
    sourceDomain: "example.com",
    published: "2026-08-04T00:00:00.000Z",
    raw: {},
  };
}

function result(overrides: Partial<SearchResult> = {}, provider = "currents"): SearchResult {
  const stats = emptyStats();
  stats.received = 1;
  stats.kept = 1;
  const merged: SearchResult = {
    sightings: [sighting("currents", "a")],
    requestedAt: new Date("2026-08-17T00:00:00.000Z"),
    rawCount: 1,
    isLastPage: false,
    completeness: [],
    pageSize: 10,
    normalization: stats,
    quota: null,
    adjustments: [],
    ...overrides,
  };
  // What every non-composite client reports: itself, and its own answer.
  // Derived from `isLastPage` unless a case scripts it, so a case that sets one
  // and forgets the other cannot exist.
  return overrides.completeness
    ? merged
    : { ...merged, completeness: soleContributor(provider, merged.isLastPage) };
}

const QUOTA: QuotaView = {
  dailyRemaining: 900,
  burstRemaining: 60,
  resetAt: null,
  observed: null,
};

function fakeCurrents(overrides: Partial<CurrentsClient> = {}): CurrentsClient {
  return {
    provider: "currents",
    limits: CURRENTS_LIMITS,
    search: vi.fn(async () => result()),
    latestNews: vi.fn(async () => result()),
    availableLanguages: vi.fn(async () => ({ English: "en" })),
    availableRegions: vi.fn(async () => ({ "United State": "US" })),
    availableCategories: vi.fn(async () => ["news"]),
    quota: vi.fn(async () => QUOTA),
    close: vi.fn(async () => {}),
    ...overrides,
  } as CurrentsClient;
}

function fakeGnews(overrides: Partial<GnewsClient> = {}): GnewsClient {
  return {
    provider: "gnews",
    limits: GNEWS_LIMITS,
    search: vi.fn(async () => result({ sightings: [sighting("gnews", "b")] }, "gnews")),
    topHeadlines: vi.fn(async () => result({ sightings: [sighting("gnews", "b")] }, "gnews")),
    quota: vi.fn(async () => ({ ...QUOTA, dailyRemaining: 42 })),
    close: vi.fn(async () => {}),
    ...overrides,
  } as GnewsClient;
}

describe("fanning out and merging", () => {
  it("returns both providers' sightings", async () => {
    const composite = new CompositeNewsClient(fakeCurrents(), [fakeGnews()]);
    const merged = await composite.search({ keywords: ["x"] });

    expect(merged.sightings.map((s) => s.provider)).toEqual(["currents", "gnews"]);
    expect(merged.rawCount).toBe(2);
  });

  it("does NOT deduplicate across providers", async () => {
    // Two providers reporting one URL is two genuine observations of one
    // article — the same relationship one provider re-emitting a story creates.
    // The storage fold collapses them on dedupKey (ADR-0002); collapsing here
    // would throw away a sighting the archive is entitled to.
    const same = sighting("gnews", "a");
    const composite = new CompositeNewsClient(fakeCurrents(), [
      fakeGnews({ search: vi.fn(async () => result({ sightings: [same] })) }),
    ]);

    const merged = await composite.search({ keywords: ["x"] });
    expect(merged.sightings).toHaveLength(2);
    expect(new Set(merged.sightings.map((s) => s.dedupKey)).size).toBe(1);
  });

  it("accumulates normalization stats across providers", async () => {
    const composite = new CompositeNewsClient(fakeCurrents(), [fakeGnews()]);
    const merged = await composite.search({ keywords: ["x"] });

    expect(merged.normalization.received).toBe(2);
    expect(merged.normalization.kept).toBe(2);
  });

  it("dispatches concurrently rather than in sequence", async () => {
    // A reader on the 1200ms synchronous fill budget should not pay for two
    // round trips end to end.
    let running = 0;
    let peak = 0;
    const slow = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return result();
    };

    const composite = new CompositeNewsClient(
      fakeCurrents({ search: vi.fn(slow) }),
      [fakeGnews({ search: vi.fn(slow) })],
    );
    await composite.search({ keywords: ["x"] });

    expect(peak).toBe(2);
  });

  it("reports the tightest quota, so the binding budget is the visible one", async () => {
    const snapshot = (remaining: number): QuotaSnapshot => ({
      limit: 1000,
      remaining,
      burstLimit: 60,
      burstRemaining: 60,
      resetTime: null,
      observedAt: new Date(),
    });

    const composite = new CompositeNewsClient(
      fakeCurrents({ search: vi.fn(async () => result({ quota: snapshot(900) })) }),
      [fakeGnews({ search: vi.fn(async () => result({ quota: snapshot(7) })) })],
    );

    expect((await composite.search({ keywords: ["x"] })).quota?.remaining).toBe(7);
  });
});

describe("a supplement can never end the shared walk or claim another's span", () => {
  it("takes isLastPage — the shared plan's terminator — from the primary alone", async () => {
    // One fan-out, one `pageNumber`, one loop, so exactly one provider can end
    // it. Letting a supplement vote would stop the primary's walk mid-window
    // (ADR-0019: providers stop sharing a plan, and until they do this is whose
    // plan it is).
    const composite = new CompositeNewsClient(
      fakeCurrents({ search: vi.fn(async () => result({ isLastPage: false })) }),
      [fakeGnews({ search: vi.fn(async () => result({ isLastPage: true }, "gnews")) })],
    );

    expect((await composite.search({ keywords: ["x"] })).isLastPage).toBe(false);
  });

  it("reports each provider's own completeness rather than resolving one answer", async () => {
    // The facts, unranked (ADR-0019). A caller writing a coverage row picks the
    // provider it is writing for and reads that provider's entry; nothing here
    // decides for it, and the primary saying "not finished" does not overwrite
    // the supplement's honest "I am".
    const composite = new CompositeNewsClient(
      fakeCurrents({ search: vi.fn(async () => result({ isLastPage: false })) }),
      [fakeGnews({ search: vi.fn(async () => result({ isLastPage: true }, "gnews")) })],
    );

    expect((await composite.search({ keywords: ["x"] })).completeness).toEqual([
      { provider: "currents", isLastPage: false },
      { provider: "gnews", isLastPage: true },
    ]);
  });

  it("leaves a provider that sat the call out ABSENT from completeness", async () => {
    // Absence is the claim, and it is why a caller cannot mistake a sit-out for
    // a walk: a supplement out of budget has no entry at all, so there is
    // nothing for a coverage write to key off. `isLastPage: false` would have
    // been a statement about a window it never looked at.
    const composite = new CompositeNewsClient(
      fakeCurrents({ search: vi.fn(async () => result({ isLastPage: true })) }),
      [
        fakeGnews({
          search: vi.fn(async () => {
            throw new NewsQuotaError("daily quota exhausted", null, true);
          }),
        }),
      ],
    );

    expect((await composite.search({ keywords: ["x"] })).completeness).toEqual([
      { provider: "currents", isLastPage: true },
    ]);
  });

  it("does not let an exhausted supplement end a walk either", async () => {
    const composite = new CompositeNewsClient(
      fakeCurrents({ search: vi.fn(async () => result({ isLastPage: false })) }),
      [
        fakeGnews({
          search: vi.fn(async () => {
            throw new NewsQuotaError("daily quota exhausted", null, true);
          }),
        }),
      ],
    );

    expect((await composite.search({ keywords: ["x"] })).isLastPage).toBe(false);
  });

  it("keeps the primary's pageSize, which is what isLastPage is read against", async () => {
    const composite = new CompositeNewsClient(
      fakeCurrents({ search: vi.fn(async () => result({ pageSize: 10 })) }),
      [fakeGnews({ search: vi.fn(async () => result({ pageSize: 3 })) })],
    );

    expect((await composite.search({ keywords: ["x"] })).pageSize).toBe(10);
  });
});

describe("a supplement's trouble is absorbed, never hidden", () => {
  const failing = (error: unknown) =>
    fakeGnews({
      search: vi.fn(async () => {
        throw error;
      }),
    });

  it("still serves the primary's results when the supplement errors", async () => {
    const composite = new CompositeNewsClient(
      fakeCurrents(),
      [failing(new NewsUpstreamError("gnews is down", 503))],
    );

    const merged = await composite.search({ keywords: ["x"] });
    expect(merged.sightings).toHaveLength(1);
    expect(merged.sightings[0]!.provider).toBe("currents");
  });

  it("records the sit-out in adjustments, so a degraded provider is visible", async () => {
    const composite = new CompositeNewsClient(
      fakeCurrents(),
      [failing(new NewsQuotaError("daily quota exhausted", null, true))],
    );

    const merged = await composite.search({ keywords: ["x"] });
    expect(merged.adjustments).toContainEqual(
      expect.stringContaining("[gnews] sat this call out"),
    );
    expect(merged.adjustments.join(" ")).toContain("quota");
  });

  it("logs the sit-out too", async () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const composite = new CompositeNewsClient(
      fakeCurrents(),
      [failing(new NewsUpstreamError("gnews is down", 503))],
      { logger },
    );

    await composite.search({ keywords: ["x"] });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "gnews", operation: "search" }),
      expect.stringContaining("contributed nothing"),
    );
  });

  it("absorbs a query the supplement cannot express", async () => {
    // GNews /search has no category filter and refuses locally rather than
    // answering unfiltered. A category-scoped topic must still get its
    // Currents results.
    const composite = new CompositeNewsClient(
      fakeCurrents(),
      [failing(new NewsInvalidQueryError("no category filter on /search"))],
    );

    const merged = await composite.search({ keywords: ["x"], category: "business" });
    expect(merged.sightings).toHaveLength(1);
  });

  it("tags a supplement's own adjustments with its name", async () => {
    const composite = new CompositeNewsClient(fakeCurrents(), [
      fakeGnews({
        search: vi.fn(async () => result({ adjustments: ["pageSize 50 → 10 (tier maximum)"] })),
      }),
    ]);

    const merged = await composite.search({ keywords: ["x"] });
    expect(merged.adjustments).toContainEqual(
      "[gnews] pageSize 50 → 10 (tier maximum)",
    );
  });
});

describe("the primary's failures are not absorbed", () => {
  it("propagates them, exactly as before the fan-out existed", async () => {
    // A cold topic has nothing to fall back on, so this failure is the caller's
    // to render (ARCHITECTURE 11). Swallowing it would turn an outage into an
    // empty timeline with no explanation.
    const composite = new CompositeNewsClient(
      fakeCurrents({
        search: vi.fn(async () => {
          throw new NewsUpstreamError("currents is down", 503);
        }),
      }),
      [fakeGnews()],
    );

    await expect(composite.search({ keywords: ["x"] })).rejects.toBeInstanceOf(
      NewsUpstreamError,
    );
  });
});

describe("limits", () => {
  it("narrows to what every provider can serve", async () => {
    const composite = new CompositeNewsClient(fakeCurrents(), [fakeGnews()]);

    expect(composite.limits).toEqual({
      maxPageSize: 10, // GNews Free is the smaller page
      maxRetrievableResults: 100,
      maxLookbackDays: 30,
      maxRangeDays: 7, // the Currents per-call ceiling is the tighter one
    });
  });

  it("takes each limit from whichever provider is strictest", () => {
    // Not "whichever provider is smallest overall" — the binding constraint can
    // come from a different provider per field, as it does here.
    const narrowed = narrowestLimits([
      { provider: "a", limits: CURRENTS_LIMITS } as never,
      { provider: "b", limits: GNEWS_LIMITS } as never,
    ]);

    expect(narrowed.maxPageSize).toBe(GNEWS_LIMITS.maxPageSize);
    expect(narrowed.maxRangeDays).toBe(CURRENTS_LIMITS.maxRangeDays);
  });
});

describe("latest news — the §10.1 breadth sample", () => {
  it("merges Currents' category sweep with GNews top headlines", async () => {
    const gnews = fakeGnews();
    const composite = new CompositeNewsClient(fakeCurrents(), [gnews]);

    const merged = await composite.latestNews({ language: "en", pageNumber: 2 });

    expect(merged.sightings).toHaveLength(2);
    expect(gnews.topHeadlines).toHaveBeenCalledWith(
      { language: "en", pageNumber: 2 },
      expect.anything(),
    );
  });

  it("survives a supplement that cannot serve it", async () => {
    const composite = new CompositeNewsClient(fakeCurrents(), [
      fakeGnews({
        topHeadlines: vi.fn(async () => {
          throw new NewsUpstreamError("down", 503);
        }),
      }),
    ]);

    expect((await composite.latestNews()).sightings).toHaveLength(1);
  });
});

describe("reference lists and quota reporting", () => {
  it("takes reference lists from the primary", async () => {
    // They define what a topic can be; a supplement either serves such a topic
    // or sits it out.
    const composite = new CompositeNewsClient(fakeCurrents(), [fakeGnews()]);

    expect(await composite.availableCategories()).toEqual(["news"]);
    expect(await composite.availableLanguages()).toEqual({ English: "en" });
  });

  it("reports the primary's budget as the headline quota", async () => {
    // So /readyz.upstream keeps meaning "the timeline stops refreshing when
    // this runs out" rather than being dominated by a 100-call supplement.
    const composite = new CompositeNewsClient(fakeCurrents(), [fakeGnews()]);

    expect((await composite.quota()).dailyRemaining).toBe(900);
  });

  it("breaks the budget down per provider for /readyz", async () => {
    const composite = new CompositeNewsClient(fakeCurrents(), [fakeGnews()]);

    expect(await composite.quotaByProvider()).toEqual({
      currents: expect.objectContaining({ dailyRemaining: 900 }),
      gnews: expect.objectContaining({ dailyRemaining: 42 }),
    });
  });

  it("closes every provider", async () => {
    const currents = fakeCurrents();
    const gnews = fakeGnews();
    await new CompositeNewsClient(currents, [gnews]).close();

    expect(currents.close).toHaveBeenCalled();
    expect(gnews.close).toHaveBeenCalled();
  });
});

describe("it passes the caller's options through untouched", () => {
  it("forwards priority and signal to every provider", async () => {
    const currents = fakeCurrents();
    const gnews = fakeGnews();
    const composite = new CompositeNewsClient(currents, [gnews]);

    const opts: CallOpts = { priority: "background" };
    const params: SearchParams = { keywords: ["x"] };
    await composite.search(params, opts);

    expect(currents.search).toHaveBeenCalledWith(params, opts);
    expect(gnews.search).toHaveBeenCalledWith(params, opts);
  });
});
