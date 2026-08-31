import { sql } from "kysely";
import {
  finishChoreRun,
  startChoreRun,
  type ChoreOutcome,
  type Database,
} from "@zammy/storage";
import type { Kysely } from "kysely";
import {
  runBridgeSweepChore,
  runDormancyChore,
  runLabelMergeChore,
  runLateCandidateChore,
  runRetentionChore,
  runStorylineGraphChore,
  runStorylineLabelChore,
  runStorylinePass,
  runSummaryChore,
  type StorylinePassDeps,
} from "./chores.js";

/**
 * One pass, under a lock, with a durable record of it — the part of
 * VERCEL-ALL-IN-SCOPE §3.3 that is neither HTTP nor a chore.
 *
 * It exists as its own module because **two entrypoints run these passes and
 * both must record them identically**: `chores-cli.ts` under Compose and a
 * laptop, `chore-route.ts` on the deployment. If only the route wrote
 * `chore_runs`, the table would answer "did last night's chores run?" for the
 * Vercel half of the system and lie by omission about the other half — and the
 * two halves share a database. The advisory lock has the same shape of reason:
 * the keys here are the CLI's original keys, so a laptop run and a scheduled run
 * exclude each other rather than both spending the label budget.
 *
 * Everything in this file is about *running* a pass. What a pass DOES is
 * `chores.ts`, and what schedules one is outside the process entirely.
 */

/**
 * Every addressable pass, exactly as the route's `?pass=` and the CLI's argument
 * spell it.
 *
 * §3.3 promised "all seven": the six individual chores plus `storylines`. There
 * are nine here — `runStorylineGraphChore` was added after that was written, for
 * the percolation alarm's nightly series (VERCEL-PHASE-0-FINDINGS §2.7), and
 * `summaries` is the historical preserve (ADR-0023). The promise was that
 * anything the night does can be re-run on its own from a curl instead of an
 * SSH, and that is what this list is.
 *
 * The three a scheduler points at come first — `retention`, `storylines` and
 * `summaries`, in the order of the clock (03:00, 04:00, 05:00 UTC). The rest are
 * the on-demand halves of the composite second one.
 */
export const CHORE_PASSES = [
  "retention",
  "storylines",
  "summaries",
  "dormancy",
  "bridges",
  "late-candidates",
  "labels",
  "label-merge",
  "graph",
] as const;

export type ChorePass = (typeof CHORE_PASSES)[number];

export function isChorePass(value: string): value is ChorePass {
  return (CHORE_PASSES as readonly string[]).includes(value);
}

/**
 * Session-scoped advisory lock keys — **three domains, not one per pass**.
 *
 * These are the exact keys `chores-cli.ts` has always used, and that is the
 * point: the CLI and the route must contend, or "re-run just the label pass from
 * a laptop" becomes a way to run the label pass twice at once while the
 * scheduler is midway through it. The label pass spends real money per call.
 *
 * A key per *pass* would have been the obvious shape and is wrong for the same
 * reason: `storylines` CONTAINS `labels`, so passes in one family overlap by
 * construction and a per-pass key would let them run concurrently. One domain
 * per family is the coarsest lock that is still honest about what conflicts —
 * and `summaries` is a family of one because it conflicts with neither of the
 * others on any table (see its key below).
 *
 * Deliberately adjacent to, and never equal to, the migrator's 7226461501 — a
 * chore that took the migration lock would be a deploy hanging behind a label
 * pass.
 */
export const CHORE_LOCK_KEYS = {
  retention: 7_226_461_502,
  storylines: 7_226_461_503,
  /**
   * A THIRD domain, and the trade is worth stating because sharing the
   * storyline lock was the other option.
   *
   * The summary pass writes only `storyline_day_summaries` and reads `articles`
   * and `storylines`, so it conflicts with the storyline night on no table at
   * all. What it does share is the model KEY — so a summary pass overlapping a
   * long label pass puts two pacers on one key, which the 429 cooldown catches
   * rather than the window (`gemini.ts`).
   *
   * Sharing the lock would have prevented that overlap by making the summary
   * pass SKIP whenever the label pass ran long. That is the wrong trade for a
   * preserve: a night of history would be lost to a slow label pass, recorded as
   * a `skipped` row that reads like the mechanism working. Deferring the cost to
   * the cooldown is recoverable; a skipped night that nobody re-runs is not.
   */
  summaries: 7_226_461_504,
} as const;

