import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  attachGroup,
  createProvisionalStoryline,
  promoteStoryline,
  readGroupStorylines,
  resolveStoryline,
  type CreatedArticle,
} from "@zammy/storage";
import { createTestHarness, type TestHarness } from "./test-support.js";
import { groupCreatedArticles } from "./grouping-service.js";
import { groupProfile } from "./storyline-link.js";
import { linkGroup, type LinkerConfig } from "./storyline-linker.js";
import { reofferJoinedGroups } from "./storyline-rejoin-trigger.js";

/**
 * The membership-change re-offer (`storyline-rejoin-trigger.ts`).
 *
 * Against real Postgres, because the fact under test is one only storage holds:
 * a group's profile is the MAJORITY of its member articles' tokens, re-aggregated
 * on every read, so "the group changed" is a claim about rows rather than about
 * anything the caller passed in.
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
  coherenceGate: false,
  narrowRetrieval: false,
  maxBridgingQualifiers: undefined,
  storyDf: { windowDays: 14, timeZone: "UTC" },
  timeZone: "UTC",
};

/**
 * Five rare tokens. Any TWO of them carry mass 13.4 and any FIVE carry 33.4
 * against a 16,000-article window, which straddles the floor of 20 — that gap is
 * what makes "the join widened the profile" observable rather than asserted.
 */
const NARROW = ["fausto", "swell"];
const WIDE = [...NARROW, "genevieve", "hawaii", "surf"];

let nextArticle = 0;

