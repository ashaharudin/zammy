import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { readStorylineDaySummaries } from "@zammy/storage";
import { createTestHarness, type TestHarness } from "./test-support.js";
import type { GenerateRequest, GenerateResult, TextGenerator } from "./gemini.js";
import {
  queueStorylineSummaries,
  runSummarizeJob,
  type SummarizeJobDeps,
} from "./storyline-summary-job.js";
import type { SummarizeJob } from "./ingest-queue.js";

/**
 * The click plane (ADR-0027): opening a storyline submits its unsummarised days.
 *
 * Real Postgres and a stub model, for `storyline-summary-service.test.ts`'s
 * reasons — what is under test is the decision to call, not the call. The two
 * halves are tested apart because they run in different places: the planner on
 * a reader's request path, the job on the queue consumer.
 *
 * The cases that matter most here are the ones about what a click MUST NOT do,
 * because every one of them is a way a reader could be made to spend a budget
 * that exists to be spent slowly.
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

const NOW = new Date("2026-08-15T05:00:00.000Z");

function stub(answers: Array<string | null>): TextGenerator & { prompts: string[] } {
  const prompts: string[] = [];
  let index = 0;
  return {
    prompts,
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      prompts.push(request.prompt);
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return answer === null || answer === undefined
        ? { ok: false, reason: "stubbed transport failure", failure: "unreachable" }
        : { ok: true, text: answer };
    },
  };
}

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

/** One arc qualifying on each of the given UTC days. */
async function arcAcrossDays(days: string[]): Promise<string> {
  const a = await article(`${days[0]}T02:00:00Z`);
  const b = await article(`${days[0]}T14:00:00Z`);
  for (const day of days) {
    for (let i = 0; i < 3; i += 1) {
      await article(`${day}T03:00:00Z`, a);
      await article(`${day}T15:00:00Z`, b);
    }
  }
  return arc([a, b]);
}

function jobDeps(
  generator: TextGenerator | null,
  overrides: Partial<SummarizeJobDeps> = {},
): SummarizeJobDeps {
  return {
    db,
    summarizer: {
      generator,
      modelId: "gemma-test",
      sampleSize: 12,
      maxAttempts: 3,
      settlingDays: 3,
      recomputeDelta: 4,
    },
    enabled: true,
    gate: { minArticlesExclusive: 4, minGroups: 2 },
    maxDays: 8,
    budgetMs: 120_000,
    ratePerMinute: 0,
    now: () => NOW,
    ...overrides,
  };
}

const job = (storylineId: string): SummarizeJob => ({ kind: "summarize", storylineId });

const rowsFor = (storylineId: string, dayKey: string) =>
  readStorylineDaySummaries(db, { storylineId, dayKey });

describe("queueing one arc's summary work", () => {
  it("queues a job addressed by the ARC alone", async () => {
    const id = await arcAcrossDays(["2026-08-13", "2026-08-14"]);
    const queued: SummarizeJob[] = [];

    const outcome = await queueStorylineSummaries(
      {
        db,
        queue: { enqueueSummarize: async (next) => void queued.push(next) },
        enabled: true,
        now: () => NOW,
      },
      { storylineId: id },
    );

    expect(outcome).toEqual({ status: "queued", storylineId: id, job: job(id) });
    expect(queued).toEqual([job(id)]);
  });

  it("queues nothing when the feature is off", async () => {
    const id = await arcAcrossDays(["2026-08-14"]);
    const queued: SummarizeJob[] = [];

    const outcome = await queueStorylineSummaries(
      {
        db,
        queue: { enqueueSummarize: async (next) => void queued.push(next) },
        enabled: false,
        now: () => NOW,
      },
      { storylineId: id },
    );

    expect(outcome).toEqual({ status: "disabled", storylineId: id });
    expect(queued).toEqual([]);
  });

  it("is `unknown` for a UUID this database has never held", async () => {
    const queued: SummarizeJob[] = [];
    const outcome = await queueStorylineSummaries(
      {
        db,
        queue: { enqueueSummarize: async (next) => void queued.push(next) },
        enabled: true,
        now: () => NOW,
      },
      { storylineId: "1b671a64-40d5-491e-99b0-da01ff1f3341" },
    );

    expect(outcome).toEqual({ status: "unknown" });
    expect(queued).toEqual([]);
  });

  it("does NOT look for work before queueing", async () => {
    // A warm arc still queues, and that is deliberate: asking "is there anything
    // to do?" would put a grouped scan over the arc's whole history on a
    // fire-and-forget POST a reader is waiting behind, to save a Redis publish.
    // The consumer plans against the rows as they stand when it runs.
    const id = await arcAcrossDays(["2026-08-14"]);
    await runSummarizeJob(jobDeps(stub(["A sentence."])), job(id));

    const queued: SummarizeJob[] = [];
    const outcome = await queueStorylineSummaries(
      {
        db,
        queue: { enqueueSummarize: async (next) => void queued.push(next) },
        enabled: true,
        now: () => NOW,
      },
      { storylineId: id },
    );

    expect(outcome.status).toBe("queued");
    expect(queued).toHaveLength(1);
  });
});