/**
 * Which lock a pass takes, and the one pass that takes none.
 *
 * `graph` is pure read — `readStorylineStats` and a log line — so it cannot
 * conflict with anything, and giving it the storyline lock would make the
 * percolation alarm unreadable during exactly the multi-hour pass you would want
 * to read it during.
 */
export function choreLockKey(pass: ChorePass): number | null {
  if (pass === "graph") return null;
  if (pass === "retention") return CHORE_LOCK_KEYS.retention;
  if (pass === "summaries") return CHORE_LOCK_KEYS.summaries;
  return CHORE_LOCK_KEYS.storylines;
}

const PASS_RUNNERS: Record<ChorePass, (deps: StorylinePassDeps) => Promise<unknown>> = {
  retention: (deps) => runRetentionChore(deps),
  storylines: (deps) => runStorylinePass(deps),
  dormancy: (deps) => runDormancyChore(deps),
  bridges: (deps) => runBridgeSweepChore(deps),
  // Addressed directly, the sweep RUNS — the `lateCandidateSweep` gate is not
  // consulted here and that is not an oversight. The gate exists so the sweep
  // does not happen at 3am unattended while K is unmeasured
  // (VERCEL-PHASE-0-FINDINGS §2.6); naming it in a query parameter is the
  // deliberate operator act the gate was protecting, exactly as
  // `--late-candidates` is on the CLI. What it still honours is the SCOPE knob,
  // because "unfiltered or changed-set" is a question about the run rather than
  // about whether to run.
  "late-candidates": (deps) =>
    runLateCandidateChore({
      ...deps,
      ...(deps.lateCandidatesChangedOnly !== undefined
        ? { changedOnly: deps.lateCandidatesChangedOnly }
        : {}),
    }),
  labels: (deps) => runStorylineLabelChore(deps),
  summaries: (deps) => runSummaryChore(deps),
  "label-merge": (deps) => runLabelMergeChore(deps),
  graph: (deps) => runStorylineGraphChore(deps),
};

/** What one invocation did. `runId` is null when the record itself could not be written. */
export interface ChoreRunResult {
  pass: ChorePass;
  outcome: ChoreOutcome;
  runId: string | null;
  report?: unknown;
  error?: unknown;
  ms: number;
}

export interface ChoreRunOptions {
  /** Which entrypoint is running this — recorded on the row. */
  source: "route" | "cli";
}

/**
 * Take the pass's lock, run it, and record the run.
 *
 * The order is load-bearing in one place: **the `chore_runs` row is opened
 * before the lock is attempted**, so a night that skipped is a row saying so
 * rather than a silence indistinguishable from a night nothing was scheduled.
 * That is the whole reason `skipped` is an outcome and not an early return.
 *
 * Never throws. A pass that fails is recorded as `failed` and returned, because
 * the callers want to log it themselves — the CLI as a non-zero exit, the route
 * as a line in a log the response has long since stopped waiting for.
 */
