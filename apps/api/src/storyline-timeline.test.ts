import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { deriveAltKey, deriveDedupKey, type Sighting } from "@zammy/currents-client";
import { encodeCursor } from "@zammy/shared";
import {
  attachGroup,
  createProvisionalStoryline,
  ingestSightings,
  mergeStorylines,
  promoteStoryline,
  readStorylineDays,
  recordCoverage,
  setStorylineLabel,
  setStorylineStatus,
  upsertTopic,
  writeStorylineDaySummary,
} from "@zammy/storage";
import type { CanonicalQuery } from "./canonical.js";
import { groupCreatedArticles } from "./grouping-service.js";
import { storylineBar } from "./storyline-bar.js";
import { readStorylineView, readTimeline, searchStorylines } from "./timeline-read.js";
import { createReadHarness, type ReadTestHarness } from "./test-support.js";
import { labelWords } from "./storyline-label-merge.js";
import { backfillLabelWords } from "./label-words-backfill.js";
import { PLANNED_COVERAGE_PROVIDER } from "./coverage-gaps.js";

/**
 * The storylines-v2 read path (ADR-0011): the timeline pages over
 * storyline-DAYS, and a UUID opens the storyline view.
 *
 * Storyline state is built here by calling the storage primitives directly
 * rather than by running the linker: what is under test is the READ, and a
 * membership arranged by hand is one whose expected page can be written down.
 */

const NOW = new Date("2026-08-13T22:00:00.000Z");
const WINDOW = {
  from: new Date("2026-08-10T00:00:00.000Z"),
  to: new Date("2026-08-14T00:00:00.000Z"),
};
const TZ = { timeZone: "UTC" };

/** The shipped grouping config with the linker disabled. */
function linkerOff(_now: Date): ReadTestHarness["deps"]["config"]["grouping"] {
  return {
    enabled: true,
    threshold: 0.5,
    timeZone: "UTC",
    linker: storylineBar({ enabled: false }),
  };
}

let harness: ReadTestHarness;
let db: ReadTestHarness["deps"]["db"];

beforeAll(async () => {
  // The LINKER off: this suite builds storyline membership by hand, because
  // what is under test is the READ, and a membership arranged deliberately is
  // one whose expected page can be written down. With the linker on it would
  // also seed its own provisional storyline per group, and every slot would
  // arrive twice — once from each.
  harness = await createReadHarness({ grouping: linkerOff(NOW) }, NOW);
  db = harness.deps.db;
});

afterAll(async () => {
  await harness.teardown();
});

beforeEach(async () => {
  await sql`
    truncate storylines, storyline_groups, storyline_days, storyline_bridges,
             articles, topic_articles, topic_coverage, topics, sightings cascade
  `.execute(db);
});

/**
 * Drop this topic's cached pages, and ONLY this topic's.
 *
 * Never `flushdb`: every api suite shares the compose Redis, so a flush here
 * empties the cache other files are mid-assertion about — which is a green
 * suite in isolation and a flaky one in the full run.
 */
async function dropCachedPages(fingerprint: string): Promise<void> {
  const keys = await harness.redis.keys(`page:*:${fingerprint}:*`);
  if (keys.length > 0) await harness.redis.del(...keys);
}

let uuid = 0;
function sighting(input: {
  domain: string;
  title: string;
  published: string;
  description?: string;
}): Sighting {
  uuid += 1;
  const url = `https://${input.domain}/${uuid}`;
  return {
    id: `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`,
    url,
    provider: "currents",
    providerSightingId: url,
    dedupKey: deriveDedupKey(url),
    altKey: deriveAltKey(input.domain, input.title, input.published),
    title: input.title,
    description: input.description ?? null,
    author: null,
    imageUrl: null,
    language: "en",
    categories: [],
    sourceCategories: [],
    sourceDomain: input.domain,
    published: input.published,
    raw: {},
  };
}

/**
 * Ingest and group a set of sightings under one topic, and mark the window
 * covered so the read is served from the store rather than the planner.
 */
async function seed(sightings: Sighting[]): Promise<CanonicalQuery> {
  const fingerprint = randomBytes(32).toString("hex");
  await upsertTopic(db, { fingerprint, keywords: ["storm"], language: "en" });
  const ingested = await ingestSightings(db, { plane: "search", ...TZ, fingerprint, sightings });
  await groupCreatedArticles(
    { db, config: harness.deps.config.grouping },
    ingested.createdArticles,
  );
  await recordCoverage(db, fingerprint, PLANNED_COVERAGE_PROVIDER, WINDOW);
  return {
    fingerprint,
    keywords: ["storm"],
    language: "en",
    country: null,
    category: null,
    window: { ...WINDOW },
  };
}

/** The group ids of the ingested articles, oldest first. */
async function groupIds(): Promise<string[]> {
  const rows = await db
    .selectFrom("articles")
    .select(["group_id", "published"])
    .distinct()
    .orderBy("published", "asc")
    .execute();
  return [...new Set(rows.map((row) => row.group_id))];
}

async function storylineOf(groupIdList: string[], label?: string): Promise<string> {
  const first = await createProvisionalStoryline(db, { groupId: groupIdList[0]!, ...TZ });
  for (const groupId of groupIdList.slice(1)) {
    await attachGroup(db, { storylineId: first.id, groupId, ...TZ });
  }
  if (groupIdList.length > 1) {
    await promoteStoryline(db, { storylineId: first.id });
    await setStorylineLabel(db, {
      storylineId: first.id,
      label: label ?? "Fausto Hawaii",
      labelWords: labelWords(label ?? "Fausto Hawaii"),
      labelAt: NOW,
      labelGroupCount: groupIdList.length,
      labelSource: "test",
    });
  }
  return first.id;
}

