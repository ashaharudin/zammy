import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { deriveDedupKey, type Sighting } from "@zammy/currents-client";
import { encodeCursor } from "@zammy/shared";
import {
  attachGroup,
  createProvisionalStoryline,
  ingestSightings,
  mergeStorylines,
  promoteStoryline,
  recordCoverage,
  setStorylineLabel,
  setStorylineStatus,
  upsertTopic,
} from "@zammy/storage";
import type { CanonicalQuery } from "./canonical.js";
import { groupCreatedArticles } from "./grouping-service.js";
import { readStorylineView, readTimeline } from "./timeline-service.js";
import { createTestHarness, type TestHarness } from "./test-support.js";

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
function linkerOff(_now: Date): TestHarness["deps"]["config"]["grouping"] {
  return {
    enabled: true,
    threshold: 0.5,
    timeZone: "UTC",
    linker: {
      enabled: false,
      rules: {
        anchorMaxShare: 0.002,
        anchorDfFloor: 10,
        massThreshold: 20,
        dormancyDays: 90,
        dormantStrictness: 1.5,
      },
      mergeBridges: 2,
      coherenceGate: false, // the pre-gate path these tests already took (§12)
      storyDf: { windowDays: 14, timeZone: "UTC" },
      timeZone: "UTC",
    },
  };
}

let harness: TestHarness;
let db: TestHarness["deps"]["db"];

beforeAll(async () => {
  // The LINKER off: this suite builds storyline membership by hand, because
  // what is under test is the READ, and a membership arranged deliberately is
  // one whose expected page can be written down. With the linker on it would
  // also seed its own provisional storyline per group, and every slot would
  // arrive twice — once from each.
  harness = await createTestHarness({ grouping: linkerOff(NOW) }, NOW);
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
  const ingested = await ingestSightings(db, { fingerprint, sightings });
  await groupCreatedArticles(
    { db, config: harness.deps.config.grouping },
    ingested.createdArticles,
  );
  await recordCoverage(db, fingerprint, WINDOW);
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
  it("serves one storyline's slots by UUID, with no keywords", async () => {
    await seed([
      sighting({ domain: "a.example", title: "Hurricane Fausto nears Hawaii", published: MONDAY }),
      sighting({ domain: "b.example", title: "Fausto weakens over Hawaii", published: TUESDAY }),
    ]);
    const storyline = await storylineOf(await groupIds(), "Hurricane Fausto");

    const view = await readStorylineView(harness.deps, { storylineId: storyline, limit: 25 });

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
    const view = await readStorylineView(harness.deps, { storylineId: loser.id, limit: 25 });

    expect(view).not.toBeNull();
    expect(view!.storylines[0]?.id).toBe(winner);
    expect(view!.items.length).toBeGreaterThan(0);
  });

  it("reports a UUID this database never held as absent, not as empty", async () => {
    const view = await readStorylineView(harness.deps, {
      storylineId: "00000000-0000-4000-8000-000000000000",
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
        storylineId: storyline,
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

    const first = await readStorylineView(harness.deps, { storylineId: storyline, limit: 2 });
    const second = await readStorylineView(harness.deps, {
      storylineId: storyline,
      limit: 2,
      cursorString: first!.page.nextCursor!,
    });

    expect(first!.storylines[0]!.size).toBe(5);
    expect(second!.storylines[0]!.size).toBe(5);
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
});

describe("after the cutover", () => {
  it("refuses a cursor minted before it, rather than casting a bigint to a UUID", async () => {
    // A reader mid-scroll across the deploy holds a cursor whose id half is a
    // hub group's bigint. The slots it named are gone; what must not happen is
    // that id reaching a UUID comparison. They get a 400 and a fresh first
    // page, which is the honest answer.
    const fingerprint = randomBytes(32).toString("hex");
    await upsertTopic(db, { fingerprint, keywords: ["storm"], language: "en" });
    await recordCoverage(db, fingerprint, WINDOW);

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
