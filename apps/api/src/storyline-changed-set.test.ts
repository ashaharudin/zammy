import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  attachGroup,
  clearStorylineLinkDirty,
  createProvisionalStoryline,
  markStorylinesLinkDirty,
  mergeStorylines,
  promoteStoryline,
  readGroupStorylines,
  readLinkDirtyStorylines,
  recordGrouping,
} from "@zammy/storage";
import { runLateCandidateChore, type ChoreDeps } from "./chores.js";
import { readChangedSetBatch } from "./storyline-changed-set.js";
import type { LinkerConfig } from "./storyline-linker.js";
import { createTestHarness, type TestHarness } from "./test-support.js";

/**
 * The nightly sweep's changed-set filter (`storyline-changed-set.ts`,
 * `storylines.link_dirty_at`).
 *
 * What has to be true here is narrower than "it works": a filter that quietly
 * stops reaching part of the window is WORSE than a slow sweep, because the
 * tally still reads clean. So the tests are mostly about reach — the case where
 * a group should be re-offered, and the marker cases where the obvious
 * implementation would miss it.
 */

const NOW = new Date("2026-08-14T03:00:00.000Z");
const TZ = { timeZone: "UTC" };
const DAY = "2026-08-13";
const YESTERDAY = "2026-08-13T09:00:00.000Z";

let harness: TestHarness;
let db: TestHarness["deps"]["db"];

beforeAll(async () => {
  harness = await createTestHarness({}, NOW);
  db = harness.deps.db;
});

afterAll(async () => {
  await harness.teardown();
});

beforeEach(async () => {
  await sql`
    truncate storylines, storyline_groups, storyline_days, storyline_bridges,
             storyline_formation_refusals, story_token_days, story_corpus_days,
             articles cascade
  `.execute(db);
});

/**
 * Loosened for a corpus of a hundred, as `chores.test.ts` loosens its own: what
 * is under test is which groups the filter REACHES, not the production bar.
 */
const LINKER: LinkerConfig = {
  enabled: true,
  rules: {
    anchorMaxShare: 0.5,
    anchorDfFloor: 4,
    massThreshold: 1,
    dormancyDays: 90,
    dormantStrictness: 1.5,
  },
  mergeBridges: 2,
  coherenceGate: false,
  storyDf: { windowDays: 14, timeZone: "UTC" },
  timeZone: "UTC",
};

const deps = (): ChoreDeps => ({
  db,
  config: {
    retentionDays: 400,
    storyDfWindowDays: 14,
    storylineDormancyDays: 90,
    timeZone: "UTC",
  },
  now: () => NOW,
  log: { info: () => {}, warn: () => {} },
});

let nextArticle = 0;

