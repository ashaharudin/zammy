import { sql, type Kysely } from "kysely";

/**
 * Coverage gains a provider, and a second subject
 * (docs/DESIGN-DISCOVERY-AND-DEEPENING.md §2b; plan §G3).
 *
 * The governing decision is **ADR-0019**, which makes coverage
 * `(subject, provider, span)` with **no provider privileged** and names this
 * migration's two halves as what it needs. ADR-0012 — which ranked providers,
 * and which deferred exactly this ("`topic_coverage` gaining a provider column
 * so each provider's spans are tracked and repaired independently ... Deferred,
 * not forgotten") — is superseded by it. This is the schema half only: nothing
 * reads `storyline_coverage` until G5, and no planner changes here.
 *
 * ADR-0012's core argument does not have to be overruled, it dissolves. Its fear
 * was a combined end-of-results signal recording coverage over days one provider
 * never looked at; per-provider rows cannot express that claim, because each
 * provider records only the spans it actually walked and a provider that ran out
 * of budget simply still has a gap.
 *
 * ## Why two subjects rather than one wider table
 *
 * `topic_coverage` is keyed on a topic fingerprint: a hash of the SEARCH that
 * was run. A deepening fetch's unit is a storyline — a persistent arc (ADR-0011)
 * whose identity is a UUID that outlives any particular query text — and it does
 * not run a topic search at all. Folding both into one table would need a
 * nullable subject column per kind and a CHECK that exactly one is set, which is
 * a discriminated union pretending to be a table; the two subjects have different
 * foreign keys, different cascade behaviour, and different readers.
 *
 * The split also puts the wrong table out of reach rather than one argument
 * away: a deepening fetch physically cannot mark a topic span covered, because
 * it has nowhere to write that claim.
 *
 * ## Why `DEFAULT 'currents'` on the existing table, and why it stays
 *
 * Migration 0013's argument, unchanged. Until this migration there was exactly
 * one provider writing coverage, so the default backfills every existing row
 * correctly — verified against the dev archive: all 383 rows are Currents'. It
 * is a statement about history, not a designation: under ADR-0019 Google News
 * writes topic coverage too, from G5.
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
 * to backfill and no obvious value to invent — under ADR-0019 no provider is
 * privileged, and which ones deepen an arc is G5's decision — so a writer that
 * forgets it should fail loudly at the point the mistake is made.
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

  // `storyline_id NOT NULL`, which is the one place this table does NOT follow
  // `topic_coverage`'s shape — 0001 left `fingerprint` nullable and nothing has
  // needed it to be. A coverage row's whole meaning is "this span was fetched
  // FOR THIS SUBJECT"; a null subject is a claim with no claimant, invisible to
  // every read here (they all filter `storyline_id = $1`) and therefore dead
  // weight that no query would ever surface as wrong. The FK already forbids
  // naming an arc that does not exist; this forbids naming none at all, and
  // costs a writer nothing, because there is no writer yet to migrate.
  await sql`
    CREATE TABLE storyline_coverage (
      storyline_id uuid NOT NULL REFERENCES storylines ON DELETE CASCADE,
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