/** One article row, and the group of one it seeds. */
async function article(input: {
  tokens: string[];
  title?: string;
  description?: string | null;
  groupId?: string;
}): Promise<{ id: string; groupId: string; published: Date }> {
  nextArticle += 1;
  const published = `${DAY}T09:0${nextArticle % 10}:00Z`;
  const { rows } = await sql<{ id: string; group_id: string }>`
    insert into articles (
      dedup_key, url, title, description, language, categories, source_category,
      published, latest_seen, sighting_count, story_tokens, title_tokens
    ) values (
      decode(${String(nextArticle).padStart(64, "0")}, 'hex'),
      ${`https://example.test/${nextArticle}`},
      ${input.title ?? input.tokens.join(" ")},
      ${input.description ?? null},
      'en', '{}', '{}', ${published}, ${published}, 1,
      ${input.tokens}, ${input.tokens}
    ) returning id, group_id
  `.execute(db);
  const row = rows[0]!;
  if (input.groupId !== undefined) {
    await sql`
      update articles set group_id = ${input.groupId}::bigint
      where id = ${row.id}::bigint
    `.execute(db);
  }
  return {
    id: row.id,
    groupId: input.groupId ?? row.group_id,
    published: new Date(published),
  };
}

/** A window in which every token here sits far under the anchor ceiling of 32. */
async function seedCorpus(tokens: readonly string[]): Promise<void> {
  await db
    .insertInto("story_corpus_days")
    .values({ day: DAY, language: "en", articles: 16_000 })
    .execute();
  await db
    .insertInto("story_token_days")
    .values(tokens.map((token) => ({ day: DAY, language: "en", token, df: 20 })))
    .execute();
}

/** A real, promoted, two-group arc carrying the whole WIDE vocabulary. */
async function arc(): Promise<string> {
  const first = await article({ tokens: WIDE, title: "Arc one" });
  const second = await article({ tokens: WIDE, title: "Arc two" });
  const storyline = await createProvisionalStoryline(db, {
    groupId: first.groupId,
    timeZone: "UTC",
  });
  await attachGroup(db, {
    storylineId: storyline.id,
    groupId: second.groupId,
    timeZone: "UTC",
  });
  await promoteStoryline(db, { storylineId: storyline.id });
  return storyline.id;
}

const deps = () => ({ db, config: CONFIG });

describe("a group whose own membership changed", () => {
  it("joins the arc its widened majority profile now qualifies for", async () => {
    await seedCorpus(WIDE);
    const target = await arc();

    // Born narrow: two rare tokens is mass 13.4 against a floor of 20, so the
    // linker's own verdict at birth is "not this arc".
    const seed = await article({ tokens: NARROW, title: "Fausto swell" });
    const birth = await linkGroup(deps(), {
      groupId: seed.groupId,
      memberTokens: [NARROW],
      language: "en",
      published: seed.published,
    });
    expect(birth.attached).toBe(false);
    expect(await readGroupStorylines(db, seed.groupId)).toEqual([birth.storylineId]);

    // An arrival joins the group and carries the rest of the vocabulary. With
    // two members the majority rule needs one, so the profile is the union.
    await article({ tokens: WIDE, title: "Fausto swell", groupId: seed.groupId });

    const outcomes = await reofferJoinedGroups(deps(), [seed.groupId]);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.attached).toBe(true);
    expect(await readGroupStorylines(db, seed.groupId)).toEqual([target]);
    // The birth storyline is an alias, not a corpse: a UUID a reader may hold
    // keeps resolving (ADR-0011).
    expect(await resolveStoryline(db, birth.storylineId)).toBe(target);
  });

  it("is asked even when the join left the majority profile byte-identical", async () => {
    await seedCorpus(WIDE);
    await arc();

    const seed = await article({ tokens: WIDE, title: "Fausto swell" });
    await linkGroup(deps(), {
      groupId: seed.groupId,
      memberTokens: [WIDE],
      language: "en",
      published: seed.published,
    });

    // The trap §4 of the research names, at the GROUP layer: with two members
    // `groupProfile` needs support from one, so an arrival carrying a subset of
    // what the group already said changes the profile not at all. A trigger
    // predicated on "the profile tokens diffed" would skip this group; the
    // predicate is "an article joined it", which is a membership fact.
    await article({ tokens: NARROW, title: "Fausto swell", groupId: seed.groupId });
    // Sorted on both sides because `groupProfile` only sorts the multi-member
    // path — the comparison that matters is the SET the retrieval overlaps and
    // the evidence sums, and it is identical.
    expect([...groupProfile([WIDE, NARROW])].sort()).toEqual([...groupProfile([WIDE])].sort());

    const outcomes = await reofferJoinedGroups(deps(), [seed.groupId]);
    expect(outcomes.map((outcome) => outcome.groupId)).toEqual([seed.groupId]);
  });

  it("offers an enlarged group once, however many of a batch's articles joined it", async () => {
    await seedCorpus(WIDE);
    const seed = await article({ tokens: NARROW, title: "Fausto swell" });
    await article({ tokens: WIDE, title: "Fausto swell", groupId: seed.groupId });
    await article({ tokens: WIDE, title: "Fausto swell", groupId: seed.groupId });

    const outcomes = await reofferJoinedGroups(deps(), [
      seed.groupId,
      seed.groupId,
      seed.groupId,
    ]);
    expect(outcomes).toHaveLength(1);
  });

  it("takes ONE retroactive arc, exactly as the nightly sweep does", async () => {
    await seedCorpus(WIDE);
    const first = await arc();
    const second = await arc();

    // Already homed in `first`, and qualifying for `second` as well.
    const seed = await article({ tokens: WIDE, title: "Fausto swell" });
    await linkGroup(deps(), {
      groupId: seed.groupId,
      memberTokens: [WIDE],
      language: "en",
      published: seed.published,
    });
    expect(await readGroupStorylines(db, seed.groupId)).toEqual([first]);

    await article({ tokens: WIDE, title: "Fausto swell", groupId: seed.groupId });
    await reofferJoinedGroups(deps(), [seed.groupId]);
    const after = await readGroupStorylines(db, seed.groupId);
    expect(after).toHaveLength(2);
    expect(after).toContain(second);

    // And the second offer gains nothing: `existing.length === 1` is what opens
    // the retroactive door, so a group that walked through it cannot walk again.
    // Without this the trigger would percolate faster than the sweep it fronts.
    await article({ tokens: WIDE, title: "Fausto swell", groupId: seed.groupId });
    await reofferJoinedGroups(deps(), [seed.groupId]);
    expect(await readGroupStorylines(db, seed.groupId)).toEqual(after);
  });

  it("never throws — a group it cannot read is a group standing where it stood", async () => {
    await seedCorpus(WIDE);
    const warnings: object[] = [];
    const log = { warn: (obj: object) => warnings.push(obj) };

    // A group id no `bigint` cast will accept: the read fails, not the caller.
    await expect(
      reofferJoinedGroups({ db, config: CONFIG, log }, ["not-a-group"]),
    ).resolves.toEqual([]);
    expect(warnings).toHaveLength(1);

    // A group id that is merely absent is not an error at all.
    await expect(
      reofferJoinedGroups({ db, config: CONFIG, log }, ["999999999"]),
    ).resolves.toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("does nothing with the linker off", async () => {
    await seedCorpus(WIDE);
    await arc();
    const seed = await article({ tokens: WIDE, title: "Fausto swell" });
    await expect(
      reofferJoinedGroups(
        { db, config: { ...CONFIG, enabled: false } },
        [seed.groupId],
      ),
    ).resolves.toEqual([]);
    expect(await readGroupStorylines(db, seed.groupId)).toEqual([]);
  });
});

describe("the trigger on the ingest path", () => {
  /**
   * The wiring, through `groupCreatedArticles`: grouping decides the join, and
   * the tail is where the re-offer happens. `labelTail` is kept so the test
   * awaits the tail rather than asserting against a dropped promise.
   */
  async function ingestJoiningArticle(reoffer: boolean): Promise<string> {
    const target = await arc();
    const seed = await article({ tokens: NARROW, title: "Fausto swell" });
    await linkGroup(deps(), {
      groupId: seed.groupId,
      memberTokens: [NARROW],
      language: "en",
      published: seed.published,
    });

    // The arrival grouping will match to `seed`: same headline, same day. Its
    // story tokens come from the real tokenizer over title AND description,
    // which is what widens the group's profile to the whole WIDE vocabulary.
    const joiner = await article({
      tokens: [],
      title: "Fausto swell",
      description: "Genevieve hawaii surf",
    });
    const created: CreatedArticle[] = [
      {
        id: joiner.id,
        title: "Fausto swell",
        description: "Genevieve hawaii surf",
        language: "en",
        published: joiner.published,
      },
    ];

    const tails: Promise<void>[] = [];
    const grouped = await groupCreatedArticles(
      {
        db,
        config: {
          enabled: true,
          threshold: 0.5,
          timeZone: "UTC",
          linker: CONFIG,
          ...(reoffer ? { reofferJoinedGroups: true } : {}),
        },
        labelTail: (task) => tails.push(task),
      },
      created,
    );
    expect(grouped).toBe(1);
    await Promise.all(tails);
    return target;
  }

  it("re-offers the group the arrival joined", async () => {
    await seedCorpus(WIDE);
    const target = await ingestJoiningArticle(true);
    const [seedGroup] = await sql<{ group_id: string }>`
      select distinct group_id from articles where title = 'Fausto swell'
    `.execute(db).then((result) => result.rows.map((row) => row.group_id));
    expect(await readGroupStorylines(db, seedGroup!)).toEqual([target]);
  });

  it("leaves the enlarged group for the nightly sweep with the knob off", async () => {
    await seedCorpus(WIDE);
    const target = await ingestJoiningArticle(false);
    const [seedGroup] = await sql<{ group_id: string }>`
      select distinct group_id from articles where title = 'Fausto swell'
    `.execute(db).then((result) => result.rows.map((row) => row.group_id));
    const homes = await readGroupStorylines(db, seedGroup!);
    expect(homes).toHaveLength(1);
    expect(homes).not.toContain(target);
  });
});