const MONDAY = "2026-08-10T09:00:00.000Z";
const TUESDAY = "2026-08-11T09:00:00.000Z";

describe("paging over storyline-days", () => {
  it("gives a storyline one slot per day it has coverage", async () => {
    const query = await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({
        domain: "b.example",
        title: "Fausto weakens as surf pounds the islands",
        published: TUESDAY,
      }),
    ]);
    const storyline = await storylineOf(await groupIds());

    const result = await readTimeline(harness.deps, query, { limit: 25 });

    // A ten-day storyline appears ten times as the reader scrolls back; this
    // is the two-day case of exactly that.
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.storylineId === storyline)).toBe(true);
    expect(result.items.map((item) => item.published.slice(0, 10))).toEqual([
      "2026-08-11",
      "2026-08-10",
    ]);
    // Each slot holds only ITS day's articles — no slot spans days, which is
    // what makes "unbounded in time" free at read time.
    expect(result.items.map((item) => 1 + item.related.length + item.moreCoverage.length)).toEqual([
      1, 1,
    ]);
  });

  it("re-derives the day slot when a later arrival joins a member group", async () => {
    // Monday's group is seeded by the 10:00 piece and Tuesday's makes the
    // storyline real. After this the storyline's GROUP set never changes again
    // — which is exactly the case `refreshStoryline` exists for, and the case
    // nothing was calling it on.
    const query = await seed([
      sighting({
        domain: "a.example",
        title: "Hurricane Fausto nears Hawaii",
        published: "2026-08-10T10:00:00.000Z",
      }),
      sighting({
        domain: "b.example",
        title: "Fausto weakens as surf pounds the islands",
        published: TUESDAY,
      }),
    ]);
    const storyline = await storylineOf(await groupIds(), "Hurricane Fausto");
    const mondayGroup = (await groupIds())[0]!;

    // A third outlet ran Monday's piece EARLIER in the day and arrives on a
    // later upstream page. It JOINS the existing group: same group id, no
    // membership change, so no `attachGroup`, no `mergeGroups`, no merge.
    const late = await ingestSightings(db, {
      plane: "search",
      ...TZ,
      fingerprint: query.fingerprint,
      sightings: [
        sighting({
          domain: "c.example",
          title: "Hurricane Fausto nears Hawaii",
          published: "2026-08-10T06:00:00.000Z",
        }),
      ],
    });
    await groupCreatedArticles(
      { db, config: harness.deps.config.grouping },
      late.createdArticles,
    );
    const joined = late.createdArticles[0]!.id;
    const home = await db
      .selectFrom("articles")
      .select("group_id")
      .where("id", "=", joined)
      .executeTakeFirst();
    expect(home?.group_id).toBe(mondayGroup);

    // A day slot IS its day's earliest article, so Monday's lead and Monday's
    // position on the §7.3 keyset axis both moved. Nothing keyed on
    // `storyline_groups` can notice, because nothing about the group set moved.
    const monday = (await readStorylineDays(db, storyline)).find(
      (day) => day.dayKey === "2026-08-10",
    );
    expect(monday?.leadArticleId).toBe(joined);
    expect(monday?.daySlotPublished.toISOString()).toBe("2026-08-10T06:00:00.000Z");

    await dropCachedPages(query.fingerprint);
    const result = await readTimeline(harness.deps, query, { limit: 25 });
    const slot = result.items.find((item) => item.published.startsWith("2026-08-10"));
    expect(slot?.published).toBe("2026-08-10T06:00:00.000Z");
  });

  it("carries the label and span for a promoted storyline", async () => {
    const query = await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Fausto weakens over Hawaii", published: TUESDAY }),
    ]);
    await storylineOf(await groupIds(), "Hurricane Fausto");

    const result = await readTimeline(harness.deps, query, { limit: 25 });

    for (const item of result.items) {
      expect(item.storyline?.label).toBe("Hurricane Fausto");
      // The span is the STORYLINE's, not the slot's — it is what tells two
      // same-label storylines apart when both are on screen.
      expect(item.storyline?.from.slice(0, 10)).toBe("2026-08-10");
      expect(item.storyline?.to.slice(0, 10)).toBe("2026-08-11");
    }
  });

  it("renders a provisional storyline-of-one as a plain slot", async () => {
    const query = await seed([
      sighting({ domain: "a.example", title: "Council approves a bridge", published: MONDAY }),
    ]);
    await storylineOf(await groupIds());

    const result = await readTimeline(harness.deps, query, { limit: 25 });

    expect(result.items).toHaveLength(1);
    // Invisible AS a storyline: no label, no treatment, nothing for the front
    // end to special-case.
    expect(result.items[0]!.storyline).toBeNull();
  });

  it("sections the pane by group: same story syndicated vs wider coverage", async () => {
    const query = await seed([
      sighting({
        domain: "a.example",
        title: "Hurricane Fausto nears Hawaii",
        published: "2026-08-10T09:00:00.000Z",
      }),
      sighting({
        domain: "b.example",
        title: "Hurricane Fausto nears Hawaii",
        published: "2026-08-10T10:00:00.000Z",
      }),
      sighting({
        domain: "c.example",
        title: "Surf advisory issued for south shores",
        published: "2026-08-10T11:00:00.000Z",
        description: "As Hurricane Fausto nears Hawaii, forecasters warn of swell.",
      }),
    ]);
    await storylineOf(await groupIds());

    const result = await readTimeline(harness.deps, query, { limit: 25 });

    expect(result.items).toHaveLength(1);
    const slot = result.items[0]!;
    // Two outlets ran the same piece — that is `related`. The advisory is a
    // different piece about the same story — that is `moreCoverage`.
    expect(slot.related).toHaveLength(1);
    expect(slot.moreCoverage).toHaveLength(1);
    expect(slot.moreCoverage[0]!.sourceDomain).toBe("c.example");
  });
});