export async function runChorePass(
  pass: ChorePass,
  deps: StorylinePassDeps,
  options: ChoreRunOptions,
): Promise<ChoreRunResult> {
  const db = deps.db;
  const startedAt = deps.now();
  const runId = await openRun(db, pass, options.source, startedAt, deps.log);
  const clockStartedAt = Date.now();
  const elapsed = (): number => Date.now() - clockStartedAt;

  const lockKey = choreLockKey(pass);
  let report: unknown;
  let ran = true;
  try {
    if (lockKey === null) {
      report = await PASS_RUNNERS[pass](deps);
    } else {
      ran = await withPassLock(db, lockKey, async () => {
        report = await PASS_RUNNERS[pass](deps);
      });
    }
  } catch (error) {
    await closeRun(
      db,
      runId,
      {
        finishedAt: deps.now(),
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
      deps.log,
    );
    return { pass, outcome: "failed", runId, error, ms: elapsed() };
  }

  if (!ran) {
    await closeRun(db, runId, { finishedAt: deps.now(), outcome: "skipped" }, deps.log);
    deps.log.warn(
      { pass },
      "another run holds this pass's lock — skipping. Expected when a run overlaps " +
        "the next schedule; a run that never finishes looks like this every night.",
    );
    return { pass, outcome: "skipped", runId, ms: elapsed() };
  }

  const summary = summarizeChoreReport(report);
  // The aggregate, as its own line. Each sub-chore logs its own tally, but the
  // composite's shape — which halves ran, what the night ended at — was only
  // ever visible in `chores-cli.ts`'s `storyline pass complete`, which the route
  // had no equivalent of. It is emitted here so both entrypoints have it, and it
  // is the SUMMARIZED report so the log cannot carry what the row deliberately
  // does not.
  deps.log.info({ pass, report: summary }, "chore pass report");
  await closeRun(
    db,
    runId,
    {
      finishedAt: deps.now(),
      outcome: "ok",
      report: summary,
      modelCalls: modelCallsFrom(pass, report),
    },
    deps.log,
  );
  return { pass, outcome: "ok", runId, report: summary, ms: elapsed() };
}

/**
 * `pg_TRY_advisory_lock`, not `pg_advisory_lock`: a second run must skip, not
 * queue behind the first and then start the same night's work an hour late.
 *
 * Exported for `storyline-summary-cli.ts`, which is not a pass and still has to
 * contend with one: it writes the same rows the `summaries` pass writes, and the
 * losing side of that race can overwrite a sentence with a refusal it decided on
 * from a stale read. Every other operator CLI here writes rows a later pass can
 * rebuild; that one does not.
 *
 * Session-scoped, on a PINNED connection — through a transaction-mode pooler a
 * session lock is taken on one backend and looked for on another, so
 * `pg_try_advisory_lock` returns true every time and both schedulers run the
 * night. That is why every caller of this builds its handle with
 * `session: true` (§4.1, `wiring.createConfiguredDb`).
 */
export async function withPassLock(
  db: Kysely<Database>,
  key: number,
  run: () => Promise<void>,
): Promise<boolean> {
  return db.connection().execute(async (connection) => {
    const locked = await sql<{
      locked: boolean;
    }>`select pg_try_advisory_lock(${sql.lit(key)}) as locked`.execute(connection);
    if (locked.rows[0]?.locked !== true) return false;
    try {
      await run();
      return true;
    } finally {
      // Unguarded on purpose. The unhandled case — the unlock throws, the
      // connection survives, and it returns to the pool still holding a
      // session-scoped lock that is re-entrant for whoever draws it next — is
      // unreachable rather than merely unlikely: `pg_advisory_unlock` on a live
      // backend that holds the lock cannot fail, so a throw here means the
      // connection is broken, a broken backend's session is gone, and Postgres
      // has released the lock with it. node-postgres also discards an errored
      // client rather than returning it to the pool. Catching would only convert
      // that into a swallowed diagnostic.
      await sql`select pg_advisory_unlock(${sql.lit(key)})`.execute(connection);
    }
  });
}

/**
 * The bookkeeping is allowed to fail; the pass is not allowed to fail with it.
 *
 * A deployment whose migrations have not caught up has no `chore_runs` table,
 * and refusing to run the night's work over a missing record would be the record
 * doing harm. Both halves therefore warn and continue, and a null `runId` simply
 * means there is nothing to close.
 */
async function openRun(
  db: Kysely<Database>,
  pass: ChorePass,
  source: "route" | "cli",
  startedAt: Date,
  log: StorylinePassDeps["log"],
): Promise<string | null> {
  try {
    return await startChoreRun(db, { pass, source, startedAt });
  } catch (error) {
    log.warn(
      { pass, err: error instanceof Error ? error.message : String(error) },
      "could not open a chore_runs row; the pass still runs",
    );
    return null;
  }
}

async function closeRun(
  db: Kysely<Database>,
  runId: string | null,
  finish: {
    finishedAt: Date;
    outcome: ChoreOutcome;
    report?: unknown;
    error?: string;
    modelCalls?: number | undefined;
  },
  log: StorylinePassDeps["log"],
): Promise<void> {
  if (runId === null) return;
  try {
    await finishChoreRun(db, { id: runId, ...finish });
  } catch (error) {
    log.warn(
      { runId, err: error instanceof Error ? error.message : String(error) },
      "could not close the chore_runs row; it will read as never finished",
    );
  }
}

/**
 * Model calls this run spent, for the `chore_runs` column.
 *
 * **It is the LABEL or SUMMARY pass's own count and not a full audit**, which is
 * worth stating because the number looks like one. The bridge sweep, the
 * late-candidate sweep
 * and the label-agreement merge each re-label the survivors of what they change,
 * and none of their reports counts those calls — the report shapes are about
 * merges and attachments, and widening them to carry a call count is a change to
 * five signatures for a number the label pass dominates by orders of magnitude.
 * What this column is for is the trend ("what is a night costing?"), and the
 * trend is the label pass.
 */
function modelCallsFrom(pass: ChorePass, report: unknown): number | undefined {
  const spender =
    pass === "labels" || pass === "summaries"
      ? (report as { model?: unknown } | undefined)
      : pass === "storylines"
        ? (report as { labels?: { model?: unknown } } | undefined)?.labels
        : undefined;
  const model = spender?.model;
  return typeof model === "number" ? model : undefined;
}

/**
 * The report as it goes into `chore_runs.report`, with every long array replaced
 * by a count and a sample.
 *
 * **This is a size bound, and it is load-bearing in the same PR that adds a
 * sweep to defend a 500 MB budget.** Several reports carry members that scale
 * with the corpus rather than with the night: the retention report's
 * `idleTopics` is every idle topic's fingerprint and grows for as long as
 * retention keeps reporting rather than deleting; `BridgeSweepReport.survivors`
 * and `LabelMergeReport.survivors`/`refusals` are UUIDs of everything the pass
 * touched, which on a backlog night is thousands. `chore_runs` has no prune, so
 * a record of the night would slowly become a second copy of the corpus.
 *
 * **A general rule rather than a list of known members**, deliberately: a
 * per-shape summarizer is a thing five report types can each grow past without
 * anybody noticing, and the failure is silent and cumulative. The cap is what a
 * reader can actually use — you read a series of these for counts, and the
 * identities of 400 merge survivors are in `storylines` where they belong.
 *
 * The sample is three items, so a spot-check is still possible without storing
 * the set. The cap is above every SHORT array a report legitimately carries —
 * `reindex.tables` is nine — so nothing useful is collapsed today, and adding a
 * tenth table does not silently truncate it.
 */
export const REPORT_ARRAY_CAP = 16;
const REPORT_SAMPLE = 3;

export function summarizeChoreReport(report: unknown): unknown {
  if (report === undefined) return null;
  return boundArrays(report, 0);
}

/**
 * Depth-limited on purpose. Reports are two levels deep at most (the composite
 * pass's report of reports), and a bound that recurses forever is a bound that
 * can be handed a cycle.
 */
function boundArrays(value: unknown, depth: number): unknown {
  if (depth > 4) return value;
  if (Array.isArray(value)) {
    if (value.length <= REPORT_ARRAY_CAP) {
      return value.map((entry) => boundArrays(entry, depth + 1));
    }
    return {
      count: value.length,
      sample: value.slice(0, REPORT_SAMPLE).map((entry) => boundArrays(entry, depth + 1)),
    };
  }
  if (value === null || typeof value !== "object") return value;
  // Anything with a prototype of its own (a Date, an Error) is left alone: it
  // is not a report shape, and rebuilding it as a plain object would change
  // what `JSON.stringify` makes of it.
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, boundArrays(entry, depth + 1)]),
  );
}
