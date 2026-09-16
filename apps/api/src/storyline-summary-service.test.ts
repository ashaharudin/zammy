import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { readStorylineDaySummaries, type SummaryCandidateDay } from "@zammy/storage";
import { createTestHarness, type TestHarness } from "./test-support.js";
import type { GenerateRequest, GenerateResult, TextGenerator } from "./gemini.js";
import {
  decideSpan,
  summarizeStorylineDay,
  summaryPass,
  type CallGate,
  type SummarizerDeps,
} from "./storyline-summary-service.js";

/**
 * The historical preserve's behaviour (ADR-0023): what gets written, what gets
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

/**
 * A stub model: answers from a queue, and records every prompt it was given.
 *
 * Three kinds of answer, because the service distinguishes three and the
 * distinction is load-bearing:
 *
 *   "a sentence."           the model answered usably
 *   { unusable: "..." }     the model ANSWERED and the answer fails the
 *                           contract — a refusal, which costs an attempt
 *   null                    the call never reached an answer (429, 503,
 *                           timeout, or the pacer refusing to queue) — which
 *                           must cost NOTHING
 */
type StubAnswer =
  | string
  | null
  | { unusable: string }
  | { failure: "unreachable" | "answered"; reason: string };

function stub(answers: StubAnswer[]): TextGenerator & { prompts: string[] } {
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
      if (answer === null || answer === undefined) {
        return { ok: false, reason: "stubbed transport failure", failure: "unreachable" };
      }
      if (typeof answer === "object") {
        return "unusable" in answer
          ? { ok: true, text: answer.unusable }
          : { ok: false, reason: answer.reason, failure: answer.failure };
      }
      return { ok: true, text: answer };
    },
  };
}

