import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { readStorylineDaySummaries, type SummaryCandidateDay } from "@zammy/storage";
import { createTestHarness, type TestHarness } from "./test-support.js";
import type { GenerateRequest, GenerateResult, TextGenerator } from "./gemini.js";
import {
  decideSpan,
  summarizeStorylineDay,
  summaryPass,
  type SummarizerDeps,
} from "./storyline-summary-service.js";

/**
 * The historical preserve's behaviour (ADR-0022): what gets written, what gets
 * rewritten, and — the half that is easy to get wrong — what does NOT.
 *
 * Real Postgres and a stub model. The model is stubbed because what is under
 * test is the DECISION to call it, not the call (`gemini.test.ts` owns that);
 * the database is real because every decision here reads rows, and the two
 * facts that matter most — an empty quarter is no row, a refusal is a row with
 * no sentence — are indistinguishable to anything that fakes the storage.
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

let nextArticle = 0;

beforeEach(async () => {
  await sql`
    truncate storylines, storyline_groups, storyline_days, storyline_bridges,
             storyline_day_summaries, story_token_days, story_corpus_days,
             articles cascade
  `.execute(db);
  nextArticle = 0;
});

/** A stub model: answers from a queue, and records every prompt it was given. */
function stub(answers: Array<string | null>): TextGenerator & { prompts: string[] } {
  const prompts: string[] = [];
  let index = 0;
  return {
    prompts,
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      prompts.push(request.prompt);
      // Past the end of the queue it keeps answering with the last entry, so a
      // test that only cares about the first two calls need not spell them all.
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return answer === null || answer === undefined
        ? { ok: false, reason: "stubbed refusal" }
        : { ok: true, text: answer };
    },
  };
}

const NOW = new Date("2026-08-15T05:00:00.000Z");

function deps(
  generator: TextGenerator | null,
  overrides: Partial<SummarizerDeps> = {},
): SummarizerDeps {
  return {
    db,
    generator,
    modelId: "gemma-test",
    sampleSize: 8,
    maxAttempts: 3,
    settlingDays: 3,
    recomputeDelta: 4,
    cliffDays: 8,
    now: () => NOW,
    ...overrides,
  };
}

/** An article at an exact instant, in a named group. */
async function article(publishedAt: string, groupId?: string): Promise<string> {
  nextArticle += 1;
  const { rows } = await sql<{ id: string; group_id: string }>`
    insert into articles (
      dedup_key, url, title, description, language, categories, source_category,
      published, latest_seen, sighting_count, story_tokens
    ) values (
      decode(${String(nextArticle).padStart(64, "0")}, 'hex'),
      ${`https://fixture.example/${nextArticle}`},
      ${`Headline ${nextArticle}`},
      ${`Body ${nextArticle}`},
      'en', '{}', '{}',
      ${publishedAt}::timestamptz, ${publishedAt}::timestamptz, 1, '{bigbend,wall}'
    ) returning id, group_id
  `.execute(db);
  const row = rows[0]!;
  if (groupId !== undefined) {
    await sql`update articles set group_id = ${groupId} where id = ${row.id}`.execute(db);
    return groupId;
  }
  return row.group_id;
}

/** A promoted, labelled arc over the given groups. */
async function arc(groupIds: string[], label = "Big Bend Wall Pause"): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    insert into storylines (label, status) values (${label}, 'active') returning id
  `.execute(db);
  const id = rows[0]!.id;
  for (const groupId of groupIds) {
    await sql`
      insert into storyline_groups (storyline_id, group_id) values (${id}::uuid, ${groupId})
    `.execute(db);
  }
  return id;
}

const candidate = (
  storylineId: string,
  dayKey: string,
  extra: Partial<SummaryCandidateDay> = {},
): SummaryCandidateDay => ({
  storylineId,
  dayKey,
  articleCount: 6,
  groupCount: 2,
  label: "Big Bend Wall Pause",
  ...extra,
});

const rowsFor = (storylineId: string, dayKey: string) =>
  readStorylineDaySummaries(db, { storylineId, dayKey });

/**
 * A day with coverage in the night, the morning and the evening — and NOTHING
 * in the afternoon, which is the case the whole feature is specified around.
 */
async function seedThreeQuarters(): Promise<string> {
  const a = await article("2026-08-14T02:00:00Z");
  await article("2026-08-14T07:00:00Z", a);
  await article("2026-08-14T08:00:00Z", a);
  const b = await article("2026-08-14T09:00:00Z");
  await article("2026-08-14T20:00:00Z", b);
  await article("2026-08-14T21:00:00Z", b);
  return arc([a, b]);
}