describe("cursor totality under the new keyset", () => {
  it("pages every slot exactly once, with hasMore honest at each step", async () => {
    const query = await seed(
      Array.from({ length: 6 }, (_, i) =>
        sighting({
          domain: `d${i}.example`,
          title: `Distinct headline number ${i} about nothing shared`,
          published: `2026-08-1${i % 4}T0${i}:00:00.000Z`,
        }),
      ),
    );
    for (const groupId of await groupIds()) await storylineOf([groupId]);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await readTimeline(harness.deps, query, {
        limit: 2,
        ...(cursor ? { cursorString: cursor } : {}),
      });
      seen.push(...result.items.map((item) => `${item.storylineId}|${item.published}`));
      if (!result.page.hasMore) {
        expect(result.page.nextCursor).toBeNull();
        break;
      }
      expect(result.page.nextCursor).not.toBeNull();
      cursor = result.page.nextCursor!;
    }

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it("fans a group in two storylines out to two slots, and pages both", async () => {
    // Duplication is accepted by ADR-0011 — honest, and rare under err-narrow
    // formation. What must not happen is a slot going missing because the
    // keyset assumed one storyline per group.
    const query = await seed([
      sighting({ domain: "a.example", title: "Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Genevieve strengthens offshore", published: MONDAY }),
    ]);
    const [shared, other] = await groupIds();
    const first = await storylineOf([shared!, other!], "Pacific Storms");
    const second = await createProvisionalStoryline(db, { groupId: shared!, ...TZ });
    await attachGroup(db, { storylineId: second.id, groupId: other!, ...TZ });
    await promoteStoryline(db, { storylineId: second.id });

    const result = await readTimeline(harness.deps, query, { limit: 25 });

    // One day, two storylines, both holding the same groups: two slots.
    expect(result.items).toHaveLength(2);
    expect(new Set(result.items.map((item) => item.storylineId))).toEqual(
      new Set([first, second.id]),
    );
  });

  it("refuses a cursor that is neither a bigint nor a UUID", async () => {
    const query = await seed([
      sighting({ domain: "a.example", title: "Something happened today", published: MONDAY }),
    ]);
    await expect(
      readTimeline(harness.deps, query, {
        limit: 5,
        cursorString: Buffer.from("2026-08-10T00:00:00.000Z|not-an-id").toString("base64url"),
      }),
    ).rejects.toThrow(/unusable cursor/);
  });

  it("refuses a v1 cursor rather than casting a bigint to a UUID", async () => {
    // The flag flipped ON under a reader mid-scroll: their cursor's id half is
    // a hub group's bigint, and the v2 keyset compares it against a UUID. A
    // 400 is the honest answer — the cursor names a slot in a model this
    // request is not serving — where the cast is a 500.
    const query = await seed([
      sighting({ domain: "a.example", title: "Something happened today", published: MONDAY }),
    ]);
    await expect(
      readTimeline(harness.deps, query, {
        limit: 5,
        cursorString: encodeCursor({ published: MONDAY, articleId: "1234567890" }),
      }),
    ).rejects.toThrow(/unusable cursor/);
  });
});

describe("the storyline view", () => {
  it("needs a database, a clock and a time zone — and nothing else", async () => {
    // Newly assertable, and worth asserting once at runtime rather than only in
    // the types: until the `timeline-service` split this read took the whole
    // planner bag, and the claim that it touched none of it was a claim in a
    // comment. Here the object handed in HAS nothing else — no client, no queue,
    // no labeler, no grouping threshold — so a future edit that reaches for one
    // fails here instead of quietly widening what opening a storyline costs.
    await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Fausto weakens over Hawaii", published: TUESDAY }),
    ]);
    const storyline = await storylineOf(await groupIds(), "Hurricane Fausto");

    const view = await readStorylineView(
      { db, now: () => NOW, config: { grouping: { timeZone: "UTC" } } },
      { storylineIds: [storyline], limit: 25 },
    );

    expect(view!.items).toHaveLength(2);
    expect(view!.storylines[0]).toMatchObject({ id: storyline, label: "Hurricane Fausto" });
  });

  it("serves one storyline's slots by UUID, with no keywords", async () => {
    await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Fausto weakens over Hawaii", published: TUESDAY }),
    ]);
    const storyline = await storylineOf(await groupIds(), "Hurricane Fausto");

    const view = await readStorylineView(harness.deps, { storylineIds: [storyline], limit: 25 });

    expect(view).not.toBeNull();
    expect(view!.items).toHaveLength(2);
    expect(view!.topic.keywords).toEqual([]);
    expect(view!.storylines[0]).toMatchObject({ id: storyline, label: "Hurricane Fausto" });
    // Nothing is being fetched for a view, so it is never "still arriving".
    expect(view!.meta.ingest).toEqual({ state: "complete", pendingJobs: 0 });
  });

  it("follows an alias to the survivor, so a merged link never dangles", async () => {
    await seed([
      sighting({ domain: "a.example", title: "Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Genevieve strengthens", published: TUESDAY }),
    ]);
    const [one, two] = await groupIds();
    const winner = await storylineOf([one!], "Pacific Storms");
    const loser = await createProvisionalStoryline(db, { groupId: two!, ...TZ });
    await mergeStorylines(db, { winnerId: winner, loserId: loser.id, ...TZ });

    // The reader's bookmark holds the LOSER's UUID.
    const view = await readStorylineView(harness.deps, { storylineIds: [loser.id], limit: 25 });

    expect(view).not.toBeNull();
    expect(view!.storylines[0]?.id).toBe(winner);
    expect(view!.items.length).toBeGreaterThan(0);
  });

  it("hands each slot the day sentence written for it, and a search none", async () => {
    // The historical preserve (ADR-0023) reaching a reader. Two days, a
    // sentence for one of them: the day that has one carries it, the day that
    // does not carries null rather than borrowing its neighbour's.
    const query = await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Fausto weakens over Hawaii", published: TUESDAY }),
    ]);
    const storyline = await storylineOf(await groupIds(), "Hurricane Fausto");
    await writeStorylineDaySummary(db, {
      storylineId: storyline,
      dayKey: "2026-08-10",
      segment: "day",
      summary: "Fausto closed on the islands as shelters opened.",
      articleCount: 6,
      label: "Hurricane Fausto",
      modelId: "gemma-test",
      attempts: 0,
      segmented: true,
      generatedAt: NOW,
    });

    const view = await readStorylineView(harness.deps, { storylineIds: [storyline], limit: 25 });

    // Newest day first, so Tuesday — which has no sentence — leads. The
    // sentence travels WITH the date it is about, because the browser cuts the
    // rail by the reader's calendar and has to put it under a heading reading
    // the same day (`TimelineEntry.daySummary`).
    expect(view!.items.map((item) => item.daySummary)).toEqual([
      null,
      { dayKey: "2026-08-10", text: "Fausto closed on the islands as shelters opened." },
    ]);

    // The same storyline-day, reached by SEARCH, says nothing: a search's slot
    // holds only the members that matched the keywords, and a sentence about
    // the whole day would describe coverage the row does not show.
    await dropCachedPages(query.fingerprint);
    const searched = await readTimeline(harness.deps, query, { limit: 25 });
    expect(searched.items.map((item) => item.daySummary)).toEqual([null, null]);
  });

  it("reports a UUID this database never held as absent, not as empty", async () => {
    const view = await readStorylineView(harness.deps, {
      storylineIds: ["00000000-0000-4000-8000-000000000000"],
      limit: 25,
    });
    // The route turns this into a 404: a stale link and an empty storyline are
    // different answers, and only one of them is worth a reader's attention.
    expect(view).toBeNull();
  });

  it("pages a long storyline without repeating a day", async () => {
    await seed(
      Array.from({ length: 5 }, (_, i) =>
        sighting({
          domain: `d${i}.example`,
          title: `Fausto update number ${i}`,
          published: `2026-08-1${i}T09:00:00.000Z`,
        }),
      ),
    );
    const storyline = await storylineOf(await groupIds(), "Hurricane Fausto");

    const days: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const view = await readStorylineView(harness.deps, {
        storylineIds: [storyline],
        limit: 2,
        ...(cursor ? { cursorString: cursor } : {}),
      });
      days.push(...view!.items.map((item) => item.published));
      if (!view!.page.hasMore) break;
      cursor = view!.page.nextCursor!;
    }

    expect(days).toHaveLength(5);
    expect(new Set(days).size).toBe(5);
  });

  it("reports the storyline's whole-life size on every page, not the page's own", async () => {
    // The wire contract says size is "articles in the storyline, over its whole
    // life" — a fact about the story. Summing the page would make it a fact
    // about the scroll position: five articles on page one, two on page two.
    await seed(
      Array.from({ length: 5 }, (_, i) =>
        sighting({
          domain: `d${i}.example`,
          title: `Fausto update number ${i}`,
          published: `2026-08-1${i}T09:00:00.000Z`,
        }),
      ),
    );
    const storyline = await storylineOf(await groupIds(), "Hurricane Fausto");

    const first = await readStorylineView(harness.deps, { storylineIds: [storyline], limit: 2 });
    const second = await readStorylineView(harness.deps, {
      storylineIds: [storyline],
      limit: 2,
      cursorString: first!.page.nextCursor!,
    });

    expect(first!.storylines[0]!.size).toBe(5);
    expect(second!.storylines[0]!.size).toBe(5);
  });

  /**
   * A view of SEVERAL storylines (ADR-0028): a reader with one open clicks
   * another, and the view holds both. Two arcs by hand — the storm on Monday
   * and Wednesday, the strike on Tuesday — so the interleaving is visible.
   */
  async function twoArcs(): Promise<{ storm: string; strike: string }> {
    await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Rail strike halts commuters", published: TUESDAY }),
      sighting({
        domain: "c.example",
        title: "Fausto weakens over Hawaii",
        published: "2026-08-12T09:00:00.000Z",
      }),
    ]);
    const [monday, tuesday, wednesday] = await groupIds();
    const storm = await storylineOf([monday!, wednesday!], "Hurricane Fausto");
    const strike = await storylineOf([tuesday!], "Rail Strike");
    return { storm, strike };
  }

  it("serves several storylines' days on one keyset, in time order across them", async () => {
    const { storm, strike } = await twoArcs();

    const view = await readStorylineView(harness.deps, { storylineIds: [storm, strike], limit: 25 });

    expect(view!.items.map((item) => [item.storylineId, item.published.slice(0, 10)])).toEqual([
      [storm, "2026-08-12"],
      [strike, "2026-08-11"],
      [storm, "2026-08-10"],
    ]);
  });

  it("names every arc in the view, in the order asked", async () => {
    const { storm, strike } = await twoArcs();

    const view = await readStorylineView(harness.deps, { storylineIds: [strike, storm], limit: 25 });

    // The browser reads these back against the list it asked for, so the
    // order is part of the answer. The strike is provisional — a storyline of
    // one — and is still NAMED here: it is the view's own subject, not an offer.
    expect(view!.storylines.map((s) => s.id)).toEqual([strike, storm]);
    expect(view!.storylines.map((s) => s.label)).toEqual([null, "Hurricane Fausto"]);
    expect(view!.storylines.map((s) => s.size)).toEqual([1, 2]);
  });

  it("hands each slot its OWN arc's day sentence when two arcs share a day", async () => {
    await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Rail strike halts commuters", published: MONDAY }),
      sighting({ domain: "c.example", title: "Fausto weakens over Hawaii", published: TUESDAY }),
    ]);
    const [storm1, strike1, storm2] = await groupIds();
    const storm = await storylineOf([storm1!, storm2!], "Hurricane Fausto");
    const strike = await storylineOf([strike1!], "Rail Strike");
    for (const [storylineId, summary] of [
      [storm, "Fausto closed on the islands."],
      [strike, "Commuters walked as the strike began."],
    ] as const) {
      await writeStorylineDaySummary(db, {
        storylineId,
        dayKey: "2026-08-10",
        segment: "day",
        summary,
        articleCount: 1,
        label: null,
        modelId: "gemma-test",
        attempts: 0,
        segmented: true,
        generatedAt: NOW,
      });
    }

    const view = await readStorylineView(harness.deps, { storylineIds: [storm, strike], limit: 25 });

    const monday = view!.items.filter((item) => item.published.startsWith("2026-08-10"));
    expect(new Map(monday.map((item) => [item.storylineId, item.daySummary?.text]))).toEqual(
      new Map([
        [storm, "Fausto closed on the islands."],
        [strike, "Commuters walked as the strike began."],
      ]),
    );
  });

  it("drops a UUID it has never held from a view of several, and serves the rest", async () => {
    const { storm, strike } = await twoArcs();

    const view = await readStorylineView(harness.deps, {
      storylineIds: [storm, "00000000-0000-4000-8000-000000000000", strike],
      limit: 25,
    });

    // One dead link in a shared list should not take the other two with it;
    // `storylines` naming only what resolved is how the browser learns which
    // chip to drop.
    expect(view!.storylines.map((s) => s.id)).toEqual([storm, strike]);
    expect(view!.items).toHaveLength(3);
  });

  it("folds two aliases of one survivor into one arc", async () => {
    await seed([
      sighting({ domain: "a.example", title: "Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Genevieve strengthens", published: TUESDAY }),
    ]);
    const [one, two] = await groupIds();
    const winner = await storylineOf([one!], "Pacific Storms");
    const loser = await createProvisionalStoryline(db, { groupId: two!, ...TZ });
    await mergeStorylines(db, { winnerId: winner, loserId: loser.id, ...TZ });

    const view = await readStorylineView(harness.deps, { storylineIds: [loser.id, winner], limit: 25 });

    expect(view!.storylines.map((s) => s.id)).toEqual([winner]);
    // Every slot once: the arc is read once, not once per name it was asked by.
    const slots = view!.items.map((item) => `${item.storylineId}|${item.published}`);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it("pages a view of several without repeating or skipping a day", async () => {
    const { storm, strike } = await twoArcs();

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const view = await readStorylineView(harness.deps, {
        storylineIds: [storm, strike],
        limit: 1,
        ...(cursor ? { cursorString: cursor } : {}),
      });
      seen.push(...view!.items.map((item) => `${item.storylineId}|${item.published}`));
      if (!view!.page.hasMore) break;
      cursor = view!.page.nextCursor!;
    }

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });
});

