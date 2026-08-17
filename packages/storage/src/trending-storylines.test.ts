import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { migrateToLatest } from "./migrator.js";
import {
  attachGroup,
  createProvisionalStoryline,
  promoteStoryline,
  setStorylineLabel,
} from "./storylines.js";
import { readTrendingStorylines } from "./trending-storylines.js";
import { createTestDatabase, type TestDatabase } from "./test-support.js";

/**
 * The wordcloud read (ARCHITECTURE 10.4, ADR-0013): the storylines the rolling
 * window updated, most recently updated first.
 *
 * Real Postgres, because the whole thing is one aggregate — a windowed join for
 * the recency and the window count, a lateral for the arc's size and breadth,
 * and the exclusions in between. A fake would agree with every one of these
 * assertions and with none of the SQL.
 */

const ZONE = "UTC";
const NOW = new Date("2026-08-17T12:00:00.000Z");
const WINDOW = { from: new Date("2026-08-16T12:00:00.000Z"), to: NOW };

let counter = 0;

describe("readTrendingStorylines", () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
  });

  afterAll(async () => {
    await harness.drop();
  });

  beforeEach(async () => {
    await sql`
      truncate storylines, storyline_groups, storyline_days, articles cascade
    `.execute(harness.db);
  });

  /** One article, in its own group unless told otherwise. */
  const article = async (input: {
    published: string;
    domain: string;
    groupId?: string;
    language?: string | null;
  }): Promise<string> => {
    counter += 1;
    const row = await harness.db
      .insertInto("articles")
      .values({
        dedup_key: randomBytes(32),
        url: `https://${input.domain}/${counter}`,
        title: `Fixture ${counter}`,
        description: null,
        author: null,
        image_url: null,
        language: input.language === undefined ? "en" : input.language,
        categories: [],
        source_category: [],
        source_domain: input.domain,
        published: new Date(input.published),
        latest_seen: new Date(input.published),
        sighting_count: 1,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    if (input.groupId !== undefined) {
      await harness.db
        .updateTable("articles")
        .set({ group_id: input.groupId })
        .where("id", "=", row.id)
        .execute();
    }
    return row.id;
  };

  /**
   * A labelled, promoted storyline over the given articles — one group each,
   * which is what the linker produces for stories no two outlets ran at the
   * same URL. Built through the storage API rather than the linker: what is
   * under test is the read, and driving the linker would make its token
   * thresholds the subject.
   */
  const storyline = async (
    label: string,
    articles: readonly { published: string; domain: string }[],
  ): Promise<string> => {
    const groups = await Promise.all(articles.map((a) => article(a)));
    const created = await createProvisionalStoryline(harness.db, {
      groupId: groups[0]!,
      timeZone: ZONE,
    });
    for (const groupId of groups.slice(1)) {
      await attachGroup(harness.db, { storylineId: created.id, groupId, timeZone: ZONE });
    }
    await promoteStoryline(harness.db, { storylineId: created.id });
    await setStorylineLabel(harness.db, {
      storylineId: created.id,
      label,
      labelAt: NOW,
      labelGroupCount: groups.length,
      labelSource: "test",
    });
    return created.id;
  };

  const read = () =>
    readTrendingStorylines(harness.db, { language: "en", ...WINDOW, limit: 50 });

  it("orders by the newest member article — most recently updated first", async () => {
    await storyline("Older Arc", [
      { published: "2026-08-17T02:00:00.000Z", domain: "a.com" },
      { published: "2026-08-16T22:00:00.000Z", domain: "b.com" },
    ]);
    await storyline("Fresher Arc", [
      { published: "2026-08-17T11:30:00.000Z", domain: "a.com" },
      { published: "2026-08-17T09:00:00.000Z", domain: "b.com" },
    ]);

    const cloud = await read();
    expect(cloud.map((s) => s.label)).toEqual(["Fresher Arc", "Older Arc"]);
    expect(cloud[0]!.lastUpdated.toISOString()).toBe("2026-08-17T11:30:00.000Z");
  });

  it("counts the WINDOW's articles for size and the whole arc separately", async () => {
    // An arc that began well before the window and gained two articles inside
    // it: the cloud sizes the word on what happened, and still says how big
    // the story is.
    await storyline("Long Running Arc", [
      { published: "2026-08-10T09:00:00.000Z", domain: "a.com" },
      { published: "2026-08-11T09:00:00.000Z", domain: "b.com" },
      { published: "2026-08-17T08:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T10:00:00.000Z", domain: "c.com" },
    ]);

    const [only] = await read();
    expect(only!.windowArticles).toBe(2);
    expect(only!.size).toBe(4);
    expect(only!.sourceCount).toBe(3); // arc-wide breadth, not the window's
  });

  it("drops a storyline whose coverage all aged out of the window", async () => {
    await storyline("Aged Out", [
      { published: "2026-08-14T09:00:00.000Z", domain: "a.com" },
      { published: "2026-08-15T09:00:00.000Z", domain: "b.com" },
    ]);

    expect(await read()).toEqual([]);
  });

  it("gates on two source domains over the arc (the Jenkins-burst class)", async () => {
    // Five articles, one outlet, inside the window: a run of near-identical
    // advisories is not what several newsrooms are covering (PROBE-FINDINGS 6b).
    await storyline("Single Outlet Advisories", [
      { published: "2026-08-17T08:00:00.000Z", domain: "loud.com" },
      { published: "2026-08-17T09:00:00.000Z", domain: "loud.com" },
      { published: "2026-08-17T10:00:00.000Z", domain: "loud.com" },
      { published: "2026-08-17T11:00:00.000Z", domain: "loud.com" },
    ]);
    await storyline("Two Newsrooms", [
      { published: "2026-08-17T07:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T07:30:00.000Z", domain: "b.com" },
    ]);

    expect((await read()).map((s) => s.label)).toEqual(["Two Newsrooms"]);
  });

  it("refuses provisional, unlabelled and merged-away storylines", async () => {
    // Provisional: a storyline-of-one is the ordinary timeline slot, not a
    // story to name as a topic of the day.
    const provisional = await createProvisionalStoryline(harness.db, {
      groupId: await article({ published: "2026-08-17T11:00:00.000Z", domain: "a.com" }),
      timeZone: ZONE,
    });
    await setStorylineLabel(harness.db, {
      storylineId: provisional.id,
      label: "Provisional Arc",
      labelAt: NOW,
      labelGroupCount: 1,
      labelSource: "test",
    });

    // Unlabelled: promoted, covered, and with no word to draw.
    const unlabelled = await storyline("Temporarily Named", [
      { published: "2026-08-17T10:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T10:30:00.000Z", domain: "b.com" },
    ]);
    await setStorylineLabel(harness.db, {
      storylineId: unlabelled,
      label: null,
      labelAt: NOW,
      labelGroupCount: 2,
      labelSource: null,
    });

    // An alias: a pointer, whose coverage the survivor already carries.
    const alias = await storyline("Merged Away", [
      { published: "2026-08-17T09:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T09:30:00.000Z", domain: "b.com" },
    ]);
    const survivor = await storyline("The Survivor", [
      { published: "2026-08-17T08:00:00.000Z", domain: "a.com" },
      { published: "2026-08-17T08:30:00.000Z", domain: "b.com" },
    ]);
    await harness.db
      .updateTable("storylines")
      .set({ merged_into: survivor })
      .where("id", "=", alias)
      .execute();

    expect((await read()).map((s) => s.label)).toEqual(["The Survivor"]);
  });

  it("scopes to the language of the COVERAGE, not of the storyline", async () => {
    // A storyline is not language-scoped — nothing about an event is — so it
    // appears in the cloud of every language that covered it, sized by that
    // language's articles.
    const groups = await Promise.all([
      article({ published: "2026-08-17T11:00:00.000Z", domain: "a.com", language: "en" }),
      article({ published: "2026-08-17T10:00:00.000Z", domain: "b.com", language: "de" }),
      article({ published: "2026-08-17T09:00:00.000Z", domain: "c.com", language: "de" }),
    ]);
    const created = await createProvisionalStoryline(harness.db, {
      groupId: groups[0]!,
      timeZone: ZONE,
    });
    for (const groupId of groups.slice(1)) {
      await attachGroup(harness.db, { storylineId: created.id, groupId, timeZone: ZONE });
    }
    await promoteStoryline(harness.db, { storylineId: created.id });
    await setStorylineLabel(harness.db, {
      storylineId: created.id,
      label: "Bilingual Arc",
      labelAt: NOW,
      labelGroupCount: 3,
      labelSource: "test",
    });

    const german = await readTrendingStorylines(harness.db, {
      language: "de",
      ...WINDOW,
      limit: 50,
    });
    expect(german).toHaveLength(1);
    expect(german[0]!.windowArticles).toBe(2);
    expect(german[0]!.lastUpdated.toISOString()).toBe("2026-08-17T10:00:00.000Z");
    // The arc's own size and breadth are language-blind: they describe the story.
    expect(german[0]!.size).toBe(3);
    expect(german[0]!.sourceCount).toBe(3);

    const english = await read();
    expect(english[0]!.windowArticles).toBe(1);
  });

  it("honours the limit, keeping the freshest end of the list", async () => {
    for (const hour of ["06", "07", "08"]) {
      await storyline(`Arc ${hour}`, [
        { published: `2026-08-17T${hour}:00:00.000Z`, domain: "a.com" },
        { published: `2026-08-17T${hour}:30:00.000Z`, domain: "b.com" },
      ]);
    }

    const top = await readTrendingStorylines(harness.db, {
      language: "en",
      ...WINDOW,
      limit: 2,
    });
    expect(top.map((s) => s.label)).toEqual(["Arc 08", "Arc 07"]);
  });
});
