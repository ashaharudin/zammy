import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateToLatest } from "./migrator.js";
import { attachGroup, createProvisionalStoryline, promoteStoryline } from "./storylines.js";
import {
  bumpSummaryAttempts,
  quarterOfUtcHour,
  readStorylineDaySegments,
  readStorylineDaySummaries,
  readStorylineSummaries,
  readSummaryCandidateDays,
  summaryDayBounds,
  summaryDayKey,
  writeStorylineDaySummary,
} from "./storyline-summaries.js";
import { createTestDatabase, type TestDatabase } from "./test-support.js";

/**
 * The storage half of the historical preserve (ADR-0022, migration 0024).
 *
 * Real Postgres, and here the reason is not incidental: everything under test is
 * SQL that a fake would fake wrong — a UTC hour extracted from a timestamptz,
 * `count(distinct group_id)` as the thing that separates coverage from
 * syndication, a window function ranking each quarter's articles, and a keyset
 * over an AGGREGATE's grouping column.
 *
 * The clock is fixed and the fixtures are placed at hours that straddle every
 * quarter boundary, because "which six-hour bucket" is the one question this
 * module exists to answer and off-by-one is its only interesting failure.
 */

let counter = 0;

describe("storyline day summaries in storage", () => {
  let harness: TestDatabase;

  /** An article in a group, at an exact instant. */
  const article = async (input: {
    published: string;
    groupId?: string;
    sightingCount?: number;
    title?: string;
  }): Promise<{ id: string; groupId: string }> => {
    counter += 1;
    const row = await harness.db
      .insertInto("articles")
      .values({
        dedup_key: randomBytes(32),
        url: `https://fixture.example/${counter}`,
        title: input.title ?? `Fixture ${counter}`,
        description: `Description ${counter}`,
        author: null,
        image_url: null,
        language: "en",
        categories: [],
        source_category: [],
        source_domain: "fixture.example",
        published: new Date(input.published),
        latest_seen: new Date(input.published),
        sighting_count: input.sightingCount ?? 1,
        story_tokens: ["bigbend", "wall"],
      })
      .returning(["id", "group_id"])
      .executeTakeFirstOrThrow();

    if (input.groupId !== undefined) {
      await harness.db
        .updateTable("articles")
        .set({ group_id: input.groupId, group_published: new Date(input.published) })
        .where("id", "=", row.id)
        .execute();
      return { id: row.id, groupId: input.groupId };
    }
    return { id: row.id, groupId: row.group_id };
  };

  /** A promoted storyline over the given groups. */
  const storyline = async (groupIds: string[], label: string | null): Promise<string> => {
    const [first, ...rest] = groupIds;
    const { id } = await createProvisionalStoryline(harness.db, {
      groupId: first!,
      timeZone: "UTC",
    });
    for (const groupId of rest) {
      await attachGroup(harness.db, { storylineId: id, groupId, timeZone: "UTC" });
    }
    await promoteStoryline(harness.db, { storylineId: id });
    if (label !== null) {
      await harness.db
        .updateTable("storylines")
        .set({ label })
        .where("id", "=", id)
        .execute();
    }
    return id;
  };

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
  });

  afterAll(async () => {
    await harness.drop();
  });

  describe("the UTC day and its quarters", () => {
    it("keys a day by UTC, never by a local calendar", () => {
      // 23:30 in Vancouver on the 14th is 06:30 UTC on the 15th, and this table
      // says the 15th. `storyline_days.day_key` would say the 14th.
      expect(summaryDayKey(new Date("2026-08-15T06:30:00.000Z"))).toBe("2026-08-15");
      expect(summaryDayKey(new Date("2026-08-15T00:00:00.000Z"))).toBe("2026-08-15");
      expect(summaryDayKey(new Date("2026-08-15T23:59:59.999Z"))).toBe("2026-08-15");
    });

    it("bounds a day half-open, so midnight belongs to the day it starts", () => {
      const { from, to } = summaryDayBounds("2026-08-14");
      expect(from.toISOString()).toBe("2026-08-14T00:00:00.000Z");
      expect(to.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    });

    it("refuses something that is not a day key", () => {
      expect(() => summaryDayBounds("not-a-day")).toThrow();
    });

    it("splits the hours into even quarters, with night inside its own day", () => {
      expect(quarterOfUtcHour(0)).toBe("night");
      expect(quarterOfUtcHour(5)).toBe("night");
      expect(quarterOfUtcHour(6)).toBe("morning");
      expect(quarterOfUtcHour(11)).toBe("morning");
      expect(quarterOfUtcHour(12)).toBe("afternoon");
      expect(quarterOfUtcHour(17)).toBe("afternoon");
      expect(quarterOfUtcHour(18)).toBe("evening");
      expect(quarterOfUtcHour(23)).toBe("evening");
    });
  });

  describe("readStorylineDaySegments", () => {
    let arcId: string;

    beforeAll(async () => {
      // Two groups, five articles, in three quarters: night 1, morning 3,
      // evening 1 — and NOTHING in the afternoon, which is the case the whole
      // feature is specified around.
      const a = await article({ published: "2026-08-14T02:00:00.000Z" });
      await article({ published: "2026-08-14T07:00:00.000Z", groupId: a.groupId });
      const b = await article({
        published: "2026-08-14T08:00:00.000Z",
        sightingCount: 12,
        title: "The syndicated one",
      });
      await article({ published: "2026-08-14T09:00:00.000Z", groupId: b.groupId });
      await article({ published: "2026-08-14T20:00:00.000Z", groupId: b.groupId });
      // A neighbouring day, to prove the bounds hold.
      await article({ published: "2026-08-15T07:00:00.000Z", groupId: a.groupId });
      arcId = await storyline([a.groupId, b.groupId], "Big Bend Wall Pause");
    });

    it("returns only the populated quarters, in chronological order", async () => {
      const segments = await readStorylineDaySegments(harness.db, {
        storylineId: arcId,
        dayKey: "2026-08-14",
        sampleSize: 8,
      });
      expect(segments.map((entry) => entry.segment)).toEqual(["night", "morning", "evening"]);
      expect(segments.map((entry) => entry.articleCount)).toEqual([1, 3, 1]);
    });

    it("does not reach into the next UTC day", async () => {
      const next = await readStorylineDaySegments(harness.db, {
        storylineId: arcId,
        dayKey: "2026-08-15",
        sampleSize: 8,
      });
      expect(next.map((entry) => entry.articleCount)).toEqual([1]);
    });

    it("samples the most-syndicated coverage but renders it oldest first", async () => {
      const [, morning] = await readStorylineDaySegments(harness.db, {
        storylineId: arcId,
        dayKey: "2026-08-14",
        sampleSize: 2,
      });
      // The count is the WHOLE quarter, not the sample — it is what the
      // recompute trigger compares against.
      expect(morning?.articleCount).toBe(3);
      expect(morning?.members).toHaveLength(2);
      // The 12-sighting article is in the sample...
      expect(morning?.members.map((member) => member.title)).toContain("The syndicated one");
      // ...and the sample is chronological, whatever order it was chosen in.
      const times = morning!.members.map((member) => member.published.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it("is empty for a day the arc has no coverage on", async () => {
      expect(
        await readStorylineDaySegments(harness.db, {
          storylineId: arcId,
          dayKey: "2026-07-01",
          sampleSize: 8,
        }),
      ).toEqual([]);
    });
  });

  describe("readSummaryCandidateDays", () => {
    const window = {
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-09-01T00:00:00.000Z"),
      minArticlesExclusive: 4,
      minGroups: 2,
      limit: 50,
    };

    it("refuses one wire story syndicated many times — six articles, one group", async () => {
      const solo = await article({ published: "2026-07-02T09:00:00.000Z" });
      for (let i = 0; i < 5; i += 1) {
        await article({ published: "2026-07-02T09:30:00.000Z", groupId: solo.groupId });
      }
      const arc = await storyline([solo.groupId], "One Telling Repeated");

      const days = await readSummaryCandidateDays(harness.db, {
        ...window,
        storylineId: arc,
      });
      // Six articles clears the volume bar; one group fails the sources bar,
      // and the sources bar is the one that matters here.
      expect(days).toEqual([]);
    });

    it("takes a day with enough articles from more than one group", async () => {
      const a = await article({ published: "2026-07-03T01:00:00.000Z" });
      const b = await article({ published: "2026-07-03T13:00:00.000Z" });
      for (let i = 0; i < 2; i += 1) {
        await article({ published: "2026-07-03T02:00:00.000Z", groupId: a.groupId });
        await article({ published: "2026-07-03T14:00:00.000Z", groupId: b.groupId });
      }
      const arc = await storyline([a.groupId, b.groupId], "Two Tellings");

      const [day] = await readSummaryCandidateDays(harness.db, { ...window, storylineId: arc });
      expect(day).toMatchObject({
        dayKey: "2026-07-03",
        articleCount: 6,
        groupCount: 2,
        label: "Two Tellings",
      });
    });

    it("refuses a day one article short of the bar", async () => {
      const a = await article({ published: "2026-07-04T01:00:00.000Z" });
      const b = await article({ published: "2026-07-04T13:00:00.000Z" });
      await article({ published: "2026-07-04T02:00:00.000Z", groupId: a.groupId });
      await article({ published: "2026-07-04T14:00:00.000Z", groupId: b.groupId });
      const arc = await storyline([a.groupId, b.groupId], "Four Articles");

      // Four is not "more than four" — the bar is exclusive, deliberately.
      expect(await readSummaryCandidateDays(harness.db, { ...window, storylineId: arc })).toEqual(
        [],
      );
    });

    it("never offers a provisional arc or an alias", async () => {
      const a = await article({ published: "2026-07-05T01:00:00.000Z" });
      const b = await article({ published: "2026-07-05T13:00:00.000Z" });
      for (let i = 0; i < 2; i += 1) {
        await article({ published: "2026-07-05T02:00:00.000Z", groupId: a.groupId });
        await article({ published: "2026-07-05T14:00:00.000Z", groupId: b.groupId });
      }
      // Provisional: created, never promoted.
      const { id: provisional } = await createProvisionalStoryline(harness.db, {
        groupId: a.groupId,
        timeZone: "UTC",
      });
      await attachGroup(harness.db, {
        storylineId: provisional,
        groupId: b.groupId,
        timeZone: "UTC",
      });
      expect(
        await readSummaryCandidateDays(harness.db, { ...window, storylineId: provisional }),
      ).toEqual([]);

      // And an alias, which is a pointer rather than a storyline.
      const alias = await storyline([a.groupId, b.groupId], "Alias");
      const winner = await storyline([a.groupId, b.groupId], "Winner");
      await harness.db
        .updateTable("storylines")
        .set({ merged_into: winner })
        .where("id", "=", alias)
        .execute();
      expect(
        await readSummaryCandidateDays(harness.db, { ...window, storylineId: alias }),
      ).toEqual([]);
    });

    it("walks the whole window on a keyset, newest day first", async () => {
      const a = await article({ published: "2026-07-06T01:00:00.000Z" });
      const b = await article({ published: "2026-07-06T13:00:00.000Z" });
      for (const day of ["2026-07-06", "2026-07-07", "2026-07-08"]) {
        for (let i = 0; i < 3; i += 1) {
          await article({ published: `${day}T02:00:00.000Z`, groupId: a.groupId });
          await article({ published: `${day}T14:00:00.000Z`, groupId: b.groupId });
        }
      }
      const arc = await storyline([a.groupId, b.groupId], "Three Days");

      const first = await readSummaryCandidateDays(harness.db, {
        ...window,
        storylineId: arc,
        limit: 2,
      });
      expect(first.map((day) => day.dayKey)).toEqual(["2026-07-08", "2026-07-07"]);

      const next = await readSummaryCandidateDays(harness.db, {
        ...window,
        storylineId: arc,
        limit: 2,
        after: { dayKey: first[1]!.dayKey, storylineId: first[1]!.storylineId },
      });
      expect(next.map((day) => day.dayKey)).toEqual(["2026-07-06"]);
    });
  });

  describe("writing", () => {
    let arcId: string;

    beforeAll(async () => {
      const a = await article({ published: "2026-08-20T01:00:00.000Z" });
      const b = await article({ published: "2026-08-20T13:00:00.000Z" });
      arcId = await storyline([a.groupId, b.groupId], "Written Arc");
    });

    const write = (segment: "night" | "day", summary: string | null, articleCount = 3) =>
      writeStorylineDaySummary(harness.db, {
        storylineId: arcId,
        dayKey: "2026-08-20",
        segment,
        summary,
        articleCount,
        label: "Written Arc",
        modelId: "gemma-test",
        attempts: summary === null ? 1 : 0,
        segmented: true,
        generatedAt: new Date("2026-08-21T05:00:00.000Z"),
      });

    it("replaces rather than accumulating versions of one span", async () => {
      await write("night", "First sentence.");
      await write("night", "Second sentence.", 9);

      const rows = await readStorylineDaySummaries(harness.db, {
        storylineId: arcId,
        dayKey: "2026-08-20",
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        segment: "night",
        summary: "Second sentence.",
        articleCount: 9,
        attempts: 0,
      });
    });

    it("records a refusal as a row with no sentence — not as an absence", async () => {
      await write("day", null);
      const rows = await readStorylineDaySummaries(harness.db, {
        storylineId: arcId,
        dayKey: "2026-08-20",
      });
      const day = rows.find((row) => row.segment === "day");
      // The distinction the whole skip rule rests on: this is "asked and
      // refused", and "no articles that segment" is no row at all.
      expect(day).toMatchObject({ summary: null, attempts: 1 });
      expect(rows.find((row) => row.segment === "afternoon")).toBeUndefined();
    });

    it("bumps attempts without touching the sentence that stands", async () => {
      await write("night", "The sentence that stands.");
      await bumpSummaryAttempts(harness.db, {
        storylineId: arcId,
        dayKey: "2026-08-20",
        segment: "night",
      });
      const rows = await readStorylineDaySummaries(harness.db, {
        storylineId: arcId,
        dayKey: "2026-08-20",
      });
      expect(rows.find((row) => row.segment === "night")).toMatchObject({
        summary: "The sentence that stands.",
        attempts: 1,
      });
    });

    it("survives the storyline it belongs to being deleted", async () => {
      // The whole reason there is no foreign key: a preserve that cascades away
      // with its arc is a preserve that deletes itself.
      const a = await article({ published: "2026-08-22T01:00:00.000Z" });
      const doomed = await storyline([a.groupId], "Doomed Arc");
      await writeStorylineDaySummary(harness.db, {
        storylineId: doomed,
        dayKey: "2026-08-22",
        segment: "day",
        summary: "It happened, and the arc is gone.",
        articleCount: 5,
        label: "Doomed Arc",
        modelId: "gemma-test",
        attempts: 0,
        segmented: true,
        generatedAt: new Date("2026-08-23T05:00:00.000Z"),
      });

      await harness.db.deleteFrom("storylines").where("id", "=", doomed).execute();

      const rows = await readStorylineSummaries(harness.db, { storylineId: doomed });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.summary).toBe("It happened, and the arc is gone.");
      // And the row still says what it was called, because the label was copied
      // onto it rather than read back through a join that no longer resolves.
      expect(rows[0]?.label).toBe("Doomed Arc");
    });
  });
});
