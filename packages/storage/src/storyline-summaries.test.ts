import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateToLatest } from "./migrator.js";
import { attachGroup, createProvisionalStoryline, promoteStoryline } from "./storylines.js";
import {
  bumpSummaryAttempts,
  readArcDaySummaries,
  readArcDaysAwaitingSummary,
  readStorylineDayArticles,
  readStorylineDaySummaries,
  readStorylineSummaries,
  readSummaryCandidateDays,
  summaryDayBounds,
  summaryDayKey,
  writeStorylineDaySummary,
} from "./storyline-summaries.js";
import { createTestDatabase, type TestDatabase } from "./test-support.js";

/**
 * The storage half of the historical preserve (ADR-0023, migration 0024).
 *
 * Real Postgres, and here the reason is not incidental: everything under test is
 * SQL that a fake would fake wrong — a UTC day extracted from a timestamptz,
 * `count(distinct group_id)` as the thing that separates coverage from
 * syndication, a window function ranking a day's articles, a keyset over an
 * AGGREGATE's grouping column, and a recursive walk down an alias chain.
 *
 * The clock is fixed and the fixtures straddle UTC midnight, because "which UTC
 * day" is the question this module exists to answer and off-by-one is its only
 * interesting failure. They used to straddle every six-hour boundary too; the
 * quarters went with ADR-0027.
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

  describe("the UTC day", () => {
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

  });

  describe("readStorylineDayArticles", () => {
    let arcId: string;

    beforeAll(async () => {
      // Two groups, five articles, spread across the day — the spread used to
      // matter (it fell in three of four quarters, with the afternoon empty)
      // and under ADR-0027 it does not. Kept as it was anyway: a day whose
      // coverage is spread is the day this read has to count whole.
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

    it("counts the whole day and returns its articles oldest first", async () => {
      const day = await readStorylineDayArticles(harness.db, {
        storylineId: arcId,
        dayKey: "2026-08-14",
        sampleSize: 8,
      });
      expect(day.articleCount).toBe(5);
      expect(day.members).toHaveLength(5);
      const times = day.members.map((member) => member.published.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it("does not reach into the next UTC day", async () => {
      const next = await readStorylineDayArticles(harness.db, {
        storylineId: arcId,
        dayKey: "2026-08-15",
        sampleSize: 8,
      });
      expect(next.articleCount).toBe(1);
    });

    it("samples the most-syndicated coverage but renders it oldest first", async () => {
      const day = await readStorylineDayArticles(harness.db, {
        storylineId: arcId,
        dayKey: "2026-08-14",
        sampleSize: 2,
      });
      // The count is the WHOLE day, not the sample — it is what the recompute
      // trigger compares against, and capping it there would retire every
      // rewrite on a day with more articles than the sample holds.
      expect(day.articleCount).toBe(5);
      expect(day.members).toHaveLength(2);
      expect(day.members.map((member) => member.title)).toContain("The syndicated one");
      const times = day.members.map((member) => member.published.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it("is empty for a day the arc has no coverage on", async () => {
      expect(
        await readStorylineDayArticles(harness.db, {
          storylineId: arcId,
          dayKey: "2026-07-01",
          sampleSize: 8,
        }),
      ).toEqual({ articleCount: 0, members: [] });
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

    it("walks the whole window on a keyset, OLDEST day first", async () => {
      const a = await article({ published: "2026-07-06T01:00:00.000Z" });
      const b = await article({ published: "2026-07-06T13:00:00.000Z" });
      for (const day of ["2026-07-06", "2026-07-07", "2026-07-08"]) {
        for (let i = 0; i < 3; i += 1) {
          await article({ published: `${day}T02:00:00.000Z`, groupId: a.groupId });
          await article({ published: `${day}T14:00:00.000Z`, groupId: b.groupId });
        }
      }
      const arc = await storyline([a.groupId, b.groupId], "Three Days");

      // Oldest first, and that is the decision rather than an accident: the
      // pass has a ceiling, and a bounded night must spend it on the days
      // about to fall out of the window rather than on the newest day, which
      // is still there tomorrow.
      const first = await readSummaryCandidateDays(harness.db, {
        ...window,
        storylineId: arc,
        limit: 2,
      });
      expect(first.map((day) => day.dayKey)).toEqual(["2026-07-06", "2026-07-07"]);

      const next = await readSummaryCandidateDays(harness.db, {
        ...window,
        storylineId: arc,
        limit: 2,
        after: { dayKey: first[1]!.dayKey, storylineId: first[1]!.storylineId },
      });
      expect(next.map((day) => day.dayKey)).toEqual(["2026-07-08"]);
    });

    it("walks NEWEST day first when asked, and pages without repeating itself", async () => {
      const a = await article({ published: "2026-07-16T01:00:00.000Z" });
      const b = await article({ published: "2026-07-16T13:00:00.000Z" });
      for (const day of ["2026-07-16", "2026-07-17", "2026-07-18"]) {
        for (let i = 0; i < 3; i += 1) {
          await article({ published: `${day}T02:00:00.000Z`, groupId: a.groupId });
          await article({ published: `${day}T14:00:00.000Z`, groupId: b.groupId });
        }
      }
      const arc = await storyline([a.groupId, b.groupId], "Three Days Backwards");

      const first = await readSummaryCandidateDays(harness.db, {
        ...window,
        storylineId: arc,
        order: "newest",
        limit: 2,
      });
      expect(first.map((day) => day.dayKey)).toEqual(["2026-07-18", "2026-07-17"]);

      // The half that a reversed ORDER BY alone would get wrong. `after` means
      // "the last row I saw", so a descending walk has to page with `<`; left
      // as `>` it would re-read the newest day for ever and the fresh phase
      // would spend its whole share on one day.
      const next = await readSummaryCandidateDays(harness.db, {
        ...window,
        storylineId: arc,
        order: "newest",
        limit: 2,
        after: { dayKey: first[1]!.dayKey, storylineId: first[1]!.storylineId },
      });
      expect(next.map((day) => day.dayKey)).toEqual(["2026-07-16"]);
    });

    it("covers every day exactly once in either direction", async () => {
      const a = await article({ published: "2026-07-21T01:00:00.000Z" });
      const b = await article({ published: "2026-07-21T13:00:00.000Z" });
      const days = ["2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"];
      for (const day of days) {
        for (let i = 0; i < 3; i += 1) {
          await article({ published: `${day}T02:00:00.000Z`, groupId: a.groupId });
          await article({ published: `${day}T14:00:00.000Z`, groupId: b.groupId });
        }
      }
      const arc = await storyline([a.groupId, b.groupId], "Four Days Either Way");

      // Page one day at a time to the end, the way the pass does with a batch
      // size smaller than the work, and assert the walk is a partition: no day
      // missed, none served twice.
      for (const order of ["oldest", "newest"] as const) {
        const seen: string[] = [];
        let after: { dayKey: string; storylineId: string } | undefined;
        for (;;) {
          const page = await readSummaryCandidateDays(harness.db, {
            ...window,
            storylineId: arc,
            order,
            limit: 1,
            ...(after ? { after } : {}),
          });
          if (page.length === 0) break;
          seen.push(...page.map((day) => day.dayKey));
          const last = page[page.length - 1]!;
          after = { dayKey: last.dayKey, storylineId: last.storylineId };
          // A keyset that does not advance is an infinite loop in production.
          expect(seen.length).toBeLessThanOrEqual(days.length);
        }
        expect(seen).toEqual(order === "oldest" ? days : [...days].reverse());
      }
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

    it("refuses to null a sentence that stands, even when told to", async () => {
      // The caller routes a refused REWRITE to `bumpSummaryAttempts`, so this
      // upsert should never be asked to do it — which is exactly why it is
      // asserted. The one race that is unrecoverable here is a writer deciding
      // "there is no row to protect" from a read taken before its model call,
      // while another writer lands a sentence in between.
      await write("night", "The sentence that stands.", 4);
      await write("night", null, 99);

      const night = (
        await readStorylineDaySummaries(harness.db, {
          storylineId: arcId,
          dayKey: "2026-08-20",
        })
      ).find((row) => row.segment === "night");

      expect(night?.summary).toBe("The sentence that stands.");
      // The count travels with the summary: advanced past a sentence that was
      // not rewritten, it would retire a rewrite that is still owed.
      expect(night?.articleCount).toBe(4);
      // The attempt DOES land — that is the part of the write that is about
      // the ask rather than about the sentence.
      expect(night?.attempts).toBe(1);
    });

    it("does not re-caption the row it just protected", async () => {
      // Keeping the sentence while letting its provenance through is worse than
      // overwriting it: the row then looks intact and lies about itself.
      await writeStorylineDaySummary(harness.db, {
        storylineId: arcId,
        dayKey: "2026-08-20",
        segment: "night",
        summary: "The sentence that stands.",
        articleCount: 4,
        label: "The label it was written under",
        modelId: "model-one",
        attempts: 0,
        segmented: true,
        generatedAt: new Date("2026-08-21T05:00:00.000Z"),
      });
      await writeStorylineDaySummary(harness.db, {
        storylineId: arcId,
        dayKey: "2026-08-20",
        segment: "night",
        summary: null,
        articleCount: 99,
        label: "A LATER label",
        modelId: "model-two",
        attempts: 1,
        segmented: false,
        generatedAt: new Date("2026-08-30T05:00:00.000Z"),
      });

      const night = (
        await readStorylineDaySummaries(harness.db, {
          storylineId: arcId,
          dayKey: "2026-08-20",
        })
      ).find((row) => row.segment === "night");

      expect(night?.summary).toBe("The sentence that stands.");
      expect(night?.modelId).toBe("model-one");
      expect(night?.segmented).toBe(true);
      expect(night?.generatedAt.toISOString()).toBe("2026-08-21T05:00:00.000Z");
      const label = await harness.db
        .selectFrom("storyline_day_summaries")
        .select("label")
        .where("storyline_id", "=", arcId)
        .where("day_key", "=", "2026-08-20")
        .where("segment", "=", "night")
        .executeTakeFirst();
      expect(label?.label).toBe("The label it was written under");
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

  describe("readArcDaySummaries", () => {
    /** The write the pass makes, with only what a case varies spelled out. */
    const wrote = async (write: {
      storylineId: string;
      dayKey: string;
      segment?: "night" | "morning" | "afternoon" | "evening" | "day";
      summary: string | null;
      articleCount?: number;
    }): Promise<void> => {
      await writeStorylineDaySummary(harness.db, {
        storylineId: write.storylineId,
        dayKey: write.dayKey,
        segment: write.segment ?? "day",
        summary: write.summary,
        articleCount: write.articleCount ?? 6,
        label: "Arc",
        modelId: "gemma-test",
        attempts: 0,
        segmented: true,
        generatedAt: new Date("2026-08-23T05:00:00.000Z"),
      });
    };

    /** Point `loser` at `winner`, the way a merge leaves the rows. */
    const alias = async (loser: string, winner: string): Promise<void> => {
      await harness.db
        .updateTable("storylines")
        .set({ merged_into: winner })
        .where("id", "=", loser)
        .execute();
    };

    it("answers with the DAY sentences, keyed by day", async () => {
      const a = await article({ published: "2026-08-20T01:00:00.000Z" });
      const arc = await storyline([a.groupId], "Arc");
      await wrote({ storylineId: arc, dayKey: "2026-08-20", summary: "The first day." });
      await wrote({ storylineId: arc, dayKey: "2026-08-21", summary: "The second day." });

      expect([...(await readArcDaySummaries(harness.db, { storylineId: arc }))]).toEqual([
        ["2026-08-20", "The first day."],
        ["2026-08-21", "The second day."],
      ]);
    });

    it("leaves the quarters where they are", async () => {
      // The day sentence is built FROM them, and the rail already cuts a day
      // into the parts of the READER's day — drawing both would be two
      // divisions of one day sitting on top of each other.
      const a = await article({ published: "2026-08-20T01:00:00.000Z" });
      const arc = await storyline([a.groupId], "Arc");
      await wrote({ storylineId: arc, dayKey: "2026-08-20", segment: "night", summary: "Night." });
      await wrote({
        storylineId: arc,
        dayKey: "2026-08-20",
        segment: "evening",
        summary: "Evening.",
      });

      expect(await readArcDaySummaries(harness.db, { storylineId: arc })).toEqual(new Map());
    });

    it("reads a refusal as the silence it is", async () => {
      // A row whose `summary` is null means the model was asked and would not
      // answer. Prose has no deterministic fallback, so the page gets the
      // heading it always had — the same as a day the pass never reached.
      const a = await article({ published: "2026-08-20T01:00:00.000Z" });
      const arc = await storyline([a.groupId], "Arc");
      await wrote({ storylineId: arc, dayKey: "2026-08-20", summary: null });

      expect(await readArcDaySummaries(harness.db, { storylineId: arc })).toEqual(new Map());
    });

    it("finds the sentences a merge left behind on the loser's id", async () => {
      // The preserve never follows a merge (migration 0024), but the view
      // resolves a bookmark forward to the winner — so the winner's read has to
      // walk back down the chain, or every pre-merge day loses its sentence
      // while still showing its coverage.
      const a = await article({ published: "2026-08-20T01:00:00.000Z" });
      const b = await article({ published: "2026-08-21T01:00:00.000Z" });
      const winner = await storyline([a.groupId], "Winner");
      const loser = await storyline([b.groupId], "Loser");
      const older = await storyline([b.groupId], "Older");
      await wrote({ storylineId: winner, dayKey: "2026-08-22", summary: "The winner's day." });
      await wrote({ storylineId: loser, dayKey: "2026-08-21", summary: "The loser's day." });
      await wrote({ storylineId: older, dayKey: "2026-08-20", summary: "Two hops back." });
      // A CHAIN, not a star: `older` was merged away before `loser` was, which
      // is the case a single hop would answer half of.
      await alias(older, loser);
      await alias(loser, winner);

      expect([...(await readArcDaySummaries(harness.db, { storylineId: winner }))]).toEqual([
        ["2026-08-20", "Two hops back."],
        ["2026-08-21", "The loser's day."],
        ["2026-08-22", "The winner's day."],
      ]);
    });

    it("gives one day one sentence: the one written over more of it", async () => {
      // Both arcs covered the day before they were merged, so two rows answer
      // for it, and one sentence per day is what the preserve is.
      const a = await article({ published: "2026-08-20T01:00:00.000Z" });
      const winner = await storyline([a.groupId], "Winner");
      const loser = await storyline([a.groupId], "Loser");
      await wrote({
        storylineId: winner,
        dayKey: "2026-08-20",
        summary: "Four articles' worth.",
        articleCount: 4,
      });
      await wrote({
        storylineId: loser,
        dayKey: "2026-08-20",
        summary: "Eleven articles' worth.",
        articleCount: 11,
      });
      await alias(loser, winner);

      expect(await readArcDaySummaries(harness.db, { storylineId: winner })).toEqual(
        new Map([["2026-08-20", "Eleven articles' worth."]]),
      );
    });

    it("answers nothing for an arc the preserve has never reached", async () => {
      const a = await article({ published: "2026-08-20T01:00:00.000Z" });
      const arc = await storyline([a.groupId], "Arc");

      expect(await readArcDaySummaries(harness.db, { storylineId: arc })).toEqual(new Map());
    });
  });

  describe("readArcDaysAwaitingSummary", () => {
    /** Every day this arc qualifies on, with no sentence written yet. */
    const awaiting = (
      storylineId: string,
      overrides: { limit?: number; before?: Date } = {},
    ): Promise<Array<{ dayKey: string }>> =>
      readArcDaysAwaitingSummary(harness.db, {
        storylineId,
        minArticlesExclusive: 4,
        minGroups: 2,
        limit: overrides.limit ?? 8,
        before: overrides.before ?? new Date("2026-09-01T00:00:00.000Z"),
      });

    /** Five articles across two groups on one UTC day — the gate, cleared. */
    const qualifyingDay = async (day: string): Promise<[string, string]> => {
      const a = await article({ published: `${day}T02:00:00.000Z` });
      await article({ published: `${day}T07:00:00.000Z`, groupId: a.groupId });
      const b = await article({ published: `${day}T08:00:00.000Z` });
      await article({ published: `${day}T09:00:00.000Z`, groupId: b.groupId });
      await article({ published: `${day}T20:00:00.000Z`, groupId: b.groupId });
      return [a.groupId, b.groupId];
    };

    it("returns the arc's qualifying days, newest first, and no others", async () => {
      const groups = await qualifyingDay("2026-07-02");
      // A second qualifying day on the same groups.
      await article({ published: "2026-07-04T02:00:00.000Z", groupId: groups[0] });
      await article({ published: "2026-07-04T03:00:00.000Z", groupId: groups[0] });
      await article({ published: "2026-07-04T04:00:00.000Z", groupId: groups[1] });
      await article({ published: "2026-07-04T05:00:00.000Z", groupId: groups[1] });
      await article({ published: "2026-07-04T06:00:00.000Z", groupId: groups[1] });
      // A day that does NOT clear the article bar.
      await article({ published: "2026-07-06T02:00:00.000Z", groupId: groups[0] });
      const arc = await storyline([...groups], "July Arc");

      expect((await awaiting(arc)).map((day) => day.dayKey)).toEqual([
        "2026-07-04",
        "2026-07-02",
      ]);
    });

    it("has NO window: it reaches a day far older than the nightly pass looks", async () => {
      // ADR-0027's click plane covers the arc's whole history. A day from March
      // is outside any SUMMARY_WINDOW_DAYS the nightly pass would use.
      const groups = await qualifyingDay("2026-03-11");
      const arc = await storyline([...groups], "March Arc");
      expect((await awaiting(arc)).map((day) => day.dayKey)).toEqual(["2026-03-11"]);
    });

    it("excludes a day that already has a day sentence", async () => {
      const groups = await qualifyingDay("2026-07-12");
      const arc = await storyline([...groups], "Written Arc");
      await writeStorylineDaySummary(harness.db, {
        storylineId: arc,
        dayKey: "2026-07-12",
        segment: "day",
        summary: "The crews stood down.",
        articleCount: 5,
        label: "Written Arc",
        modelId: "test",
        attempts: 0,
        segmented: false,
        generatedAt: new Date("2026-07-13T00:00:00.000Z"),
      });
      expect(await awaiting(arc)).toEqual([]);
    });

    it("treats a REFUSAL as having one, so a click never retries it", async () => {
      // The row exists with a null summary: the model was asked and would not
      // answer. Retrying is the nightly pass's business, bounded by
      // SUMMARY_MAX_ATTEMPTS — a reader clicking three times would otherwise
      // retire the day for ever.
      const groups = await qualifyingDay("2026-07-14");
      const arc = await storyline([...groups], "Refused Arc");
      await writeStorylineDaySummary(harness.db, {
        storylineId: arc,
        dayKey: "2026-07-14",
        segment: "day",
        summary: null,
        articleCount: 5,
        label: "Refused Arc",
        modelId: "test",
        attempts: 1,
        segmented: false,
        generatedAt: new Date("2026-07-15T00:00:00.000Z"),
      });
      expect(await awaiting(arc)).toEqual([]);
    });

    it("ignores a QUARTER row, which is not the sentence anything reads", async () => {
      // ADR-0027 left the old quarter rows in place. A day whose only rows are
      // quarters has never had a day sentence, so it is still owed one.
      const groups = await qualifyingDay("2026-07-16");
      const arc = await storyline([...groups], "Quartered Arc");
      await writeStorylineDaySummary(harness.db, {
        storylineId: arc,
        dayKey: "2026-07-16",
        segment: "morning",
        summary: "Crews stood down at first light.",
        articleCount: 3,
        label: "Quartered Arc",
        modelId: "test",
        attempts: 0,
        segmented: true,
        generatedAt: new Date("2026-07-17T00:00:00.000Z"),
      });
      expect((await awaiting(arc)).map((day) => day.dayKey)).toEqual(["2026-07-16"]);
    });

    it("sees a sentence written under a LOSER's id, so a merge is not re-bought", async () => {
      // The preserve never follows a merge; membership does. Reading the
      // winner's summaries alone would re-buy every pre-merge sentence, once
      // per click, for ever.
      const winnerGroups = await qualifyingDay("2026-07-20");
      const loserGroups = await qualifyingDay("2026-07-22");
      const winner = await storyline([...winnerGroups], "Winner");
      const loser = await storyline([...loserGroups], "Loser");
      await writeStorylineDaySummary(harness.db, {
        storylineId: loser,
        dayKey: "2026-07-22",
        segment: "day",
        summary: "Written before the merge.",
        articleCount: 5,
        label: "Loser",
        modelId: "test",
        attempts: 0,
        segmented: false,
        generatedAt: new Date("2026-07-23T00:00:00.000Z"),
      });
      // The merge: the loser's groups follow, its summary row does not.
      for (const groupId of loserGroups) {
        await attachGroup(harness.db, { storylineId: winner, groupId, timeZone: "UTC" });
      }
      await harness.db
        .updateTable("storylines")
        .set({ merged_into: winner })
        .where("id", "=", loser)
        .execute();

      const days = (await awaiting(winner)).map((day) => day.dayKey);
      expect(days).toContain("2026-07-20");
      expect(days).not.toContain("2026-07-22");
    });

    it("excludes days at or after `before`, which is how today is kept out", async () => {
      const groups = await qualifyingDay("2026-08-20");
      const arc = await storyline([...groups], "Today Arc");
      expect(
        await awaiting(arc, { before: new Date("2026-08-20T00:00:00.000Z") }),
      ).toEqual([]);
    });

    it("stops at the limit, which is what bounds one click", async () => {
      const groups = await qualifyingDay("2026-06-02");
      for (const day of ["2026-06-04", "2026-06-06"]) {
        await article({ published: `${day}T02:00:00.000Z`, groupId: groups[0] });
        await article({ published: `${day}T03:00:00.000Z`, groupId: groups[0] });
        await article({ published: `${day}T04:00:00.000Z`, groupId: groups[1] });
        await article({ published: `${day}T05:00:00.000Z`, groupId: groups[1] });
        await article({ published: `${day}T06:00:00.000Z`, groupId: groups[1] });
      }
      const arc = await storyline([...groups], "Bounded Arc");
      // Newest first, so a bounded click spends itself on what a reader can see.
      expect((await awaiting(arc, { limit: 2 })).map((day) => day.dayKey)).toEqual([
        "2026-06-06",
        "2026-06-04",
      ]);
    });
  });
});
