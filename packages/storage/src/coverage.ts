import { sql, type Kysely } from "kysely";
import { hexToBytea, type Database } from "./database.js";

/**
 * topic_coverage (ARCHITECTURE 7.2): which time windows have actually been
 * fetched for a topic. This is what makes "do I need an upstream call?" an
 * exact question instead of a guess — including after a zero-result fetch,
 * which records coverage so we never re-ask (§11).
 *
 * ## The provider column, and why the reads here ignore it
 *
 * Migration 0021 gave the table a `provider`, paying ADR-0012's named debt. The
 * reads below deliberately do not filter on it, and that is a decision rather
 * than an omission.
 *
 * Currents is the only thing that writes topic coverage — ADR-0012 makes that
 * structural, not incidental: a best-effort supplement may never end a walk, so
 * it has no end-of-results signal to record, and the deepening plane writes to
 * `storyline_coverage` instead. Every row in the table is therefore `'currents'`
 * (verified on the dev archive: 383 of 383), so `where fingerprint = $1` and
 * `where fingerprint = $1 and provider = 'currents'` select the same rows and
 * return the same answer.
 *
 * Adding the predicate now would be a change that cannot be tested against a
 * case where it matters, in a read whose answer decides whether an upstream call
 * is spent. A half-applied one would be worse than none: a provider predicate on
 * `readCoverage` with none on the gap arithmetic upstairs, or vice versa, is a
 * planner that subtracts one provider's coverage from another's window.
 *
 * **What has to change together, the day a second writer appears.** It is one
 * change with four parts, and doing any subset of it is the bug:
 *
 *   1. `recordCoverage` takes the provider instead of assuming it (below);
 *   2. `readCoverage` takes it and filters on it;
 *   3. every caller in `apps/api` — `timeline-service.ts` plans and records,
 *      `routes.ts` reports — decides WHICH provider's coverage it is asking
 *      about, which is a planner question and not a mechanical one: a window is
 *      "covered" for the discovery plane and separately for each supplement, and
 *      the gap the planner fills is per provider from that point on;
 *   4. `topic_coverage_gist` gets re-measured, since a provider predicate that
 *      nothing issues today was measured as buying zero (migration 0021).
 *
 * The WRITE path is already scoped, because it is not symmetric with the reads:
 * a provider-blind read of a single-provider table is exact, but a
 * provider-blind delete-and-rewrite would destroy rows it did not create.
 */

/**
 * The provider `recordCoverage` writes, and the only one that may.
 *
 * Not a parameter, because nothing may pass a different one: ADR-0012 makes
 * Currents the sole coverage-bearing provider for a topic, and the deepening
 * plane has its own table. Naming it is what lets the merge below scope itself
 * without a magic string, and what makes the coupling above greppable.
 */
const COVERAGE_BEARING_PROVIDER = "currents";

export interface CoverageSpan {
  from: Date;
  to: Date;
}

/**
 * Record a fetched span, merging overlapping and adjacent spans on write so
 * the table stays small and reads see disjoint ranges (§7.2).
 *
 * The merged span keeps the OLDEST contributing fetched_at — understating
 * freshness costs at worst a redundant top-up call; overstating it hides
 * staleness with no error anywhere.
 *
 * Merges within ONE provider's rows. The fold is a delete-and-rewrite, so an
 * unscoped one would take a foreign provider's rows into the `range_agg`,
 * coalesce them with Currents' spans, and write the union back stamped
 * `'currents'` — coverage manufactured over spans Currents never fetched, which
 * is precisely the failure ADR-0012 spends itself preventing, arriving through
 * the back door of a write that was not thinking about providers at all.
 *
 * This is a no-op today by construction: every row is `'currents'`, so the
 * scoped and unscoped row sets are identical. It is here because the cost of
 * being wrong is a permanent invisible gap, and the cost of being early is one
 * predicate.
 */
export async function recordCoverage(
  db: Kysely<Database>,
  fingerprint: string,
  span: CoverageSpan,
): Promise<void> {
  const key = hexToBytea(fingerprint);

  await db.transaction().execute(async (trx) => {
    // Serialize writers per topic. Two concurrent recorders would otherwise
    // each merge from a snapshot missing the other's insert, and the
    // delete-and-rewrite below would drop one of the spans.
    await sql`select pg_advisory_xact_lock(hashtext(${fingerprint}))`.execute(trx);

    await trx
      .insertInto("topic_coverage")
      .values({
        fingerprint: key,
        provider: COVERAGE_BEARING_PROVIDER,
        span: sql<string>`tstzrange(${span.from}, ${span.to}, '[)')`,
      })
      .execute();

    // range_agg folds everything into a multirange, which coalesces overlaps
    // and adjacency; unnest hands back the disjoint spans.
    await sql`
      with all_spans as (
        select span, fetched_at from topic_coverage
         where fingerprint = ${key} and provider = ${COVERAGE_BEARING_PROVIDER}
      ),
      merged as (
        select unnest(range_agg(span)) as span from all_spans
      ),
      rewritten as (
        select m.span, min(a.fetched_at) as fetched_at
        from merged m
        join all_spans a on m.span @> a.span
        group by m.span
      ),
      cleared as (
        delete from topic_coverage
         where fingerprint = ${key} and provider = ${COVERAGE_BEARING_PROVIDER}
      )
      insert into topic_coverage (fingerprint, provider, span, fetched_at)
      select ${key}, ${COVERAGE_BEARING_PROVIDER}, span, fetched_at from rewritten
    `.execute(trx);
  });
}

/**
 * All covered spans for a topic, disjoint and ascending.
 *
 * Provider-blind, and exact while Currents is the sole writer — the module
 * header says what has to change together if that stops being true.
 */
export async function readCoverage(
  db: Kysely<Database>,
  fingerprint: string,
): Promise<CoverageSpan[]> {
  const { rows } = await sql<{ from: Date; to: Date }>`
    select lower(span) as "from", upper(span) as "to"
    from topic_coverage
    where fingerprint = ${hexToBytea(fingerprint)}
    order by lower(span)
  `.execute(db);

  return rows.map((row) => ({ from: row.from, to: row.to }));
}
