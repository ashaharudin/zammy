import { beforeAll, describe, expect, it } from "vitest";
import { createCurrentsClient } from "./factory.js";
import { collectPages } from "./paging.js";
import { usefulCategories } from "./client.js";
import type { CurrentsClient } from "./client.js";
import { FIXTURES_DIR } from "./test-support.js";

/**
 * Fixture mode end to end (ARCHITECTURE 4.1).
 *
 * This is the mode nearly all development and the whole test suite run in, so it
 * needs to behave like the real thing rather than merely return something. In
 * particular it must reproduce the upstream misbehaviour the recorded payloads
 * captured — synthetic fixtures would hide exactly the bugs worth catching.
 */

const config = {
  CURRENTS_MODE: "fixture" as const,
  CURRENTS_BASE_URL: "https://api.currentsapi.services/v1",
  CURRENTS_USER_AGENT: "zammy-test/0.0",
  CURRENTS_MAX_PAGE_SIZE: 20,
  CURRENTS_MAX_RETRIEVABLE_RESULTS: 100,
  CURRENTS_MAX_LOOKBACK_DAYS: 30,
  CURRENTS_MAX_RANGE_DAYS: 7,
  CURRENTS_DAILY_CALL_LIMIT: 1000,
  CURRENTS_BURST_CALL_LIMIT: 60,
  INTERACTIVE_RESERVE: 250,
  FIXTURES_DIR,
};

let client: CurrentsClient;

beforeAll(async () => {
  client = await createCurrentsClient(config);
});

