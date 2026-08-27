import { describe, expect, it } from "vitest";
import type { Article, TimelineEntry } from "@zammy/shared";
import { dayLabel, groupByDay, hasLaterCoverage, segmentOf } from "./format.js";

/**
 * Day and part-of-day bucketing over timeline slots (§8.1's rail dividers).
 *
 * Three traps worth pinning. A slot's day is the GROUP's, not its headline
 * article's — those differ whenever a tier-1 outlet ran the story later than
 * whoever broke it (§14.3), and taking the article's would file the slot under
 * a divider it does not sit beneath. The day is the READER's, in their own
 * zone: every case below names its zone explicitly, so none of them can pass
 * by accident on a machine that happens to sit in it. And a slot is not one
 * entry: its wider coverage is drawn in the part of the day it landed in, so a
 * day's parts no longer fall out of slot adjacency (`RailSlot`).
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

const entry = (
  id: string,
  published: string,
  headlinePublished = published,
  members: { related?: Article[]; moreCoverage?: Article[] } = {},
): TimelineEntry => {
  const related = members.related ?? [];
  const moreCoverage = members.moreCoverage ?? [];
  return {
    storylineId: id,
    published,
    // What the service sends: the newest member of the WHOLE slot, coverage
    // included (timeline-service.toEntry). Several cases below turn on the rail
    // narrowing that to what a card still holds.
    updatedAt: [headlinePublished, ...[...related, ...moreCoverage].map((a) => a.published)].reduce(
      (latest, at) => (Date.parse(at) > Date.parse(latest) ? at : latest),
    ),
    article: article(id, headlinePublished),
    related,
    moreCoverage,
    storyline: null,
  };
};

/** The one slot every part-of-day case below reads: `days[0].segments`. */
const partsOf = (days: ReturnType<typeof groupByDay>) =>
  (days[0]?.segments ?? []).map((part) => part.segment);

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

  it("keeps a day's identity when its label moves at midnight", () => {
    // The label is not the identity: at 23:59 this slot's day reads "Today",
    // two minutes later it reads "Yesterday". Collapse state keys on `key`,
    // so a day the reader collapsed cannot hand that flag to its neighbour
    // when the clock rolls over.
    const slot = [entry("1", "2026-08-11T20:00:00.000Z")]; // 13:00 in Vancouver

    const before = groupByDay(slot, new Date("2026-08-12T06:59:00.000Z"), VANCOUVER);
    const after = groupByDay(slot, new Date("2026-08-12T07:01:00.000Z"), VANCOUVER);

    expect(before[0]?.day).toBe("Today");
    expect(after[0]?.day).toBe("Yesterday");
    expect(after[0]?.key).toBe(before[0]?.key);
    expect(after[0]?.key).toBe("2026-08-11");
  });

  it("identifies a day by the reader's calendar, not the UTC one", () => {
    // 23:00 on the 11th in Vancouver is already the 12th in UTC. Keying on
    // the UTC date would split one rail day in two.
    const days = groupByDay(
      [entry("1", "2026-08-12T06:59:00.000Z"), entry("2", "2026-08-12T05:00:00.000Z")],
      new Date("2026-08-12T19:00:00.000Z"),
      VANCOUVER,
    );

    expect(days).toHaveLength(1);
    expect(days[0]?.key).toBe("2026-08-11");
  });

  it("draws a slot's later coverage as its own card in the part it landed in", () => {
    // The live case (#155): a Loblaw labelling story broke at 08:31 and two
    // outlets followed it up just after half one. All three sat under MORNING,
    // the follow-ups inside a disclosure hanging off a card that ran five
    // hours before them.
    const days = groupByDay(
      [
        entry("1", "2026-08-11T15:31:00.000Z", "2026-08-11T15:31:00.000Z", {
          moreCoverage: [
            article("globalnews", "2026-08-11T20:35:00.000Z"), // 13:35 — Afternoon
            article("ttnews", "2026-08-11T20:30:00.000Z"), // 13:30 — Afternoon
          ],
        }),
      ],
      now,
      VANCOUVER,
    );

    expect(partsOf(days)).toEqual(["Afternoon", "Morning"]);
    const [afternoon, morning] = days[0]!.segments;
    // The afternoon's own card: its EARLIEST article heads it, the rest is the
    // coverage around it, and it sits at the headline it shows.
    expect(afternoon?.items).toHaveLength(1);
    expect(afternoon?.items[0]?.article.id).toBe("ttnews");
    expect(afternoon?.items[0]?.published).toBe("2026-08-11T20:30:00.000Z");
    expect(afternoon?.items[0]?.moreCoverage.map((a) => a.id)).toEqual(["globalnews"]);
    // Nothing in a later part of the day is the same story as its headline:
    // the lead group's copies stayed with the lead.
    expect(afternoon?.items[0]?.related).toEqual([]);
    // The morning card keeps its headline and promises nothing it no longer
    // holds: no coverage rows, and no "updated" stamp reaching into the
    // afternoon (the service sent `updatedAt` over the whole slot).
    expect(morning?.items[0]?.article.id).toBe("1");
    expect(morning?.items[0]?.moreCoverage).toEqual([]);
    expect(morning?.items[0]?.updatedAt).toBe("2026-08-11T15:31:00.000Z");
    expect(hasLaterCoverage(morning!.items[0]!)).toBe(false);
  });

  it("stamps a part of the day's card from the coverage it still holds", () => {
    // Three follow-ups in one afternoon: the earliest heads the card, and the
    // last of them is what "updated" measures — the same treatment §8.1 gives
    // a slot whose coverage went on after its headline.
    const days = groupByDay(
      [
        entry("1", "2026-08-11T14:00:00.000Z", "2026-08-11T14:00:00.000Z", {
          moreCoverage: [
            article("late", "2026-08-11T23:00:00.000Z"), // 16:00
            article("mid", "2026-08-11T21:00:00.000Z"), // 14:00
            article("first", "2026-08-11T20:00:00.000Z"), // 13:00
          ],
        }),
      ],
      now,
      VANCOUVER,
    );

    const afternoon = days[0]?.segments[0];
    expect(afternoon?.segment).toBe("Afternoon");
    expect(afternoon?.items[0]?.article.id).toBe("first");
    // Newest first, the order the wire sent and the disclosure renders.
    expect(afternoon?.items[0]?.moreCoverage.map((a) => a.id)).toEqual(["late", "mid"]);
    expect(afternoon?.items[0]?.updatedAt).toBe("2026-08-11T23:00:00.000Z");
    expect(hasLaterCoverage(afternoon!.items[0]!)).toBe(true);
  });

  it("keeps same-story copies with the headline, wherever they ran", () => {
    // Syndication is the same piece on another wire, so a copy is never a
    // second thing that happened: cutting it into its own part of the day
    // would scatter one story down the rail to say nothing. It still stamps
    // the card "updated", which is the treatment §8.1 gives it.
    const days = groupByDay(
      [
        entry("1", "2026-08-11T15:00:00.000Z", "2026-08-11T15:00:00.000Z", {
          related: [article("copy", "2026-08-11T21:00:00.000Z")], // 14:00 — Afternoon
        }),
      ],
      now,
      VANCOUVER,
    );

    expect(partsOf(days)).toEqual(["Morning"]);
    expect(days[0]?.segments[0]?.items[0]?.related.map((a) => a.id)).toEqual(["copy"]);
    expect(days[0]?.segments[0]?.items[0]?.updatedAt).toBe("2026-08-11T21:00:00.000Z");
  });

  it("keeps coverage that fell on another of the reader's days with the lead", () => {
    // The slot's day is the one the API pages by (§7.3), and a reader east of
    // APP_TIMEZONE can see a slot's coverage cross their midnight. Moving that
    // row to another divider could put it in a day this page has not loaded,
    // so only the cut inside the slot's own day is the rail's to make.
    // One Vancouver day (03:00 and 09:00 PDT on the 11th), so this is a slot
    // the service could really send; two Tokyo days (19:00 on the 11th and
    // 01:00 on the 12th).
    const days = groupByDay(
      [
        entry("1", "2026-08-11T10:00:00.000Z", "2026-08-11T10:00:00.000Z", {
          moreCoverage: [article("late", "2026-08-11T16:00:00.000Z")],
        }),
      ],
      now,
      TOKYO,
    );

    expect(days).toHaveLength(1);
    expect(partsOf(days)).toEqual(["Evening"]);
    expect(days[0]?.segments[0]?.items[0]?.moreCoverage.map((a) => a.id)).toEqual(["late"]);
  });

  it("orders a part of the day by what its cards hold, not by which slot they came from", () => {
    // Slots arrive published DESC, but a card cut out of a later part of the
    // day sits at its own headline — which can be LATER than the headline of a
    // slot above it. Read off adjacency, the afternoon would run oldest-first.
    const days = groupByDay(
      [
        entry("1", "2026-08-11T19:30:00.000Z"), // 12:30 — Afternoon lead
        entry("2", "2026-08-11T14:00:00.000Z", "2026-08-11T14:00:00.000Z", {
          moreCoverage: [article("late", "2026-08-11T23:00:00.000Z")], // 16:00
        }),
      ],
      now,
      VANCOUVER,
    );

    expect(partsOf(days)).toEqual(["Afternoon", "Morning"]);
    expect(days[0]?.segments[0]?.items.map((slot) => slot.published)).toEqual([
      "2026-08-11T23:00:00.000Z",
      "2026-08-11T19:30:00.000Z",
    ]);
  });

  it("keys a slot's entries apart so React cannot reuse one for another", () => {
    const days = groupByDay(
      [
        entry("1", "2026-08-11T15:31:00.000Z", "2026-08-11T15:31:00.000Z", {
          moreCoverage: [article("later", "2026-08-11T20:35:00.000Z")],
        }),
      ],
      now,
      VANCOUVER,
    );

    expect(days[0]?.segments.flatMap((part) => part.items).map((slot) => slot.key)).toEqual([
      "1:2026-08-11T15:31:00.000Z:Afternoon",
      "1:2026-08-11T15:31:00.000Z:Morning",
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
