import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateToLatest } from "./migrator.js";
import {
  attachGroup,
  countBridges,
  createProvisionalStoryline,
  mergeStorylines,
  recordBridge,
  promoteStoryline,
  readGroupStorylines,
  readStoryline,
  readStorylineDays,
  refreshStoryline,
  resolveStoryline,
  setStorylineLabel,
  setStorylineStatus,
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
      labelAt,
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
});
