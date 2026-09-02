import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@zammy/config";
import { createDb, migrateToLatest, readChoreRuns, type Database } from "@zammy/storage";
import {
  CHORE_LOCK_KEYS,
  CHORE_PASSES,
  choreLockKey,
  isChorePass,
  runChorePass,
  summarizeChoreReport,
  REPORT_ARRAY_CAP,
} from "./chore-runner.js";
import { readChoreStatus } from "./chore-status.js";
import { EXIT_CONFIG, parseArgs } from "./operator-command.js";
import { storylineBar } from "./storyline-bar.js";
import { spec as summarySpec } from "./storyline-summary-command.js";
import type { StorylinePassDeps } from "./chores.js";

/**
 * The half of Phase 4 that is neither HTTP nor a chore: the lock, and the
 * durable record of a run (VERCEL-ALL-IN-SCOPE §3.3).
 *
 * Everything here needs a real Postgres, and not incidentally — the two things
 * worth pinning are a SESSION-scoped advisory lock and a table with a CHECK
 * constraint on the relationship between two of its columns. A fake would fake
 * both wrong, and the lock in particular is the mechanism that stands between
 * two schedulers and a doubled label bill.
 */

const PG_ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://zammy:zammy@localhost:5432/zammy";

const NOW = new Date("2026-08-25T03:00:00.000Z");

let dbName: string;
let db: Kysely<Database>;
let dbUrl: string;

/** No labeler generator: every pass here runs the bigram path and calls nothing. */
function deps(overrides: Partial<StorylinePassDeps> = {}): StorylinePassDeps {
  return {
    db,
    config: {
      retentionDays: 90,
      storyDfWindowDays: 14,
      storylineDormancyDays: 90,
      timeZone: "UTC",
    },
    now: () => NOW,
    log: { info: () => {}, warn: () => {} },
    // No generator anywhere here: every pass runs its no-model path, so a test
    // that reaches the network is a test that fails rather than one that bills.
    summarizer: {
      generator: null,
      modelId: null,
      sampleSize: 8,
      maxAttempts: 3,
      settlingDays: 3,
      recomputeDelta: 4,
      cliffDays: 8,
    },
    summaryGate: { windowDays: 8, minArticlesExclusive: 4, minGroups: 2 },
    linker: storylineBar(),
    labeler: { generator: null, sampleSize: 10, driftFactor: 2 },
    rules: { graceDays: 3, maxComponent: 5 },
    ...overrides,
  };
}

beforeAll(async () => {
  dbName = `zammy_chore_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: PG_ADMIN_URL, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${dbName}`;
  dbUrl = url.toString();
  // max: 4, as every chore entrypoint builds it — one connection is pinned
  // holding the lock and the passes borrow the rest.
  db = createDb(dbUrl, { max: 4 });
  await migrateToLatest(db);
});

afterAll(async () => {
  await db.destroy();
  const cleanup = new pg.Pool({ connectionString: PG_ADMIN_URL, max: 1 });
  try {
    await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  } finally {
    await cleanup.end();
  }
});

beforeEach(async () => {
  await sql`truncate chore_runs`.execute(db);
});

/**
 * Hold a pass's advisory lock from a SECOND session, and hand back a release.
 *
 * A second session and not a second call on this one: `pg_try_advisory_lock` is
 * re-entrant within a session, so a same-session hold would prove nothing about
 * the case that matters — two schedulers, two connections, one night's work.
 */