describe("summarizing one storyline-day", () => {
  it("writes a sentence per populated quarter and one for the day, and nothing for the empty one", async () => {
    const id = await seedThreeQuarters();
    const model = stub(["Night words.", "Morning words.", "Evening words.", "Day words."]);

    const outcome = await summarizeStorylineDay(deps(model), candidate(id, "2026-08-14"));

    expect(outcome.written).toBe(4);
    expect(outcome.modelCalls).toBe(4);
    const rows = await rowsFor(id, "2026-08-14");
    expect(rows.map((row) => row.segment).sort()).toEqual([
      "day",
      "evening",
      "morning",
      "night",
    ]);
    // The afternoon is ABSENT, not null: no row is how "no articles" is spelled.
    expect(rows.find((row) => row.segment === "afternoon")).toBeUndefined();
    expect(rows.find((row) => row.segment === "day")?.summary).toBe("Day words.");
  });

  it("builds the day sentence from the quarters' sentences, not from the headlines", async () => {
    const id = await seedThreeQuarters();
    const model = stub(["Night words.", "Morning words.", "Evening words.", "Day words."]);

    await summarizeStorylineDay(deps(model), candidate(id, "2026-08-14"));

    const dayPrompt = model.prompts[3]!;
    expect(dayPrompt).toContain("night (00:00-06:00 UTC): Night words.");
    expect(dayPrompt).toContain("evening (18:00-24:00 UTC): Evening words.");
    // The cost argument, asserted: the day call is four sentences, not the day's
    // coverage over again.
    expect(dayPrompt).not.toContain("Headline");
  });

  it("copies the label onto every row, because labels drift", async () => {
    const id = await seedThreeQuarters();
    await summarizeStorylineDay(deps(stub(["A sentence."])), candidate(id, "2026-08-14"));

    await sql`update storylines set label = 'Renamed Later' where id = ${id}::uuid`.execute(db);

    const rows = await sql<{ label: string }>`
      select label from storyline_day_summaries where storyline_id = ${id}::uuid
    `.execute(db);
    expect(rows.rows.every((row) => row.label === "Big Bend Wall Pause")).toBe(true);
  });

  it("records a refusal as a row with no sentence, and retries it until the cap", async () => {
    const id = await seedThreeQuarters();
    const refusing = deps(stub([null]));

    await summarizeStorylineDay(refusing, candidate(id, "2026-08-14"));
    let night = (await rowsFor(id, "2026-08-14")).find((row) => row.segment === "night");
    expect(night).toMatchObject({ summary: null, attempts: 1 });

    await summarizeStorylineDay(refusing, candidate(id, "2026-08-14"));
    night = (await rowsFor(id, "2026-08-14")).find((row) => row.segment === "night");
    expect(night?.attempts).toBe(2);

    await summarizeStorylineDay(refusing, candidate(id, "2026-08-14"));
    // Three asks, and then it stops paying: a fourth run makes no call at all.
    const fourth = await summarizeStorylineDay(refusing, candidate(id, "2026-08-14"));
    expect(fourth.modelCalls).toBe(0);
    expect(
      (await rowsFor(id, "2026-08-14")).find((row) => row.segment === "night")?.attempts,
    ).toBe(3);
  });

  it("costs nothing to re-run over work that is already current", async () => {
    const id = await seedThreeQuarters();
    await summarizeStorylineDay(deps(stub(["A sentence."])), candidate(id, "2026-08-14"));

    const second = stub(["Should never be asked."]);
    const outcome = await summarizeStorylineDay(deps(second), candidate(id, "2026-08-14"));

    expect(outcome.modelCalls).toBe(0);
    expect(second.prompts).toEqual([]);
    expect(outcome.skipped).toBe(4);
  });
});