describe("the factory hides which client you got", () => {
  it("returns normalized sightings from the recorded payloads", async () => {
    const result = await client.search({ pageSize: 20 });

    expect(result.sightings).toHaveLength(20);
    expect(result.rawCount).toBe(20);
    expect(result.isLastPage).toBe(false);
    // Normalization ran: no upstream quirk survives into fixture mode either.
    expect(result.sightings.every((sighting) => sighting.imageUrl !== "None")).toBe(true);
    expect(result.sightings.every((sighting) => sighting.dedupKey.length === 64)).toBe(true);
    expect(
      result.sightings.every((sighting) => sighting.published.endsWith("Z")),
    ).toBe(true);
  });

  it("reports no quota observation, because no call was made", async () => {
    // Null rather than a fabricated "plenty remaining": a quota bug must not be
    // invisible in the mode most development happens in.
    const result = await client.search({ pageSize: 5 });
    expect(result.quota).toBeNull();
    expect((await client.quota()).observed).toBeNull();
  });

  it("returns sightings newest-first, as upstream does", async () => {
    const result = await client.search({ pageSize: 20 });
    const times = result.sightings.map((sighting) => Date.parse(sighting.published));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("pages disjointly", async () => {
    const page1 = await client.search({ pageNumber: 1, pageSize: 20 });
    const page2 = await client.search({ pageNumber: 2, pageSize: 20 });

    const first = new Set(page1.sightings.map((sighting) => sighting.id));
    expect(page2.sightings.filter((sighting) => first.has(sighting.id))).toHaveLength(0);
  });

  it("signals the last page on a short page", async () => {
    // 16 of the recorded sightings carry "climate" in the text fixture mode can
    // match on, so one page covers them and the short page ends the query.
    const result = await client.search({ keywords: ["climate"], pageSize: 20 });

    expect(result.rawCount).toBeLessThan(20);
    expect(result.isLastPage).toBe(true);
  });

  it("refuses a page past the cap rather than re-serving the last one", async () => {
    await expect(client.search({ pageNumber: 6, pageSize: 20 })).rejects.toThrow(
      /exceeds the retrievable cap/,
    );
  });

  it("clamps to tier limits exactly as the live client does", async () => {
    const result = await client.search({ pageSize: 500 });
    expect(result.sightings.length).toBeLessThanOrEqual(20);
    expect(result.adjustments.join(" ")).toMatch(/tier maximum/);
  });
});

describe("filters", () => {
  it("filters by keyword against the text we actually have", async () => {
    const result = await client.search({ keywords: ["climate"], pageSize: 20 });

    expect(result.sightings.length).toBeGreaterThan(0);
    for (const sighting of result.sightings) {
      const haystack = `${sighting.title} ${sighting.description ?? ""}`.toLowerCase();
      expect(haystack).toContain("climate");
    }
  });

  it("filters by language", async () => {
    const result = await client.search({ language: "en", pageSize: 20 });
    expect(result.sightings.every((sighting) => sighting.language === "en")).toBe(true);
  });

  it("returns an empty last page for a keyword nothing matches", async () => {
    const result = await client.search({ keywords: ["zzzznotarealword"] });
    expect(result.sightings).toHaveLength(0);
    expect(result.isLastPage).toBe(true);
  });
});

describe("reference data offline", () => {
  it("serves the recorded name→code maps", async () => {
    const languages = await client.availableLanguages();
    const regions = await client.availableRegions();

    expect(languages["English"]).toBe("en");
    expect(languages["Malay"]).toBe("msa");
    expect(regions["United State"]).toBe("US");
  });

  it("serves categories verbatim, junk included", async () => {
    const categories = await client.availableCategories();

    expect(categories).toContain("technology");
    expect(categories).toContain("crap");
    // Filtering is the picker's job, and it is available as a helper.
    expect(usefulCategories(categories)).not.toContain("crap");
    expect(usefulCategories(categories)).toContain("technology");
  });
});

describe("paging over fixture mode reproduces the cap", () => {
  it("stops at the 100-result cap with a full final page", async () => {
    // 180 recorded sightings is more than the tier can retrieve for one query, so
    // offline mode exercises the truncation path rather than only the tidy one —
    // and `cap`, not `end_of_results`, is what makes Phase 3 subdivide the window.
    const result = await collectPages(client, {});

    expect(result.pages).toBe(5);
    expect(result.rawCount).toBe(100);
    expect(result.stoppedBy).toBe("cap");
  });

  it("shows the duplication the real API exhibits", async () => {
    const result = await collectPages(client, {});

    // Fewer unique articles than raw sightings — the finding that makes the
    // load-bearing rather than cosmetic (PROBE-FINDINGS 4). A synthetic fixture
    // collapse necessary. Synthetic fixtures would report these equal and the
    // collapse would look like wasted work.
    expect(result.uniqueArticles).toBeLessThan(result.rawCount);
  });
});

describe("latestNews offline — the recorded /v2 feed (PROBE-FINDINGS 6c)", () => {
  it("filters by v2 categories and pages, newest first", async () => {
    const result = await client.latestNews({
      language: "en",
      categories: ["science_technology", "politics_government"],
    });

    expect(result.sightings.length).toBeGreaterThan(0);
    expect(result.sightings.length).toBeLessThanOrEqual(20);
    for (const sighting of result.sightings) {
      expect(
        sighting.categories.some((c) =>
          ["science_technology", "politics_government"].includes(c),
        ),
        `${sighting.url} leaked past the category filter`,
      ).toBe(true);
    }

    // Newest first, like the real feed.
    const times = result.sightings.map((s) => Date.parse(s.published));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("returns the newest ~20 across all categories when unfiltered", async () => {
    const result = await client.latestNews({ language: "en" });
    expect(result.sightings.length).toBeGreaterThan(0);
    expect(result.rawCount).toBeLessThanOrEqual(20);
  });
});

describe("per-call date range ceiling — fixture mode reproduces the wall", () => {
  it("throws the same local error as live mode for an over-range search", async () => {
    await expect(
      client.search({
        keywords: ["climate"],
        startDate: new Date("2026-07-01T00:00:00Z"),
        endDate: new Date("2026-08-06T00:00:00Z"),
      }),
    ).rejects.toMatchObject({ name: "CurrentsInvalidQueryError" });
  });
});
