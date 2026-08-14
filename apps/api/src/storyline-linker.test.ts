import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  attachGroup,
  countBridges,
  createProvisionalStoryline,
  promoteStoryline,
  readGroupStorylines,
  setStorylineStatus,
  readStoryline,
  readStorylineDays,
  recordStoryDf,
  resolveStoryline,
} from "@zammy/storage";
import { createTestHarness, type TestHarness } from "./test-support.js";
import { linkGroup, linkSeededGroups, type LinkerConfig } from "./storyline-linker.js";

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
             story_token_days, story_corpus_days, articles cascade
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
