import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { readGroupStorylines, readStorylineStats } from "@zammy/storage";
import { createTestHarness, type TestHarness } from "./test-support.js";
import type { LinkerConfig } from "./storyline-linker.js";
import { backfillStorylines } from "./storyline-backfill.js";
import type { GenerateRequest, GenerateResult } from "./gemini.js";

/**
 * The full-history backfill (ADR-0011's Rollout, S5).
 *
 * What is worth testing here is not "does the linker link" — that is
 * `storyline-linker.test.ts`, and this deliberately runs the same `linkGroup`
 * rather than a copy. It is the three claims a backfill makes that a linker
 * does not:
 *
 *   chronological       — replay order is the canonical order
 *   resumable           — interrupted twice, the result is the uninterrupted one
 *   idempotent          — re-running over finished work changes nothing
 *
 * Against real Postgres, because the resume cursor is a SQL question about the
 * join table and a fake would answer it from the wrong place.
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
  nextArticle = 0;
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

const deps = () => ({ db, config: CONFIG });

let nextArticle = 0;

/** An article, which is a group of one until grouping says otherwise. */
async function article(input: {
  tokens: string[];
  publishedAt?: string;
  language?: string | null;
}): Promise<string> {
  nextArticle += 1;
  const published = input.publishedAt ?? `${DAY}T09:${String(nextArticle % 60).padStart(2, "0")}:00Z`;
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
  return rows[0]!.id;
}

/** The same corpus shape the linker's own tests use: ceiling 32, floor 20. */
async function seedCorpus(input: {
  rare?: string[];
  common?: string[];
  /** The day the corpus covers; the trailing window is read relative to it. */
  day?: string;
}): Promise<void> {
  const day = input.day ?? DAY;
  await db
    .insertInto("story_corpus_days")
    .values({ day, language: "en", articles: 16_000 })
    .execute();
  const rows = [
    ...(input.rare ?? []).map((token) => ({ day, language: "en", token, df: 20 })),
    ...(input.common ?? []).map((token) => ({ day, language: "en", token, df: 2_000 })),
  ];
  if (rows.length > 0) await db.insertInto("story_token_days").values(rows).execute();
}

const STORY = ["fausto", "hawaii", "surf", "swell", "genevieve"];
const OTHER = ["kalgoorlie", "nickel", "smelter", "tailings", "wyalkatchem"];

/** Two storylines' worth of coverage: five groups on one story, three on another. */
async function seedArchive(): Promise<void> {
  await seedCorpus({ rare: [...STORY, ...OTHER] });
  for (let i = 0; i < 5; i += 1) {
    await article({ tokens: STORY, publishedAt: `${DAY}T09:0${i}:00Z` });
  }
  for (let i = 0; i < 3; i += 1) {
    await article({ tokens: OTHER, publishedAt: `${DAY}T10:0${i}:00Z` });
  }
}

/** A shape of the built world that two runs can be compared on. */
async function shape(): Promise<Array<{ groups: number; days: number }>> {
  const { rows } = await sql<{ groups: string; days: string }>`
    select
      (select count(*) from storyline_groups g where g.storyline_id = s.id) as groups,
      (select count(*) from storyline_days d where d.storyline_id = s.id) as days
    from storylines s
    where s.merged_into is null
    order by groups desc, days desc, s.id
  `.execute(db);
  return rows.map((row) => ({ groups: Number(row.groups), days: Number(row.days) }));
}