async function holdLock(key: number): Promise<() => Promise<void>> {
  const other = createDb(dbUrl, { max: 2 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let taken!: () => void;
  const acquired = new Promise<void>((resolve) => {
    taken = resolve;
  });

  const holding = other.connection().execute(async (connection) => {
    await sql`select pg_advisory_lock(${sql.lit(key)})`.execute(connection);
    taken();
    await held;
    await sql`select pg_advisory_unlock(${sql.lit(key)})`.execute(connection);
  });

  await acquired;
  return async () => {
    release();
    await holding;
    await other.destroy();
  };
}

describe("the pass table", () => {
  it("addresses every step of the night individually", () => {
    // §3.3's promise: anything the night does can be re-run on its own from a
    // curl instead of an SSH this deployment does not have.
    expect([...CHORE_PASSES]).toEqual([
      "retention",
      "storylines",
      "summaries",
      "dormancy",
      "bridges",
      "late-candidates",
      "labels",
      "label-merge",
      "graph",
    ]);
    expect(isChorePass("labels")).toBe(true);
    expect(isChorePass("nightly")).toBe(false);
  });

  it("puts every storyline-family pass on ONE lock, and retention on its own", () => {
    // A key per pass is the obvious shape and is wrong: `storylines` CONTAINS
    // `labels`, so a per-pass key would let an operator re-run the label pass
    // while the scheduler is midway through it — and the label pass spends real
    // money per call.
    expect(choreLockKey("storylines")).toBe(CHORE_LOCK_KEYS.storylines);
    expect(choreLockKey("labels")).toBe(CHORE_LOCK_KEYS.storylines);
    expect(choreLockKey("late-candidates")).toBe(CHORE_LOCK_KEYS.storylines);
    expect(choreLockKey("retention")).toBe(CHORE_LOCK_KEYS.retention);
    // `summaries` is a family of one: it writes only `storyline_day_summaries`,
    // so it conflicts with neither of the others on any table. What it shares
    // with the label pass is the model KEY, and that is the 429 cooldown's
    // problem rather than the lock's — losing a night of history to a slow
    // label pass would be the worse trade.
    expect(choreLockKey("summaries")).toBe(CHORE_LOCK_KEYS.summaries);
    expect(choreLockKey("summaries")).not.toBe(CHORE_LOCK_KEYS.storylines);
    // And these are the CLI's original keys, so a laptop run and a scheduled
    // run contend rather than both running the night.
    expect(CHORE_LOCK_KEYS.retention).toBe(7_226_461_502);
    expect(CHORE_LOCK_KEYS.storylines).toBe(7_226_461_503);
    // Never the migrator's, which would be a deploy hanging behind a label pass.
    expect(Object.values(CHORE_LOCK_KEYS)).not.toContain(7_226_461_501);
  });
});

describe("runChorePass", () => {
  it("records a successful run, with its report and its timestamps", async () => {
    const result = await runChorePass("graph", deps(), { source: "route" });

    expect(result.outcome).toBe("ok");
    const [row] = await readChoreRuns(db);
    expect(row).toMatchObject({
      pass: "graph",
      source: "route",
      outcome: "ok",
      error: null,
    });
    expect(row?.startedAt).toEqual(NOW);
    expect(row?.finishedAt).toEqual(NOW);
    // The graph shape is the percolation alarm, and a series of these rows is
    // what makes it readable at all (VERCEL-PHASE-0-FINDINGS §2.7).
    expect(row?.report).toMatchObject({ arcs: 0, largestArc: 0, bridges: 0 });
  });

  it("records a run from the CLI as such", async () => {
    // Both entrypoints write here on purpose: a table that only knew about the
    // route would answer "did last night's chores run?" for the Vercel half of
    // the system and lie by omission about the other half.
    await runChorePass("graph", deps(), { source: "cli" });
    const [row] = await readChoreRuns(db);
    expect(row?.source).toBe("cli");
  });

  it("skips on the lock, and RECORDS the skip", async () => {
    const release = await holdLock(CHORE_LOCK_KEYS.storylines);
    try {
      const result = await runChorePass("dormancy", deps(), { source: "route" });
      expect(result.outcome).toBe("skipped");
    } finally {
      await release();
    }

    const [row] = await readChoreRuns(db);
    // The row exists because it is opened BEFORE the lock is attempted. A skip
    // that recorded nothing would be indistinguishable from a night nothing was
    // ever scheduled — which is the confusion the table exists to prevent.
    expect(row).toMatchObject({ pass: "dormancy", outcome: "skipped", report: null });
    expect(row?.finishedAt).toEqual(NOW);
  });

  it("runs the graph pass while the storyline lock is held", async () => {
    // `graph` is the one pass with no lock: it is `readStorylineStats` and a log
    // line, so it cannot conflict — and giving it the storyline key would make
    // the percolation alarm unreadable during exactly the multi-hour pass you
    // would want to read it during.
    expect(choreLockKey("graph")).toBeNull();
    const release = await holdLock(CHORE_LOCK_KEYS.storylines);
    try {
      const result = await runChorePass("graph", deps(), { source: "route" });
      expect(result.outcome).toBe("ok");
    } finally {
      await release();
    }
  });

  it("records a failed pass and does not throw", async () => {
    // An invalid IANA zone makes `storyDfDay` throw inside the retention chore —
    // a real failure from a real configuration mistake, rather than a stub.
    const result = await runChorePass(
      "retention",
      deps({ config: { ...deps().config, timeZone: "Mars/Olympus" } }),
      { source: "route" },
    );

    expect(result.outcome).toBe("failed");
    const [row] = await readChoreRuns(db);
    expect(row?.outcome).toBe("failed");
    expect(row?.error).toBeTruthy();
    // Finished, not abandoned: the row must say the pass came back and failed,
    // which is a different fact from the row that never finished at all.
    expect(row?.finishedAt).toEqual(NOW);
  });

  it("leaves the row unfinished when the pass never comes back", async () => {
    // The reason the row is opened before the work. There is no way to run a
    // `finally` after the platform kills a function at `maxDuration`, so an
    // end-only write would leave nothing at all — and a night that was killed
    // would look exactly like a night nothing was scheduled. Simulated here by
    // opening a run and never closing it, which is the state that kill leaves.
    await sql`
      insert into chore_runs (pass, source, started_at) values ('storylines', 'route', ${NOW})
    `.execute(db);
    const [row] = await readChoreRuns(db);
    expect(row).toMatchObject({ finishedAt: null, outcome: null });
  });

  it("refuses a row that is half-finished", async () => {
    // The CHECK: `finished_at` and `outcome` move together or the row cannot say
    // which state it is in, and "unfinished" is a meaning this table depends on.
    await expect(
      sql`
        insert into chore_runs (pass, source, started_at, finished_at)
        values ('graph', 'route', ${NOW}, ${NOW})
      `.execute(db),
    ).rejects.toThrow(/chore_runs_finished_together/);
  });

  it("reports a gated sweep as SKIPPED rather than as a clean zero", async () => {
    // Phase 4's own exit criterion. `STORYLINE_LATE_CANDIDATE_SWEEP` is off, and
    // "the sweep ran and found nothing" must not read the same as "the sweep did
    // not run" — that is how a flag left off by accident survives a month of
    // clean-looking nightly reports.
    const result = await runChorePass("storylines", deps({ lateCandidateSweep: false }), {
      source: "route",
    });

    expect(result.outcome).toBe("ok");
    const [row] = await readChoreRuns(db);
    expect(row?.report).toMatchObject({
      lateCandidates: { skipped: true, offered: 0 },
    });
  });

  it("runs the late-candidate sweep when it is named directly, gate or no gate", async () => {
    // Naming the pass IS the deliberate operator act the gate protects, exactly
    // as `--late-candidates` is on the CLI. A gate that also suppressed the
    // explicit re-run would leave no way to run the sweep at all.
    const result = await runChorePass("late-candidates", deps({ lateCandidateSweep: false }), {
      source: "route",
    });

    expect(result.outcome).toBe("ok");
    const [row] = await readChoreRuns(db);
    expect(row?.report).not.toHaveProperty("skipped");
    expect(row?.report).toMatchObject({ offered: 0 });
  });

  it("hoists the label pass's model calls into their own column", async () => {
    // The one number in a report that is a COST and gets summed across rows.
    // Zero here because there is no generator, which is the honest answer: the
    // pass could have called the model and did not.
    await runChorePass("labels", deps({ now: () => new Date("2026-08-25T04:00:00Z") }), {
      source: "route",
    });
    const [row] = await readChoreRuns(db, { pass: "labels" });
    expect(row?.modelCalls).toBe(0);

    // And null for a pass that makes no model calls at all, which is every
    // other one — a distinction the column would lose if absent read as zero.
    await runChorePass("graph", deps({ now: () => new Date("2026-08-25T05:00:00Z") }), {
      source: "route",
    });
    const [latest] = await readChoreRuns(db);
    expect(latest?.pass).toBe("graph");
    expect(latest?.modelCalls).toBeNull();
  });

  it("runs the reindex sweep as part of retention", async () => {
    // The second piece of unscoped Phase 4 work Phase 0 turned up: 22% of the
    // database in index bloat, recovered by ~2 s of non-blocking work
    // (VERCEL-PHASE-0-FINDINGS §5).
    const result = await runChorePass("retention", deps(), { source: "route" });
    expect(result.outcome).toBe("ok");

    const [row] = await readChoreRuns(db);
    const report = row?.report as {
      reindex: { failed: number; invalidIndexes: string[]; tables: { table: string }[] };
      retention: Record<string, unknown>;
    };
    expect(report.reindex.failed).toBe(0);
    // An interrupted CONCURRENTLY rebuild leaves a `_ccnew` twin that is never
    // read and still maintained on every write — the exact inversion of what the
    // sweep is for, and nothing else complains about it.
    expect(report.reindex.invalidIndexes).toEqual([]);
    expect(report.reindex.tables.map((entry) => entry.table)).toContain("story_token_days");
    // The retention report's unbounded member survives intact only because this
    // corpus is empty; `summarizeChoreReport`'s own tests cover what happens
    // when it is not.
    expect(report.retention).toHaveProperty("idleTopics", []);
  });

  it("runs the pass even when the record cannot be written", async () => {
    // Bookkeeping is allowed to fail; the pass is not allowed to fail with it. A
    // deployment whose migrations have not caught up has no `chore_runs` table,
    // and refusing to run the night's work over a missing record would be the
    // record doing harm.
    await sql`alter table chore_runs rename to chore_runs_hidden`.execute(db);
    try {
      const result = await runChorePass("graph", deps(), { source: "route" });
      expect(result.outcome).toBe("ok");
      expect(result.runId).toBeNull();
    } finally {
      await sql`alter table chore_runs_hidden rename to chore_runs`.execute(db);
    }
  });
});

describe("readChoreRuns", () => {
  it("returns the newest first, and narrows to one pass", async () => {
    await runChorePass("graph", deps({ now: () => new Date("2026-08-23T04:00:00Z") }), {
      source: "cli",
    });
    await runChorePass("dormancy", deps({ now: () => new Date("2026-08-24T04:00:00Z") }), {
      source: "cli",
    });
    await runChorePass("graph", deps({ now: () => new Date("2026-08-25T04:00:00Z") }), {
      source: "cli",
    });

    const all = await readChoreRuns(db);
    expect(all.map((run) => run.pass)).toEqual(["graph", "dormancy", "graph"]);

    const graphOnly = await readChoreRuns(db, { pass: "graph" });
    expect(graphOnly).toHaveLength(2);
    expect(graphOnly[0]?.startedAt).toEqual(new Date("2026-08-25T04:00:00Z"));
  });
});

describe("the status predicates, over rows a real pass wrote", () => {
  /**
   * `chore-status.test.ts` pins the arithmetic; this pins the JOIN between the
   * arithmetic and the table.
   *
   * A pure test cannot catch a `started_at` that arrives as a string, a
   * `finished_at` that arrives as `undefined` rather than `null`, or a pass name
   * spelled one way in `CHORE_PASSES` and another in the column — and those are
   * exactly the mistakes that would make a green suite report every pass as
   * having never run. So the rows here come from `runChorePass` rather than from
   * an `INSERT`, and the predicates read them back through `readChoreRuns`.
   */
  const at = (iso: string): StorylinePassDeps["now"] => () => new Date(iso);

  it("reads a real run back as the last run of its pass, and calls nothing overdue", async () => {
    await runChorePass("retention", deps({ now: at("2026-09-01T03:00:02Z") }), {
      source: "route",
    });
    await runChorePass("storylines", deps({ now: at("2026-09-01T04:00:05Z") }), {
      source: "route",
    });
    await runChorePass("summaries", deps({ now: at("2026-09-01T05:00:01Z") }), {
      source: "route",
    });

    const status = await readChoreStatus(db, { now: new Date("2026-09-01T05:30:00Z") });

    expect(status.ok).toBe(true);
    expect(status.overdue).toEqual([]);
    expect(status.passes.find((entry) => entry.pass === "storylines")?.last).toMatchObject({
      source: "route",
      startedAt: new Date("2026-09-01T04:00:05Z"),
      outcome: "ok",
    });
  });

  it("names the pass whose firing left no row", async () => {
    // The night retention did not fire. On Hobby's one-hour log retention there
    // is nothing else left by 06:30 — the absence of this row IS the evidence,
    // which is the whole argument for the table (ADR-0015).
    await runChorePass("storylines", deps({ now: at("2026-09-01T04:00:05Z") }), {
      source: "route",
    });

    const status = await readChoreStatus(db, { now: new Date("2026-09-01T06:30:00Z") });

    expect(status.overdue).toEqual(["retention", "summaries"]);
    expect(status.ok).toBe(false);
  });

  it("names the pass whose row never finished, past the function ceiling", async () => {
    // The state a kill at `maxDuration` leaves, written the only way it can be:
    // no `finally` runs after the platform stops the function, so the row stays
    // open. Same insert the "leaves the row unfinished" test above makes,
    // because that is what the real failure looks like.
    await sql`
      insert into chore_runs (pass, source, started_at)
      values ('storylines', 'route', ${new Date("2026-09-01T04:00:00Z")})
    `.execute(db);

    const status = await readChoreStatus(db, { now: new Date("2026-09-01T04:10:00Z") });

    expect(status.stalled).toEqual(["storylines"]);
    // And NOT overdue as well: it started when it was supposed to. Two
    // predicates, two questions, and a run can satisfy one without the other.
    // (The other two passes are overdue here because this table holds one row.)
    expect(status.overdue).not.toContain("storylines");
  });

  it("stops calling it stalled once a later run closes its own row", async () => {
    await sql`
      insert into chore_runs (pass, source, started_at)
      values ('storylines', 'route', ${new Date("2026-08-26T04:00:00Z")})
    `.execute(db);
    await runChorePass("storylines", deps({ now: at("2026-09-01T04:00:05Z") }), {
      source: "route",
    });

    const status = await readChoreStatus(db, { now: new Date("2026-09-01T04:30:00Z") });

    // An unfinished row from last week is a scar, not a stuck process — and a
    // predicate that kept reporting it would leave `/readyz` permanently red for
    // a night that has since been re-run successfully.
    expect(status.stalled).toEqual([]);
  });
});

describe("the summary command lands in the same table", () => {
  /**
   * `pnpm summaries:storylines` used to be the exception, and it was the worst
   * possible one to have.
   *
   * It took `CHORE_LOCK_KEYS.summaries` by hand and called `summaryPass`
   * directly, so a manual preserve wrote NO `chore_runs` row at all: the one
   * pass whose rows nothing can rebuild was the one pass with no durable record
   * that it had run, no `model_calls` against the night it spent them on, and no
   * non-UTC `APP_TIMEZONE` warning — the line that says the day keys it is
   * writing no longer name the same 24 hours as `storyline_days`. It now runs
   * through `runChorePass` like everything else.
   *
   * No key is configured here, so `summaryPass` returns `no-model` before
   * reading anything — which is the point: even the run that does NOTHING is
   * recorded, because "the backfill ran and there was no key" and "nobody ever
   * ran the backfill" are different facts.
   */
  it("writes a chore_runs row for a manual backfill", async () => {
    const config = loadConfig({
      DATABASE_URL: dbUrl,
      REDIS_URL: "redis://localhost:6379",
      CURRENTS_USER_AGENT: "zammy/0.1 (+test)",
    } as NodeJS.ProcessEnv);

    const code = await summarySpec.run({
      args: parseArgs(summarySpec, ["--from=2026-08-20", "--to=2026-08-21"]),
      config,
      db,
      get labeler(): never {
        throw new Error("summaries:storylines declares no labeler");
      },
    });

    // 78, EX_CONFIG: no key, so nothing could have been written. The row is the
    // half that used to be missing.
    expect(code).toBe(EXIT_CONFIG);
    const [row] = await readChoreRuns(db, { pass: "summaries" });
    expect(row).toMatchObject({ pass: "summaries", source: "cli", outcome: "ok" });
    expect(row?.finishedAt).not.toBeNull();
    // The tally, summarized into the row exactly as the nightly pass's is — so
    // "did the backfill spend anything?" is answerable from the table.
    expect(row?.report).toMatchObject({ stoppedBy: "no-model", days: 0, model: 0 });
  });

  it("takes the same lock the nightly pass takes, and records the skip", async () => {
    // The lock was the one thing the old entrypoint got right, and routing
    // through the runner must not lose it: this command writes the rows the
    // 05:00 pass writes, and the losing side of that race can overwrite a
    // sentence with a refusal it decided on from a stale read.
    const config = loadConfig({
      DATABASE_URL: dbUrl,
      REDIS_URL: "redis://localhost:6379",
      CURRENTS_USER_AGENT: "zammy/0.1 (+test)",
    } as NodeJS.ProcessEnv);
    const release = await holdLock(CHORE_LOCK_KEYS.summaries);
    try {
      const code = await summarySpec.run({
        args: parseArgs(summarySpec, []),
        config,
        db,
        get labeler(): never {
          throw new Error("summaries:storylines declares no labeler");
        },
      });
      // Overlap is expected, exactly as it is for a chore: exit 0.
      expect(code).toBeUndefined();
    } finally {
      await release();
    }

    const [row] = await readChoreRuns(db, { pass: "summaries" });
    expect(row).toMatchObject({ outcome: "skipped", source: "cli" });
  });
});

describe("summarizeChoreReport", () => {
  it("bounds an array that scales with the corpus", () => {
    // `chore_runs` has no prune, and several report members are UUIDs of
    // everything a pass touched — the retention report's idle-topic
    // fingerprints, the bridge sweep's survivors, the label merge's refusals. A
    // record of the night must not become a second copy of the corpus, in the
    // same phase that adds a sweep to defend a 500 MB budget.
    const idleTopics = Array.from({ length: 400 }, (_, index) => `topic-${index}`);
    const summary = summarizeChoreReport({
      retention: { articleCandidates: 3, idleTopics },
      prunedStoryDf: 7,
    }) as { retention: { idleTopics: { count: number; sample: string[] } } };

    expect(summary.retention.idleTopics.count).toBe(400);
    // A sample rather than nothing, so a spot-check is possible without storing
    // the set.
    expect(summary.retention.idleTopics.sample).toEqual(["topic-0", "topic-1", "topic-2"]);
  });

  it("bounds a nested one too, wherever in the report it sits", () => {
    // `BridgeSweepReport.survivors` and `LabelMergeReport.survivors`/`refusals`
    // arrive nested under the composite pass's report — which is why the rule is
    // general rather than a list of known members: a per-shape summarizer is a
    // thing five report types can each grow past without anybody noticing.
    const survivors = Array.from({ length: 900 }, (_, index) => `arc-${index}`);
    const summary = summarizeChoreReport({
      bridges: { merged: 12, survivors },
      labelMerge: { merged: 3, refusals: [] },
    }) as { bridges: { survivors: { count: number } }; labelMerge: { refusals: unknown[] } };

    expect(summary.bridges.survivors.count).toBe(900);
    // And a short array is left exactly as it was: bounding is a size rule, not
    // a blanket "counts only" rule.
    expect(summary.labelMerge.refusals).toEqual([]);
  });

  it("leaves the reindex tally intact, with room to grow", () => {
    // The cap has to sit above every array a report legitimately carries in
    // full. `reindex.tables` is the longest of them at nine, and adding a tenth
    // table must not silently truncate the tally.
    const tables = Array.from({ length: 9 }, (_, index) => ({ table: `t${index}`, ok: true }));
    const summary = summarizeChoreReport({ reindex: { tables, invalidIndexes: [] } }) as {
      reindex: { tables: unknown[] };
    };
    expect(summary.reindex.tables).toHaveLength(9);
    expect(REPORT_ARRAY_CAP).toBeGreaterThan(9);
  });

  it("passes a short report through unchanged", () => {
    const report = { dormant: 2, labels: { model: 4, bigram: 1, none: 0, skipped: 3 } };
    expect(summarizeChoreReport(report)).toEqual(report);
    expect(summarizeChoreReport(undefined)).toBeNull();
  });
});
