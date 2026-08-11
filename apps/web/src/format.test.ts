import { describe, expect, it } from "vitest";
import type { Article, TimelineEntry } from "@zammy/shared";
import { groupByDay } from "./format.js";

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
  groupId: id,
  published,
  updatedAt: headlinePublished,
  article: article(id, headlinePublished),
  related: [],
});

describe("groupByDay", () => {
  it("files a slot under the group's day, not the headline article's", () => {
    // Group positioned just before midnight; its headline ran after it.
    const straddling = entry("1", "2026-08-10T23:30:00.000Z", "2026-08-11T01:00:00.000Z");
    const nextDay = entry("2", "2026-08-11T09:00:00.000Z");

    const days = groupByDay([nextDay, straddling]);

    expect(days).toHaveLength(2);
    expect(days[1]?.items.map((item) => item.groupId)).toEqual(["1"]);
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
