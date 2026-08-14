import { describe, expect, it } from "vitest";
import type { Article, TimelineEntry } from "@zammy/shared";
import { groupByDay, hasLaterCoverage } from "./format.js";

/**
 * Day bucketing over timeline slots (§8.1's sticky day dividers).
 *
 * The one trap worth pinning: a slot's day is the GROUP's, not its headline
 * article's. Those differ whenever a tier-1 outlet ran the story later than
 * whoever broke it (§14.3), and taking the article's would file the slot under
 * a divider it does not sit beneath.
 */

const article = (id: string, published: string): Article => ({
  id,
  url: `https://example.com/${id}`,
  title: `story ${id}`,
  description: null,
  author: null,
  imageUrl: null,
  language: "en",
  categories: [],
  sourceCategories: [],
  sourceDomain: "example.com",
  published,
  sightingCount: 1,
  latestSeen: published,
});

const entry = (id: string, published: string, headlinePublished = published): TimelineEntry => ({
  storylineId: id,
  published,
  updatedAt: headlinePublished,
  article: article(id, headlinePublished),
  related: [],
  moreCoverage: [],
  storylinePhrase: null,
  storyline: null,
});

describe("hasLaterCoverage", () => {
  it("says nothing about a syndication burst", () => {
    // The live check on the recorded payload: two Seven West outlets ran one
    // headline a SECOND apart. "updated 9d ago" on that claims a story
    // developed when all that happened is the wire went out twice.
    expect(
      hasLaterCoverage({
        published: "2026-08-02T21:02:38.000Z",
        updatedAt: "2026-08-02T21:02:39.000Z",
      }),
    ).toBe(false);
  });

  it("stamps a story that was still being covered hours later", () => {
    expect(
      hasLaterCoverage({
        published: "2026-08-02T09:00:00.000Z",
        updatedAt: "2026-08-02T18:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("says nothing about a group of one, whose times are equal", () => {
    expect(
      hasLaterCoverage({
        published: "2026-08-02T09:00:00.000Z",
        updatedAt: "2026-08-02T09:00:00.000Z",
      }),
    ).toBe(false);
  });
});

describe("groupByDay", () => {
  it("files a slot under the group's day, not the headline article's", () => {
    // Group positioned just before midnight; its headline ran after it.
    const straddling = entry("1", "2026-08-10T23:30:00.000Z", "2026-08-11T01:00:00.000Z");
    const nextDay = entry("2", "2026-08-11T09:00:00.000Z");

    const days = groupByDay([nextDay, straddling]);

    expect(days).toHaveLength(2);
    expect(days[1]?.items.map((item) => item.storylineId)).toEqual(["1"]);
  });

  it("keeps consecutive slots from one day in a single bucket", () => {
    const days = groupByDay([
      entry("1", "2026-08-11T18:00:00.000Z"),
      entry("2", "2026-08-11T09:00:00.000Z"),
    ]);

    expect(days).toHaveLength(1);
    expect(days[0]?.items).toHaveLength(2);
  });
});