/**
 * Storylines by keyword on their own (ADR-0028, amended): what the view's
 * search box runs. The match is the SAME one a search makes beside its results,
 * so the one thing worth pinning is that it agrees with `readTimeline` — and
 * that asking it mints no topic.
 */
describe("searching for storylines", () => {
  it("surfaces the same storylines a search would, without a page or a topic", async () => {
    const query = await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({
        domain: "b.example",
        title: "Hurricane Fausto weakens west of Hawaii",
        published: TUESDAY,
      }),
    ]);
    const storyline = await storylineOf(await groupIds(), "Hurricane Fausto");
    const topicsBefore = await db.selectFrom("topics").select("fingerprint").execute();

    const found = await searchStorylines(harness.deps, "Hurricane");

    // Nothing was minted: a search beside a page upserts its topic; this must
    // not, or every question typed into the view would leave a keyword-less
    // row behind for retention to find.
    const topicsAfter = await db.selectFrom("topics").select("fingerprint").execute();
    expect(topicsAfter).toEqual(topicsBefore);

    const beside = await readTimeline(harness.deps, { ...query, keywords: ["hurricane"] }, { limit: 25 });
    expect(found.map((s) => s.id)).toEqual([storyline]);
    expect(found).toEqual(beside.storylines);
  });

  it("folds and splits the words the way a search does", async () => {
    await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Fausto weakens west of Hawaii", published: TUESDAY }),
    ]);
    const storyline = await storylineOf(await groupIds(), "Hurricane Fausto");

    // Two words, capitals, a plural: the label's "Fausto" and the profile's
    // "hawaii", found together, as the pill beside a search would be.
    expect((await searchStorylines(harness.deps, "  FAUSTO Hawaii ")).map((s) => s.id)).toEqual([storyline]);
    expect(await searchStorylines(harness.deps, "fausto tornado")).toEqual([]);
    expect(await searchStorylines(harness.deps, "   ")).toEqual([]);
  });
});