describe("the backfill", () => {
  it("builds storylines, joins and day slots from an archive with none", async () => {
    await seedArchive();

    const report = await backfillStorylines(deps(), { skipLabels: true });

    expect(report.linked).toBe(8);
    expect(report.failures).toBe(0);
    expect(report.incomplete).toBe(false);
    // Five groups of one story and three of another: two promoted storylines,
    // every group linked, and a day slot each because it all happened on one
    // day.
    const stats = await readStorylineStats(db);
    expect(stats.linkedGroups).toBe(8);
    expect(stats.promoted).toBe(2);
    expect(stats.largestStoryline).toBe(5);
    expect(stats.daySlots).toBe(2);
  });

  it("reads groups whose members carry different numbers of tokens", async () => {
    // Postgres refuses to build a 2-D array from rows of unequal length, and
    // member articles differ constantly — a headline with a description
    // carries more tokens than one without. The first run of this against the
    // real archive died on exactly that, where every fixture here had been
    // uniform.
    await seedCorpus({ rare: STORY });
    const seed = await article({ tokens: STORY, publishedAt: `${DAY}T09:00:00Z` });
    const short = await article({ tokens: ["fausto"], publishedAt: `${DAY}T09:01:00Z` });
    const long = await article({
      tokens: [...STORY, "kauai", "lifeguard", "advisory"],
      publishedAt: `${DAY}T09:02:00Z`,
    });
    // One group of three members, each with a different token count.
    await sql`update articles set group_id = ${seed} where id in (${short}, ${long})`.execute(db);

    const report = await backfillStorylines(deps(), { skipLabels: true });

    expect(report.failures).toBe(0);
    expect(report.linked).toBe(1);
    expect((await readStorylineStats(db)).linkedGroups).toBe(1);
  });

  it("takes one fresh slot per day a storyline has coverage", async () => {
    await seedCorpus({ rare: STORY });
    await article({ tokens: STORY, publishedAt: `${DAY}T09:00:00Z` });
    await article({ tokens: STORY, publishedAt: "2026-08-12T09:00:00Z" });
    await article({ tokens: STORY, publishedAt: "2026-08-13T09:00:00Z" });
    // The corpus has to cover the later days too, or their rarity lookups come
    // back empty and the linker correctly refuses to decide.
    await db
      .insertInto("story_corpus_days")
      .values([
        { day: "2026-08-12", language: "en", articles: 16_000 },
        { day: "2026-08-13", language: "en", articles: 16_000 },
      ])
      .execute();

    await backfillStorylines(deps(), { skipLabels: true });

    const stats = await readStorylineStats(db);
    expect(stats.promoted).toBe(1);
    expect(stats.largestStoryline).toBe(3);
    expect(stats.daySlots).toBe(3);
  });

  it("stamps dormancy at the end of the run, so a replay of old history is not all active", async () => {
    // A fresh replay of a five-month archive would otherwise leave every
    // storyline it built marked `active` until the first nightly sweep fires —
    // for hours, and for the whole first day if the backfill runs after 3am.
    const MARCH = "2026-03-02";
    await seedCorpus({ rare: STORY, day: MARCH });
    for (let i = 0; i < 3; i += 1) {
      await article({ tokens: STORY, publishedAt: `${MARCH}T09:0${i}:00Z` });
    }

    const report = await backfillStorylines(deps(), {
      skipLabels: true,
      now: () => new Date("2026-08-14T03:00:00.000Z"),
    });

    expect(report.dormant).toBe(1);
    const live = await db
      .selectFrom("storylines")
      .select("status")
      .where("merged_into", "is", null)
      .execute();
    expect(live.map((row) => row.status)).toEqual(["dormant"]);
  });

  describe("resuming", () => {
    it("reaches the same world as an uninterrupted run", async () => {
      await seedArchive();
      await backfillStorylines(deps(), { skipLabels: true });
      const uninterrupted = await shape();

      // Same archive, built in three interrupted goes.
      await sql`
        truncate storylines, storyline_groups, storyline_days, storyline_bridges cascade
      `.execute(db);
      let runs = 0;
      for (;;) {
        const report = await backfillStorylines(deps(), {
          skipLabels: true,
          maxGroups: 3,
          batchSize: 2,
        });
        runs += 1;
        if (!report.incomplete) break;
        if (runs > 10) throw new Error("resume made no progress");
      }

      expect(runs).toBeGreaterThan(1);
      expect(await shape()).toEqual(uninterrupted);
    });

    it("re-runs the group it stopped on, rather than skipping it", async () => {
      // A run can die between a group's birth and its bridges. Resuming from
      // the group AFTER the last linked one would leave that gap for ever;
      // `linkGroup` is idempotent so re-running it is free and completes it.
      await seedArchive();
      const first = await backfillStorylines(deps(), {
        skipLabels: true,
        maxGroups: 4,
        batchSize: 4,
      });
      expect(first.incomplete).toBe(true);

      const second = await backfillStorylines(deps(), { skipLabels: true, batchSize: 4 });

      // 8 groups, 4 in the first run — the second run re-does the 4th and
      // finishes the rest.
      expect(second.linked).toBe(5);
      expect((await readStorylineStats(db)).linkedGroups).toBe(8);
    });

    it("changes nothing when re-run over finished work", async () => {
      await seedArchive();
      await backfillStorylines(deps(), { skipLabels: true });
      const before = await shape();

      const again = await backfillStorylines(deps(), { skipLabels: true });

      expect(again.attached).toBe(0);
      expect(again.merges).toBe(0);
      expect(await shape()).toEqual(before);
    });

    it("stops at a group boundary when cancelled, and resumes from there", async () => {
      await seedArchive();
      const controller = new AbortController();
      let seen = 0;

      const report = await backfillStorylines(deps(), {
        skipLabels: true,
        batchSize: 2,
        onProgress: () => {
          seen += 1;
          if (seen === 2) controller.abort();
        },
        signal: controller.signal,
      });

      expect(report.incomplete).toBe(true);
      expect(report.linked).toBeLessThan(8);
      // Whatever it reached is COMPLETE work, not a half-written group.
      for (const row of await sql<{ group_id: string }>`
        select distinct group_id from storyline_groups
      `.execute(db).then((r) => r.rows)) {
        expect(await readGroupStorylines(db, row.group_id)).not.toHaveLength(0);
      }

      await backfillStorylines(deps(), { skipLabels: true });
      expect((await readStorylineStats(db)).linkedGroups).toBe(8);
    });

    it("wipes and rebuilds under --restart", async () => {
      await seedArchive();
      await backfillStorylines(deps(), { skipLabels: true });
      const before = await shape();

      const report = await backfillStorylines(deps(), { skipLabels: true, restart: true });

      // Every group linked again, from nothing — same world, rebuilt.
      expect(report.linked).toBe(8);
      expect(await shape()).toEqual(before);
    });
  });

  it("refuses to run against an empty trailing corpus", async () => {
    // The silent-failure case: with no df rows every rarity decision is
    // refused, so the backfill would report "8 storylines, 0 promoted" and
    // look like a threshold problem rather than a missing command.
    await article({ tokens: STORY });

    await expect(backfillStorylines(deps(), { skipLabels: true })).rejects.toThrow(
      /trailing corpus is empty/,
    );
  });

  describe("the labelling pass", () => {
    /**
     * Prompt-aware on purpose: a label must be GROUNDED in the coverage it
     * names (S4), so a stub answering "Fausto Hawaii Swell" for the nickel
     * storyline would be refused by validation and fall back — which is the
     * validator working, and would make this test measure the wrong thing.
     */
    const generator = () => ({
      calls: 0,
      prompts: [] as string[],
      async generate(request: GenerateRequest): Promise<GenerateResult> {
        this.calls += 1;
        this.prompts.push(request.prompt);
        return {
          ok: true,
          text: request.prompt.includes("fausto")
            ? "Fausto Hawaii Swell"
            : "Kalgoorlie Nickel Smelter",
        };
      },
    });

    const labeler = (gen: { generate: (r: GenerateRequest) => Promise<GenerateResult> } | null) => ({
      generator: gen,
      modelId: "test-flash",
      sampleSize: 10,
      driftFactor: 2,
    });

    it("labels promoted storylines and leaves provisional ones alone", async () => {
      await seedArchive();
      const gen = generator();

      const report = await backfillStorylines(
        { ...deps(), labeler: labeler(gen) },
        { sleep: async () => {} },
      );

      // Two promoted storylines, two calls — the provisional storylines-of-one
      // are invisible and have nothing to name.
      expect(gen.calls).toBe(2);
      expect(report.labelled.model).toBe(2);
      // Each prompt carried its own storyline's coverage, which is what makes
      // the grounded label possible at all.
      expect(gen.prompts.some((prompt) => prompt.includes("fausto"))).toBe(true);
      expect(gen.prompts.some((prompt) => prompt.includes("kalgoorlie"))).toBe(true);
      const stats = await readStorylineStats(db);
      expect(stats.labelled).toBe(2);
      expect(stats.promoted).toBe(2);
    });

    it("is resumable: a second pass asks the model nothing", async () => {
      await seedArchive();
      await backfillStorylines(
        { ...deps(), labeler: labeler(generator()) },
        { sleep: async () => {} },
      );

      const second = generator();
      const report = await backfillStorylines(
        { ...deps(), labeler: labeler(second) },
        { sleep: async () => {} },
      );

      expect(second.calls).toBe(0);
      expect(report.labelled.skipped).toBe(2);
    });

    it("spaces its MODEL calls, because a full archive is a burst of them", async () => {
      await seedArchive();
      const waits: number[] = [];

      await backfillStorylines(
        { ...deps(), labeler: labeler(generator()) },
        { labelRatePerMinute: 30, sleep: async (ms) => void waits.push(ms) },
      );

      // Two labels, one gap: the first call does not wait for a rate limit it
      // has not used yet.
      expect(waits).toEqual([2000]);
    });

    it("does not rate-limit the fallback, which calls nothing", async () => {
      // Measured the hard way on the dev archive: with no key configured the
      // labeller spaced 2,781 pure-CPU extractor runs a second apart and would
      // have taken 46 minutes to do a second of work.
      await seedArchive();
      const waits: number[] = [];

      await backfillStorylines(
        { ...deps(), labeler: labeler(null) },
        { labelRatePerMinute: 30, sleep: async (ms) => void waits.push(ms) },
      );

      expect(waits).toEqual([]);
    });

    it("labels from the extractor when there is no model configured", async () => {
      await seedArchive();

      const report = await backfillStorylines(
        { ...deps(), labeler: labeler(null) },
        { sleep: async () => {} },
      );

      expect(report.labelled.model).toBe(0);
      expect(report.labelled.bigram + report.labelled.none).toBe(2);
    });

    it("relabels everything on demand, for when the model config changed", async () => {
      // The drift rule refuses to re-name what it has already named, which is
      // right and makes "I have configured a real model now" unsayable: every
      // storyline the fallback labelled would be skipped for ever.
      await seedArchive();
      await backfillStorylines(
        { ...deps(), labeler: labeler(null) },
        { sleep: async () => {} },
      );

      const gen = generator();
      const report = await backfillStorylines(
        { ...deps(), labeler: labeler(gen) },
        { labelsOnly: true, relabel: true, sleep: async () => {} },
      );

      expect(gen.calls).toBe(2);
      expect(report.labelled.model).toBe(2);
      expect(report.labelled.skipped).toBe(0);
    });

    it("records what produced each label", async () => {
      await seedArchive();
      await backfillStorylines(
        { ...deps(), labeler: labeler(generator()) },
        { sleep: async () => {} },
      );

      const { rows } = await sql<{ label_source: string | null; n: string }>`
        select label_source, count(*) as n from storylines
        where merged_into is null and label is not null group by 1
      `.execute(db);
      expect(rows).toEqual([{ label_source: "test-flash", n: "2" }]);
    });

    it("resumes a relabel campaign instead of re-spending it", async () => {
      // THE BUG this column exists for. `--relabel` used to ignore every skip
      // condition, so a five-hour campaign that died at hour four started over
      // from the top and paid the whole bill again — the one flag long enough
      // to need resume was the only one without it.
      await seedArchive();
      await backfillStorylines(
        { ...deps(), labeler: labeler(null) },
        { sleep: async () => {} },
      );

      // Campaign, interrupted after one storyline.
      const first = generator();
      await backfillStorylines(
        { ...deps(), labeler: labeler(first) },
        { labelsOnly: true, relabel: true, maxLabels: 1, sleep: async () => {} },
      );
      expect(first.calls).toBe(1);

      // Resumed: it asks the model about the ONE storyline still on the
      // fallback, not about both.
      const second = generator();
      const report = await backfillStorylines(
        { ...deps(), labeler: labeler(second) },
        { labelsOnly: true, relabel: true, sleep: async () => {} },
      );

      expect(second.calls).toBe(1);
      expect(report.labelled.model).toBe(1);
      expect(report.labelled.skipped).toBe(1);
    });

    it("does nothing on a relabel campaign that already finished", async () => {
      await seedArchive();
      await backfillStorylines(
        { ...deps(), labeler: labeler(generator()) },
        { labelsOnly: false, relabel: true, sleep: async () => {} },
      );

      const again = generator();
      const report = await backfillStorylines(
        { ...deps(), labeler: labeler(again) },
        { labelsOnly: true, relabel: true, sleep: async () => {} },
      );

      expect(again.calls).toBe(0);
      expect(report.labelled.skipped).toBe(2);
    });

    it("relabels model labels too when the configured model changes", async () => {
      // Upgrading from one model to a better one is the same operation as
      // upgrading from the fallback, which is why provenance is the model ID
      // and not a `model | bigram` enum.
      await seedArchive();
      await backfillStorylines(
        { ...deps(), labeler: labeler(generator()) },
        { relabel: true, sleep: async () => {} },
      );

      const newer = generator();
      const report = await backfillStorylines(
        { ...deps(), labeler: { ...labeler(newer), modelId: "test-flash-2" } },
        { labelsOnly: true, relabel: true, sleep: async () => {} },
      );

      expect(newer.calls).toBe(2);
      expect(report.labelled.skipped).toBe(0);
    });

    it("re-names everything under --relabel-all, provenance regardless", async () => {
      // The rarer intent: a PROMPT change, where every label is stale however
      // it was produced.
      await seedArchive();
      await backfillStorylines(
        { ...deps(), labeler: labeler(generator()) },
        { relabel: true, sleep: async () => {} },
      );

      const again = generator();
      const report = await backfillStorylines(
        { ...deps(), labeler: labeler(again) },
        { labelsOnly: true, relabelAll: true, sleep: async () => {} },
      );

      expect(again.calls).toBe(2);
      expect(report.labelled.skipped).toBe(0);
    });

    it("can run alone, over storylines an earlier run linked", async () => {
      await seedArchive();
      await backfillStorylines(deps(), { skipLabels: true });
      const gen = generator();

      const report = await backfillStorylines(
        { ...deps(), labeler: labeler(gen) },
        { labelsOnly: true, sleep: async () => {} },
      );

      expect(report.linked).toBe(0);
      expect(gen.calls).toBe(2);
    });
  });
});