describe("running one click's summary job", () => {
  it("writes a sentence for every unsummarised qualifying day", async () => {
    const id = await arcAcrossDays(["2026-08-12", "2026-08-13", "2026-08-14"]);

    const tally = await runSummarizeJob(jobDeps(stub(["A sentence."])), job(id));

    expect(tally).toMatchObject({ planned: 3, written: 3, model: 3, failures: 0 });
    expect(tally.stoppedBy).toBe("exhausted");
    for (const day of ["2026-08-12", "2026-08-13", "2026-08-14"]) {
      expect((await rowsFor(id, day))[0]?.summary).toBe("A sentence.");
    }
  });

  it("reaches a day FAR older than the nightly window", async () => {
    // The scope decision ADR-0027 records: the nightly window bounds unattended
    // spend across every arc, and a click is one reader asking about one arc.
    const id = await arcAcrossDays(["2026-03-11"]);

    const tally = await runSummarizeJob(jobDeps(stub(["An old day."])), job(id));

    expect(tally.written).toBe(1);
    expect((await rowsFor(id, "2026-03-11"))[0]?.summary).toBe("An old day.");
  });

  it("stops at `maxDays`, leaving the rest for the next open", async () => {
    const id = await arcAcrossDays([
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ]);

    const first = await runSummarizeJob(jobDeps(stub(["A sentence."]), { maxDays: 2 }), job(id));

    expect(first.model).toBe(2);
    expect(first.stoppedBy).toBe("max-days");
    // NEWEST first: a reader who opened this arc is looking at its present, and
    // a bounded click should spend itself on the days they can see.
    expect((await rowsFor(id, "2026-08-14"))[0]?.summary).toBe("A sentence.");
    expect(await rowsFor(id, "2026-08-10")).toEqual([]);

    // The next open picks up where this one stopped, because the plan selects on
    // the ABSENCE of a row rather than on a cursor anything has to carry.
    const second = await runSummarizeJob(jobDeps(stub(["A sentence."]), { maxDays: 2 }), job(id));
    // Two more of the three still owed — `planned` is what this job will WORK
    // on, and `max-days` is how it says there was more.
    expect(second.planned).toBe(2);
    expect(second.stoppedBy).toBe("max-days");
    expect((await rowsFor(id, "2026-08-12"))[0]?.summary).toBe("A sentence.");

    // And the third open drains it, reporting `exhausted` because nothing is
    // left beyond what it planned.
    const third = await runSummarizeJob(jobDeps(stub(["A sentence."]), { maxDays: 2 }), job(id));
    expect(third.planned).toBe(1);
    expect(third.stoppedBy).toBe("exhausted");
  });

  it("costs one query and no model call on a warm arc", async () => {
    const id = await arcAcrossDays(["2026-08-13", "2026-08-14"]);
    await runSummarizeJob(jobDeps(stub(["A sentence."])), job(id));

    const model = stub(["Should never be asked."]);
    const tally = await runSummarizeJob(jobDeps(model), job(id));

    expect(tally).toMatchObject({ planned: 0, model: 0, written: 0 });
    expect(model.prompts).toEqual([]);
  });

  it("never RETRIES a refusal, however often the arc is opened", async () => {
    // The rule that keeps a reader from spending a budget that exists to be
    // spent slowly. `SUMMARY_MAX_ATTEMPTS` is 3, and three opens would retire
    // the day for ever on the one table nothing can rebuild.
    const id = await arcAcrossDays(["2026-08-14"]);
    await sql`
      insert into storyline_day_summaries
        (storyline_id, day_key, segment, summary, article_count, label, model_id,
         attempts, segmented, generated_at)
      values (${id}::uuid, '2026-08-14', 'day', null, 6, 'Big Bend Wall Pause',
              'gemma-test', 1, false, '2026-08-15T00:00:00Z'::timestamptz)
    `.execute(db);

    const model = stub(["Should never be asked."]);
    for (let open = 0; open < 3; open += 1) {
      const tally = await runSummarizeJob(jobDeps(model), job(id));
      expect(tally.planned).toBe(0);
    }

    expect(model.prompts).toEqual([]);
    const row = (await rowsFor(id, "2026-08-14"))[0];
    // Untouched: still one attempt, still retriable by the nightly pass.
    expect(row?.attempts).toBe(1);
  });

  it("never RECOMPUTES a day that gained articles", async () => {
    // Also the nightly pass's business. A click buys first writes.
    const id = await arcAcrossDays(["2026-08-14"]);
    await runSummarizeJob(jobDeps(stub(["First."])), job(id));

    const [group] = await sql<{ group_id: string }>`
      select group_id from storyline_groups where storyline_id = ${id}::uuid limit 1
    `.execute(db).then((result) => result.rows);
    for (let i = 0; i < 20; i += 1) await article("2026-08-14T22:00:00Z", group!.group_id);

    const model = stub(["Second."]);
    const tally = await runSummarizeJob(jobDeps(model), job(id));

    expect(tally.planned).toBe(0);
    expect(model.prompts).toEqual([]);
    expect((await rowsFor(id, "2026-08-14"))[0]?.summary).toBe("First.");
  });

  it("excludes today, because a day is summarised once it has finished", async () => {
    // NOW is 05:00 on the 15th. A sentence written over five hours of a day and
    // then frozen would permanently describe a fraction of its own span.
    const id = await arcAcrossDays(["2026-08-15"]);

    const tally = await runSummarizeJob(jobDeps(stub(["Too early."])), job(id));

    expect(tally.planned).toBe(0);
    expect(await rowsFor(id, "2026-08-15")).toEqual([]);
  });

  it("writes nothing and is not a failure with the feature off", async () => {
    const id = await arcAcrossDays(["2026-08-14"]);
    const model = stub(["Should never be asked."]);

    const tally = await runSummarizeJob(jobDeps(model, { enabled: false }), job(id));

    expect(tally.stoppedBy).toBe("disabled");
    expect(model.prompts).toEqual([]);
    expect(await rowsFor(id, "2026-08-14")).toEqual([]);
  });

  it("writes nothing and is not a failure with no model configured", async () => {
    const id = await arcAcrossDays(["2026-08-14"]);
    const tally = await runSummarizeJob(jobDeps(null), job(id));
    expect(tally.stoppedBy).toBe("no-model");
    expect(await rowsFor(id, "2026-08-14")).toEqual([]);
  });

  it("costs an unreachable model nothing: no row, no attempt, no retirement", async () => {
    const id = await arcAcrossDays(["2026-08-14"]);

    const tally = await runSummarizeJob(jobDeps(stub([null])), job(id));

    expect(tally.unavailable).toBe(1);
    expect(tally.written).toBe(0);
    // No row at all, so the next open plans it again — which is what makes a
    // redelivery and a retry both free.
    expect(await rowsFor(id, "2026-08-14")).toEqual([]);
  });

  it("is idempotent under redelivery, because the plan selects on absence", async () => {
    // Vercel Queues DO redeliver, and a consumer's 200 proves nothing about the
    // lease. The second delivery reads what the first one wrote.
    const id = await arcAcrossDays(["2026-08-13", "2026-08-14"]);
    const model = stub(["A sentence."]);

    const first = await runSummarizeJob(jobDeps(model), job(id));
    const second = await runSummarizeJob(jobDeps(model), job(id));

    expect(first.model).toBe(2);
    expect(second.model).toBe(0);
    expect(model.prompts).toHaveLength(2);
  });

  it("stops at the wall-clock budget", async () => {
    const id = await arcAcrossDays([
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ]);
    // A clock the model's own latency moves, so the budget falls due mid-walk.
    let t = NOW.getTime();
    const now = (): Date => new Date(t);
    const slow: TextGenerator = {
      async generate(): Promise<GenerateResult> {
        t += 1_000;
        return { ok: true, text: "A sentence." };
      },
    };

    const tally = await runSummarizeJob(
      jobDeps(slow, { budgetMs: 2_500, now, maxDays: 8 }),
      job(id),
    );

    expect(tally.stoppedBy).toBe("budget");
    expect(tally.model).toBeLessThan(5);
    expect(tally.model).toBeGreaterThan(0);
  });

  it("paces its calls from one call's START, not from its return", async () => {
    // The distinction the nightly pass measured its way into: sleeping a full
    // interval AFTER each answer runs at `60000 / (spacing + latency)`, which is
    // not the rate anybody configured.
    const id = await arcAcrossDays(["2026-08-12", "2026-08-13", "2026-08-14"]);
    let t = NOW.getTime();
    const sleeps: number[] = [];
    const now = (): Date => new Date(t);
    const latent: TextGenerator = {
      async generate(): Promise<GenerateResult> {
        t += 500;
        return { ok: true, text: "A sentence." };
      },
    };

    await runSummarizeJob(
      jobDeps(latent, {
        now,
        // 2 s between the START of one call and the start of the next.
        ratePerMinute: 30,
        sleep: async (ms) => {
          sleeps.push(ms);
          t += ms;
        },
      }),
      job(id),
    );

    // Two waits, each the interval MINUS the latency already spent.
    expect(sleeps).toEqual([1_500, 1_500]);
  });
});
