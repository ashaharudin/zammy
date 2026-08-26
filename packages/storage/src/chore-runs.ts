import type { Kysely } from "kysely";
import type { ChoreOutcome, Database } from "./database.js";

/**
 * Reads and writes for `chore_runs` (migration 0018) — the durable record that a
 * nightly pass ran.
 *
 * The migration header has the reasoning; this module is the two writes and the
 * one read, kept in the storage package for the same reason every other query
 * is: the api app owns decisions, not SQL.
 */

/** What a run is, before it has run. */
export interface ChoreRunStart {
  /** The addressable pass name, exactly as the route and the CLI spell it. */
  pass: string;
  /** `route` or `cli`. */
  source: "route" | "cli";
  startedAt: Date;
}

/** What a run turned out to be. */
export interface ChoreRunFinish {
  id: string;
  finishedAt: Date;
  outcome: ChoreOutcome;
  /** Already summarized by the caller — see the api's `summarizeChoreReport`. */
  report?: unknown;
  /** The message, for `failed`. The stack belongs in the log. */
  error?: string | undefined;
  /** Model calls this run spent, where the pass makes any. */
  modelCalls?: number | undefined;
}

export interface ChoreRun {
  id: string;
  pass: string;
  source: string;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: ChoreOutcome | null;
  report: unknown;
  error: string | null;
  modelCalls: number | null;
}

/**
 * Open a run. Returns the row id the finish below needs.
 *
 * Deliberately NOT wrapped in the caller's transaction, and there is no
 * transaction here either: the whole point of the start row is that it survives
 * a pass that never returns, and a row inside a transaction the pass is still
 * holding open would be rolled back by exactly the crash it exists to record.
 */
export async function startChoreRun(
  db: Kysely<Database>,
  input: ChoreRunStart,
): Promise<string> {
  const row = await db
    .insertInto("chore_runs")
    .values({
      pass: input.pass,
      source: input.source,
      started_at: input.startedAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Close a run.
 *
 * `report` is stringified here rather than by the caller because the column is
 * `jsonb` and the driver would otherwise send a JS object as a Postgres record
 * literal. `undefined` and `null` both mean "no report", which is what a skipped
 * run has.
 */
export async function finishChoreRun(
  db: Kysely<Database>,
  input: ChoreRunFinish,
): Promise<void> {
  await db
    .updateTable("chore_runs")
    .set({
      finished_at: input.finishedAt,
      outcome: input.outcome,
      report: input.report === undefined ? null : JSON.stringify(input.report),
      error: input.error ?? null,
      model_calls: input.modelCalls ?? null,
    })
    .where("id", "=", input.id)
    .execute();
}

/**
 * The most recent runs, newest first — "did last night's chores run?" as a
 * query.
 *
 * `pass` narrows it to one pass's series, which is what the percolation alarm
 * reads (`?pass=storylines`, then `report->'graph'`). Without it the answer is
 * the night across every pass, which is the operator's version of the same
 * question.
 */
export async function readChoreRuns(
  db: Kysely<Database>,
  options: { pass?: string | undefined; limit?: number } = {},
): Promise<ChoreRun[]> {
  let query = db
    .selectFrom("chore_runs")
    .select([
      "id",
      "pass",
      "source",
      "started_at",
      "finished_at",
      "outcome",
      "report",
      "error",
      "model_calls",
    ])
    .orderBy("started_at", "desc")
    .limit(Math.min(Math.max(options.limit ?? 20, 1), 200));
  if (options.pass) query = query.where("pass", "=", options.pass);

  const rows = await query.execute();
  return rows.map((row) => ({
    id: row.id,
    pass: row.pass,
    source: row.source,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome,
    report: row.report ?? null,
    error: row.error,
    modelCalls: row.model_calls,
  }));
}
