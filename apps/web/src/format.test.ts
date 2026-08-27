import { describe, expect, it } from "vitest";
import type { Article, TimelineEntry } from "@zammy/shared";
import { dayLabel, groupByDay, hasLaterCoverage, segmentOf } from "./format.js";

/**
 * Day and part-of-day bucketing over timeline slots (§8.1's rail dividers).
 *
 * Two traps worth pinning. A slot's day is the GROUP's, not its headline
 * article's — those differ whenever a tier-1 outlet ran the story later than
 * whoever broke it (§14.3), and taking the article's would file the slot under
 * a divider it does not sit beneath. And the day is the READER's, in their own
 * zone: every case below names its zone explicitly, so none of them can pass
 * by accident on a machine that happens to sit in it.
 */

const VANCOUVER = "America/Vancouver";
const TOKYO = "Asia/Tokyo";

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

describe("segmentOf", () => {
  // PDT is UTC-7, so these are the Vancouver wall-clock hours the boundaries
  // are defined at, either side of each cut.
  it.each([
    ["2026-08-11T07:00:00.000Z", "00:00", "Night"],
    ["2026-08-11T12:59:59.000Z", "05:59", "Night"],
    ["2026-08-11T13:00:00.000Z", "06:00", "Morning"],
    ["2026-08-11T18:59:59.000Z", "11:59", "Morning"],
    ["2026-08-11T19:00:00.000Z", "12:00", "Afternoon"],
    ["2026-08-12T00:59:59.000Z", "17:59", "Afternoon"],
    ["2026-08-12T01:00:00.000Z", "18:00", "Evening"],
    ["2026-08-12T06:59:59.000Z", "23:59", "Evening"],
  ])("puts %s (%s local) in %s", (iso, _local, segment) => {
    expect(segmentOf(iso, VANCOUVER)).toBe(segment);
  });

  it("reads the zone it was given, not the one the runtime sits in", () => {
    // One instant, two readers: noon in Vancouver is four in the morning in
    // Tokyo. A segment that came from the runtime's own clock could not tell
    // these apart.
    const noonInVancouver = "2026-08-11T19:00:00.000Z";

    expect(segmentOf(noonInVancouver, VANCOUVER)).toBe("Afternoon");
    expect(segmentOf(noonInVancouver, TOKYO)).toBe("Night");
  });

  it("keeps the boundary at 06:00 local across a spring-forward day", () => {
    // Vancouver loses an hour at 02:00 on 2026-03-08, so 06:00 local is a
    // different UTC instant either side of it. Reading the hour in the zone
    // means neither needs correcting.
    expect(segmentOf("2026-03-07T14:00:00.000Z", VANCOUVER)).toBe("Morning"); // 06:00 PST
    expect(segmentOf("2026-03-08T13:00:00.000Z", VANCOUVER)).toBe("Morning"); // 06:00 PDT
  });

  it("puts both passes of a repeated hour in the same segment", () => {
    // 2026-11-01 is 25 hours long in Vancouver: 01:00 happens twice.
    expect(segmentOf("2026-11-01T08:00:00.000Z", VANCOUVER)).toBe("Night"); // 01:00 PDT
    expect(segmentOf("2026-11-01T09:00:00.000Z", VANCOUVER)).toBe("Night"); // 01:00 PST
  });
});

describe("dayLabel", () => {
  it("names today and yesterday from the reader's own calendar", () => {
    const now = new Date("2026-08-12T19:00:00.000Z"); // noon in Vancouver

    expect(dayLabel("2026-08-12T07:00:00.000Z", now, VANCOUVER)).toBe("Today");
    expect(dayLabel("2026-08-11T07:00:00.000Z", now, VANCOUVER)).toBe("Yesterday");
  });

  it("counts calendar days, not 24-hour blocks, across a 25-hour day", () => {
    // 2026-11-01 in Vancouver is 25 hours long. Midnight on the 2nd is 25
    // hours after midnight on the 1st, so subtracting a fixed day would call
    // the 2nd's own small hours "Yesterday".
    const now = new Date("2026-11-02T20:00:00.000Z"); // noon PST on the 2nd

    expect(dayLabel("2026-11-02T08:00:00.000Z", now, VANCOUVER)).toBe("Today"); // 00:00 PST
    expect(dayLabel("2026-11-01T08:00:00.000Z", now, VANCOUVER)).toBe("Yesterday"); // 01:00 PDT
  });

  it("puts one instant on different days for readers in different zones", () => {
    // Noon in Vancouver is already four in the morning of the NEXT day in
    // Tokyo, so the two readers disagree about where "today" starts.
    const now = new Date("2026-08-12T19:00:00.000Z");
    const instant = "2026-08-12T14:00:00.000Z";

    expect(dayLabel(instant, now, VANCOUVER)).toBe("Today"); // 07:00 on the 12th
    expect(dayLabel(instant, now, TOKYO)).toBe("Yesterday"); // 23:00 on the 12th
  });
});

describe("groupByDay", () => {
  const now = new Date("2026-08-12T19:00:00.000Z");

  it("files a slot under the group's day, not the headline article's", () => {
    // Group positioned just before local midnight; its headline ran after it.
    const straddling = entry("1", "2026-08-11T06:30:00.000Z", "2026-08-11T08:00:00.000Z");
    const nextDay = entry("2", "2026-08-11T16:00:00.000Z");

    const days = groupByDay([nextDay, straddling], now, VANCOUVER);

    expect(days).toHaveLength(2);
    expect(days[1]?.segments.flatMap((part) => part.items).map((item) => item.storylineId)).toEqual([
      "1",
    ]);
  });

  it("leaves a day whose coverage landed in one segment with a single entry", () => {
    // Both are Vancouver mornings, so there is nothing to divide and the
    // renderer draws no segment heading.
    const days = groupByDay(
      [entry("1", "2026-08-11T18:00:00.000Z"), entry("2", "2026-08-11T13:30:00.000Z")],
      now,
      VANCOUVER,
    );

    expect(days).toHaveLength(1);
    expect(days[0]?.segments).toHaveLength(1);
    expect(days[0]?.segments[0]?.segment).toBe("Morning");
    expect(days[0]?.segments[0]?.items).toHaveLength(2);
  });

  it("splits a day that spans segments, newest segment first", () => {
    const days = groupByDay(
      [
        entry("1", "2026-08-12T02:00:00.000Z"), // 19:00 — Evening
        entry("2", "2026-08-11T20:00:00.000Z"), // 13:00 — Afternoon
        entry("3", "2026-08-11T14:00:00.000Z"), // 07:00 — Morning
      ],
      now,
      VANCOUVER,
    );

    expect(days).toHaveLength(1);
    expect(days[0]?.segments.map((part) => part.segment)).toEqual([
      "Evening",
      "Afternoon",
      "Morning",
    ]);
  });

  it("grows a second segment when older slots arrive", () => {
    // The accepted cost of hiding the divider until a day has two segments
    // (§8.1): loading older coverage can turn a bare day into a segmented one,
    // which inserts a heading above cards already on screen. Pinned so the
    // behaviour is a decision on the record rather than a surprise.
    const first = [entry("1", "2026-08-12T02:00:00.000Z")]; // Evening only
    expect(groupByDay(first, now, VANCOUVER)[0]?.segments).toHaveLength(1);

    const older = [...first, entry("2", "2026-08-11T14:00:00.000Z")]; // + Morning
    expect(groupByDay(older, now, VANCOUVER)[0]?.segments).toHaveLength(2);
  });
});