/** One group, as an article in storage. */
async function group(tokens: string[], publishedAt = YESTERDAY): Promise<string> {
  nextArticle += 1;
  const { rows } = await sql<{ id: string }>`
    insert into articles (
      dedup_key, url, title, description, language, categories, source_category,
      published, latest_seen, sighting_count, story_tokens
    ) values (
      decode(${String(nextArticle).padStart(64, "0")}, 'hex'),
      ${`https://example.test/${nextArticle}`}, ${tokens.join(" ")}, null,
      'en', '{}', '{}', ${publishedAt}, ${publishedAt}, 1, ${tokens}
    ) returning id
  `.execute(db);
  return rows[0]!.id;
}

/** An article inside an existing group — the join the grouping path performs. */
async function joiner(groupId: string, tokens: string[]): Promise<string> {
  const id = await group(tokens);
  await recordGrouping(db, {
    articleId: id,
    titleTokens: tokens,
    storyTokens: tokens,
    tokensVersion: 1,
    groupId,
  });
  return id;
}

async function seedCorpus(tokens: string[]): Promise<void> {
  await db
    .insertInto("story_corpus_days")
    .values({ day: DAY, language: "en", articles: 100 })
    .execute();
  await db
    .insertInto("story_token_days")
    .values(tokens.map((token) => ({ day: DAY, language: "en", token, df: 4 })))
    .execute();
}

const dirtyAt = async (storylineId: string): Promise<Date | null> => {
  const row = await db
    .selectFrom("storylines")
    .select("link_dirty_at")
    .where("id", "=", storylineId)
    .executeTakeFirstOrThrow();
  return row.link_dirty_at as Date | null;
};

const profileOf = async (storylineId: string): Promise<string[]> => {
  const row = await db
    .selectFrom("storylines")
    .select("profile_tokens")
    .where("id", "=", storylineId)
    .executeTakeFirstOrThrow();
  return row.profile_tokens;
};

const changedSet = async () =>
  readChangedSetBatch(
    { db, config: LINKER },
    { publishedFrom: new Date(NOW.getTime() - 14 * 86_400_000), limit: 100 },
  );

describe("what marks an arc as changed", () => {
  it("is membership, not a profile diff — the 1→2 transition that changes nothing visible", async () => {
    // §4's trap. With two member groups the majority rule needs support from
    // ONE, so a token only the newcomer carries — or only the incumbent — still
    // passes, and `profile_tokens` can come out byte-identical. That transition
    // is exactly the one that un-blocks a coherence refusal (`groupCount === 1`
    // is what the linker filters on), so a marker predicated on "the profile
    // tokens diffed" would silently miss the entire refusal-unblocking class.
    const incumbent = await group(["fausto", "hawaii"]);
    const arc = await createProvisionalStoryline(db, { groupId: incumbent, ...TZ });
    expect(await dirtyAt(arc.id)).toBeNull();
    const before = await profileOf(arc.id);

    const newcomer = await group(["fausto"]);
    await attachGroup(db, { storylineId: arc.id, groupId: newcomer, ...TZ });

    expect(await profileOf(arc.id)).toEqual(before);
    expect(await dirtyAt(arc.id)).not.toBeNull();
  });

  it("is NOT a birth — the newborn's own offer just asked the same question", async () => {
    // §1's symmetry: at the newborn group's birth `linkGroup` already retrieved
    // every overlapping live storyline, including every old group's provisional
    // singleton. Marking a birth would re-ask that, measured 69% for nothing.
    const born = await group(["fausto", "hawaii"]);
    const arc = await createProvisionalStoryline(db, { groupId: born, ...TZ });
    expect(await dirtyAt(arc.id)).toBeNull();
    expect((await changedSet()).markers).toEqual([]);
  });

  it("survives a merge, which `attached_at` could not express", async () => {
    // `mergeStorylines` PRESERVES the loser's `attached_at` on re-point, by
    // design — "when a group joined the story is a fact about the group, not
    // about which of two UUIDs won" — so the winner of a merge never appears in
    // `attached_at > $lastRun`. It is the whole reason the marker is a column.
    const first = await group(["fausto", "hawaii"]);
    const second = await group(["fausto", "swell"]);
    const winner = await createProvisionalStoryline(db, { groupId: first, ...TZ });
    const loser = await createProvisionalStoryline(db, { groupId: second, ...TZ });
    await clearStorylineLinkDirty(db, [
      { id: winner.id, dirtyAt: new Date() },
      { id: loser.id, dirtyAt: new Date() },
    ]);

    const attachedBefore = await db
      .selectFrom("storyline_groups")
      .select("attached_at")
      .where("group_id", "=", second)
      .executeTakeFirstOrThrow();

    await mergeStorylines(db, { winnerId: winner.id, loserId: loser.id, ...TZ });

    expect(await dirtyAt(winner.id)).not.toBeNull();
    // The alias keeps no marker: a pointer has no linking decision left.
    expect(await dirtyAt(loser.id)).toBeNull();
    const attachedAfter = await db
      .selectFrom("storyline_groups")
      .select("attached_at")
      .where("group_id", "=", second)
      .executeTakeFirstOrThrow();
    expect(attachedAfter.attached_at).toEqual(attachedBefore.attached_at);
  });

  it("catches an article joining a group, which no storyline-shaped signal carries", async () => {
    const host = await group(["fausto", "hawaii"]);
    const arc = await createProvisionalStoryline(db, { groupId: host, ...TZ });
    await clearStorylineLinkDirty(db, [{ id: arc.id, dirtyAt: new Date() }]);

    await joiner(host, ["fausto", "swell"]);

    expect(await dirtyAt(arc.id)).not.toBeNull();
    // And the group itself travels: a changed arc's member groups are offered
    // alongside whatever its inverse retrieval finds, which is the only way the
    // group whose OWN profile widened reaches the sweep.
    const batch = await changedSet();
    expect(batch.groupIds).toContain(host);
  });
});

describe("paging the changed set", () => {
  it("advances past a batch of arcs marked in one statement", async () => {
    // The bug this exists for: one UPDATE marks every row with the same `now()`,
    // so the whole batch shares a `link_dirty_at` and only the id breaks the
    // tie — and at Postgres's full microsecond precision the marker is strictly
    // GREATER than the millisecond `Date` the driver returns for it, so
    // `(link_dirty_at, id) > ($read, $id)` matches every row and the keyset
    // never moves. It ran forever against the dev archive. `timestamptz(3)`
    // (migration 0017) is the fix, and this is what proves it.
    await seedCorpus(["fausto", "hawaii"]);
    const arcs: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const only = await group(["fausto", "hawaii"]);
      arcs.push((await createProvisionalStoryline(db, { groupId: only, ...TZ })).id);
    }
    await sql`update storylines set link_dirty_at = now()`.execute(db);

    const seen = new Set<string>();
    let after: { dirtyAt: Date; id: string } | undefined;
    for (let page = 0; page < 10; page += 1) {
      const batch = await readChangedSetBatch(
        { db, config: LINKER },
        {
          publishedFrom: new Date(NOW.getTime() - 14 * 86_400_000),
          limit: 2,
          ...(after ? { after } : {}),
        },
      );
      for (const marker of batch.markers) seen.add(marker.id);
      if (batch.next === null) break;
      after = batch.next;
    }
    expect([...seen].sort()).toEqual([...arcs].sort());
  });
});

describe("the clear cannot swallow a newer write", () => {
  it("leaves a marker the pass has not seen", async () => {
    const only = await group(["fausto", "hawaii"]);
    const arc = await createProvisionalStoryline(db, { groupId: only, ...TZ });
    await markStorylinesLinkDirty(db, [arc.id]);
    const read = await dirtyAt(arc.id);

    // A write landing while the pass offered — an attach, a merge, one of the
    // pass's own cascades — moves the marker forward.
    await sql`
      update storylines set link_dirty_at = link_dirty_at + interval '1 second'
      where id = ${arc.id}::uuid
    `.execute(db);

    expect(await clearStorylineLinkDirty(db, [{ id: arc.id, dirtyAt: read! }])).toBe(0);
    expect(await dirtyAt(arc.id)).not.toBeNull();

    // And a marker no newer than the one read IS cleared, or nothing ever drains.
    const moved = await dirtyAt(arc.id);
    expect(await clearStorylineLinkDirty(db, [{ id: arc.id, dirtyAt: moved! }])).toBe(1);
    expect(await dirtyAt(arc.id)).toBeNull();
  });
});

describe("the filter's reach", () => {
  /**
   * The case that must not be lost: an old group that shares nothing with an arc
   * until the arc's profile widens, at which point it should be re-offered and
   * the unfiltered sweep would find it.
   */
  async function widenedArc(): Promise<{ arc: string; old: string }> {
    await seedCorpus(["fausto", "hawaii", "genevieve", "swell"]);
    // The old group: in the window, homed in its own provisional, sharing
    // nothing with the arc below.
    const old = await group(["fausto", "hawaii"]);
    await createProvisionalStoryline(db, { groupId: old, ...TZ });

    const seed = await group(["genevieve", "swell"]);
    const arc = await createProvisionalStoryline(db, { groupId: seed, ...TZ });
    await clearStorylineLinkDirty(db, [{ id: arc.id, dirtyAt: new Date() }]);
    expect(await profileOf(arc.id)).toEqual(["genevieve", "swell"]);

    // Nothing overlaps yet, so the arc names no old group even when asked.
    await markStorylinesLinkDirty(db, [arc.id]);
    expect((await changedSet()).groupIds).not.toContain(old);
    await clearStorylineLinkDirty(db, [{ id: arc.id, dirtyAt: new Date() }]);

    // The widening: a second group carrying the old group's vocabulary. With two
    // members the majority needs one, so the profile becomes the union.
    const widener = await group(["fausto", "hawaii", "genevieve", "swell"]);
    await attachGroup(db, { storylineId: arc.id, groupId: widener, ...TZ });
    await promoteStoryline(db, { storylineId: arc.id });
    expect(await profileOf(arc.id)).toEqual(["fausto", "genevieve", "hawaii", "swell"]);

    return { arc: arc.id, old };
  }

  it("reaches an old group the widened arc could now take", async () => {
    const { arc, old } = await widenedArc();

    const batch = await changedSet();
    expect(batch.markers.map((marker) => marker.id)).toEqual([arc]);
    expect(batch.groupIds).toContain(old);
  });

  it("attaches it, and the unfiltered sweep reaches exactly the same verdict", async () => {
    const { arc, old } = await widenedArc();
    // A window group with nothing to do with any of this: the unfiltered pass
    // offers it and the filter does not, which is the whole point of the filter.
    const bystander = await group(["ferry", "storm"]);
    await createProvisionalStoryline(db, { groupId: bystander, ...TZ });

    const narrow = await runLateCandidateChore({
      ...deps(),
      linker: LINKER,
      changedOnly: true,
    });
    expect(narrow.changedArcs).toBe(1);
    expect(narrow.offered).toBe(3);
    expect(await readGroupStorylines(db, old)).toContain(arc);

    // The equivalence that makes the narrowing safe: the same offer, from the
    // unfiltered pass, on a database where it has not happened yet.
    await sql`
      delete from storyline_groups
      where group_id = ${old}::bigint and storyline_id = ${arc}::uuid
    `.execute(db);
    const full = await runLateCandidateChore({ ...deps(), linker: LINKER });
    expect(full.offered).toBeGreaterThan(narrow.offered);
    expect(await readGroupStorylines(db, old)).toContain(arc);
  });

  it("reaches a group whose own fortnight disagrees with the arc's about what is rare", async () => {
    // The measurement that decided the filter's shape, as a test. `df` and `N`
    // are properties of a WINDOW, and the inverse retrieval stands in the arc's
    // window while `linkGroup` will stand in the group's. `pruneStoryDf` makes
    // them differ by an order of magnitude: an old group's window is mostly gone.
    //
    // Here the old group's window holds 100 articles, so its anchor ceiling
    // floors out at 10 and its shared tokens have df 4 — rare, mass 22.5, it
    // qualifies. The arc's window holds 10,100 and the SAME tokens have df 904:
    // ceiling 20.2, not one of them anchor-eligible. A filter that pushed the
    // anchor or the mass floor into SQL would name nothing here and the group
    // would never be re-offered. Measured over 400 real groups, that form
    // reached 38.9% of the forward decision's pairs.
    const PRODUCTION: LinkerConfig = {
      ...LINKER,
      rules: { ...LINKER.rules, anchorMaxShare: 0.002, anchorDfFloor: 10, massThreshold: 20 },
    };
    const SHARED = ["fausto", "hawaii", "swell", "surf", "genevieve", "kona", "hilo"];
    const OLD_DAY = "2026-08-01";
    const OLD = "2026-08-01T09:00:00.000Z";

    await db
      .insertInto("story_corpus_days")
      .values([
        { day: OLD_DAY, language: "en", articles: 100 },
        { day: DAY, language: "en", articles: 10_000 },
      ])
      .execute();
    await db
      .insertInto("story_token_days")
      .values([
        ...SHARED.map((token) => ({ day: OLD_DAY, language: "en", token, df: 4 })),
        ...SHARED.map((token) => ({ day: DAY, language: "en", token, df: 900 })),
      ])
      .execute();

    const old = await group(SHARED, OLD);
    await createProvisionalStoryline(db, { groupId: old, ...TZ });

    // A two-group arc whose coverage is recent, so it reads the wide window.
    const seed = await group(SHARED);
    const arc = await createProvisionalStoryline(db, { groupId: seed, ...TZ });
    await attachGroup(db, { storylineId: arc.id, groupId: await group(SHARED), ...TZ });
    await promoteStoryline(db, { storylineId: arc.id });

    const batch = await readChangedSetBatch(
      { db, config: PRODUCTION },
      { publishedFrom: new Date(NOW.getTime() - 14 * 86_400_000), limit: 100 },
    );
    expect(batch.groupIds).toContain(old);

    // And the offer the filter enables is one the real decision acts on.
    await runLateCandidateChore({ ...deps(), linker: PRODUCTION, changedOnly: true });
    expect(await readGroupStorylines(db, old)).toContain(arc.id);
  });

  it("offers a group once however many changed arcs named it", async () => {
    // The changed set is deduped within a batch of arcs; across batches it is
    // not, and the same group is named by every arc it overlaps. One arc per
    // batch here, all naming the same member group.
    await seedCorpus(["fausto", "hawaii"]);
    const shared = await group(["fausto", "hawaii"]);
    for (let i = 0; i < 3; i += 1) {
      const arc = await createProvisionalStoryline(db, { groupId: await group(["fausto"]), ...TZ });
      await attachGroup(db, { storylineId: arc.id, groupId: shared, ...TZ });
    }
    const arcs = await readLinkDirtyStorylines(db, { limit: 10 });
    expect(arcs.length).toBeGreaterThanOrEqual(3);

    const report = await runLateCandidateChore({
      ...deps(),
      linker: LINKER,
      changedOnly: true,
      batchSize: 1,
    });
    // Every group in the archive, offered at most once — not once per arc that
    // named it.
    const groups = await sql<{ n: string }>`
      select count(distinct group_id) n from articles
    `.execute(db);
    expect(report.offered).toBeLessThanOrEqual(Number(groups.rows[0]!.n));
  });

  it("keeps a batch's markers when maxGroups cut it short", async () => {
    // The one failure mode a changed-set filter must not have. Markers are
    // per-arc and offers are the union over the batch, so a ceiling that stops
    // mid-batch leaves no way to say which arc an un-offered group came from —
    // clearing anyway would retire questions the pass never asked, and the tally
    // would read clean either way.
    await widenedArc();
    const dirtyBefore = await readLinkDirtyStorylines(db, { limit: 100 });
    expect(dirtyBefore.length).toBeGreaterThan(0);

    const report = await runLateCandidateChore({
      ...deps(),
      linker: LINKER,
      changedOnly: true,
      maxGroups: 1,
    });
    expect(report.offered).toBe(1);
    const dirtyAfter = await readLinkDirtyStorylines(db, { limit: 100 });
    expect(dirtyAfter.map((arc) => arc.id).sort()).toEqual(
      dirtyBefore.map((arc) => arc.id).sort(),
    );
  });

  it("offers nothing when nothing changed, and says so", async () => {
    await seedCorpus(["fausto", "hawaii"]);
    const only = await group(["fausto", "hawaii"]);
    await createProvisionalStoryline(db, { groupId: only, ...TZ });
    await sql`update storylines set link_dirty_at = null`.execute(db);

    const report = await runLateCandidateChore({
      ...deps(),
      linker: LINKER,
      changedOnly: true,
    });
    // `changedArcs` in the tally is what distinguishes "nothing changed" from
    // "the filter is broken" — an offered count of zero reads clean either way.
    expect(report).toMatchObject({ offered: 0, changedArcs: 0, failures: 0 });
  });

  it("drains its markers, so an unchanged night is idempotent", async () => {
    const { old } = await widenedArc();

    await runLateCandidateChore({ ...deps(), linker: LINKER, changedOnly: true });
    const second = await runLateCandidateChore({
      ...deps(),
      linker: LINKER,
      changedOnly: true,
    });

    // The attach the first pass performed re-marked its arc, which is correct —
    // a changed arc is a new question. What must not happen is the queue never
    // emptying: the second pass finds only what the first pass's writes marked,
    // and a third finds less again.
    const third = await runLateCandidateChore({
      ...deps(),
      linker: LINKER,
      changedOnly: true,
    });
    expect(third.changedArcs).toBeLessThanOrEqual(second.changedArcs);
    // The old group left its own provisional for the arc by merge-with-alias —
    // the fresh path's move, reached late. One home, and it is the arc.
    expect(await readGroupStorylines(db, old)).toHaveLength(1);
  });
});

describe("a withheld formation keeps travelling", () => {
  it("re-marks its own arc, because a withhold writes nothing to mark", async () => {
    // The one class with no state at all: both groups keep their provisional
    // singletons, `attachedTo` and `merged` are both empty, and the only carrier
    // is the in-memory outcome. Nothing marked anything — so if the pass cleared
    // the marker it read and moved on, the pair would drop out of the changed
    // set for good, and `runLateCandidateChore`'s own comment says that is the
    // one thing it may not do.
    await seedCorpus(["fausto", "hawaii"]);
    const first = await group(["fausto", "hawaii"]);
    const second = await group(["fausto", "hawaii"]);
    await createProvisionalStoryline(db, { groupId: first, ...TZ });
    const partner = await createProvisionalStoryline(db, { groupId: second, ...TZ });
    await markStorylinesLinkDirty(db, [partner.id]);

    const report = await runLateCandidateChore({
      ...deps(),
      linker: { ...LINKER, coherenceGate: true },
      changedOnly: true,
    });

    // Withheld: nothing attached, nothing merged.
    expect(report).toMatchObject({ attachedTo: 0, merges: 0, failures: 0 });
    expect(await readGroupStorylines(db, first)).toHaveLength(1);
    // And the markers are back, so the next pass asks again.
    const dirty = await readLinkDirtyStorylines(db, { limit: 10 });
    expect(dirty.length).toBeGreaterThan(0);
  });
});
