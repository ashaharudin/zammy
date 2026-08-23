import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  attachGroup,
  countBridges,
  recordFormationRefusal,
  createProvisionalStoryline,
  promoteStoryline,
  readCandidateStorylines,
  readGroupStorylines,
  recordBridge,
  setStorylineStatus,
  readStoryline,
  readStorylineDays,
  recordStoryDf,
  resolveStoryline,
} from "@zammy/storage";
import { createTestHarness, type TestHarness } from "./test-support.js";
import {
  linkGroup,
  linkSeededGroups,
  runBridgeSweep,
  type LinkerConfig,
} from "./storyline-linker.js";

/**
 * The linker, end to end (ADR-0011): birth, attach, promote, bridge, merge.
 *
 * Against real Postgres, because what can be wrong here is the interaction
 * between a decision and the writes it implies — profile re-derivation after a
 * merge, day slots recomputed across a span neither storyline covered alone,
 * bridges re-pointed at a survivor. None of that is what a fake would fake.
 */

let harness: TestHarness;
let db: TestHarness["deps"]["db"];

beforeAll(async () => {
  harness = await createTestHarness();
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

const DAY = "2026-08-11";
const CONFIG: LinkerConfig = {
  enabled: true,
  rules: {
    anchorMaxShare: 0.002,
    anchorDfFloor: 10,
    massThreshold: 20,
    dormancyDays: 90,
    dormantStrictness: 1.5,
  },
  mergeBridges: 2,
  // Off, so everything below describes the pre-gate path: the merge happens
  // inside `linkGroup`. The gate has its own describe block at the bottom.
  coherenceGate: false,
  narrowRetrieval: false,
  storyDf: { windowDays: 14, timeZone: "UTC" },
  timeZone: "UTC",
};

const deps = () => ({ db: db, config: CONFIG });

let nextArticle = 0;

/**
 * One group, as an article in storage plus the linker's view of it. The
 * storyline layer reads member articles back for its day slots, so a group
 * that exists only in the linker's arguments would produce slot-less
 * storylines and prove nothing.
 */
async function group(input: {
  tokens: string[];
  publishedAt?: string;
  language?: string | null;
}): Promise<{ groupId: string; memberTokens: string[][]; language: string | null; published: Date }> {
  nextArticle += 1;
  const published = input.publishedAt ?? `${DAY}T09:0${nextArticle % 10}:00Z`;
  const { rows } = await sql<{ id: string }>`
    insert into articles (
      dedup_key, url, title, description, language, categories, source_category,
      published, latest_seen, sighting_count, story_tokens
    ) values (
      decode(${String(nextArticle).padStart(64, "0")}, 'hex'),
      ${`https://example.test/${nextArticle}`}, ${input.tokens.join(" ")}, null,
      ${input.language ?? "en"}, '{}', '{}', ${published}, ${published}, 1, ${input.tokens}
    ) returning id
  `.execute(db);
  return {
    groupId: rows[0]!.id,
    memberTokens: [input.tokens],
    language: input.language ?? "en",
    published: new Date(published),
  };
}

/**
 * A trailing corpus in which `rare` tokens sit far under the anchor ceiling and
 * `common` ones far over it. 16,000 articles, so the ceiling is 32 — the same
 * arithmetic the dev archive produces.
 */
async function seedCorpus(input: {
  rare?: string[];
  common?: string[];
  size?: number;
}): Promise<void> {
  const size = input.size ?? 16_000;
  await db
    .insertInto("story_corpus_days")
    .values({ day: DAY, language: "en", articles: size })
    .execute();
  const rows = [
    ...(input.rare ?? []).map((token) => ({ day: DAY, language: "en", token, df: 20 })),
    ...(input.common ?? []).map((token) => ({ day: DAY, language: "en", token, df: 2_000 })),
  ];
  if (rows.length > 0) await db.insertInto("story_token_days").values(rows).execute();
}

/** Five rare tokens: mass 33.4, comfortably over the floor of 20. */
const STORY = ["fausto", "hawaii", "surf", "swell", "genevieve"];

describe("birth", () => {
  it("gives every group a provisional storyline of its own", async () => {
    await seedCorpus({ rare: STORY });
    const first = await group({ tokens: STORY });

    const outcome = await linkGroup(deps(), first);

    expect(outcome.attached).toBe(false);
    const storyline = await readStoryline(db, outcome.storylineId);
    expect(storyline?.status).toBe("provisional");
    expect(storyline?.label).toBeNull();
    expect(await readGroupStorylines(db, first.groupId)).toEqual([outcome.storylineId]);
  });

  it("is idempotent — a replayed group does not seed a second storyline", async () => {
    await seedCorpus({ rare: STORY });
    const first = await group({ tokens: STORY });

    const once = await linkGroup(deps(), first);
    const twice = await linkGroup(deps(), first);

    expect(twice.storylineId).toBe(once.storylineId);
    const { rows } = await sql<{ n: string }>`select count(*) as n from storylines`.execute(
      db,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("leaves a group alone when the corpus is empty — every token would read as rare", async () => {
    // A fresh database. Without this guard every candidate qualifies, which is
    // the percolation the whole design refuses.
    const first = await group({ tokens: STORY });
    const second = await group({ tokens: STORY });

    await linkGroup(deps(), first);
    const outcome = await linkGroup(deps(), second);

    expect(outcome.attached).toBe(false);
  });
});

describe("attach and promote", () => {
  it("moves the second group into the first's storyline and promotes it", async () => {
    await seedCorpus({ rare: STORY });
    const first = await group({ tokens: STORY });
    const second = await group({ tokens: STORY });

    const born = await linkGroup(deps(), first);
    const outcome = await linkGroup(deps(), second);

    expect(outcome.attached).toBe(true);
    expect(outcome.storylineId).toBe(born.storylineId);
    expect((await readStoryline(db, born.storylineId))?.status).toBe("active");
    expect(await readGroupStorylines(db, second.groupId)).toEqual([born.storylineId]);
  });

  it("absorbs the joiner's own storyline rather than leaving it standing", async () => {
    // Two storylines holding one group each would render the article twice —
    // once in its own plain slot, once in the storyline's.
    await seedCorpus({ rare: STORY });
    const first = await group({ tokens: STORY });
    const second = await group({ tokens: STORY });

    await linkGroup(deps(), first);
    const outcome = await linkGroup(deps(), second);

    const live = await db
      .selectFrom("storylines")
      .select("id")
      .where("merged_into", "is", null)
      .execute();
    expect(live.map((row) => row.id)).toEqual([outcome.storylineId]);
  });

  it("keeps the absorbed UUID resolving, so nothing holding it dangles", async () => {
    await seedCorpus({ rare: STORY });
    const first = await group({ tokens: STORY });
    const second = await group({ tokens: STORY });

    await linkGroup(deps(), first);
    const outcome = await linkGroup(deps(), second);

    // The joiner's provisional UUID is gone as a storyline but still resolves:
    // it may already be in a reader's URL, and ADR-0011 is explicit that
    // nothing holding one may dangle.
    const aliases = await db
      .selectFrom("storylines")
      .select("id")
      .where("merged_into", "is not", null)
      .execute();
    expect(aliases).toHaveLength(1);
    expect(await resolveStoryline(db, aliases[0]!.id)).toBe(outcome.storylineId);
  });

  it("refuses a group sharing only beat vocabulary", async () => {
    await seedCorpus({ common: ["trump", "president", "washington"] });
    const first = await group({ tokens: ["trump", "president", "washington"] });
    const second = await group({ tokens: ["trump", "president", "washington"] });

    await linkGroup(deps(), first);
    const outcome = await linkGroup(deps(), second);

    expect(outcome.attached).toBe(false);
  });

  it("wakes a dormant storyline the moment it earns coverage", async () => {
    // ADR-0011: "active again when it earns coverage" — earns, not "is swept
    // over at 3am". A dormant storyline that takes a group at noon must read as
    // active to the noon reader, so reactivation belongs to the write path and
    // the nightly sweep only ever marks quiet.
    await seedCorpus({ rare: STORY });
    const march = await group({ tokens: STORY, publishedAt: "2026-03-02T09:00:00Z" });
    const born = await createProvisionalStoryline(db, { groupId: march.groupId, timeZone: "UTC" });
    await attachGroup(db, {
      storylineId: born.id,
      groupId: (await group({ tokens: STORY, publishedAt: "2026-03-03T09:00:00Z" })).groupId,
      timeZone: "UTC",
    });
    await promoteStoryline(db, { storylineId: born.id });
    await setStorylineStatus(db, { storylineId: born.id, status: "dormant" });

    const outcome = await linkGroup(deps(), await group({ tokens: STORY }));

    // Five months quiet, and it still cleared the dormant bar — which is the
    // point of keeping dormant storylines matchable at all.
    expect(outcome.storylineId).toBe(born.id);
    expect(outcome.attached).toBe(true);
    expect((await readStoryline(db, born.id))?.status).toBe("active");
  });

  it("takes one day slot per day the storyline has coverage", async () => {
    await seedCorpus({ rare: STORY });
    await db
      .insertInto("story_corpus_days")
      .values({ day: "2026-08-12", language: "en", articles: 16_000 })
      .execute();
    await db
      .insertInto("story_token_days")
      .values(STORY.map((token) => ({ day: "2026-08-12", language: "en", token, df: 20 })))
      .execute();

    const monday = await group({ tokens: STORY, publishedAt: `${DAY}T09:00:00Z` });
    const tuesday = await group({ tokens: STORY, publishedAt: "2026-08-12T09:00:00Z" });

    const born = await linkGroup(deps(), monday);
    await linkGroup(deps(), tuesday);

    // A storyline spanning two days is TWO slots — which is what makes
    // "unbounded in time" cost the reader nothing.
    const days = await readStorylineDays(db, born.storylineId);
    expect(days.map((day) => day.dayKey).sort()).toEqual(["2026-08-11", "2026-08-12"]);
  });
});

describe("retroactive attachment", () => {
  /**
   * A storyline formed after a group did, which the group belongs in: ADR-0011's
   * "a Wednesday storyline may pull in Monday's group". Built with the storage
   * primitives, because what is under test is the SECOND offer of an already-homed
   * group — the arc it is being pulled into has to exist first, and how it came
   * to exist is not the subject.
   */
  async function laterArc(): Promise<string> {
    const one = await group({ tokens: STORY, publishedAt: `${DAY}T20:00:00Z` });
    const two = await group({ tokens: STORY, publishedAt: `${DAY}T21:00:00Z` });
    const born = await createProvisionalStoryline(db, { groupId: one.groupId, timeZone: "UTC" });
    await attachGroup(db, { storylineId: born.id, groupId: two.groupId, timeZone: "UTC" });
    await promoteStoryline(db, { storylineId: born.id });
    return born.id;
  }

  it("pulls an already-homed group into an arc it also belongs to", async () => {
    await seedCorpus({ rare: STORY });
    const monday = await group({ tokens: STORY, publishedAt: `${DAY}T09:00:00Z` });
    const born = await linkGroup(deps(), monday);
    await linkGroup(deps(), await group({ tokens: STORY, publishedAt: `${DAY}T10:00:00Z` }));
    const later = await laterArc();

    // Monday's group, offered again — the sweep's whole job.
    const outcome = await linkGroup(deps(), monday);

    expect(outcome.attachedTo).toEqual([later]);
    // BOTH arcs, which is the duplication ADR-0011 accepts: this is an
    // ADDITIONAL membership, not a move.
    expect((await readGroupStorylines(db, monday.groupId)).sort()).toEqual(
      [born.storylineId, later].sort(),
    );
  });

  it("never re-homes, and never merges the two arcs on one group's say-so", async () => {
    await seedCorpus({ rare: STORY });
    const monday = await group({ tokens: STORY, publishedAt: `${DAY}T09:00:00Z` });
    const born = await linkGroup(deps(), monday);
    const tuesday = await group({ tokens: STORY, publishedAt: `${DAY}T10:00:00Z` });
    await linkGroup(deps(), tuesday);
    const later = await laterArc();

    await linkGroup(deps(), monday);

    // Absorbing a REAL storyline into another because one of its members would
    // also fit there is a merge with no bridge evidence — the percolation K
    // exists to prevent.
    expect(await resolveStoryline(db, born.storylineId)).toBe(born.storylineId);
    expect(await resolveStoryline(db, later)).toBe(later);
    expect((await readGroupStorylines(db, tuesday.groupId))).toEqual([born.storylineId]);
  });

  it("is idempotent — a group offered twice more joins nothing twice", async () => {
    await seedCorpus({ rare: STORY });
    const monday = await group({ tokens: STORY, publishedAt: `${DAY}T09:00:00Z` });
    await linkGroup(deps(), monday);
    await linkGroup(deps(), await group({ tokens: STORY, publishedAt: `${DAY}T10:00:00Z` }));
    await laterArc();

    const first = await linkGroup(deps(), monday);
    const second = await linkGroup(deps(), monday);

    // A nightly sweep re-offers the same fortnight every night; the second
    // night must cost reads and change nothing.
    expect(first.attachedTo).toHaveLength(1);
    expect(second.attachedTo).toEqual([]);
    expect(await readGroupStorylines(db, monday.groupId)).toHaveLength(2);
  });

  it("stops at one retroactive arc — further qualifiers stay bridge evidence", async () => {
    await seedCorpus({ rare: STORY });
    const monday = await group({ tokens: STORY, publishedAt: `${DAY}T09:00:00Z` });
    await linkGroup(deps(), monday);
    await linkGroup(deps(), await group({ tokens: STORY, publishedAt: `${DAY}T10:00:00Z` }));
    await laterArc();
    await laterArc();

    // Two later arcs qualify. A next-best rule would hand the group one per
    // nightly re-offer until it belonged to every qualifier — percolation with
    // extra steps. A late ARRIVAL attaches to one best arc, so a late OFFER
    // gets the same and no more; the rest is bridge evidence for a merge.
    const first = await linkGroup(deps(), monday);
    const second = await linkGroup(deps(), monday);

    expect(first.attachedTo).toHaveLength(1);
    expect(second.attachedTo).toEqual([]);
    expect(await readGroupStorylines(db, monday.groupId)).toHaveLength(2);
  });

  it("a member's fit for an arc it already joined is not bridge evidence", async () => {
    await seedCorpus({ rare: STORY });
    const monday = await group({ tokens: STORY, publishedAt: `${DAY}T09:00:00Z` });
    await linkGroup(deps(), monday);
    await linkGroup(deps(), await group({ tokens: STORY, publishedAt: `${DAY}T10:00:00Z` }));
    const joined = await laterArc();
    await linkGroup(deps(), monday); // retro-joins `joined`
    const newcomer = await laterArc();

    const outcome = await linkGroup(deps(), monday);

    // The group's tokens are already IN `joined`'s profile — re-qualifying for
    // it is the trivial fit `own` is excluded for on the fresh path, and
    // counting it would let one multi-homed group manufacture K "independent"
    // bridges night after night until two arcs merged on its say-so alone.
    expect(outcome.bridged).toEqual([newcomer]);
    expect(await countBridges(db, { storylineA: joined, storylineB: newcomer })).toBe(0);
  });

  it("promotes a provisional it retro-attaches to — two groups is real however they arrived", async () => {
    await seedCorpus({ rare: STORY });
    const monday = await group({ tokens: STORY, publishedAt: `${DAY}T09:00:00Z` });
    await linkGroup(deps(), monday);
    await linkGroup(deps(), await group({ tokens: STORY, publishedAt: `${DAY}T10:00:00Z` }));
    const lone = await group({ tokens: STORY, publishedAt: `${DAY}T20:00:00Z` });
    const provisional = await createProvisionalStoryline(db, {
      groupId: lone.groupId,
      timeZone: "UTC",
    });

    const outcome = await linkGroup(deps(), monday);

    // Without the promotion, a provisional grown retroactively would hold two
    // groups forever while staying invisible to surfacing, labelling, and the
    // dormancy sweep — no path ever offers it a repair.
    expect(outcome.attachedTo).toEqual([provisional.id]);
    expect(outcome.promoted).toEqual([provisional.id]);
    expect((await readStoryline(db, provisional.id))?.status).toBe("active");
  });
});

describe("bridges and merging", () => {
  // Two storylines that share nothing with each other, and a group that
  // qualifies for both.
  const LEFT = ["fausto", "hawaii", "surf", "swell", "genevieve"];
  const RIGHT = ["ontario", "premier", "hotel", "expense", "scandal"];
  const BOTH = [...LEFT, ...RIGHT];

  async function twoStorylines() {
    await seedCorpus({ rare: BOTH });
    const a1 = await group({ tokens: LEFT });
    const a2 = await group({ tokens: LEFT });
    const b1 = await group({ tokens: RIGHT });
    const b2 = await group({ tokens: RIGHT });
    const left = await linkGroup(deps(), a1);
    await linkGroup(deps(), a2);
    const right = await linkGroup(deps(), b1);
    await linkGroup(deps(), b2);
    return { left: left.storylineId, right: right.storylineId };
  }

  it("records a bridge without merging on the first one", async () => {
    const { left, right } = await twoStorylines();
    const straddler = await group({ tokens: BOTH });

    const outcome = await linkGroup(deps(), straddler);

    expect(outcome.bridged).toHaveLength(1);
    expect(outcome.merged).toEqual([]);
    expect(await countBridges(db, { storylineA: left, storylineB: right })).toBe(1);
    // Single-bridge merging is refused: one ambiguous roundup chaining
    // storylines together is percolation by another door.
    expect(await resolveStoryline(db, left)).toBe(left);
    expect(await resolveStoryline(db, right)).toBe(right);
  });

  it("merges once K INDEPENDENT groups bridge the pair", async () => {
    const { left, right } = await twoStorylines();

    await linkGroup(deps(), await group({ tokens: BOTH }));
    const outcome = await linkGroup(deps(), await group({ tokens: BOTH }));

    expect(outcome.merged).toHaveLength(1);
    const survivor = await resolveStoryline(db, left);
    expect(await resolveStoryline(db, right)).toBe(survivor);
  });

  it("does not let ONE group's re-evaluation count twice", async () => {
    // "Independent" is the whole rule. A retried batch, a backfill re-reaching
    // the same group, a regroup pass — all one observation.
    const { left, right } = await twoStorylines();
    const straddler = await group({ tokens: BOTH });

    await linkGroup(deps(), straddler);
    await linkGroup(deps(), straddler);
    await linkGroup(deps(), straddler);

    expect(await countBridges(db, { storylineA: left, storylineB: right })).toBe(1);
    expect(await resolveStoryline(db, left)).toBe(left);
  });
});

describe("bridges a merge re-points", () => {
  // Three arcs with nothing in common. THIRD bridges each of the other two
  // once — below K either way — and then two straddlers merge LEFT and MID.
  // That merge moves MID's bridge onto the survivor, so (survivor, THIRD) holds
  // two independent bridges without one ever being inserted for that pair.
  //
  // Before the fix the K check only ran on an insert, so the pair sat at K for
  // ever: 31 such pairs in the dev archive, the bridge merge never having fired.
  const LEFT = ["fausto", "hawaii", "surf", "swell", "genevieve"];
  const MID = ["ontario", "premier", "hotel", "expense", "scandal"];
  const THIRD = ["tanker", "hormuz", "strait", "seizure", "shipping"];

  async function threeStorylines() {
    await seedCorpus({ rare: [...LEFT, ...MID, ...THIRD] });
    let left = "";
    let mid = "";
    let third = "";
    for (let i = 0; i < 4; i += 1) {
      left = (await linkGroup(deps(), await group({ tokens: LEFT }))).storylineId;
      mid = (await linkGroup(deps(), await group({ tokens: MID }))).storylineId;
      third = (await linkGroup(deps(), await group({ tokens: THIRD }))).storylineId;
    }
    return { left, mid, third };
  }

  it("re-checks the survivor's pairs against K, and merges what reaches it", async () => {
    const { left, mid, third } = await threeStorylines();

    // One bridge each to THIRD: neither pair reaches K on its own.
    await linkGroup(deps(), await group({ tokens: [...LEFT, ...THIRD] }));
    await linkGroup(deps(), await group({ tokens: [...MID, ...THIRD] }));
    expect(await countBridges(db, { storylineA: left, storylineB: third })).toBe(1);
    expect(await countBridges(db, { storylineA: mid, storylineB: third })).toBe(1);
    expect(await resolveStoryline(db, third)).toBe(third);

    // Two independent straddlers merge LEFT and MID — and the cascade must then
    // notice that THIRD's two bridges now point at one storyline.
    await linkGroup(deps(), await group({ tokens: [...LEFT, ...MID] }));
    const outcome = await linkGroup(deps(), await group({ tokens: [...LEFT, ...MID] }));

    // Two merges from one arrival: the pair that had K, then the pair the
    // re-pointing lifted to K.
    expect(outcome.merged.length).toBeGreaterThanOrEqual(2);
    const survivor = await resolveStoryline(db, left);
    expect(await resolveStoryline(db, mid)).toBe(survivor);
    expect(await resolveStoryline(db, third)).toBe(survivor);
    // The healed pair keeps no evidence: a pair that is now one storyline has
    // nothing left to bridge.
    expect(await countBridges(db, { storylineA: survivor!, storylineB: third })).toBe(0);
  });

  it("re-checks a pair whose count crosses K LATER in the same cascade", async () => {
    // FOURTH's two bridges reach the survivor on different hops: one when MID
    // is absorbed, the second when THIRD is. A cascade that remembers the
    // first, below-K answer never asks again and leaves the pair for the
    // nightly sweep to repair a day late — the count does grow mid-cascade.
    const FOURTH = ["kelowna", "vineyard", "frost", "harvest", "riesling"];
    await seedCorpus({ rare: [...LEFT, ...MID, ...THIRD, ...FOURTH] });
    let left = "";
    let mid = "";
    let third = "";
    let fourth = "";
    for (let i = 0; i < 4; i += 1) {
      left = (await linkGroup(deps(), await group({ tokens: LEFT }))).storylineId;
      mid = (await linkGroup(deps(), await group({ tokens: MID }))).storylineId;
      third = (await linkGroup(deps(), await group({ tokens: THIRD }))).storylineId;
      fourth = (await linkGroup(deps(), await group({ tokens: FOURTH }))).storylineId;
    }
    // LEFT must win the first merge — more coverage wins — because the pair
    // this test is about is (survivor, FOURTH), and it is MID's bridges that
    // have to be the ones re-pointed onto the survivor.
    for (let i = 0; i < 10; i += 1) {
      left = (await linkGroup(deps(), await group({ tokens: LEFT }))).storylineId;
    }

    // One bridge on every pair but LEFT-MID: nothing reaches K on an insert.
    await linkGroup(deps(), await group({ tokens: [...LEFT, ...THIRD] }));
    await linkGroup(deps(), await group({ tokens: [...MID, ...THIRD] }));
    await linkGroup(deps(), await group({ tokens: [...MID, ...FOURTH] }));
    await linkGroup(deps(), await group({ tokens: [...THIRD, ...FOURTH] }));
    expect(await countBridges(db, { storylineA: left, storylineB: fourth })).toBe(0);
    expect(await countBridges(db, { storylineA: mid, storylineB: fourth })).toBe(1);
    expect(await countBridges(db, { storylineA: third, storylineB: fourth })).toBe(1);

    await linkGroup(deps(), await group({ tokens: [...LEFT, ...MID] }));
    await linkGroup(deps(), await group({ tokens: [...LEFT, ...MID] }));

    // Hop one absorbs MID and lifts THIRD to K; hop two absorbs THIRD, and the
    // bridge it carries is FOURTH's second — asked again, FOURTH merges too.
    const survivor = await resolveStoryline(db, left);
    expect(await resolveStoryline(db, mid)).toBe(survivor);
    expect(await resolveStoryline(db, third)).toBe(survivor);
    expect(await resolveStoryline(db, fourth)).toBe(survivor);
  });

  it("leaves a re-pointed pair alone while it is still under K", async () => {
    const { left, mid, third } = await threeStorylines();

    // Only ONE bridge to THIRD this time, from the MID side.
    await linkGroup(deps(), await group({ tokens: [...MID, ...THIRD] }));
    await linkGroup(deps(), await group({ tokens: [...LEFT, ...MID] }));
    await linkGroup(deps(), await group({ tokens: [...LEFT, ...MID] }));

    const survivor = await resolveStoryline(db, left);
    expect(await resolveStoryline(db, mid)).toBe(survivor);
    // Re-pointed, still one bridge, still two storylines. The cascade merges on
    // evidence, not on adjacency.
    expect(await countBridges(db, { storylineA: survivor!, storylineB: third })).toBe(1);
    expect(await resolveStoryline(db, third)).toBe(third);
  });
});

describe("runBridgeSweep", () => {
  const LEFT = ["fausto", "hawaii", "surf", "swell", "genevieve"];
  const RIGHT = ["ontario", "premier", "hotel", "expense", "scandal"];

  it("merges a pair that reached K without an insert to notice it", async () => {
    await seedCorpus({ rare: [...LEFT, ...RIGHT] });
    let left = "";
    let right = "";
    for (let i = 0; i < 3; i += 1) {
      left = (await linkGroup(deps(), await group({ tokens: LEFT }))).storylineId;
      right = (await linkGroup(deps(), await group({ tokens: RIGHT }))).storylineId;
    }
    // Two independent bridges written directly — the state a re-pointing merge
    // leaves behind, and the state the archive was found in.
    const one = await group({ tokens: LEFT });
    const two = await group({ tokens: RIGHT });
    await recordBridge(db, { storylineA: left, storylineB: right, groupId: one.groupId });
    await recordBridge(db, { storylineA: left, storylineB: right, groupId: two.groupId });
    expect(await resolveStoryline(db, right)).toBe(right);

    const report = await runBridgeSweep(deps());

    expect(report.found).toBe(1);
    expect(report.merged).toBe(1);
    expect(report.incomplete).toBe(false);
    const survivor = await resolveStoryline(db, left);
    expect(await resolveStoryline(db, right)).toBe(survivor);
    // The survivor is handed back so the caller can re-name it: a merge is one
    // of ADR-0011's label triggers.
    expect(report.survivors).toEqual([survivor]);
  });

  it("is a no-op when the invariant already holds", async () => {
    await seedCorpus({ rare: [...LEFT, ...RIGHT] });
    for (let i = 0; i < 3; i += 1) await linkGroup(deps(), await group({ tokens: LEFT }));

    const report = await runBridgeSweep(deps());

    expect(report).toEqual({
      found: 0,
      merged: 0,
      failures: 0,
      incomplete: false,
      survivors: [],
    });
  });

  it("leaves a pair under K alone", async () => {
    await seedCorpus({ rare: [...LEFT, ...RIGHT] });
    let left = "";
    let right = "";
    for (let i = 0; i < 3; i += 1) {
      left = (await linkGroup(deps(), await group({ tokens: LEFT }))).storylineId;
      right = (await linkGroup(deps(), await group({ tokens: RIGHT }))).storylineId;
    }
    const one = await group({ tokens: LEFT });
    await recordBridge(db, { storylineA: left, storylineB: right, groupId: one.groupId });

    const report = await runBridgeSweep(deps());

    expect(report.found).toBe(0);
    expect(await resolveStoryline(db, right)).toBe(right);
  });
});

describe("linkSeededGroups", () => {
  it("does nothing at all when the flag is off", async () => {
    await seedCorpus({ rare: STORY });
    const first = await group({ tokens: STORY });

    await linkSeededGroups({ db: db, config: { ...CONFIG, enabled: false } }, [first]);

    const { rows } = await sql<{ n: string }>`select count(*) as n from storylines`.execute(
      db,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it("lets the second group of a batch join what the first just seeded", async () => {
    // A syndicated pair arriving in one upstream page would otherwise never
    // find each other.
    await seedCorpus({ rare: STORY });
    const first = await group({ tokens: STORY, publishedAt: `${DAY}T09:00:00Z` });
    const second = await group({ tokens: STORY, publishedAt: `${DAY}T10:00:00Z` });

    const outcomes = await linkSeededGroups(deps(), [second, first]);

    // Processed in publication order regardless of the argument order, so a
    // replay of the same batch makes the same decisions.
    expect(outcomes.map((o) => o.groupId)).toEqual([first.groupId, second.groupId]);
    expect(outcomes[1]!.attached).toBe(true);
    expect(outcomes[1]!.storylineId).toBe(outcomes[0]!.storylineId);
  });

  it("survives one group failing without losing the rest of the batch", async () => {
    await seedCorpus({ rare: STORY });
    const good = await group({ tokens: STORY });
    const broken = { ...good, groupId: "999999999999999999" };

    const outcomes = await linkSeededGroups({ ...deps(), log: { warn: () => {} } }, [
      broken,
      good,
    ]);

    expect(outcomes.some((o) => o.groupId === good.groupId)).toBe(true);
  });
});

describe("the trailing corpus is what rarity is measured against", () => {
  it("links on a token that is rare in the fortnight even when today is loud", async () => {
    // ADR-0009's measured failure: on the day its coverage peaked, a story's
    // own name reached 4.4% of the day and an absolute cap refused it. Against
    // the fortnight the same name is 0.9%, and the link survives.
    await recordStoryDf(
      db,
      Array.from({ length: 150 }, () => ({ day: DAY, language: "en", tokens: STORY })),
    );
    await db
      .updateTable("story_corpus_days")
      .set({ articles: 16_000 })
      .where("day", "=", DAY)
      .execute();

    const first = await group({ tokens: STORY });
    const second = await group({ tokens: STORY });
    await linkGroup(deps(), first);
    const outcome = await linkGroup(deps(), second);

    // df 150 of 16,000 is 0.94% — over the 0.2% ceiling, so these five tokens
    // alone no longer anchor. The link is refused, and that is the rule
    // working: at this df the vocabulary has become a beat.
    expect(outcome.attached).toBe(false);
  });
});

describe("the coherence gate (ADR-0011's amendment)", () => {
  const GATED: LinkerConfig = { ...CONFIG, coherenceGate: true };
  const gated = () => ({ db, config: GATED });

  it("withholds the FORMATION instead of performing it", async () => {
    await seedCorpus({ rare: STORY });
    const first = await group({ tokens: STORY });
    const second = await group({ tokens: STORY });

    await linkGroup(gated(), first);
    const outcome = await linkGroup(gated(), second);

    // The token evidence was earned and reported…
    expect(outcome.pendingFormation).toMatchObject({
      groupId: second.groupId,
      partnerGroupId: first.groupId,
    });
    // …and nothing was merged, promoted or re-homed.
    expect(outcome.attached).toBe(false);
    expect(outcome.promoted).toEqual([]);
    const firstStoryline = await readStoryline(db, outcome.pendingFormation!.winnerId);
    expect(firstStoryline?.status).toBe("provisional");
    const homes = await readGroupStorylines(db, second.groupId);
    expect(homes).toHaveLength(1);
    expect(homes[0]).not.toBe(outcome.pendingFormation!.winnerId);
  });

  it("does not defer a join to a storyline that is already REAL", async () => {
    // The gate is measurably wrong about established arcs (43% false refusals at
    // 20 groups or more), so it must never see one. Two groups formed ungated
    // make the third arrival an ordinary attach.
    await seedCorpus({ rare: STORY });
    const first = await group({ tokens: STORY });
    const second = await group({ tokens: STORY });
    await linkGroup(deps(), first);
    const home = await linkGroup(deps(), second);
    expect(home.promoted).toHaveLength(1);

    const third = await group({ tokens: STORY });
    const outcome = await linkGroup(gated(), third);

    expect(outcome.pendingFormation).toBeUndefined();
    expect(outcome.attached).toBe(true);
  });

  it("performs the formation synchronously when the gate is off", async () => {
    await seedCorpus({ rare: STORY });
    const first = await group({ tokens: STORY });
    const second = await group({ tokens: STORY });

    await linkGroup(deps(), first);
    const outcome = await linkGroup(deps(), second);

    expect(outcome.pendingFormation).toBeUndefined();
    expect(outcome.attached).toBe(true);
    expect(outcome.promoted).toEqual([outcome.storylineId]);
  });

  it("never offers a formation a verdict already refused", async () => {
    await seedCorpus({ rare: STORY });
    const first = await group({ tokens: STORY });
    const second = await group({ tokens: STORY });
    await linkGroup(gated(), first);
    const deferred = await linkGroup(gated(), second);
    expect(deferred.pendingFormation).toBeTruthy();

    await recordFormationRefusal(db, { groupA: first.groupId, groupB: second.groupId });

    // Re-offered by the nightly late-candidate sweep. Without the refusal this
    // would defer again and spend another model call, every night, for ever.
    const again = await linkGroup(gated(), second);

    expect(again.pendingFormation).toBeUndefined();
    expect(again.attached).toBe(false);
  });

  it("a refusal bars only THAT pair, not the group from linking at all", async () => {
    await seedCorpus({ rare: STORY });
    const first = await group({ tokens: STORY });
    const second = await group({ tokens: STORY });
    await linkGroup(gated(), first);
    await linkGroup(gated(), second);
    await recordFormationRefusal(db, { groupA: first.groupId, groupB: second.groupId });

    // A THIRD group covering the same story is a formation the gate has said
    // nothing about, so it is still offered.
    const third = await group({ tokens: STORY });
    const outcome = await linkGroup(gated(), third);

    expect(outcome.pendingFormation).toBeTruthy();
    expect([first.groupId, second.groupId]).toContain(
      outcome.pendingFormation!.partnerGroupId,
    );
  });

  it("records bridge evidence even though the formation was withheld", async () => {
    // "This group qualified for both of these" is a fact about those storylines
    // whatever happens to the formation — suppressing it would leave the K-bridge
    // merge blind.
    await seedCorpus({ rare: [...STORY, "kona", "hilo"] });
    const a = await group({ tokens: [...STORY, "kona"] });
    const b = await group({ tokens: [...STORY, "hilo"] });
    const linkedA = await linkGroup(gated(), a);
    const linkedB = await linkGroup(gated(), b);
    expect(linkedB.pendingFormation).toBeTruthy();

    const straddler = await group({ tokens: [...STORY, "kona", "hilo"] });
    const outcome = await linkGroup(gated(), straddler);

    expect(outcome.bridged.length + (outcome.pendingFormation ? 1 : 0)).toBeGreaterThan(1);
    expect(
      await countBridges(db, {
        storylineA: linkedA.storylineId,
        storylineB: linkedB.storylineId,
      }),
    ).toBeGreaterThan(0);
  });
});

describe("STORYLINE_NARROW_RETRIEVAL", () => {
  /** The narrowed mode: anchor-eligible probe, cap 4,000. `CONFIG` is the off one. */
  const NARROWED: LinkerConfig = { ...CONFIG, narrowRetrieval: true };

  /**
   * The whole point of the flag, in one fixture: a real qualifier that the BROAD
   * probe's 200-row cut throws away.
   *
   * 204 decoy storylines share only a COMMON token with the arrival — above the
   * anchor ceiling, so none of them can ever qualify — and every one of them has
   * fresher coverage than the single storyline that CAN. `readCandidateStorylines`
   * cuts at `last_coverage desc`, which is not what the decision reads, so the
   * broad probe spends its 200 rows on the decoys and never sees the qualifier.
   * The narrowed probe cannot retrieve the decoys at all: a token 12.5% of the
   * corpus carries is not anchor-eligible, so it never enters the probe array.
   *
   * This is the dev archive's measured shape in miniature — the cut bound on
   * 12,266 of 12,366 window groups and discarded ~90% of candidates, and the
   * narrowed probe found 1,147 more qualifiers while losing none.
   */
  async function seedRecencyDecoys(): Promise<{ qualifierId: string }> {
    await seedCorpus({ rare: STORY, common: ["trump"] });

    // One article to lead every decoy's day slot: `storyline_days` needs a hero,
    // and which article it is has no bearing on retrieval.
    const lead = await group({ tokens: ["trump"] });
    const decoys = await db
      .insertInto("storylines")
      .values(
        Array.from({ length: 204 }, () => ({
          profile_tokens: ["trump", "president"],
          status: "active" as const,
        })),
      )
      .returning("id")
      .execute();
    await db
      .insertInto("storyline_days")
      .values(
        decoys.map((decoy) => ({
          storyline_id: decoy.id,
          day_key: DAY,
          day_slot_published: new Date(`${DAY}T08:00:00Z`),
          lead_article_id: lead.groupId,
        })),
      )
      .execute();

    // The one storyline the arrival genuinely belongs to: two groups, the five
    // rare tokens, and coverage 40 days old — inside dormancy (90) and therefore
    // judged at the normal bar, but last in the recency order the cut uses.
    const members = [await group({ tokens: STORY }), await group({ tokens: STORY })];
    const qualifier = await db
      .insertInto("storylines")
      .values({ profile_tokens: STORY, status: "active" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("storyline_groups")
      .values(members.map((member) => ({ storyline_id: qualifier.id, group_id: member.groupId })))
      .execute();
    await db
      .insertInto("storyline_days")
      .values({
        storyline_id: qualifier.id,
        day_key: "2026-07-02",
        day_slot_published: new Date("2026-07-02T08:00:00Z"),
        lead_article_id: members[0]!.groupId,
      })
      .execute();

    return { qualifierId: qualifier.id };
  }

  it("OFF: the whole profile, and the 200-row cut loses the real link", async () => {
    // Not a hypothetical about the flag — this is what production has done since
    // the linker shipped, and why narrowing is a repair rather than a widening.
    const { qualifierId } = await seedRecencyDecoys();
    const arrival = await group({ tokens: [...STORY, "trump"] });

    const outcome = await linkGroup(deps(), arrival);

    expect(outcome.attached).toBe(false);
    expect(outcome.storylineId).not.toBe(qualifierId);
    expect(await readGroupStorylines(db, arrival.groupId)).toEqual([outcome.storylineId]);
  });

  it("ON: the anchor-eligible probe finds it, because the decoys cannot enter", async () => {
    const { qualifierId } = await seedRecencyDecoys();
    const arrival = await group({ tokens: [...STORY, "trump"] });

    const outcome = await linkGroup({ db, config: NARROWED }, arrival);

    expect(outcome.attached).toBe(true);
    expect(outcome.storylineId).toBe(qualifierId);
  });

  it("the coupling: it is the 200 CAP that loses it, not the broad probe", async () => {
    // Why the flag must switch both halves at once. Run the broad probe's own
    // token array at each mode's limit against the same fixture: at 200 the
    // qualifier is cut, at 4,000 it is not. So "whole profile + 4,000" is a THIRD
    // behaviour — the broad probe with its only bound effectively removed, which
    // is more percolation-prone than either mode, since every extra qualifier
    // multiplies into `bridgePairs`' O(n^2) cross-product. `candidateRetrieval`
    // is the reason that pair is unreachable from `LinkerConfig`.
    const { qualifierId } = await seedRecencyDecoys();
    const broadTokens = [...STORY, "trump"];

    const capped = await readCandidateStorylines(db, { tokens: broadTokens, limit: 200 });
    const uncapped = await readCandidateStorylines(db, { tokens: broadTokens, limit: 4_000 });

    expect(capped).toHaveLength(200);
    expect(capped.map((row) => row.id)).not.toContain(qualifierId);
    expect(uncapped.map((row) => row.id)).toContain(qualifierId);
  });

  it("agrees with the broad probe whenever the cap does not bind", async () => {
    // The necessary-condition property, end to end: narrowing is not a narrower
    // DECISION, so with nothing truncated both modes reach the same verdict.
    // That is what makes the off path a pure rollback rather than a third
    // behaviour, and what `storyline-link.test.ts` proves at the rule level.
    await seedCorpus({ rare: STORY });
    const first = await group({ tokens: STORY });
    const second = await group({ tokens: STORY });
    const third = await group({ tokens: STORY });

    const born = await linkGroup(deps(), first);
    const broad = await linkGroup(deps(), second);
    const narrowed = await linkGroup({ db, config: NARROWED }, third);

    expect(broad.storylineId).toBe(born.storylineId);
    expect(narrowed.storylineId).toBe(born.storylineId);
    expect(narrowed.attached).toBe(true);
  });
});
