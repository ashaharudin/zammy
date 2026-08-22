import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  countStorylinesSharingLabelWords,
  readStoryline,
  resolveStoryline,
} from "@zammy/storage";
import { createTestHarness, type TestHarness } from "./test-support.js";
import { mergeCollidingLabels } from "./storyline-label-merge-trigger.js";
import { labelKey, labelWords } from "./storyline-label-merge.js";
import type { LabelOutcome } from "./storyline-label-service.js";
import type { TextGenerator } from "./gemini.js";

/**
 * The collision-triggered label merge against real Postgres, for the
 * merge-service tests' reason: what can be wrong here is the interaction —
 * the GIN pre-check agreeing with the planner's bucketing, a survivor's
 * relabel landing on a name another live arc already holds, and the loop
 * following it there.
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

const RULES = { graceDays: 7, maxComponent: 25 };
const TZ = "UTC";

let nextArticle = 0;

/** A labelled, promoted storyline with coverage — the merge-service test's shape. */
async function labelledStoryline(input: {
  label: string;
  labelSource?: string | null;
  status?: "active" | "provisional";
  articles: { title: string; description: string; published: string }[];
}): Promise<string> {
  // `label_words` folded the way `setStorylineLabel` writes them, because the
  // GIN pre-check reads them: a fixture whose words disagree with its label
  // would test a state the labeler never produces.
  const { rows: created } = await sql<{ id: string }>`
    insert into storylines (label, label_source, label_words, status, profile_tokens)
    values (${input.label},
            ${input.labelSource === undefined ? "gemini-3.1-flash-lite" : input.labelSource},
            ${labelWords(input.label)}::text[], ${input.status ?? "active"}, '{}')
    returning id
  `.execute(db);
  const storylineId = created[0]!.id;

  for (const article of input.articles) {
    nextArticle += 1;
    const { rows } = await sql<{ id: string }>`
      insert into articles (
        dedup_key, url, title, description, language, categories, source_category,
        published, latest_seen, sighting_count, story_tokens
      ) values (
        decode(${String(nextArticle).padStart(64, "0")}, 'hex'),
        ${`https://example.test/${nextArticle}`}, ${article.title}, ${article.description},
        'en', '{}', '{}', ${article.published}, ${article.published}, 1, '{}'
      ) returning id, group_id
    `.execute(db);
    const groupId = rows[0]!.id;
    await sql`
      insert into storyline_groups (storyline_id, group_id) values (${storylineId}::uuid, ${groupId})
    `.execute(db);
    await sql`
      insert into storyline_days (storyline_id, day_key, day_slot_published, lead_article_id)
      values (${storylineId}::uuid, ${article.published.slice(0, 10)}, ${article.published}, ${groupId})
      on conflict do nothing
    `.execute(db);
  }
  return storylineId;
}

/** Hormuz coverage: "Hormuz" and "Strait" are never written lowercase. */
function hormuz(day: string, n: number) {
  return {
    title: `Iran and Oman near a deal to reopen the Strait of Hormuz`,
    description:
      `Talks over the Strait of Hormuz continued in Muscat on day ${n}. ` +
      `Officials said Iran and Oman were close to an arrangement for the strait.`,
    published: `2026-08-${day}T09:0${n % 10}:00Z`,
  };
}

/** Earnings coverage: every label word appears lowercase in the prose. */
function earnings(day: string, company: string, n: number) {
  return {
    title: `${company} Reports Q2 2026 Financial Results`,
    description:
      `The company posted its q2 2026 financial results this morning. ` +
      `Quarterly revenue rose and the financial results beat estimates.`,
    published: `2026-08-${day}T09:0${n % 10}:00Z`,
  };
}

/** A batch outcome as `labelLinkedStorylines` returns one. */
function wrote(storylineId: string, label: string, source: LabelOutcome["source"] = "model"): LabelOutcome {
  return { storylineId, label, source, trigger: "promotion", groupCount: 2 };
}

describe("countStorylinesSharingLabelWords", () => {
  it("counts live model-labelled holders and nothing else", async () => {
    await labelledStoryline({ label: "Strait of Hormuz Crisis", articles: [hormuz("02", 1)] });
    await labelledStoryline({ label: "Strait of Hormuz Crisis", articles: [hormuz("03", 2)] });
    // Word order does not matter: the same bag is the same label.
    await labelledStoryline({ label: "Hormuz Strait of Crisis", articles: [hormuz("04", 3)] });
    // None of these can collide: not a model label, not promoted, not live.
    await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      labelSource: "bigram",
      articles: [hormuz("05", 4)],
    });
    await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      status: "provisional",
      articles: [hormuz("06", 5)],
    });

    const words = labelKey("Strait of Hormuz Crisis").split(" ");
    expect(await countStorylinesSharingLabelWords(db, words)).toBe(3);
    expect(await countStorylinesSharingLabelWords(db, [])).toBe(0);
  });
});

describe("mergeCollidingLabels", () => {
  it("merges a collision the moment the second label is written", async () => {
    const big = await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("02", 1), hormuz("05", 2), hormuz("09", 3)],
    });
    const small = await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("13", 4), hormuz("14", 5)],
    });

    const report = await mergeCollidingLabels(
      { db, rules: RULES, timeZone: TZ, threshold: 2 },
      [wrote(small, "Strait of Hormuz Crisis")],
    );

    expect(report).toEqual({ checked: 1, fired: 1, merged: 1, rounds: 1 });
    expect(await resolveStoryline(db, small)).toBe(big);
  });

  it("does not fire below the threshold", async () => {
    await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("02", 1), hormuz("05", 2)],
    });
    const second = await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("06", 3)],
    });

    const report = await mergeCollidingLabels(
      { db, rules: RULES, timeZone: TZ, threshold: 3 },
      [wrote(second, "Strait of Hormuz Crisis")],
    );

    expect(report).toEqual({ checked: 1, fired: 0, merged: 0, rounds: 0 });
    expect(await resolveStoryline(db, second)).toBe(second);
  });

  it("is off at threshold 0, and counts nothing", async () => {
    await labelledStoryline({ label: "Strait of Hormuz Crisis", articles: [hormuz("02", 1)] });
    const second = await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("03", 2)],
    });

    const report = await mergeCollidingLabels(
      { db, rules: RULES, timeZone: TZ, threshold: 0 },
      [wrote(second, "Strait of Hormuz Crisis")],
    );

    expect(report).toEqual({ checked: 0, fired: 0, merged: 0, rounds: 0 });
    expect(await resolveStoryline(db, second)).toBe(second);
  });

  it("ignores outcomes the model did not write", async () => {
    await labelledStoryline({ label: "Strait of Hormuz Crisis", articles: [hormuz("02", 1)] });
    const second = await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("03", 2)],
    });

    const report = await mergeCollidingLabels(
      { db, rules: RULES, timeZone: TZ, threshold: 2 },
      [
        wrote(second, "Strait of Hormuz Crisis", "bigram"),
        { storylineId: second, label: null, source: "skipped", trigger: "drift", groupCount: 1 },
      ],
    );

    expect(report).toEqual({ checked: 0, fired: 0, merged: 0, rounds: 0 });
    expect(await resolveStoryline(db, second)).toBe(second);
  });

  it("fires and is refused by the grounding guard — the trigger changes when, never whether", async () => {
    const one = await labelledStoryline({
      label: "Q2 2026 Financial Results",
      articles: [earnings("02", "CVB Financial Corp", 1), earnings("05", "Mitsui", 2)],
    });
    const two = await labelledStoryline({
      label: "Q2 2026 Financial Results",
      articles: [earnings("06", "Mayfair Gold", 3)],
    });

    const report = await mergeCollidingLabels(
      { db, rules: RULES, timeZone: TZ, threshold: 2 },
      [wrote(two, "Q2 2026 Financial Results")],
    );

    expect(report.fired).toBe(1);
    expect(report.merged).toBe(0);
    expect(await resolveStoryline(db, one)).toBe(one);
    expect(await resolveStoryline(db, two)).toBe(two);
  });

  it("follows a survivor relabelled into another live storyline's name", async () => {
    // Two arcs share one name; a third holds the name the relabel will land
    // on. Round one merges the pair, the model re-names the survivor onto the
    // third's label, and round two must follow it there — the two-pass
    // convergence observed by hand on 2026-08-21.
    const a = await labelledStoryline({
      label: "Hormuz Strait Standoff",
      articles: [hormuz("02", 1), hormuz("05", 2)],
    });
    const b = await labelledStoryline({
      label: "Hormuz Strait Standoff",
      articles: [hormuz("06", 3), hormuz("07", 4)],
    });
    const c = await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("08", 5), hormuz("09", 6)],
    });

    const generator: TextGenerator = {
      generate: async () => ({ ok: true, text: "Strait of Hormuz Crisis" }),
    };
    const report = await mergeCollidingLabels(
      {
        db,
        rules: RULES,
        timeZone: TZ,
        threshold: 2,
        labeler: { generator, modelId: "gemini-test", sampleSize: 10, driftFactor: 2 },
      },
      [wrote(b, "Hormuz Strait Standoff")],
    );

    expect(report.rounds).toBe(2);
    expect(report.merged).toBe(2);
    const survivor = await resolveStoryline(db, a);
    expect(await resolveStoryline(db, b)).toBe(survivor);
    expect(await resolveStoryline(db, c)).toBe(survivor);
    expect((await readStoryline(db, survivor!))?.label).toBe("Strait of Hormuz Crisis");
  });
});
