import { describe, expect, it } from "vitest";
import { NewsInvalidQueryError, sourceDomain } from "@zammy/news-client";
import { FixtureGoogleNewsClient } from "./fixture-client.js";
import { GoogleNewsFixtureStore } from "./fixture-store.js";
import { ITEMS_PER_QUERY } from "./raw.js";
import { FIXTURES_DIR } from "./test-support.js";

/**
 * The recorded feeds, read end to end through the same parser and the same
 * mapping the live client uses.
 *
 * These are genuine live captures, so this file is where the claims made about
 * the endpoint stop being comments and become assertions against real bytes:
 * the cap, the depth, the suffix on every title, the publisher hidden in
 * `<source url>`, and the fields that are simply not there.
 *
 * Fixture mode also matters more here than for either other adapter. This
 * provider has no key, no published ceiling and no rate-limit header, so there
 * is no number that would tell us when we had asked too often — every call a
 * developer does not make against it is a cost we would otherwise be unable to
 * measure.
 */

const limits = {
  maxPageSize: ITEMS_PER_QUERY,
  maxRetrievableResults: ITEMS_PER_QUERY,
  maxLookbackDays: 730,
  maxRangeDays: 730,
};

/** The two windows the fixtures were captured over. */
const CAPPED_WINDOW = {
  startDate: new Date("2026-08-19T00:00:00.000Z"),
  endDate: new Date("2026-08-23T00:00:00.000Z"),
};
const DEEP_WINDOW = {
  startDate: new Date("2025-01-31T00:00:00.000Z"),
  endDate: new Date("2025-02-04T00:00:00.000Z"),
};

async function client(): Promise<FixtureGoogleNewsClient> {
  const store = new GoogleNewsFixtureStore(FIXTURES_DIR);
  await store.load();
  return new FixtureGoogleNewsClient(store, limits, { dailyLimit: 200, burstLimit: 5 });
}

describe("the recorded feeds", () => {
  it("parse and normalize with nothing dropped", async () => {
    const result = await (await client()).search({ keywords: ["bank", "of", "canada"] });

    expect(result.sightings.length).toBeGreaterThan(0);
    expect(result.normalization.kept).toBe(result.normalization.received);
  });

  it("tag every sighting as google-news, with a derived uuid", async () => {
    const result = await (await client()).search({ keywords: ["x"] });

    for (const sighting of result.sightings) {
      expect(sighting.provider).toBe("google-news");
      expect(sighting.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("refuse to load from a directory with no fixture", async () => {
    await expect(new GoogleNewsFixtureStore("/nonexistent").load()).rejects.toThrow(
      /google-news-search-capped\.xml/,
    );
  });
});

describe("the 100-item cap, against the real capture", () => {
  it("returns exactly the cap for the window that hit it, and says subdivide", async () => {
    // The capture is what a capped window looks like: `"bank of canada"
    // after:2026-08-20 before:2026-08-22` returned 100 items with no offset
    // parameter to get past them.
    const result = await (await client()).search({ keywords: ["x"], ...CAPPED_WINDOW });

    expect(result.rawCount).toBe(ITEMS_PER_QUERY);
    expect(result.isLastPage).toBe(false);
  });

  it("ends the window for the capture that came back short", async () => {
    const result = await (await client()).search({ keywords: ["x"], ...DEEP_WINDOW });

    expect(result.rawCount).toBe(20);
    expect(result.isLastPage).toBe(true);
  });
});

describe("depth past Currents' horizon", () => {
  it("holds articles 18 months old, from many newsrooms at once", async () => {
    // 573 days before the capture date, which is ~19x Currents' verified
    // 30-day lookback — and the breadth is the point as much as the depth.
    const result = await (await client()).search({ keywords: ["x"], ...DEEP_WINDOW });
    const domains = new Set(result.sightings.map((s) => s.sourceDomain));

    for (const sighting of result.sightings) {
      expect(new Date(sighting.published).getUTCFullYear()).toBe(2025);
    }
    expect(domains.size).toBeGreaterThanOrEqual(15);
  });
});

describe("what every real item carries", () => {
  it("has the trailing ' - Outlet' suffix on essentially all of them", async () => {
    // 100 of 101 in the survey. Measured here on the capture rather than
    // asserted from the doc — and asserted to be PRESENT, because stripping it
    // is G0's job and an adapter doing it early would hide the damage G0 exists
    // to fix.
    const result = await (await client()).search({ keywords: ["x"] });
    const suffixed = result.sightings.filter((s) => / - .+$/.test(s.title));

    expect(result.sightings.length).toBeGreaterThan(50);
    expect(suffixed.length / result.sightings.length).toBeGreaterThan(0.95);
  });

  it("attributes to the publisher, never to Google", async () => {
    const result = await (await client()).search({ keywords: ["x"] });

    for (const sighting of result.sightings) {
      expect(sighting.url).toContain("news.google.com");
      expect(sighting.sourceDomain).not.toBeNull();
      expect(sighting.sourceDomain).not.toBe("google.com");
      // The departure, on real data: the stored domain disagrees with the one
      // the stored URL would produce, on every single row.
      expect(sighting.sourceDomain).not.toBe(sourceDomain(sighting.url));
    }
  });

  it("names real newsrooms, enough of them to be worth the call", async () => {
    const result = await (await client()).search({ keywords: ["x"], ...CAPPED_WINDOW });
    const domains = new Set(result.sightings.map((s) => s.sourceDomain));

    expect(domains.size).toBeGreaterThanOrEqual(25);
    expect(domains).toContain("theglobeandmail.com");
  });

  it("has no description, no author and no image on any of them", async () => {
    const result = await (await client()).search({ keywords: ["x"] });

    for (const sighting of result.sightings) {
      expect(sighting.description).toBeNull();
      expect(sighting.author).toBeNull();
      expect(sighting.imageUrl).toBeNull();
    }
  });

  it("carries a real publication time on every one", async () => {
    const result = await (await client()).search({ keywords: ["x"] });

    for (const sighting of result.sightings) {
      expect(Number.isNaN(Date.parse(sighting.published))).toBe(false);
    }
  });
});

describe("it refuses what the live client refuses", () => {
  it("rejects a second page, tagged with the provider", async () => {
    await expect(
      (await client()).search({ keywords: ["x"], pageNumber: 2 }),
    ).rejects.toMatchObject({ provider: "google-news" });
  });

  it("rejects a category filter", async () => {
    await expect(
      (await client()).search({ keywords: ["x"], category: "business" }),
    ).rejects.toBeInstanceOf(NewsInvalidQueryError);
  });

  it("rejects a keyword-less sweep", async () => {
    await expect((await client()).search({})).rejects.toBeInstanceOf(NewsInvalidQueryError);
  });
});

describe("quota", () => {
  it("is null, as it would be live", async () => {
    // Unlike every other adapter, this is not merely "no call was made" — a
    // live call would report nothing either.
    const result = await (await client()).search({ keywords: ["x"] });

    expect(result.quota).toBeNull();
  });
});
