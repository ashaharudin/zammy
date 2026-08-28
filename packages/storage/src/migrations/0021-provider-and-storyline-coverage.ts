import { sql, type Kysely } from "kysely";

/**
 * Coverage gains a provider, and a second subject
 * (docs/DESIGN-DISCOVERY-AND-DEEPENING.md §2b; plan §G3).
 *
 * ADR-0012 deferred exactly this and named it: "`topic_coverage` gaining a
 * provider column so each provider's spans are tracked and repaired
 * independently. That is a schema and planner change, and it buys nothing until
 * a supplement contributes enough to be worth backfilling. Deferred, not
 * forgotten." The deepening plane makes it worth backfilling, so this cashes it
 * in — the schema half only. Nothing reads `storyline_coverage` until G5, and
 * no planner changes here.
 *
 * ## Why two subjects rather than one wider table
 *
 * `topic_coverage` is keyed on a topic fingerprint: a hash of the SEARCH that
 * was run. The deepening plane's unit is a storyline — a persistent arc
 * (ADR-0011) whose identity is a UUID that outlives any particular query text —
 * and it does not run a topic search at all. Folding both into one table would
 * need a nullable subject column per kind and a CHECK that exactly one is set,
 * which is a discriminated union pretending to be a table; the two subjects have
 * different foreign keys, different cascade behaviour, and different readers.
 *
 * What the split buys is the thing ADR-0012 spends itself protecting: **two
 * planes that never write each other's coverage cannot manufacture coverage over
 * spans the other never fetched.** A deepening fetch physically cannot mark a
 * topic span covered, because it has nowhere to write that claim.
 *
 * ## Why `DEFAULT 'currents'` on the existing table, and why it stays
 *
 * Migration 0013's argument, unchanged. Until this migration there was exactly
 * one provider writing coverage, so the default backfills every existing row
 * correctly — verified against the dev archive: all 383 rows are Currents'.
 *
 * The default STAYS rather than being dropped afterwards, for 0013's reason:
 * "a write path that forgot to set it would otherwise fail at 3am, and being
 * wrong about the provider of one row is much cheaper than refusing to ingest
 * it." That trade holds here with one extra clause worth naming, because
 * coverage is the table where being wrong is normally the expensive direction:
 * a row defaulted to `'currents'` is a claim that Currents covered a span it may
 * not have, which is over-coverage — the failure ADR-0001 exists to prevent.
 * The default is still right, because the alternative is not "no row" but "the
 * fill succeeded and recorded nothing", which is under-coverage that nothing
 * ever repairs, plus a 3am page. Over-coverage of one span by one provider is
 * recoverable; a coverage write that refuses is a gap with no evidence it
 * exists.
 *
 * `storyline_coverage.provider` deliberately has NO default. There is no history
 * to backfill and no single obvious value — which plane writes storyline
 * coverage is G5's decision, not this migration's — so a writer that forgets it
 * should fail loudly at the point the mistake is made.
 *
 * ## Why `topic_coverage_gist` is left alone — the numbers
 *
 * `USING gist (fingerprint, span)`, unchanged. `btree_gist` has been enabled
 * since 0001, so `(fingerprint, provider, span)` was available and was measured
 * rather than assumed.
 *
 * Measured on the dev archive's own `topic_coverage` (383 rows, 276 topics,
 * max 4 spans per topic — merge-on-write in `recordCoverage` is what bounds
 * that), `EXPLAIN (ANALYZE, BUFFERS)` on `readCoverage`'s exact query:
 *
 *   index                          today's read        + provider predicate
 *   (fingerprint, span)            9 buffers, 0.36ms   3 buffers, 0.063ms
 *   (fingerprint, provider, span)  9 buffers, 0.35ms   3 buffers, 0.047ms
 *   index size                     56 kB               64 kB
 *
 * Identical plans and identical buffer counts. Adding `provider` moves it from
 * `Filter:` to `Index Cond:` and saves nothing, because `fingerprint` has
 * already narrowed the scan to four rows on one heap page.
 *
 * Repeated at 400,000 rows across two providers — 1,045x the real table, far
 * past anything merge-on-write permits — the composite gets WORSE on the query
 * the code actually runs: 57 buffers against 37, because the index tuples are
 * wider, for a 47 MB -> 56 MB index. On the provider-scoped query it saves at
 * most two buffers. Over 5,000 sequential reads the wall-clock difference
 * between the two indexes was ~4 microseconds per read in the composite's
 * favour — the opposite sign to the buffer counts, which is how you know the
 * effect is below the noise floor either way.
 *
 * The structural reason behind the numbers: `provider` has two values and
 * `fingerprint` has 276, and `recordCoverage` merges on write so a topic's spans
 * are a handful of disjoint rows rather than a history. All the selectivity is
 * in the subject column. A two-valued column cannot earn an index level here at
 * any scale this table can reach.
 *
 * `storyline_coverage_gist` follows the same shape and the same reasoning:
 * `(storyline_id, span)`, no `provider`.
 *
 * ## Why `storyline_coverage` has no primary key
 *
 * `topic_coverage`'s precedent, deliberately followed. Neither table wants
 * uniqueness on `(subject, provider, span)`: `recordStorylineCoverage` INSERTS
 * the new span and then folds the whole set with `range_agg`, so an overlapping
 * row exists inside the transaction by design. The obvious constraint — a GiST
 * `EXCLUDE` on overlapping spans, which this table's index could have supported
 * for free — would reject that insert and break the merge idiom outright. The
 * disjointness is an invariant the WRITER maintains, not one the schema can
 * express without forbidding the write that establishes it.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE topic_coverage ADD COLUMN provider text NOT NULL DEFAULT 'currents'
  `.execute(db);

  // `storyline_id` nullable, mirroring `topic_coverage.fingerprint` (0001). The
  // FK still holds: a row can name no storyline, but it cannot name one that
  // does not exist, and a null-subject row is invisible to every read here
  // (they all filter `storyline_id = $1`) — dead weight rather than a coverage
  // claim over something unfetched.
  await sql`
    CREATE TABLE storyline_coverage (
      storyline_id uuid REFERENCES storylines ON DELETE CASCADE,
      provider     text NOT NULL,
      span         tstzrange NOT NULL,
      fetched_at   timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE INDEX storyline_coverage_gist ON storyline_coverage USING gist (storyline_id, span)
  `.execute(db);

  // 0019's convention: a migration that creates a table enables RLS on it, in
  // the same `up`. 0019 was a one-time sweep and cannot reach a table added
  // after it; `migrator.test.ts` asserts no public table reaches the current
  // schema with RLS off, which is what makes this a rule rather than a comment.
  await sql`ALTER TABLE storyline_coverage ENABLE ROW LEVEL SECURITY`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS storyline_coverage`.execute(db);
  await sql`ALTER TABLE topic_coverage DROP COLUMN IF EXISTS provider`.execute(db);
}