describe("the settling window and the recompute delta", () => {
  it("rewrites a quarter that gained more than the delta, inside the window", async () => {
    const id = await seedThreeQuarters();
    await summarizeStorylineDay(deps(stub(["First."])), candidate(id, "2026-08-14"));

    // Five more articles land in the evening: 2 becomes 7, a gain of 5.
    const [group] = await sql<{ group_id: string }>`
      select group_id from storyline_groups where storyline_id = ${id}::uuid limit 1
    `.execute(db).then((result) => result.rows);
    for (let i = 0; i < 5; i += 1) {
      await article("2026-08-14T22:00:00Z", group!.group_id);
    }

    const model = stub(["Second."]);
    const outcome = await summarizeStorylineDay(deps(model), candidate(id, "2026-08-14"));

    expect(outcome.recomputed).toBeGreaterThan(0);
    const evening = (await rowsFor(id, "2026-08-14")).find((row) => row.segment === "evening");
    expect(evening?.summary).toBe("Second.");
    expect(evening?.articleCount).toBe(7);
    // And the day is rewritten with it: the sentences it was built from moved.
    expect((await rowsFor(id, "2026-08-14")).find((row) => row.segment === "day")?.summary).toBe(
      "Second.",
    );
  });

  it("leaves a quarter that gained exactly the delta alone", async () => {
    const id = await seedThreeQuarters();
    await summarizeStorylineDay(deps(stub(["First."])), candidate(id, "2026-08-14"));

    const [group] = await sql<{ group_id: string }>`
      select group_id from storyline_groups where storyline_id = ${id}::uuid limit 1
    `.execute(db).then((result) => result.rows);
    // Four more, which is the delta and not MORE than it.
    for (let i = 0; i < 4; i += 1) {
      await article("2026-08-14T22:00:00Z", group!.group_id);
    }

    const model = stub(["Second."]);
    const outcome = await summarizeStorylineDay(deps(model), candidate(id, "2026-08-14"));

    expect(outcome.modelCalls).toBe(0);
    expect(model.prompts).toEqual([]);
  });

  it("freezes a day past the settling window however much it gains", async () => {
    const id = await seedThreeQuarters();
    await summarizeStorylineDay(deps(stub(["First."])), candidate(id, "2026-08-14"));

    const [group] = await sql<{ group_id: string }>`
      select group_id from storyline_groups where storyline_id = ${id}::uuid limit 1
    `.execute(db).then((result) => result.rows);
    for (let i = 0; i < 40; i += 1) {
      await article("2026-08-14T22:00:00Z", group!.group_id);
    }

    // Five days later: the day closed on the 15th, so it is four days old.
    const later = deps(stub(["Should never be asked."]), {
      now: () => new Date("2026-08-19T05:00:00.000Z"),
    });
    const outcome = await summarizeStorylineDay(later, candidate(id, "2026-08-14"));

    expect(outcome.modelCalls).toBe(0);
    expect((await rowsFor(id, "2026-08-14")).find((row) => row.segment === "evening")?.summary)
      .toBe("First.");
  });

  it("still allows a FIRST write for a day older than the window", async () => {
    // The slow-building story: it only clears the article bar on its fourth day,
    // and excluding it for ever is the opposite of what a preserve is for.
    const id = await seedThreeQuarters();
    const late = deps(stub(["Late but written."]), {
      now: () => new Date("2026-08-20T05:00:00.000Z"),
    });

    const outcome = await summarizeStorylineDay(late, candidate(id, "2026-08-14"));

    expect(outcome.written).toBeGreaterThan(0);
  });
});

describe("the pubDate cliff", () => {
  it("summarises a day past the cliff whole, from its articles, and marks it", async () => {
    const id = await seedThreeQuarters();
    const model = stub(["The whole day."]);
    // 2026-08-14 closed on the 15th; at 05:00 on the 24th it is nine days old.
    const old = deps(model, { now: () => new Date("2026-08-24T05:00:00.000Z") });

    const outcome = await summarizeStorylineDay(old, candidate(id, "2026-08-14"));

    const rows = await rowsFor(id, "2026-08-14");
    expect(rows.map((row) => row.segment)).toEqual(["day"]);
    expect(rows[0]).toMatchObject({ summary: "The whole day.", segmented: false });
    expect(outcome.modelCalls).toBe(1);
    // The articles path, not the segments path — there are no quarters to build
    // from, and inventing four sentences off a collapsed timestamp would be
    // inventing a shape the data does not have.
    expect(model.prompts[0]).toContain("Headline");
    expect(model.prompts[0]).toContain("coverage from 2026-08-14 (UTC)");
  });

  it("leaves quarters written while the day was fresh exactly where they are", async () => {
    const id = await seedThreeQuarters();
    await summarizeStorylineDay(deps(stub(["Fresh."])), candidate(id, "2026-08-14"));

    const old = deps(stub(["Later."]), { now: () => new Date("2026-08-24T05:00:00.000Z") });
    await summarizeStorylineDay(old, candidate(id, "2026-08-14"));

    const rows = await rowsFor(id, "2026-08-14");
    // They were honest when they were written; ageing does not make them false.
    expect(rows.filter((row) => row.segment !== "day")).toHaveLength(3);
    expect(rows.every((row) => row.summary === "Fresh.")).toBe(true);
  });
});

