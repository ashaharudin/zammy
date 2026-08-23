import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateToLatest } from "./migrator.js";
import {
  attachGroup,
  countBridges,
  createProvisionalStoryline,
  dissolveFormation,
  mergeStorylines,
  recordBridge,
  promoteStoryline,
  readGroupStorylines,
  readStoryline,
  readStorylineDays,
  readStorylineStats,
  refreshStoryline,
  resolveStoryline,
  setStorylineLabel,
  setStorylineStatus,
  type StorylineStats,
} from "./storylines.js";
import { createTestDatabase, type TestDatabase } from "./test-support.js";

/**
 * The storage half of storylines v2 (ADR-0011). Judgement — which group belongs
 * to which storyline — lives in the linker; what is tested here is the
 * persistence contract it stands on:
 *
 *   a merge re-points membership and leaves an alias  (nothing dangles)
 *   an alias chain resolves to the surviving UUID     (a stale link still works)
 *   day slots track membership across attach and merge (the keyset stays true)
 *   the profile is the member groups' MAJORITY        (the percolation damper)
 *
 * Real Postgres, because every one of those is SQL: a recursive alias walk, a
 * timezone-bucketed DISTINCT ON, and a count over distinct (group, token) pairs.
 * A fake would fake all three, and the timezone one especially — the day key is
 * an APP_TIMEZONE day, so a UTC-thinking fake agrees with production for
 * sixteen hours out of twenty-four.
 */

// Deliberately not UTC: under this zone a 05:00Z article belongs to the PREVIOUS
// calendar day, which is exactly the bucketing bug a UTC test cannot see.
const ZONE = "America/Vancouver";

let counter = 0;