describe("surfacing storylines beside a search", () => {
  it("surfaces a storyline whose profile CONTAINS every keyword", async () => {
    // Two distinct headlines, so they form two groups and the storyline is
    // promoted — a storyline-of-one would be provisional and never surface.
    const query = await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({
        domain: "b.example",
        title: "Hurricane Fausto weakens west of Hawaii",
        published: TUESDAY,
      }),
    ]);
    const storyline = await storylineOf(await groupIds(), "Hurricane Fausto");

    const matching = await readTimeline(
      harness.deps,
      { ...query, keywords: ["hurricane"] },
      { limit: 25 },
    );
    expect(matching.storylines.map((s) => s.id)).toEqual([storyline]);
    expect(matching.storylines[0]).toMatchObject({ label: "Hurricane Fausto" });

    // Containment, not overlap: one keyword the profile lacks is enough to
    // refuse it, or a search would surface every storyline it brushes past.
    //
    // The cache is keyed by FINGERPRINT, and this test varies keywords while
    // holding the fingerprint fixed — which no real request can do, since the
    // fingerprint is derived from the keywords. Dropped so the second read
    // actually runs.
    await dropCachedPages(query.fingerprint);
    const partial = await readTimeline(
      harness.deps,
      { ...query, keywords: ["hurricane", "typhoon"] },
      { limit: 25 },
    );
    expect(partial.storylines).toEqual([]);
  });

  it("says which surfaced storylines are dormant", async () => {
    // S8's verdict: the marker "explained the March match instantly — without
    // it the reader wonders why a five-month-old story is being offered".
    const query = await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({
        domain: "b.example",
        title: "Hurricane Fausto weakens west of Hawaii",
        published: TUESDAY,
      }),
    ]);
    const storyline = await storylineOf(await groupIds(), "Hurricane Fausto");

    const active = await readTimeline(
      harness.deps,
      { ...query, keywords: ["hurricane"] },
      { limit: 25 },
    );
    expect(active.storylines[0]).toMatchObject({ id: storyline, dormant: false });

    await setStorylineStatus(db, { storylineId: storyline, status: "dormant" });
    await dropCachedPages(query.fingerprint);
    const dormant = await readTimeline(
      harness.deps,
      { ...query, keywords: ["hurricane"] },
      { limit: 25 },
    );

    // Still offered — a dormant storyline is a real story that has fallen
    // quiet, and quiet is a thing to say rather than a reason to hide it.
    expect(dormant.storylines[0]).toMatchObject({ id: storyline, dormant: true });
  });

  it("never surfaces a provisional storyline — it is a slot, not a story", async () => {
    const query = await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
    ]);
    // One group, so the storyline stays provisional however well it matches.
    await storylineOf(await groupIds());

    const result = await readTimeline(
      harness.deps,
      { ...query, keywords: ["hurricane"] },
      { limit: 25 },
    );
    expect(result.storylines).toEqual([]);
  });

  it("surfaces a storyline whose LABEL holds a keyword its profile does not", async () => {
    // The gap the profile alone leaves: the model names the event with a word
    // the coverage barely uses, and the profile's majority rule drops it. The
    // label is the name the reader was shown — in the cloud, in the gutter —
    // so typing it back in has to find the story.
    const query = await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({
        domain: "b.example",
        title: "Hurricane Fausto weakens west of Hawaii",
        published: TUESDAY,
      }),
    ]);
    const storyline = await storylineOf(await groupIds(), "Pacific Storm Fausto");

    const result = await readTimeline(
      harness.deps,
      { ...query, keywords: ["pacific"] },
      { limit: 25 },
    );
    expect(result.storylines.map((s) => s.id)).toEqual([storyline]);
  });

  it("folds plurals across the label too, by folding the label the same way", async () => {
    // `label_words` is folded by `normalizeLabel` and `profile_tokens` by the
    // corpus tokenizer, which is the same two steps in the same order — so one
    // folded keyword answers both and neither side needs an inverse. Both
    // directions: a plural label found by a singular keyword, and a plural
    // keyword found by the singular profile.
    const query = await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({
        domain: "b.example",
        title: "Hurricane Fausto weakens west of Hawaii",
        published: TUESDAY,
      }),
    ]);
    const storyline = await storylineOf(await groupIds(), "Pacific Storms");

    const label = await readTimeline(harness.deps, { ...query, keywords: ["storm"] }, { limit: 25 });
    expect(label.storylines.map((s) => s.id)).toEqual([storyline]);

    await dropCachedPages(query.fingerprint);
    const profile = await readTimeline(
      harness.deps,
      { ...query, keywords: ["hurricanes"] },
      { limit: 25 },
    );
    expect(profile.storylines.map((s) => s.id)).toEqual([storyline]);
  });

  it("reads both vocabularies as one, per keyword", async () => {
    // Containment is per keyword across the profile AND the label together,
    // not within either alone: "fausto pacific" is one word from each, and it
    // is the same storyline both times.
    const query = await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({
        domain: "b.example",
        title: "Hurricane Fausto weakens west of Hawaii",
        published: TUESDAY,
      }),
    ]);
    const storyline = await storylineOf(await groupIds(), "Pacific Storm");

    const split = await readTimeline(
      harness.deps,
      { ...query, keywords: ["fausto", "pacific"] },
      { limit: 25 },
    );
    expect(split.storylines.map((s) => s.id)).toEqual([storyline]);

    // And widening the surface does not loosen containment: a keyword in
    // neither vocabulary still refuses the match.
    await dropCachedPages(query.fingerprint);
    const missing = await readTimeline(
      harness.deps,
      { ...query, keywords: ["pacific", "typhoon"] },
      { limit: 25 },
    );
    expect(missing.storylines).toEqual([]);
  });

  it("finds a label's possessive by the name inside it", async () => {
    // "Dillard's Tariff Refund" answers to `dillard`, because the words stored
    // for it went through `trimWordPunctuation` — the tokenizer's own fold, the
    // one that took the possessive off the corpus side too.
    const query = await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({
        domain: "b.example",
        title: "Hurricane Fausto weakens west of Hawaii",
        published: TUESDAY,
      }),
    ]);
    const storyline = await storylineOf(await groupIds(), "Dillard's Tariff Refund");

    const result = await readTimeline(
      harness.deps,
      { ...query, keywords: ["dillard"] },
      { limit: 25 },
    );
    expect(result.storylines.map((s) => s.id)).toEqual([storyline]);

    // And by the possessive itself, which is what a reader typing the label
    // back sends. `canonicalize` does not trim punctuation, so the keyword
    // arrives as `dillard's`; `labelWords` trims it before stemming, exactly as
    // it did when the label was written, so both sides say `dillard`. With
    // `singular` alone the keyword reaches `dillard'` and meets nothing — the
    // stranded apostrophe `trimWordPunctuation` exists to prevent, arriving
    // this time from the search side.
    await dropCachedPages(query.fingerprint);
    const possessive = await readTimeline(
      harness.deps,
      { ...query, keywords: ["dillard's"] },
      { limit: 25 },
    );
    expect(possessive.storylines.map((s) => s.id)).toEqual([storyline]);
  });

  it("matches nothing on the label side until the backfill runs, then does", async () => {
    // Migration 0016 adds `label_words` empty and only `setStorylineLabel`
    // fills it, so every row labelled before the migration has none. That is
    // deliberate and is what lets the migration run AHEAD of the API: an
    // un-backfilled row simply falls back to the profile-only surfacing it had
    // before, rather than erroring or matching wrongly.
    //
    // `label_words` is emptied here by hand because that is the only way to
    // stand where a pre-migration row stands — the write path cannot produce it.
    const query = await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({
        domain: "b.example",
        title: "Hurricane Fausto weakens west of Hawaii",
        published: TUESDAY,
      }),
    ]);
    const storyline = await storylineOf(await groupIds(), "Pacific Storm Fausto");
    await sql`update storylines set label_words = '{}' where id = ${storyline}::uuid`.execute(db);

    // `pacific` is in the label and in no headline, so the profile cannot
    // answer it: this is the label side and nothing else.
    const before = await readTimeline(
      harness.deps,
      { ...query, keywords: ["pacific"] },
      { limit: 25 },
    );
    expect(before.storylines).toEqual([]);

    const result = await backfillLabelWords({ db }, { batch: 100 });
    expect(result.written).toBeGreaterThanOrEqual(1);

    await dropCachedPages(query.fingerprint);
    const after = await readTimeline(
      harness.deps,
      { ...query, keywords: ["pacific"] },
      { limit: 25 },
    );
    expect(after.storylines.map((s) => s.id)).toEqual([storyline]);
  });
});