describe("a refusal never destroys a sentence that stands", () => {
  it("keeps the older sentence and bumps attempts when a rewrite is refused", async () => {
    const id = await seedThreeQuarters();
    await summarizeStorylineDay(deps(stub(["The good sentence."])), candidate(id, "2026-08-14"));

    const [group] = await sql<{ group_id: string }>`
      select group_id from storyline_groups where storyline_id = ${id}::uuid limit 1
    `.execute(db).then((result) => result.rows);
    for (let i = 0; i < 6; i += 1) {
      await article("2026-08-14T22:00:00Z", group!.group_id);
    }

    await summarizeStorylineDay(deps(stub([null])), candidate(id, "2026-08-14"));

    const evening = (await rowsFor(id, "2026-08-14")).find((row) => row.segment === "evening");
    expect(evening?.summary).toBe("The good sentence.");
    expect(evening?.attempts).toBe(1);
    // The count is NOT advanced, so the rewrite is still owed and will be
    // retried — a night the API was down must not silently retire the work.
    expect(evening?.articleCount).toBe(2);
  });
});

describe("with no model configured", () => {
  it("writes nothing at all, and is not a failure", async () => {
    const id = await seedThreeQuarters();
    const outcome = await summarizeStorylineDay(deps(null), candidate(id, "2026-08-14"));
    expect(outcome).toMatchObject({ written: 0, modelCalls: 0, refused: 0 });
    expect(await rowsFor(id, "2026-08-14")).toEqual([]);
  });
});

describe("decideSpan", () => {
  const base = {
    articleCount: 10,
    withinSettlingWindow: true,
    recomputeDelta: 4,
    maxAttempts: 3,
  };
  const stored = (over: Partial<{ summary: string | null; articleCount: number; attempts: number }>) => ({
    segment: "night" as const,
    summary: "A sentence." as string | null,
    articleCount: 10,
    attempts: 0,
    segmented: true,
    modelId: "gemma-test",
    generatedAt: NOW,
    ...over,
  });

  it("writes when there is no row, whatever the window says", () => {
    expect(decideSpan({ ...base, existing: undefined, withinSettlingWindow: false })).toBe(
      "write",
    );
  });

  it("retries a refusal regardless of the window, until the cap", () => {
    expect(
      decideSpan({ ...base, existing: stored({ summary: null }), withinSettlingWindow: false }),
    ).toBe("retry");
    expect(
      decideSpan({ ...base, existing: stored({ summary: null, attempts: 3 }) }),
    ).toBe("skip");
  });

  it("recomputes only inside the window AND past the delta", () => {
    expect(decideSpan({ ...base, existing: stored({ articleCount: 5 }) })).toBe("recompute");
    expect(decideSpan({ ...base, existing: stored({ articleCount: 6 }) })).toBe("skip");
    expect(
      decideSpan({
        ...base,
        existing: stored({ articleCount: 5 }),
        withinSettlingWindow: false,
      }),
    ).toBe("skip");
  });
});

describe("the pass", () => {
  it("stops at the model-call ceiling and resumes on the next run", async () => {
    const id = await seedThreeQuarters();
    const model = stub(["A sentence."]);
    const options = {
      from: new Date("2026-08-01T00:00:00Z"),
      to: NOW,
      minArticlesExclusive: 4,
      minGroups: 2,
      ratePerMinute: 0,
      now: () => NOW,
    };

    const first = await summaryPass(deps(model), { ...options, maxSummaries: 2 });
    expect(first.model).toBe(2);
    expect(first.stoppedBy).toBe("max-summaries");
    expect(await rowsFor(id, "2026-08-14")).toHaveLength(2);

    const second = await summaryPass(deps(model), { ...options, maxSummaries: 10 });
    expect(second.stoppedBy).toBe("exhausted");
    // The two the first run could not reach, plus the day.
    expect(await rowsFor(id, "2026-08-14")).toHaveLength(4);
  });

  it("says so rather than failing when there is no model", async () => {
    await seedThreeQuarters();
    const tally = await summaryPass(deps(null), {
      from: new Date("2026-08-01T00:00:00Z"),
      to: NOW,
      minArticlesExclusive: 4,
      minGroups: 2,
    });
    expect(tally).toMatchObject({ stoppedBy: "no-model", days: 0, model: 0 });
  });

  it("skips the days that do not clear the bar", async () => {
    // Five articles in ONE group: over the volume bar, under the sources bar.
    const solo = await article("2026-08-14T09:00:00Z");
    for (let i = 0; i < 5; i += 1) await article("2026-08-14T09:30:00Z", solo);
    await arc([solo], "One Telling Repeated");

    const model = stub(["Never asked."]);
    const tally = await summaryPass(deps(model), {
      from: new Date("2026-08-01T00:00:00Z"),
      to: NOW,
      minArticlesExclusive: 4,
      minGroups: 2,
      ratePerMinute: 0,
    });
    expect(tally.days).toBe(0);
    expect(model.prompts).toEqual([]);
  });
});