describe("storylines in storage", () => {
  let harness: TestDatabase;

  /**
   * An article in a given group, with the story tokens the profile derives from.
   * Inserted directly rather than through ingest: these tests are about what the
   * storyline tables do with a membership, and building one through the real
   * grouping path would make the fixture the subject.
   */
  const article = async (input: {
    published: string;
    storyTokens: string[];
    /** Omit to leave it a group of one — the trigger seeds it to its own id. */
    groupId?: string;
  }): Promise<string> => {
    counter += 1;
    const row = await harness.db
      .insertInto("articles")
      .values({
        dedup_key: randomBytes(32),
        url: `https://fixture.example/${counter}`,
        title: `Fixture ${counter}`,
        description: null,
        author: null,
        image_url: null,
        language: "en",
        categories: [],
        source_category: [],
        source_domain: "fixture.example",
        published: new Date(input.published),
        latest_seen: new Date(input.published),
        sighting_count: 1,
        story_tokens: input.storyTokens,
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

  /** A group of one article, returning the group id (which is the article id). */
  const group = async (published: string, storyTokens: string[]): Promise<string> =>
    article({ published, storyTokens });

  const days = async (storylineId: string) =>
    (await readStorylineDays(harness.db, storylineId)).map((day) => ({
      dayKey: day.dayKey,
      published: day.daySlotPublished.toISOString(),
      lead: day.leadArticleId,
    }));

  const profile = async (storylineId: string) =>
    (await readStoryline(harness.db, storylineId))?.profileTokens;

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("births a provisional storyline of one, with the group's own vocabulary", async () => {
    // Every new group seeds one (ADR-0011's Lifecycle), and a storyline of one
    // is majority-supported by definition: its only group carries everything.
    const groupId = await group("2026-08-11T18:00:00.000Z", ["fort", "hood", "crash"]);
    const storyline = await createProvisionalStoryline(harness.db, { groupId, timeZone: ZONE });

    expect(storyline.status).toBe("provisional");
    expect(storyline.label).toBeNull();
    expect(storyline.mergedInto).toBeNull();
    expect(storyline.profileTokens).toEqual(["crash", "fort", "hood"]);
    expect(await readGroupStorylines(harness.db, groupId)).toEqual([storyline.id]);
    expect(await days(storyline.id)).toEqual([
      { dayKey: "2026-08-11", published: "2026-08-11T18:00:00.000Z", lead: groupId },
    ]);
  });

  it("buckets a day slot by APP_TIMEZONE, not UTC", async () => {
    // 05:00Z on the 12th is 22:00 on the 11th in Vancouver. Getting this wrong
    // splits one evening's coverage across two slots — and the reader sees the
    // same story twice on days it never had twice.
    const groupId = await group("2026-08-12T05:00:00.000Z", ["harbour", "spill"]);
    const storyline = await createProvisionalStoryline(harness.db, { groupId, timeZone: ZONE });

    expect((await days(storyline.id)).map((day) => day.dayKey)).toEqual(["2026-08-11"]);
  });

  it("takes one fresh slot per day of coverage, led by that day's earliest", async () => {
    // The heart of ADR-0011's timeline: a storyline unbounded in time still
    // never spans a slot across days, so keyset paging survives unchanged.
    const monday = await group("2026-08-10T14:00:00.000Z", ["fort", "hood", "crash"]);
    const storyline = await createProvisionalStoryline(harness.db, {
      groupId: monday,
      timeZone: ZONE,
    });

    const tuesday = await group("2026-08-11T20:00:00.000Z", ["fort", "hood", "survivor"]);
    const tuesdayLate = await article({
      published: "2026-08-11T22:00:00.000Z",
      storyTokens: ["fort", "hood", "survivor"],
      groupId: tuesday,
    });
    await attachGroup(harness.db, { storylineId: storyline.id, groupId: tuesday, timeZone: ZONE });

    expect(await days(storyline.id)).toEqual([
      { dayKey: "2026-08-11", published: "2026-08-11T20:00:00.000Z", lead: tuesday },
      { dayKey: "2026-08-10", published: "2026-08-10T14:00:00.000Z", lead: monday },
    ]);
    expect(tuesdayLate).not.toEqual(tuesday);
  });

  it("re-derives the profile as the member groups' majority", async () => {
    // The rule that silenced live-blog vocabulary, promoted one level: a token
    // one group of four carries is that group's word, not the storyline's.
    const first = await group("2026-08-10T09:00:00.000Z", ["mars", "lander", "touchdown"]);
    const storyline = await createProvisionalStoryline(harness.db, {
      groupId: first,
      timeZone: ZONE,
    });
    const second = await group("2026-08-10T10:00:00.000Z", ["mars", "lander", "photos"]);
    await attachGroup(harness.db, { storylineId: storyline.id, groupId: second, timeZone: ZONE });

    // Two groups: one group IS half, so the profile is their union. A young
    // storyline is deliberately the permissive case — it has nothing to be a
    // consensus about yet, and it is a growing one that must tighten.
    expect(await profile(storyline.id)).toEqual([
      "lander",
      "mars",
      "photos",
      "touchdown",
    ]);

    const third = await group("2026-08-10T11:00:00.000Z", ["mars", "lander", "reaction"]);
    await attachGroup(harness.db, { storylineId: storyline.id, groupId: third, timeZone: ZONE });

    // Three groups, and the profile TIGHTENS rather than accumulating: "mars"
    // and "lander" are in all three, the rest are one group's words each. That
    // direction is the percolation damper — a swallowing storyline's vocabulary
    // narrows, so it gets harder to join, not easier.
    expect(await profile(storyline.id)).toEqual(["lander", "mars"]);
  });

  it("counts a group once however syndicated", async () => {
    // Support is per GROUP, not per article: forty wire copies of one story are
    // one vote, or the loudest syndication would write the profile alone.
    const wide = await group("2026-08-10T09:00:00.000Z", ["kyoto", "summit"]);
    const storyline = await createProvisionalStoryline(harness.db, {
      groupId: wide,
      timeZone: ZONE,
    });
    const narrow = await group("2026-08-10T10:00:00.000Z", ["kyoto", "protest"]);
    const third = await group("2026-08-10T11:00:00.000Z", ["kyoto", "delegates"]);
    for (const groupId of [narrow, third]) {
      await attachGroup(harness.db, { storylineId: storyline.id, groupId, timeZone: ZONE });
    }

    for (let copy = 0; copy < 5; copy += 1) {
      await article({
        published: "2026-08-10T09:30:00.000Z",
        storyTokens: ["kyoto", "summit", "communique"],
        groupId: wide,
      });
    }
    await refreshStoryline(harness.db, { storylineId: storyline.id, timeZone: ZONE });

    // "summit" and "communique" stay one group's words even after six articles
    // carry them; only "kyoto", carried by all three groups, is the storyline's.
    expect(await profile(storyline.id)).toEqual(["kyoto"]);
  });

  it("attaches idempotently, and lets a group sit in two storylines", async () => {
    // Duplication is accepted, not repaired (ADR-0011): the group appears in
    // both storylines' slots that day, and "primary storyline" has no
    // principled definition to choose between them.
    const shared = await group("2026-08-11T12:00:00.000Z", ["arctic", "convoy"]);
    const one = await createProvisionalStoryline(harness.db, { groupId: shared, timeZone: ZONE });
    const otherGroup = await group("2026-08-11T13:00:00.000Z", ["arctic", "ice"]);
    const two = await createProvisionalStoryline(harness.db, {
      groupId: otherGroup,
      timeZone: ZONE,
    });

    const first = await attachGroup(harness.db, {
      storylineId: two.id,
      groupId: shared,
      timeZone: ZONE,
    });
    const replay = await attachGroup(harness.db, {
      storylineId: two.id,
      groupId: shared,
      timeZone: ZONE,
    });

    expect(first.attached).toBe(true);
    expect(replay.attached).toBe(false);
    expect(await readGroupStorylines(harness.db, shared)).toEqual([one.id, two.id]);
    // Both storylines hold that day, and the earlier article leads both.
    expect((await days(two.id)).map((day) => day.lead)).toEqual([shared]);
    expect((await days(one.id)).map((day) => day.lead)).toEqual([shared]);
  });

  it("promotes, labels, and moves between active and dormant", async () => {
    const groupId = await group("2026-08-11T08:00:00.000Z", ["delta", "flood"]);
    const storyline = await createProvisionalStoryline(harness.db, { groupId, timeZone: ZONE });

    await promoteStoryline(harness.db, { storylineId: storyline.id });
    const labelAt = new Date("2026-08-11T08:05:00.000Z");
    await setStorylineLabel(harness.db, {
      storylineId: storyline.id,
      label: "Delta Flood",
      // What `labelWords` (apps/api) would fold this label to. Spelled out
      // rather than imported: storage cannot reach the fold, and inventing a
      // second one here is the exact duplication `label_words` exists to
      // prevent. Safe for these fixtures because their labels are plain ASCII
      // words with no plural, possessive or punctuation, where the fold is just
      // the lowercase split; the fold itself is pinned in apps/api.
      labelWords: ["delta", "flood"],
      labelAt,
      // The drift baseline and the provenance. One member group here, and
      // "test" for the source, as every other suite spells it. Both were
      // omitted until the tests were type-checked (§12), which wrote the
      // baseline this label would later be measured against as nothing.
      labelGroupCount: 1,
      labelSource: "test",
    });
    expect(await readStoryline(harness.db, storyline.id)).toMatchObject({
      status: "active",
      label: "Delta Flood",
      labelAt,
    });

    // Nothing ends a storyline: dormancy is reversible, and the label survives
    // it — a story matched fourteen months later is the same story.
    await setStorylineStatus(harness.db, { storylineId: storyline.id, status: "dormant" });
    expect((await readStoryline(harness.db, storyline.id))?.status).toBe("dormant");
    await setStorylineStatus(harness.db, { storylineId: storyline.id, status: "active" });
    expect(await readStoryline(harness.db, storyline.id)).toMatchObject({
      status: "active",
      label: "Delta Flood",
    });
  });

  describe("merge", () => {
    it("re-points membership, rewrites day slots, and leaves an alias", async () => {
      const winnerGroup = await group("2026-08-09T15:00:00.000Z", ["reef", "bleaching"]);
      const winner = await createProvisionalStoryline(harness.db, {
        groupId: winnerGroup,
        timeZone: ZONE,
      });
      // The loser covers a day the winner does not, and shares one it does —
      // both directions of the day-slot rewrite in one merge.
      const loserGroup = await group("2026-08-09T09:00:00.000Z", ["reef", "survey"]);
      const loser = await createProvisionalStoryline(harness.db, {
        groupId: loserGroup,
        timeZone: ZONE,
      });
      const loserLater = await group("2026-08-12T09:00:00.000Z", ["reef", "survey", "results"]);
      await attachGroup(harness.db, {
        storylineId: loser.id,
        groupId: loserLater,
        timeZone: ZONE,
      });

      const result = await mergeStorylines(harness.db, {
        winnerId: winner.id,
        loserId: loser.id,
        timeZone: ZONE,
      });

      expect(result).toEqual({ merged: true, winnerId: winner.id, repointed: [] });
      // Every one of the loser's groups is now the winner's, and none of them
      // is left pointing at a UUID that no longer holds members.
      expect(await readGroupStorylines(harness.db, loserGroup)).toEqual([winner.id]);
      expect(await readGroupStorylines(harness.db, loserLater)).toEqual([winner.id]);
      expect(await days(loser.id)).toEqual([]);
      expect(await days(winner.id)).toEqual([
        { dayKey: "2026-08-12", published: "2026-08-12T09:00:00.000Z", lead: loserLater },
        // The shared day takes the EARLIER article as its lead: the loser's
        // 09:00 outranks the winner's 15:00 the moment they become one story.
        { dayKey: "2026-08-09", published: "2026-08-09T09:00:00.000Z", lead: loserGroup },
      ]);

      const alias = await readStoryline(harness.db, loser.id);
      expect(alias?.mergedInto).toBe(winner.id);
      // An alias is a pointer, not a candidate: an empty profile means it cannot
      // be retrieved even by a caller that forgets the merged_into filter.
      expect(alias?.profileTokens).toEqual([]);
      // Three groups now, so a token needs two of them: "reef" from all three
      // and "survey" from the loser's pair survive, the two singletons do not.
      expect(await profile(winner.id)).toEqual(["reef", "survey"]);
    });

    it("reports the third storylines whose bridges it re-pointed", async () => {
      // The fact the linker's K check could not see. A merge moves the loser's
      // bridges onto the winner, so a pair can reach K with no bridge ever being
      // inserted for it — and the check fires on the insert. Storage does not
      // know what K is, so it reports WHICH pairs changed and the caller re-asks.
      const arc = async (tokens: string[]): Promise<string> => {
        const groupId = await group("2026-08-11T09:00:00.000Z", tokens);
        const born = await createProvisionalStoryline(harness.db, { groupId, timeZone: ZONE });
        await promoteStoryline(harness.db, { storylineId: born.id });
        return born.id;
      };
      const winner = await arc(["reef", "survey"]);
      const loser = await arc(["quarry", "fire"]);
      const third = await arc(["tanker", "strait"]);
      const fourth = await arc(["eclipse", "solar"]);

      const bridgeGroup = await group("2026-08-11T10:00:00.000Z", ["bridge"]);
      const otherGroup = await group("2026-08-11T11:00:00.000Z", ["other"]);
      // The loser is bridged to a third arc, and to the WINNER itself.
      await recordBridge(harness.db, {
        storylineA: loser,
        storylineB: third,
        groupId: bridgeGroup,
      });
      await recordBridge(harness.db, {
        storylineA: loser,
        storylineB: winner,
        groupId: otherGroup,
      });

      const result = await mergeStorylines(harness.db, {
        winnerId: winner,
        loserId: loser,
        timeZone: ZONE,
      });

      // The third arc is reported; the winner is not — a pair that is now one
      // storyline has nothing left to bridge. An arc the loser never met is
      // absent entirely.
      expect(result.merged).toBe(true);
      expect(result.repointed).toEqual([third]);
      expect(result.repointed).not.toContain(winner);
      expect(result.repointed).not.toContain(fourth);
      // And the evidence really did move: the survivor now carries it.
      expect(await countBridges(harness.db, { storylineA: winner, storylineB: third })).toBe(1);
      expect(await countBridges(harness.db, { storylineA: loser, storylineB: third })).toBe(0);
    });

    it("records a bridge under the RESOLVED pair, and says which pair that was", async () => {
      // The caller holds the ids it retrieved candidates under; a merge can have
      // turned one into an alias since. Returning the pair actually written is
      // what stops the caller counting under a stale id and reading zero.
      const first = await group("2026-08-11T09:00:00.000Z", ["reef"]);
      const second = await group("2026-08-11T09:30:00.000Z", ["quarry"]);
      const third = await group("2026-08-11T10:00:00.000Z", ["tanker"]);
      const a = await createProvisionalStoryline(harness.db, { groupId: first, timeZone: ZONE });
      const b = await createProvisionalStoryline(harness.db, { groupId: second, timeZone: ZONE });
      const c = await createProvisionalStoryline(harness.db, { groupId: third, timeZone: ZONE });
      await mergeStorylines(harness.db, { winnerId: a.id, loserId: b.id, timeZone: ZONE });

      const bridgeGroup = await group("2026-08-11T11:00:00.000Z", ["bridge"]);
      // Bridging the ALIAS: it must land on the survivor's pair.
      const recorded = await recordBridge(harness.db, {
        storylineA: b.id,
        storylineB: c.id,
        groupId: bridgeGroup,
      });

      expect(recorded.recorded).toBe(true);
      expect(recorded.pair).toEqual(a.id < c.id ? [a.id, c.id] : [c.id, a.id]);
      expect(await countBridges(harness.db, { storylineA: a.id, storylineB: c.id })).toBe(1);
    });

    it("wakes a dormant winner for a live loser, and not for a dormant one", async () => {
      // "Active again when it EARNS coverage" (ADR-0011): a fresh birth merging
      // in is coverage earned; two quiet arcs healed by K bridges earn nothing,
      // and waking would hide the dormant marker on exactly the stale story it
      // exists to explain.
      const dormantStoryline = async (tokens: string[]): Promise<string> => {
        const groupId = await group("2026-03-02T09:00:00.000Z", tokens);
        const born = await createProvisionalStoryline(harness.db, { groupId, timeZone: ZONE });
        await promoteStoryline(harness.db, { storylineId: born.id });
        await setStorylineStatus(harness.db, { storylineId: born.id, status: "dormant" });
        return born.id;
      };

      const wokenBy = await group("2026-08-11T09:00:00.000Z", ["glacier", "melt"]);
      const birth = await createProvisionalStoryline(harness.db, {
        groupId: wokenBy,
        timeZone: ZONE,
      });
      const woken = await dormantStoryline(["glacier", "retreat"]);
      await mergeStorylines(harness.db, { winnerId: woken, loserId: birth.id, timeZone: ZONE });
      expect((await readStoryline(harness.db, woken))?.status).toBe("active");

      const stillQuiet = await dormantStoryline(["aquifer", "survey"]);
      const quietLoser = await dormantStoryline(["aquifer", "levels"]);
      await mergeStorylines(harness.db, {
        winnerId: stillQuiet,
        loserId: quietLoser,
        timeZone: ZONE,
      });
      expect((await readStoryline(harness.db, stillQuiet))?.status).toBe("dormant");
    });

    it("resolves a chain of aliases to the surviving storyline", async () => {
      // A reader's open URL holds the UUID it was given. Two merges later that
      // UUID must still open the story it named, however long the chain.
      const groupA = await group("2026-08-11T09:00:00.000Z", ["orbit", "debris"]);
      const groupB = await group("2026-08-11T10:00:00.000Z", ["orbit", "debris"]);
      const groupC = await group("2026-08-11T11:00:00.000Z", ["orbit", "debris"]);
      const [a, b, c] = await Promise.all(
        [groupA, groupB, groupC].map((groupId) =>
          createProvisionalStoryline(harness.db, { groupId, timeZone: ZONE }),
        ),
      );

      await mergeStorylines(harness.db, { winnerId: b!.id, loserId: c!.id, timeZone: ZONE });
      await mergeStorylines(harness.db, { winnerId: a!.id, loserId: b!.id, timeZone: ZONE });

      expect(await resolveStoryline(harness.db, c!.id)).toBe(a!.id);
      expect(await resolveStoryline(harness.db, b!.id)).toBe(a!.id);
      expect(await resolveStoryline(harness.db, a!.id)).toBe(a!.id);
      // Flattened on the way, so the common case stays one hop.
      expect((await readStoryline(harness.db, c!.id))?.mergedInto).toBe(a!.id);
    });

    it("attaches through an alias to the surviving storyline", async () => {
      // The linker may hold a UUID from before a merge — a retroactive
      // attachment is by definition a decision made against an older view.
      const winnerGroup = await group("2026-08-11T09:00:00.000Z", ["levee", "breach"]);
      const winner = await createProvisionalStoryline(harness.db, {
        groupId: winnerGroup,
        timeZone: ZONE,
      });
      const loserGroup = await group("2026-08-11T10:00:00.000Z", ["levee", "repair"]);
      const loser = await createProvisionalStoryline(harness.db, {
        groupId: loserGroup,
        timeZone: ZONE,
      });
      await mergeStorylines(harness.db, {
        winnerId: winner.id,
        loserId: loser.id,
        timeZone: ZONE,
      });

      const late = await group("2026-08-13T10:00:00.000Z", ["levee", "inquiry"]);
      await attachGroup(harness.db, { storylineId: loser.id, groupId: late, timeZone: ZONE });

      expect(await readGroupStorylines(harness.db, late)).toEqual([winner.id]);
      expect((await days(winner.id)).map((day) => day.dayKey)).toEqual([
        "2026-08-13",
        "2026-08-11",
      ]);
    });

    it("is a no-op when both sides already resolve to one storyline", async () => {
      // Replayed merges are routine — the backfill re-runs the linker over
      // history — and a self-merge would build a cycle no resolver could walk.
      const groupA = await group("2026-08-11T09:00:00.000Z", ["tunnel", "collapse"]);
      const groupB = await group("2026-08-11T10:00:00.000Z", ["tunnel", "rescue"]);
      const a = await createProvisionalStoryline(harness.db, {
        groupId: groupA,
        timeZone: ZONE,
      });
      const b = await createProvisionalStoryline(harness.db, {
        groupId: groupB,
        timeZone: ZONE,
      });
      await mergeStorylines(harness.db, { winnerId: a.id, loserId: b.id, timeZone: ZONE });

      const replay = await mergeStorylines(harness.db, {
        winnerId: a.id,
        loserId: b.id,
        timeZone: ZONE,
      });
      // And the reverse: the loser's UUID nominated as winner resolves back to
      // the same storyline rather than un-merging it.
      const reversed = await mergeStorylines(harness.db, {
        winnerId: b.id,
        loserId: a.id,
        timeZone: ZONE,
      });

      expect(replay).toEqual({ merged: false, winnerId: a.id, repointed: [] });
      expect(reversed).toEqual({ merged: false, winnerId: a.id, repointed: [] });
      expect(await readGroupStorylines(harness.db, groupB)).toEqual([a.id]);
    });

    it("survives two concurrent merges of the same pair in opposite directions", async () => {
      // The ingest cascade and the nightly sweeps can nominate the same pair at
      // the same moment with opposite winners. Un-serialized, both resolve
      // against pre-merge state and both commit, writing merged_into on BOTH
      // rows — a cycle every `merged_into is null` read excludes, so the
      // storyline vanishes. The advisory lock in mergeStorylines makes the
      // second merge resolve after the first commits and no-op.
      const groupA = await group("2026-08-12T09:00:00.000Z", ["dam", "breach"]);
      const groupB = await group("2026-08-12T10:00:00.000Z", ["dam", "evacuation"]);
      const a = await createProvisionalStoryline(harness.db, {
        groupId: groupA,
        timeZone: ZONE,
      });
      const b = await createProvisionalStoryline(harness.db, {
        groupId: groupB,
        timeZone: ZONE,
      });

      const [forward, backward] = await Promise.all([
        mergeStorylines(harness.db, { winnerId: a.id, loserId: b.id, timeZone: ZONE }),
        mergeStorylines(harness.db, { winnerId: b.id, loserId: a.id, timeZone: ZONE }),
      ]);

      // Exactly one direction wins; the other arrives late and no-ops.
      expect([forward.merged, backward.merged].filter(Boolean)).toHaveLength(1);
      // Both callers were told the same survivor, and it is still readable.
      expect(forward.winnerId).toBe(backward.winnerId);
      const survivor = await resolveStoryline(harness.db, forward.winnerId!);
      expect(survivor).not.toBeNull();
      expect(await resolveStoryline(harness.db, a.id)).toBe(survivor);
      expect(await resolveStoryline(harness.db, b.id)).toBe(survivor);
      // One row survives un-merged; the other aliases to it. Never a cycle.
      const rows = await harness.db
        .selectFrom("storylines")
        .select(["id", "merged_into"])
        .where("id", "in", [a.id, b.id])
        .execute();
      expect(rows.filter((row) => row.merged_into === null)).toHaveLength(1);
    });

    it("refuses a merge naming a storyline this database never held", async () => {
      const groupId = await group("2026-08-11T09:00:00.000Z", ["quarry", "fire"]);
      const real = await createProvisionalStoryline(harness.db, { groupId, timeZone: ZONE });
      const stale = "00000000-0000-4000-8000-000000000000";

      expect(await resolveStoryline(harness.db, stale)).toBeNull();
      expect(
        await mergeStorylines(harness.db, {
          winnerId: real.id,
          loserId: stale,
          timeZone: ZONE,
        }),
      ).toEqual({ merged: false, winnerId: real.id, repointed: [] });
    });
  });

  it("takes a storyline's joins and day slots with it if it is ever deleted", async () => {
    // Nothing in the product deletes a storyline — merges alias instead. The
    // cascade is here so retention or a repair script cannot leave joins and
    // slots pointing at a UUID with no row.
    const groupId = await group("2026-08-11T09:00:00.000Z", ["ferry", "grounding"]);
    const storyline = await createProvisionalStoryline(harness.db, { groupId, timeZone: ZONE });

    await harness.db.deleteFrom("storylines").where("id", "=", storyline.id).execute();

    const { rows } = await sql<{ joins: string; slots: string }>`
      select
        (select count(*) from storyline_groups where storyline_id = ${storyline.id}::uuid) as joins,
        (select count(*) from storyline_days   where storyline_id = ${storyline.id}::uuid) as slots
    `.execute(harness.db);
    expect(rows[0]).toEqual({ joins: "0", slots: "0" });
  });

  describe("dissolve — the inverse of ONE formation", () => {
    /** Two singleton groups merged into a storyline, as a formation leaves them. */
    const formed = async () => {
      const keptGroup = await group("2026-08-09T15:00:00.000Z", ["fatally", "shot", "lounge"]);
      const kept = await createProvisionalStoryline(harness.db, {
        groupId: keptGroup,
        timeZone: ZONE,
      });
      const leavingGroup = await group("2026-08-12T09:00:00.000Z", ["fatally", "shot", "ice"]);
      const leaving = await createProvisionalStoryline(harness.db, {
        groupId: leavingGroup,
        timeZone: ZONE,
      });
      await mergeStorylines(harness.db, {
        winnerId: kept.id,
        loserId: leaving.id,
        timeZone: ZONE,
      });
      await promoteStoryline(harness.db, { storylineId: kept.id });
      await setStorylineLabel(harness.db, {
        storylineId: kept.id,
        label: "Fatally Shot",
        labelWords: ["fatally", "shot"],
        labelAt: new Date("2026-08-13T00:00:00.000Z"),
        labelGroupCount: 2,
        labelSource: "bigram",
      });
      return { kept: kept.id, keptGroup, leaving: leaving.id, leavingGroup };
    };

    it("REVIVES the departing group's original UUID rather than minting one", async () => {
      // ADR-0011's requirement is that a held UUID never dangle. Reviving the
      // alias satisfies it more completely than a fresh row: the link a reader
      // has now names the one story it really covers.
      const { kept, leaving, leavingGroup } = await formed();
      expect(await resolveStoryline(harness.db, leaving)).toBe(kept);

      const result = await dissolveFormation(harness.db, {
        storylineId: kept,
        groupId: leavingGroup,
        timeZone: ZONE,
      });

      expect(result).toMatchObject({
        dissolved: true,
        freedStorylineId: leaving,
        revivedAlias: true,
      });
      expect(await resolveStoryline(harness.db, leaving)).toBe(leaving);
      expect(await readGroupStorylines(harness.db, leavingGroup)).toEqual([leaving]);
    });

    it("leaves both sides provisional and unlabelled", async () => {
      // The label described coverage half of which has just left, and a
      // storyline-of-one is invisible as a storyline by ADR-0011's lifecycle.
      const { kept, leaving, leavingGroup } = await formed();

      await dissolveFormation(harness.db, {
        storylineId: kept,
        groupId: leavingGroup,
        timeZone: ZONE,
      });

      for (const id of [kept, leaving]) {
        const storyline = await readStoryline(harness.db, id);
        expect(storyline?.status).toBe("provisional");
        expect(storyline?.label).toBeNull();
        expect(storyline?.labelSource).toBeNull();
      }
    });

    it("rewrites the day slots on both sides", async () => {
      // The kept storyline covered the leaver's day only through the leaver.
      const { kept, leaving, keptGroup, leavingGroup } = await formed();
      expect((await days(kept)).length).toBe(2);

      await dissolveFormation(harness.db, {
        storylineId: kept,
        groupId: leavingGroup,
        timeZone: ZONE,
      });

      expect((await days(kept)).map((day) => day.lead)).toEqual([keptGroup]);
      expect((await days(leaving)).map((day) => day.lead)).toEqual([leavingGroup]);
    });

    it("re-derives the profile from what is left", async () => {
      const { kept, leavingGroup } = await formed();

      await dissolveFormation(harness.db, {
        storylineId: kept,
        groupId: leavingGroup,
        timeZone: ZONE,
      });

      // A storyline of one speaks with its own group's tokens: `ice` came from
      // the leaver and must be gone.
      const storyline = await readStoryline(harness.db, kept);
      expect(storyline?.profileTokens).toContain("lounge");
      expect(storyline?.profileTokens).not.toContain("ice");
    });

    it("REFUSES a storyline of three or more — that is the split, not a dissolve", async () => {
      // The guard is the whole reason this operation is allowed to exist. Three
      // groups asks which of them belong together, and nothing here can answer.
      const { kept, leavingGroup } = await formed();
      const third = await group("2026-08-13T09:00:00.000Z", ["fatally", "shot", "third"]);
      await attachGroup(harness.db, { storylineId: kept, groupId: third, timeZone: ZONE });

      const result = await dissolveFormation(harness.db, {
        storylineId: kept,
        groupId: leavingGroup,
        timeZone: ZONE,
      });

      expect(result).toMatchObject({ dissolved: false, refusedBecause: "holds 3 groups, not 2" });
      expect(await readGroupStorylines(harness.db, leavingGroup)).toEqual([kept]);
    });

    it("refuses a group that is not a member, and an unknown storyline", async () => {
      const { kept } = await formed();
      const stranger = await group("2026-08-14T09:00:00.000Z", ["unrelated"]);

      expect(
        await dissolveFormation(harness.db, {
          storylineId: kept,
          groupId: stranger,
          timeZone: ZONE,
        }),
      ).toMatchObject({ dissolved: false, refusedBecause: "group is not a member" });
      expect(
        await dissolveFormation(harness.db, {
          storylineId: "00000000-0000-0000-0000-000000000000",
          groupId: stranger,
          timeZone: ZONE,
        }),
      ).toMatchObject({ dissolved: false, refusedBecause: "no such storyline" });
    });

    it("is reached through an alias, like every other storyline operation", async () => {
      const { kept, keptGroup, leaving, leavingGroup } = await formed();

      // The caller holds the loser's UUID. It resolves to the survivor.
      const result = await dissolveFormation(harness.db, {
        storylineId: leaving,
        groupId: leavingGroup,
        timeZone: ZONE,
      });

      expect(result.dissolved).toBe(true);
      expect(await readGroupStorylines(harness.db, leavingGroup)).toEqual([leaving]);
      // …and the survivor kept its own group and nothing else.
      expect(await readGroupStorylines(harness.db, keptGroup)).toEqual([kept]);
    });

    it("mints a fresh identity when the formation left no alias", async () => {
      // An `attachGroup` formation — the retroactive path — never made the
      // arriving group's storyline a loser, so there is nothing to revive.
      const keptGroup = await group("2026-08-09T15:00:00.000Z", ["reef", "survey"]);
      const kept = await createProvisionalStoryline(harness.db, {
        groupId: keptGroup,
        timeZone: ZONE,
      });
      const joinerGroup = await group("2026-08-10T09:00:00.000Z", ["reef", "results"]);
      await attachGroup(harness.db, {
        storylineId: kept.id,
        groupId: joinerGroup,
        timeZone: ZONE,
      });

      const result = await dissolveFormation(harness.db, {
        storylineId: kept.id,
        groupId: joinerGroup,
        timeZone: ZONE,
      });

      expect(result).toMatchObject({ dissolved: true, revivedAlias: false });
      expect(result.freedStorylineId).not.toBe(kept.id);
      expect(await readGroupStorylines(harness.db, joinerGroup)).toEqual([
        result.freedStorylineId,
      ]);
    });

    it("leaves bridge evidence standing — K still needs two distinct groups", async () => {
      // Recorded as a judgement, not an oversight: deleting would discard
      // evidence a later, better merge is entitled to, and keeping cannot
      // manufacture a merge because K counts DISTINCT groups.
      const { kept, leavingGroup } = await formed();
      const other = await group("2026-08-11T09:00:00.000Z", ["kelp", "forest"]);
      const otherStoryline = await createProvisionalStoryline(harness.db, {
        groupId: other,
        timeZone: ZONE,
      });
      await recordBridge(harness.db, {
        storylineA: kept,
        storylineB: otherStoryline.id,
        groupId: leavingGroup,
      });

      await dissolveFormation(harness.db, {
        storylineId: kept,
        groupId: leavingGroup,
        timeZone: ZONE,
      });

      expect(
        await countBridges(harness.db, { storylineA: kept, storylineB: otherStoryline.id }),
      ).toBe(1);
    });
  });

  /**
   * ADR-0011's percolation alarm, as the numbers the nightly pass now reports
   * (VERCEL-PHASE-0-FINDINGS §2.7, action 3).
   *
   * The fixture is memberships inserted straight into `storyline_groups`, and
   * that is deliberate: what is under test is the bucketing SQL, and reaching
   * the 19/20 and 99/100 edges through the linker would take 376 real groups
   * and make the fixture the subject. A synthetic membership is a legal row —
   * `group_id` carries no foreign key by design (migration 0007) — and the
   * distribution is a pure function of this table.
   *
   * Runs last in the file and truncates first, because it is the only test here
   * whose subject is a count over EVERYTHING rather than one storyline.
   */
  describe("the graph-shape report", () => {
    // One arc on each side of every bucket edge, so an off-by-one in any
    // `between` shows up as a bucket that is wrong by exactly one arc: 1 |
    // 2..4 | 5..19 | 20..99 | 100+. The 124 is the dev corpus's actual largest
    // arc, kept as the maximum so the assertion below reads like a real night.
    const SIZES = [1, 1, 1, 2, 4, 5, 19, 20, 99, 100, 124];
    let stats: StorylineStats;

    beforeAll(async () => {
      await sql`
        truncate storylines, storyline_groups, storyline_days, storyline_bridges cascade
      `.execute(harness.db);

      let groupId = 0;
      const ids: string[] = [];
      for (const size of SIZES) {
        const row = await harness.db
          .insertInto("storylines")
          .defaultValues()
          .returning("id")
          .executeTakeFirstOrThrow();
        ids.push(row.id);
        await harness.db
          .insertInto("storyline_groups")
          .values(
            Array.from({ length: size }, () => {
              groupId += 1;
              return { storyline_id: row.id, group_id: String(groupId) };
            }),
          )
          .execute();
      }
      // An alias holding nothing, which is what a merge leaves behind. It must
      // count as neither an arc nor a singleton, or every merge would look like
      // the graph growing a fragment.
      await harness.db
        .insertInto("storylines")
        .values({ merged_into: ids[0] as string })
        .execute();
      await harness.db
        .insertInto("storyline_bridges")
        .values({
          storyline_lo: [ids[1], ids[2]].sort()[0] as string,
          storyline_hi: [ids[1], ids[2]].sort()[1] as string,
          group_id: "1",
        })
        .execute();

      stats = await readStorylineStats(harness.db);
    });

    it("buckets arc size on the edges docs/STORYLINE-LINKING.md reports", () => {
      expect(stats.largestStoryline).toBe(124);
      expect(stats.singletons).toBe(3);
      expect(stats.arcs2To4).toBe(2);
      expect(stats.arcs5To19).toBe(2);
      expect(stats.arcs20To99).toBe(2);
      expect(stats.arcs100Plus).toBe(2);
    });

    it("accounts for every live arc exactly once, so the buckets are a partition", () => {
      // The property that makes a night's row readable: a bucket moving means an
      // arc CHANGED SIZE, never that a count drifted from the population. This
      // is also the assertion that catches an arc falling into no bucket at all.
      const bucketed =
        stats.singletons + stats.arcs2To4 + stats.arcs5To19 + stats.arcs20To99 + stats.arcs100Plus;
      expect(bucketed).toBe(SIZES.length);
      expect(stats.storylines).toBe(SIZES.length);
      // Promoted is "more than one group" (ADR-0011), which is everything but
      // the singletons — the same partition read a second way.
      expect(stats.promoted).toBe(SIZES.length - stats.singletons);
    });

    it("excludes aliases from the population without filtering on merged_into", () => {
      // `mergeStorylines` deletes the loser's `storyline_groups` rows, so the
      // size aggregate never sees an alias and needs no `merged_into` clause.
      // If that ever changes, this is the test that says so.
      expect(stats.aliases).toBe(1);
      expect(stats.storylines).toBe(SIZES.length);
      expect(stats.linkedGroups).toBe(SIZES.reduce((sum, size) => sum + size, 0));
    });

    it("reports standing bridge evidence, the count that moves BEFORE the buckets do", () => {
      // K bridges merge a pair, so bridges accumulate first and the arc sizes
      // follow. §2.6's runaway showed 1,913 → 10,282 bridges.
      expect(stats.bridges).toBe(1);
    });
  });
});