describe("after the cutover", () => {
  it("refuses a cursor minted before it, rather than casting a bigint to a UUID", async () => {
    // A reader mid-scroll across the deploy holds a cursor whose id half is a
    // hub group's bigint. The slots it named are gone; what must not happen is
    // that id reaching a UUID comparison. They get a 400 and a fresh first
    // page, which is the honest answer.
    const fingerprint = randomBytes(32).toString("hex");
    await upsertTopic(db, { fingerprint, keywords: ["storm"], language: "en" });
    await recordCoverage(db, fingerprint, PLANNED_COVERAGE_PROVIDER, WINDOW);

    await expect(
      readTimeline(
        harness.deps,
        {
          fingerprint,
          keywords: ["storm"],
          language: "en",
          country: null,
          category: null,
          window: { ...WINDOW },
        },
        {
          limit: 5,
          cursorString: encodeCursor({ published: MONDAY, articleId: "123456" }),
        },
      ),
    ).rejects.toThrow(/unusable cursor/);
  });
});

/**
 * MEMBERSHIP ON THE WIRE (ADR-0025): which storylines each group on a page is
 * filed in.
 *
 * Membership lives on the GROUP (`storyline_groups`), never on the article and
 * never on the slot, so these assertions are all about `memberships.byGroup`
 * rather than about any entry. What the page has to make possible is a row
 * saying "this piece also runs over there" and being able to get there.
 */
