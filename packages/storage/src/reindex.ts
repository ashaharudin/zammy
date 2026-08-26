import { sql, type Kysely } from "kysely";
import type { Database } from "./database.js";

/**
 * The nightly index-bloat sweep (VERCEL-ALL-IN-SCOPE §3.3;
 * VERCEL-PHASE-0-FINDINGS §5).
 *
 * ## Why this exists, and why it is not a performance chore
 *
 * It is a **storage** chore. Autovacuum keeps up with dead tuples here —
 * `n_dead_tup` is 0 on the worst table — it simply does not return the pages to
 * the filesystem, and index pages are the bulk of what it does not return.
 * Measured on the dev archive: **190 MB live against 125 MB freshly restored**,
 * 22% of the database, concentrated exactly where the design churns hardest
 * (`story_token_days`: 605,268 deletes against 84,550 live rows, 52 MB live
 * versus 12 MB restored).
 *
 * `REINDEX TABLE CONCURRENTLY` recovers it in **2.0 s across these tables**,
 * non-blocking. On Supabase's free 500 MB that is the difference between the
 * storage tripwire reading **1,214 articles/day and 1,485** — against an
 * observed ingest of 742–1,747/day. The habit is what keeps the corpus inside
 * the budget at 90 days of retention; the ingest rate alone does not decide it.
 *
 * ## Why these tables and not `REINDEX DATABASE`
 *
 * `REINDEX DATABASE` cannot be run CONCURRENTLY, so it takes locks a live
 * deployment should not take at 3am for the sake of tables that do not churn.
 * The list below is the measured one: §4's seven retention-scaling tables plus
 * `story_token_days`, which is not retention-scaling — it is bounded by the DF
 * window — but is the single largest recovery in the measurement and the one
 * table the linker rewrites wholesale every night.
 *
 * Everything not listed accounted for ~5 MB of bloat between them (§5's
 * "everything else"), which is not worth the round trips or the invalid-index
 * risk below.
 *
 * ## The failure mode this reports on
 *
 * A `REINDEX ... CONCURRENTLY` that is interrupted leaves an **invalid index**
 * behind — a `*_ccnew` twin that is never used for reads and is still maintained
 * on every write, so it costs write throughput and the disk space this pass
 * exists to reclaim. Nothing cleans them up automatically and nothing complains.
 * The sweep therefore counts them afterwards and reports the number, because a
 * silent accumulation of them is a direct inversion of what this chore is for.
 */

/**
 * The tables reindexed, in the order they are worth doing.
 *
 * A hard-coded list rather than a parameter, and read into `sql.raw` — these are
 * identifiers, which cannot be bound as parameters, so the list being a
 * compile-time constant is what makes that safe.
 */
export const REINDEX_TABLES = [
  // The largest recovery by a wide margin: 30 MB of indexes down to 7 MB, in
  // 355 ms of the sweep's 2.0 s (findings §5).
  "story_token_days",
  "story_corpus_days",
  "articles",
  "sightings",
  "storylines",
  "storyline_groups",
  "storyline_days",
  "storyline_bridges",
  "topic_articles",
] as const;

export interface ReindexTableResult {
  table: string;
  ms: number;
  /** False when this table's reindex threw; the sweep continues regardless. */
  ok: boolean;
  error?: string;
}

export interface ReindexReport {
  tables: ReindexTableResult[];
  /** Wall clock for the whole sweep. */
  ms: number;
  failed: number;
  /**
   * Invalid indexes standing after the sweep — interrupted CONCURRENTLY runs.
   * Should be 0; anything else wants `DROP INDEX` by hand, because dropping an
   * index automatically is not a thing a nightly chore gets to decide.
   */
  invalidIndexes: string[];
}

/**
 * Run the sweep. Never throws: a table that fails is recorded and the next one
 * is attempted.
 *
 * That tolerance is deliberate and it is not the usual "keep going" reflex.
 * `REINDEX ... CONCURRENTLY` waits for transactions older than itself and can be
 * cancelled by the deadlock detector or a lock timeout, and the pass it lives in
 * — retention — is a REPORT whose numbers matter more than this does. Aborting
 * the night's report because one index rebuild lost a race would trade the
 * deliverable for the side effect.
 */
export async function reindexBloatedTables(
  db: Kysely<Database>,
  options: { now?: () => number } = {},
): Promise<ReindexReport> {
  const clock = options.now ?? (() => Date.now());
  const startedAt = clock();
  const tables: ReindexTableResult[] = [];

  for (const table of REINDEX_TABLES) {
    const tableStartedAt = clock();
    try {
      // Not inside a transaction, and it cannot be: Postgres rejects REINDEX
      // CONCURRENTLY in a transaction block. Kysely's bare `execute(db)` borrows
      // a pooled connection and issues the statement on its own, which is
      // exactly right — nothing here needs two statements to agree.
      await sql`REINDEX TABLE CONCURRENTLY ${sql.raw(table)}`.execute(db);
      tables.push({ table, ms: clock() - tableStartedAt, ok: true });
    } catch (error) {
      tables.push({
        table,
        ms: clock() - tableStartedAt,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const invalid = await sql<{ name: string }>`
    select c.relname as name
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not i.indisvalid
      and n.nspname = current_schema()
  `.execute(db);

  return {
    tables,
    ms: clock() - startedAt,
    failed: tables.filter((entry) => !entry.ok).length,
    invalidIndexes: invalid.rows.map((row) => row.name),
  };
}
