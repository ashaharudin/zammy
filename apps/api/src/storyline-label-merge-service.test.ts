import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  readLabelMergeCandidates,
  readStoryline,
  readStorylineDays,
  resolveStoryline,
  setStorylineLabel,
} from "@zammy/storage";
import { createTestHarness, type TestHarness } from "./test-support.js";
import {
  mergeAgreeingLabels,
  planLabelMerges,
} from "./storyline-label-merge-service.js";

/**
 * The label-agreement merge against real Postgres.
 *
 * Against a real database because what can be wrong here is the interaction
 * between the decision and the writes it implies: the candidate query's
 * label_source filter, spans read off `storyline_days`, the proper-noun corpus
 * assembled from member articles, and a merge that has to leave the loser
 * resolving to the survivor. A fake would fake all four.
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

/**
 * A storyline holding `articles`, labelled and promoted — the shape this pass
 * reads. Descriptions carry the prose the proper-noun test needs: a name is a
 * word capitalized mid-sentence and never seen lowercase.
 */
async function labelledStoryline(input: {
  label: string;
  labelSource?: string | null;
  status?: "active" | "provisional";
  articles: { title: string; description: string; published: string }[];
}): Promise<string> {
  const { rows: created } = await sql<{ id: string }>`
    insert into storylines (label, label_source, status, profile_tokens)
    values (${input.label}, ${input.labelSource === undefined ? "gemini-3.1-flash-lite" : input.labelSource},
            ${input.status ?? "active"}, '{}')
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

/** Hormuz coverage: "Hormuz" is never written lowercase, so it is a name. */
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

describe("readLabelMergeCandidates", () => {
  it("returns model-labelled live storylines with their spans", async () => {
    const id = await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("02", 1), hormuz("06", 2)],
    });

    const rows = await readLabelMergeCandidates(db);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.groupCount).toBe(2);
    expect(rows[0]!.spanFrom.toISOString()).toContain("2026-08-02");
    expect(rows[0]!.spanTo.toISOString()).toContain("2026-08-06");
  });

  it("excludes bigram labels, unlabelled rows, provisionals and aliases", async () => {
    await labelledStoryline({
      label: "Strait Hormuz",
      labelSource: "bigram",
      articles: [hormuz("02", 1)],
    });
    await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      labelSource: null,
      articles: [hormuz("03", 2)],
    });
    await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      status: "provisional",
      articles: [hormuz("04", 3)],
    });

    expect(await readLabelMergeCandidates(db)).toEqual([]);
  });

  it("excludes a storyline with no day slots — no coverage is no span", async () => {
    await labelledStoryline({ label: "Strait of Hormuz Crisis", articles: [] });
    expect(await readLabelMergeCandidates(db)).toEqual([]);
  });
});

describe("mergeAgreeingLabels", () => {
  it("merges arcs that agree on a grounded name", async () => {
    const big = await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("02", 1), hormuz("05", 2), hormuz("09", 3)],
    });
    const small = await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("13", 4), hormuz("14", 5)],
    });

    const report = await mergeAgreeingLabels({ db, rules: RULES, timeZone: TZ });

    expect(report.sharedLabels).toBe(1);
    expect(report.merged).toBe(1);
    expect(report.refusals).toEqual([]);
    // More groups wins, and the loser keeps resolving — a reader's URL must
    // never dangle (ADR-0011).
    expect(await resolveStoryline(db, small)).toBe(big);
    expect((await readStoryline(db, small))?.mergedInto).toBe(big);
    // The survivor's day slots now span coverage neither arc held alone.
    const days = await readStorylineDays(db, big);
    expect(days).toHaveLength(5);
  });

  it("refuses a cluster whose label grounds no name", async () => {
    const one = await labelledStoryline({
      label: "Q2 2026 Financial Results",
      articles: [earnings("02", "CVB Financial Corp", 1), earnings("05", "Mitsui", 2)],
    });
    const two = await labelledStoryline({
      label: "Q2 2026 Financial Results",
      articles: [earnings("06", "Mayfair Gold", 3), earnings("07", "Westaim", 4)],
    });

    const report = await mergeAgreeingLabels({ db, rules: RULES, timeZone: TZ });

    expect(report.merged).toBe(0);
    expect(report.refusals).toEqual([
      { label: "q2 2026 financial result", storylines: 2, reason: "no grounded name" },
    ]);
    expect(await resolveStoryline(db, one)).toBe(one);
    expect(await resolveStoryline(db, two)).toBe(two);
  });

  it("leaves two same-named stories apart when their spans do not touch", async () => {
    const january = await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [
        { ...hormuz("02", 1), published: "2026-01-02T09:00:00Z" },
        { ...hormuz("03", 2), published: "2026-01-03T09:00:00Z" },
      ],
    });
    const august = await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("14", 3), hormuz("15", 4)],
    });

    const report = await mergeAgreeingLabels({ db, rules: RULES, timeZone: TZ });

    expect(report.merged).toBe(0);
    expect(await resolveStoryline(db, january)).toBe(january);
    expect(await resolveStoryline(db, august)).toBe(august);
  });

  it("is idempotent — a second run has nothing left to merge", async () => {
    await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("02", 1), hormuz("05", 2)],
    });
    await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("06", 3), hormuz("07", 4)],
    });

    const first = await mergeAgreeingLabels({ db, rules: RULES, timeZone: TZ });
    const second = await mergeAgreeingLabels({ db, rules: RULES, timeZone: TZ });

    expect(first.merged).toBe(1);
    expect(second.merged).toBe(0);
    expect(second.sharedLabels).toBe(0);
  });

  it("collapses six arcs into one, as the archive's Hormuz cluster does", async () => {
    const ids: string[] = [];
    for (const [from, to] of [
      ["02", "17"],
      ["03", "14"],
      ["04", "17"],
      ["13", "14"],
      ["14", "17"],
      ["17", "17"],
    ]) {
      ids.push(
        await labelledStoryline({
          label: "Strait of Hormuz Crisis",
          articles: [hormuz(from, ids.length + 1), hormuz(to, ids.length + 2)],
        }),
      );
    }

    const report = await mergeAgreeingLabels({ db, rules: RULES, timeZone: TZ });

    expect(report.merged).toBe(5);
    expect(report.survivors).toHaveLength(1);
    const survivor = report.survivors[0]!.winnerId;
    for (const id of ids) expect(await resolveStoryline(db, id)).toBe(survivor);
  });

  it("plans without writing, and the plan is what the run performs", async () => {
    await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("02", 1), hormuz("05", 2)],
    });
    const second = await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("06", 3), hormuz("07", 4)],
    });

    const planned = await planLabelMerges({ db, rules: RULES });
    expect(planned.plans).toHaveLength(1);
    expect(planned.plans[0]!.loserIds).toEqual([second]);
    // Nothing was written.
    expect(await resolveStoryline(db, second)).toBe(second);

    const report = await mergeAgreeingLabels({ db, rules: RULES, timeZone: TZ });
    expect(report.merged).toBe(1);
    expect(await resolveStoryline(db, second)).not.toBe(second);
  });

  it("does not merge on a label the model did not write", async () => {
    // Sixteen arcs called "Strait Hormuz" by the bigram extractor is the case
    // that must NOT collapse: that is shared vocabulary, which is the anchor
    // rule's business, not a shared judgement about what the story is.
    const one = await labelledStoryline({
      label: "Strait Hormuz",
      labelSource: "bigram",
      articles: [hormuz("02", 1), hormuz("05", 2)],
    });
    const two = await labelledStoryline({
      label: "Strait Hormuz",
      labelSource: "bigram",
      articles: [hormuz("06", 3), hormuz("07", 4)],
    });

    const report = await mergeAgreeingLabels({ db, rules: RULES, timeZone: TZ });

    expect(report.sharedLabels).toBe(0);
    expect(report.merged).toBe(0);
    expect(await resolveStoryline(db, one)).toBe(one);
    expect(await resolveStoryline(db, two)).toBe(two);
  });

  it("survives a label written by a previous model id", async () => {
    // "not bigram" rather than "equals the configured model": switching models
    // must not silently empty the candidate set.
    await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      labelSource: "gemini-2.9-flash",
      articles: [hormuz("02", 1), hormuz("05", 2)],
    });
    await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      labelSource: "gemini-3.1-flash-lite",
      articles: [hormuz("06", 3), hormuz("07", 4)],
    });

    const report = await mergeAgreeingLabels({ db, rules: RULES, timeZone: TZ });
    expect(report.merged).toBe(1);
  });

  it("relabels the survivor when a labeler is supplied", async () => {
    const big = await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("02", 1), hormuz("05", 2), hormuz("09", 3)],
    });
    await labelledStoryline({
      label: "Strait of Hormuz Crisis",
      articles: [hormuz("13", 4), hormuz("14", 5)],
    });
    await setStorylineLabel(db, {
      storylineId: big,
      label: "Strait of Hormuz Crisis",
      groupCount: 3,
      source: "gemini-3.1-flash-lite",
    });

    const report = await mergeAgreeingLabels({
      db,
      rules: RULES,
      timeZone: TZ,
      // No generator: the fallback extractor names it, which is enough to prove
      // the survivor was re-labelled over its ENLARGED membership.
      labeler: { generator: null, sampleSize: 10, driftFactor: 2 },
    });

    expect(report.merged).toBe(1);
    const survivor = await readStoryline(db, report.survivors[0]!.winnerId);
    expect(survivor?.labelGroupCount).toBe(5);
  });
});