describe("the storylines a page's groups are in", () => {
  /**
   * Two arcs sharing one group, and a third group that is in only one of them.
   * Returns the shared group and both storyline ids.
   */
  async function twoArcsSharingAGroup(): Promise<{
    query: CanonicalQuery;
    shared: string;
    lone: string;
    first: string;
    second: string;
  }> {
    const query = await seed([
      sighting({ domain: "a.example", title: "Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Genevieve strengthens offshore", published: MONDAY }),
      sighting({ domain: "c.example", title: "Shipping lanes rerouted west", published: MONDAY }),
    ]);
    const [shared, lone, third] = await groupIds();
    const first = await storylineOf([shared!, lone!], "Pacific Storms");
    const second = await storylineOf([shared!, third!], "Shipping Disruption");
    return { query, shared: shared!, lone: lone!, first, second };
  }

  it("names both storylines a shared group is filed in, and describes each", async () => {
    const { query, shared, first, second } = await twoArcsSharingAGroup();

    const result = await readTimeline(harness.deps, query, { limit: 25 });

    expect(new Set(result.memberships.byGroup[shared])).toEqual(new Set([first, second]));
    // A UUID a reader can be sent to is worth nothing without something to
    // call it, so the directory answers every id the map names.
    const directory = new Map(result.memberships.storylines.map((s) => [s.id, s]));
    expect(directory.get(first)?.label).toBe("Pacific Storms");
    expect(directory.get(second)?.label).toBe("Shipping Disruption");
    expect(directory.get(first)?.dormant).toBe(false);
  });

  it("says nothing about a group filed in exactly one storyline", async () => {
    const { query, lone } = await twoArcsSharingAGroup();

    const result = await readTimeline(harness.deps, query, { limit: 25 });

    // The common case by a wide margin, and it must cost the wire nothing: the
    // one arc such a group is in is the arc of the slot it appears in, which
    // the entry already carries.
    expect(result.memberships.byGroup[lone]).toBeUndefined();
  });

  it("reports nothing at all for a page whose groups all sit in one arc", async () => {
    const query = await seed([
      sighting({ domain: "a.example", title: "Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Genevieve strengthens offshore", published: MONDAY }),
    ]);
    const groups = await groupIds();
    await storylineOf(groups, "Pacific Storms");

    const result = await readTimeline(harness.deps, query, { limit: 25 });

    expect(result.memberships.byGroup).toEqual({});
    expect(result.memberships.storylines).toEqual([]);
  });

  /**
   * THE ASYMMETRY, pinned so a later change cannot quietly start reporting it.
   *
   * `related` is the lead group's OTHER MEMBERS — same `groupId` as the
   * headline by construction — so those rows are in precisely the headline's
   * storylines, always, and membership has nothing to add to them. `moreCoverage`
   * is every OTHER group in the slot, each with its own rows in
   * `storyline_groups`, and those genuinely can run in arcs the headline never
   * touches. A page that reported membership per row would be saying something
   * about "same story" that is true of the headline and news about neither.
   */
  it("adds nothing to SAME STORY: those rows are the headline's own group", async () => {
    const query = await seed([
      // Two outlets, one story, one group — the slot's "same story" rows, and
      // the largest group in the slot, so this is also its headline.
      sighting({ domain: "a.example", title: "Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Fausto nears Hawaii", published: MONDAY }),
      // A different piece, its own group: the slot's "more coverage".
      sighting({ domain: "c.example", title: "Shipping lanes rerouted west", published: MONDAY }),
      // A fourth piece, in the second arc only, so that arc is a real one.
      sighting({ domain: "d.example", title: "Port backlog grows in Oakland", published: MONDAY }),
    ]);
    const [lead, angle, offshore] = await groupIds();
    // The ANGLE crosses into a second arc. The HEADLINE's group does not — so
    // the only crossing on this slot is one the disclosure holds.
    const first = await storylineOf([lead!, angle!], "Pacific Storms");
    const second = await storylineOf([angle!, offshore!], "Shipping Disruption");

    const result = await readTimeline(harness.deps, query, { limit: 25 });
    const slot = result.items.find((item) => item.storylineId === first)!;

    // The premise: every "same story" row IS the headline's group.
    expect(slot.related.length).toBeGreaterThan(0);
    for (const article of slot.related) {
      expect(article.groupId).toBe(slot.article.groupId);
    }
    // So a row of "same story" can never cross where its headline does not,
    // and here the headline crosses nowhere: the map says nothing about that
    // group, and the whole "same story" section inherits the silence.
    expect(result.memberships.byGroup[slot.article.groupId]).toBeUndefined();

    // "More coverage" is the section where a crossing can differ, and it is
    // answered by the same map because every article names its group.
    expect(slot.moreCoverage.map((article) => article.groupId)).toContain(angle);
    expect(new Set(result.memberships.byGroup[angle!])).toEqual(new Set([first, second]));
  });

  it("gives the STORYLINE VIEW the crossings too, and names arcs it cannot show", async () => {
    // The view is filtered to one arc, so the arc a row crosses into has no
    // slot on this page at all — which is exactly why the directory travels
    // beside the map rather than being read off the items.
    const { shared, first, second } = await twoArcsSharingAGroup();

    const view = (await readStorylineView(harness.deps, { storylineIds: [first], limit: 25 }))!;

    expect(new Set(view.memberships.byGroup[shared])).toEqual(new Set([first, second]));
    expect(view.items.every((item) => item.storylineId === first)).toBe(true);
    expect(view.memberships.storylines.map((s) => s.id)).toContain(second);
  });

  it("never names a PROVISIONAL storyline as an arc a group is also in", async () => {
    const query = await seed([
      sighting({ domain: "a.example", title: "Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Genevieve strengthens offshore", published: MONDAY }),
    ]);
    const groups = await groupIds();
    await storylineOf(groups, "Pacific Storms");
    // A storyline-of-one over a group that already has a real arc. It is
    // invisible as a storyline (ADR-0011's Lifecycle) and its own slot reaches
    // the browser with `storyline: null`, so naming it here would be the first
    // place the UI called it a story.
    await createProvisionalStoryline(db, { groupId: groups[0]!, ...TZ });

    const result = await readTimeline(harness.deps, query, { limit: 25 });

    expect(result.memberships.byGroup[groups[0]!]).toBeUndefined();
  });
});