/** An answer that arrives and fails the one-sentence contract. */
const UNUSABLE = { unusable: "One sentence. And then a second one." };

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
    const refusing = deps(stub([UNUSABLE]));

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

  it("does not replay the first ask when it retries a refusal", async () => {
    // Measured live: a refused answer re-asked at temperature 0 came back
    // byte-identical and one character over the cap again. The retry budget
    // would be spent re-reading the same refusal and the span retired for a
    // sentence the model could easily have written shorter.
    const id = await seedThreeQuarters();
    const temperatures: Array<number | undefined> = [];
    const watching: TextGenerator = {
      async generate(request: GenerateRequest) {
        temperatures.push(request.temperature);
        return { ok: true as const, text: "One sentence. And a second." };
      },
    };

    await summarizeStorylineDay(deps(watching), candidate(id, "2026-08-14"));
    // Every first ask is deterministic: the same coverage should name the same
    // day on a replay.
    expect(temperatures.every((value) => value === undefined)).toBe(true);

    temperatures.length = 0;
    await summarizeStorylineDay(deps(watching), candidate(id, "2026-08-14"));
    expect(temperatures.length).toBeGreaterThan(0);
    expect(temperatures.every((value) => typeof value === "number" && value > 0)).toBe(true);
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

/**
 * `ok: false` is not one thing, and treating it as one is the bug that hides
 * behind a passing suite: the client returns it for a safety block and for a
 * timeout alike, and only the first is the model's verdict on the span.
 */
describe("a blocked or empty answer is a refusal, not an outage", () => {
  const BLOCKED = { failure: "answered" as const, reason: "blocked: SAFETY" };
  const EMPTY = { failure: "answered" as const, reason: "empty (MAX_TOKENS)" };

  it("counts a safety block against the span", async () => {
    const id = await seedThreeQuarters();
    const outcome = await summarizeStorylineDay(deps(stub([BLOCKED])), candidate(id, "2026-08-14"));

    expect(outcome.refused).toBeGreaterThan(0);
    expect(outcome.unavailable).toBe(0);
    // A row, so the refusal is visible and bounded. Asking a blocked prompt
    // again gets the same block, which is what the attempt cap is for.
    const night = (await rowsFor(id, "2026-08-14")).find((row) => row.segment === "night");
    expect(night).toMatchObject({ summary: null, attempts: 1 });
  });

  it("counts a candidate that answered nothing against the span too", async () => {
    const id = await seedThreeQuarters();
    const outcome = await summarizeStorylineDay(deps(stub([EMPTY])), candidate(id, "2026-08-14"));
    expect(outcome.refused).toBeGreaterThan(0);
    expect(outcome.unavailable).toBe(0);
  });

  it("does not stop the pass, the way a run of real outages does", async () => {
    // The circuit breaker is for "the API is down", and a storyline whose
    // headlines trip the safety filter is not that. Left misclassified, the
    // oldest-first walk would halt at the same day every night and every day
    // newer than it would age out of the window unwritten.
    const id = await seedThreeQuarters();
    const [group] = await sql<{ group_id: string }>`
      select group_id from storyline_groups where storyline_id = ${id}::uuid limit 1
    `.execute(db).then((result) => result.rows);
    for (let i = 0; i < 6; i += 1) await article("2026-08-13T09:00:00Z", group!.group_id);
    const other = await article("2026-08-13T10:00:00Z");
    await sql`
      insert into storyline_groups (storyline_id, group_id) values (${id}::uuid, ${other})
    `.execute(db);

    const tally = await summaryPass(deps(stub([BLOCKED])), {
      from: new Date("2026-08-01T00:00:00Z"),
      to: NOW,
      minArticlesExclusive: 4,
      minGroups: 2,
      ratePerMinute: 0,
      now: () => NOW,
    });

    expect(tally.stoppedBy).toBe("exhausted");
    expect(tally.days).toBe(2);
    expect(tally.unavailable).toBe(0);
  });
});

describe("segmented never lies about a day that has quarters", () => {
  it("keeps segmented true when a day row is retried past the cliff", async () => {
    const id = await seedThreeQuarters();
    // Fresh: the quarters are written, the day itself refuses.
    await summarizeStorylineDay(
      deps(stub(["Night.", "Morning.", "Evening.", UNUSABLE])),
      candidate(id, "2026-08-14"),
    );

    // Nine days later the retry succeeds — past the cliff.
    await summarizeStorylineDay(
      deps(stub(["The day, at last."]), { now: () => new Date("2026-08-24T05:00:00.000Z") }),
      candidate(id, "2026-08-14"),
    );

    const rows = await rowsFor(id, "2026-08-14");
    const day = rows.find((row) => row.segment === "day");
    expect(day?.summary).toBe("The day, at last.");
    // `segmented: false` means "we could not tell when this day's coverage
    // landed", and three quarter sentences sitting beside it say otherwise.
    expect(day?.segmented).toBe(true);
  });

  it("marks a day whose every quarter was REFUSED as unsegmented", async () => {
    const id = await seedThreeQuarters();
    // Fresh, and nothing answers: three null quarter rows and a null day row.
    await summarizeStorylineDay(deps(stub([UNUSABLE])), candidate(id, "2026-08-14"));

    // Nine days later the day itself is retried and answers.
    await summarizeStorylineDay(
      deps(stub(["The whole day."]), { now: () => new Date("2026-08-24T05:00:00.000Z") }),
      candidate(id, "2026-08-14"),
    );

    const day = (await rowsFor(id, "2026-08-14")).find((row) => row.segment === "day");
    expect(day?.summary).toBe("The whole day.");
    // Quarter ROWS exist, but none of them carries a sentence — so nothing
    // here places this day's coverage in time, which is what `false` says.
    expect(day?.segmented).toBe(false);
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

    await summarizeStorylineDay(deps(stub([UNUSABLE])), candidate(id, "2026-08-14"));

    const evening = (await rowsFor(id, "2026-08-14")).find((row) => row.segment === "evening");
    expect(evening?.summary).toBe("The good sentence.");
    expect(evening?.attempts).toBe(1);
    // The count is NOT advanced, so the rewrite is still owed and will be
    // retried — a night the API was down must not silently retire the work.
    expect(evening?.articleCount).toBe(2);
  });
});

/**
 * An outage must not retire a span. Collapsing "the model declined" into "we
 * could not ask" is how three nights of 429s take every span in the window to
 * `maxAttempts` without the model having declined a single one — after which
 * the days age out of the window and the preserve for that week is never
 * written.
 */
describe("unreachable is not refused", () => {
  it("writes nothing and costs no attempt when the call never lands", async () => {
    const id = await seedThreeQuarters();
    const down = deps(stub([null]));

    const outcome = await summarizeStorylineDay(down, candidate(id, "2026-08-14"));

    expect(outcome.unavailable).toBeGreaterThan(0);
    expect(outcome.refused).toBe(0);
    // No row at all — not a row with attempts: 1. The span stands where it
    // stood and the next run asks again.
    expect(await rowsFor(id, "2026-08-14")).toEqual([]);
  });

  it("does not consume the attempt budget over repeated outages", async () => {
    const id = await seedThreeQuarters();
    const down = deps(stub([null]));

    for (let night = 0; night < 5; night += 1) {
      await summarizeStorylineDay(down, candidate(id, "2026-08-14"));
    }
    // Five nights of outage, and the span is still askable — which is the whole
    // point. Under the collapsed behaviour it would have been retired on night
    // three, for ever.
    const recovered = await summarizeStorylineDay(
      deps(stub(["The API came back."])),
      candidate(id, "2026-08-14"),
    );
    expect(recovered.written).toBe(4);
  });

  it("leaves a standing sentence untouched when a rewrite cannot be sent", async () => {
    const id = await seedThreeQuarters();
    await summarizeStorylineDay(deps(stub(["The good sentence."])), candidate(id, "2026-08-14"));

    const [group] = await sql<{ group_id: string }>`
      select group_id from storyline_groups where storyline_id = ${id}::uuid limit 1
    `.execute(db).then((result) => result.rows);
    for (let i = 0; i < 6; i += 1) await article("2026-08-14T22:00:00Z", group!.group_id);

    await summarizeStorylineDay(deps(stub([null])), candidate(id, "2026-08-14"));

    const evening = (await rowsFor(id, "2026-08-14")).find((row) => row.segment === "evening");
    expect(evening?.summary).toBe("The good sentence.");
    // Not even an attempt: an outage says nothing about this span.
    expect(evening?.attempts).toBe(0);
  });

  it("stops the pass once the model has been unreachable for a run of asks", async () => {
    // Otherwise a night of 429s spends the whole ceiling discovering that the
    // API is still down. Two qualifying days, so the run of unreachable asks
    // has to cross a day boundary to reach the limit — which is the case the
    // counter is written for.
    const id = await seedThreeQuarters();
    const [group] = await sql<{ group_id: string }>`
      select group_id from storyline_groups where storyline_id = ${id}::uuid limit 1
    `.execute(db).then((result) => result.rows);
    for (let i = 0; i < 6; i += 1) await article("2026-08-13T09:00:00Z", group!.group_id);
    const other = await article("2026-08-13T10:00:00Z");
    await sql`
      insert into storyline_groups (storyline_id, group_id) values (${id}::uuid, ${other})
    `.execute(db);

    const model = stub([null]);
    const tally = await summaryPass(deps(model), {
      from: new Date("2026-08-01T00:00:00Z"),
      to: NOW,
      minArticlesExclusive: 4,
      minGroups: 2,
      maxSummaries: 500,
      ratePerMinute: 0,
      now: () => NOW,
    });

    expect(tally.stoppedBy).toBe("unavailable");
    expect(tally.model).toBeLessThan(500);
  });
});

/**
 * The day sentence must follow its quarters even past the settling window,
 * because a quarter can legitimately change there: a first write of a quarter
 * that had no row, and a successful retry of a refusal, both ignore the window
 * by design.
 */
describe("the day follows its quarters", () => {
  const AGED = { now: () => new Date("2026-08-20T05:00:00.000Z") };

  it("rewrites a frozen day when a NEW quarter appears under it", async () => {
    const id = await seedThreeQuarters();
    await summarizeStorylineDay(deps(stub(["First."])), candidate(id, "2026-08-14"));

    // A late group lands afternoon coverage on a day that had none.
    const [group] = await sql<{ group_id: string }>`
      select group_id from storyline_groups where storyline_id = ${id}::uuid limit 1
    `.execute(db).then((result) => result.rows);
    await article("2026-08-14T14:00:00Z", group!.group_id);

    await summarizeStorylineDay(deps(stub(["Second."]), AGED), candidate(id, "2026-08-14"));

    const rows = await rowsFor(id, "2026-08-14");
    expect(rows.find((row) => row.segment === "afternoon")?.summary).toBe("Second.");
    // The day was rewritten WITH it. Left frozen, it would describe a day one
    // of whose quarters it has never seen.
    expect(rows.find((row) => row.segment === "day")?.summary).toBe("Second.");
  });

  it("rewrites a frozen day when a refused quarter is finally written", async () => {
    const id = await seedThreeQuarters();
    // The evening refuses; the day is written from what the others gave.
    await summarizeStorylineDay(
      deps(stub(["Night.", "Morning.", UNUSABLE, "Day."])),
      candidate(id, "2026-08-14"),
    );
    expect((await rowsFor(id, "2026-08-14")).find((row) => row.segment === "day")?.summary).toBe(
      "Day.",
    );

    await summarizeStorylineDay(deps(stub(["Retried."]), AGED), candidate(id, "2026-08-14"));

    const rows = await rowsFor(id, "2026-08-14");
    expect(rows.find((row) => row.segment === "evening")?.summary).toBe("Retried.");
    expect(rows.find((row) => row.segment === "day")?.summary).toBe("Retried.");
  });

  it("remembers across runs that a quarter outran the day", async () => {
    // The force is in memory for the length of one call, and the pass can stop
    // between the quarters and the day — on the budget or the ceiling, which is
    // what actually stops a healthy night. Without a durable check the flag is
    // gone by the next run, the quarter is current, and a frozen day keeps a
    // sentence that omits a quarter it has never seen.
    const id = await seedThreeQuarters();
    await summarizeStorylineDay(deps(stub(["First."])), candidate(id, "2026-08-14"));

    const [group] = await sql<{ group_id: string }>`
      select group_id from storyline_groups where storyline_id = ${id}::uuid limit 1
    `.execute(db).then((result) => result.rows);
    await article("2026-08-14T14:00:00Z", group!.group_id);

    // Run A: the afternoon is written, and the run is cut off before the day.
    const cutOff: CallGate = {
      before: async () => null,
      after: () => {},
    };
    let asks = 0;
    await summarizeStorylineDay(deps(stub(["Afternoon."]), AGED), candidate(id, "2026-08-14"), {
      before: async () => (asks++ === 0 ? null : "budget"),
      after: cutOff.after,
    });
    expect(
      (await rowsFor(id, "2026-08-14")).find((row) => row.segment === "afternoon")?.summary,
    ).toBe("Afternoon.");
    expect((await rowsFor(id, "2026-08-14")).find((row) => row.segment === "day")?.summary).toBe(
      "First.",
    );

    // Run B, a fresh call with no memory of run A, and the day still frozen.
    await summarizeStorylineDay(
      deps(stub(["The day, caught up."]), {
        now: () => new Date("2026-08-21T05:00:00.000Z"),
      }),
      candidate(id, "2026-08-14"),
    );

    expect((await rowsFor(id, "2026-08-14")).find((row) => row.segment === "day")?.summary).toBe(
      "The day, caught up.",
    );
  });

  it("still freezes a day nothing happened to", async () => {
    const id = await seedThreeQuarters();
    await summarizeStorylineDay(deps(stub(["First."])), candidate(id, "2026-08-14"));

    const model = stub(["Should never be asked."]);
    const outcome = await summarizeStorylineDay(deps(model, AGED), candidate(id, "2026-08-14"));

    expect(outcome.modelCalls).toBe(0);
    expect(model.prompts).toEqual([]);
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

/**
 * One arc with qualifying coverage on each of the given UTC days: six articles
 * across two groups, landing in the night and afternoon quarters, so every day
 * clears the gate and costs three calls (two quarters and the day).
 */
async function arcAcrossDays(days: string[], label = "Many Days"): Promise<string> {
  const a = await article(`${days[0]}T02:00:00Z`);
  const b = await article(`${days[0]}T14:00:00Z`);
  for (const day of days) {
    for (let i = 0; i < 3; i += 1) {
      await article(`${day}T03:00:00Z`, a);
      await article(`${day}T15:00:00Z`, b);
    }
  }
  return arc([a, b], label);
}

/** A clock the model's own latency moves, so pacing can be asserted exactly. */
function movingClock(latencyMs: number) {
  let t = NOW.getTime();
  const sleeps: number[] = [];
  return {
    sleeps,
    now: (): Date => new Date(t),
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      t += ms;
    },
    /** Wrap a stub so each call costs `latencyMs` of the clock. */
    wrap(model: TextGenerator): TextGenerator {
      return {
        async generate(request: GenerateRequest): Promise<GenerateResult> {
          t += latencyMs;
          return model.generate(request);
        },
      };
    },
  };
}

describe("the pass spaces calls from one call's START", () => {
  const options = {
    from: new Date("2026-08-01T00:00:00Z"),
    to: NOW,
    minArticlesExclusive: 4,
    minGroups: 2,
    // 2 s between the START of one call and the start of the next.
    ratePerMinute: 30,
  };

  it("sleeps only the remainder when the call was faster than the interval", async () => {
    await seedThreeQuarters();
    const clock = movingClock(500);
    const model = clock.wrap(stub(["A sentence."]));

    const tally = await summaryPass(deps(model, { now: clock.now }), {
      ...options,
      now: clock.now,
      sleep: clock.sleep,
    });

    // Four calls: three populated quarters and the day.
    expect(tally.model).toBe(4);
    // Three waits, each the interval MINUS the latency already spent on the
    // previous call. Sleeping the full 2000 here is the double pacing that cost
    // production 40% of its key: 2 s of spacing plus 1.3 s of latency ran a
    // 30 rpm key at 18.
    expect(clock.sleeps).toEqual([1_500, 1_500, 1_500]);
  });

  it("does not sleep at all when the call already outlasted the interval", async () => {
    await seedThreeQuarters();
    const clock = movingClock(3_000);
    const model = clock.wrap(stub(["A sentence."]));

    const tally = await summaryPass(deps(model, { now: clock.now }), {
      ...options,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(tally.model).toBe(4);
    // A slow call has already paid the interval by taking it. The rate is a
    // ceiling on how often a call may START, not a delay owed after each one.
    expect(clock.sleeps).toEqual([]);
  });
});

describe("the fresh-first phase", () => {
  const DAYS = ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14"];
  const options = {
    from: new Date("2026-08-10T00:00:00Z"),
    // Whole UTC days at both ends, as the chore computes them: today is excluded.
    to: new Date("2026-08-15T00:00:00Z"),
    minArticlesExclusive: 4,
    minGroups: 2,
    ratePerMinute: 0,
    now: () => NOW,
  };

  it("reaches the newest day first, where the oldest-first walk would not", async () => {
    const id = await arcAcrossDays(DAYS);
    // Three calls: exactly one day's worth.
    const budget = { maxSummaries: 3 };

    const fresh = await summaryPass(deps(stub(["A sentence."])), {
      ...options,
      ...budget,
      freshDays: 2,
    });
    expect(fresh.stoppedBy).toBe("max-summaries");
    expect(await rowsFor(id, "2026-08-14")).toHaveLength(3);
    expect(await rowsFor(id, "2026-08-10")).toHaveLength(0);

    // The contrast is the point: the same corpus and the same ceiling, with the
    // phase off, spends everything on the oldest end — which is what ADR-0023
    // chose and what left the two newest days of production with no sentence at
    // all through six consecutive firings.
    await sql`truncate storyline_day_summaries`.execute(db);
    const oldest = await summaryPass(deps(stub(["A sentence."])), {
      ...options,
      ...budget,
      freshDays: 0,
    });
    expect(oldest.stoppedBy).toBe("max-summaries");
    expect(await rowsFor(id, "2026-08-14")).toHaveLength(0);
    expect(await rowsFor(id, "2026-08-10")).toHaveLength(3);
  });

  it("yields to the oldest-first walk when its share runs out, rather than ending the night", async () => {
    const id = await arcAcrossDays(DAYS);
    const clock = movingClock(1_000);
    const model = clock.wrap(stub(["A sentence."]));

    // Four fresh days would cost 12 calls; a quarter of a 20 s budget admits
    // about five. So the phase is cut off mid-walk, which is the case that
    // matters — the whole guarantee is that being cut off hands the rest of the
    // night to the days about to leave the window.
    const tally = await summaryPass(deps(model, { now: clock.now }), {
      ...options,
      now: clock.now,
      sleep: clock.sleep,
      budgetMs: 20_000,
      freshDays: 4,
      freshShare: 0.25,
    });

    expect(tally.fresh).toBeGreaterThan(0);
    expect(tally.fresh).toBeLessThan(tally.days);
    // The newest day, reached by the fresh phase.
    expect(await rowsFor(id, "2026-08-14")).toHaveLength(3);
    // The oldest day, reached only because the fresh phase gave way.
    expect(await rowsFor(id, "2026-08-10")).toHaveLength(3);
    // And the night ended on its own terms. `fresh-budget` must never surface
    // here: it is one phase yielding, not the pass running out of room.
    expect(tally.stoppedBy).toBe("exhausted");
  });

  it("counts and walks each storyline-day once when both phases cover it", async () => {
    await arcAcrossDays(DAYS);
    const model = stub(["A sentence."]);

    // The fresh phase covers the WHOLE window here, so the oldest-first walk
    // that follows sees nothing it has not already done. It must not re-walk
    // them: the cost would be silent (no model call, since every span is
    // current) and the report would say the night considered ten days when the
    // window holds five.
    const tally = await summaryPass(deps(model), { ...options, freshDays: 8 });

    expect(tally.days).toBe(DAYS.length);
    expect(tally.fresh).toBe(DAYS.length);
    expect(tally.model).toBe(DAYS.length * 3);
    expect(tally.stoppedBy).toBe("exhausted");
  });

  it("still lets the oldest-first walk finish the fresh days the phase could not reach", async () => {
    const id = await arcAcrossDays(DAYS);
    const clock = movingClock(1_000);
    const model = clock.wrap(stub(["A sentence."]));

    // A tiny share, so the fresh phase writes the newest day and stops. The
    // window phase walks the whole window — not the window minus the fresh
    // range — so budget it did not spend still reaches 08-13.
    const tally = await summaryPass(deps(model, { now: clock.now }), {
      ...options,
      now: clock.now,
      sleep: clock.sleep,
      budgetMs: 60_000,
      freshDays: 2,
      freshShare: 0.05,
    });

    expect(tally.stoppedBy).toBe("exhausted");
    for (const day of DAYS) {
      expect(await rowsFor(id, day)).toHaveLength(3);
    }
    expect(tally.days).toBe(DAYS.length);
  });
});
