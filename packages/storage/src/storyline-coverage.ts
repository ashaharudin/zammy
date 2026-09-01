import { sql, type Kysely } from "kysely";
import type { CoverageSpan } from "./coverage.js";
import type { Database } from "./database.js";

/**
 * `storyline_coverage` (migration 0021;
 * docs/DESIGN-DISCOVERY-AND-DEEPENING.md §2b): which time windows have actually
 * been fetched FOR AN ARC, by which provider.
 *
 * The same question `coverage.ts` answers about a topic — "did we ask, or was
 * nothing published?" (ADR-0001) — asked about a storyline instead. ADR-0019
 * makes coverage `(subject, provider, span)`; this module is the second subject.
 *
 * A deliberate near-copy of `coverage.ts` rather than a generalization of it:
 * the two subjects have different key types, different foreign keys, different
 * readers, and different callers planning against them. A shared helper
 * parameterized over the subject column would hand a deepening fetch a code path
 * that reaches `topic_coverage` — and "no provider can claim what another
 * fetched" is cheaper to guarantee when the wrong table is unreachable than when
 * it is one argument away.
 *
 * ## Provider-scoped in both directions, as `coverage.ts` now is too
 *
 * ADR-0019 retires the single-answer form of "is this span covered", so "what is
 * covered for this arc" is not a question and "what is covered for this arc, BY
 * THIS PROVIDER" is. A blind read would let one provider's fetches suppress
 * another's fills — over-coverage, the unrecoverable direction. This module was
 * written that way from the start, and `coverage.ts` has since been brought to
 * the same shape, so the two now differ only in their subject.
 *
 * `storyline-deepening.ts` writes here; nothing plans against the reads yet.
 */

/**
 * Advisory-lock namespace for arc coverage.
 *
 * `pg_advisory_xact_lock(int, int)` and `pg_advisory_xact_lock(bigint)` occupy
 * SEPARATE key spaces that never conflict with each other, so using the
 * two-argument form here means these locks cannot collide with `coverage.ts`'s
 * single-argument `hashtext(fingerprint)` — two unrelated recorders sharing one
 * 32-bit hash space would otherwise serialize each other for no reason, rarely
 * and unreproducibly. Arbitrary but stable; the value is never compared to
 * anything but itself.
 */
const STORYLINE_COVERAGE_LOCK_NAMESPACE = 0x5c07;

/**
 * Record a span fetched for one arc by one provider, merging overlapping and
 * adjacent spans on write.
 *
 * `coverage.ts`'s idiom throughout, for its reasons: `range_agg` folds the
 * provider's spans into a multirange that coalesces overlaps and adjacency, and
 * the merged span keeps the OLDEST contributing `fetched_at` — understating
 * freshness costs at worst a redundant top-up, overstating it hides staleness
 * with no error anywhere.
 *
 * The merge is scoped to `(storyline_id, provider)`, which is load-bearing
 * rather than tidy: it is a delete-and-rewrite, so an unscoped one would fold a
 * second provider's spans into this one's and write the union back under this
 * provider's name — a claim that this provider covered a span it never fetched.
 * Per-provider rows are what make that claim inexpressible (ADR-0019), and they
 * only do so if the writes respect them.
 */
export async function recordStorylineCoverage(
  db: Kysely<Database>,
  storylineId: string,
  provider: string,
  span: CoverageSpan,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // Serialize writers per arc PER PROVIDER, not per arc: two providers
    // recording for one storyline touch disjoint row sets, so making them wait
    // on each other would buy nothing. Two recorders for the same pair would
    // otherwise each merge from a snapshot missing the other's insert, and the
    // delete-and-rewrite below would drop one of the spans.
    await sql`
      select pg_advisory_xact_lock(
        ${sql.lit(STORYLINE_COVERAGE_LOCK_NAMESPACE)},
        hashtext(${`${storylineId}:${provider}`})
      )
    `.execute(trx);

    await trx
      .insertInto("storyline_coverage")
      .values({
        storyline_id: storylineId,
        provider,
        span: sql<string>`tstzrange(${span.from}, ${span.to}, '[)')`,
      })
      .execute();

    await sql`
      with all_spans as (
        select span, fetched_at from storyline_coverage
         where storyline_id = ${storylineId}::uuid and provider = ${provider}
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
        delete from storyline_coverage
         where storyline_id = ${storylineId}::uuid and provider = ${provider}
      )
      insert into storyline_coverage (storyline_id, provider, span, fetched_at)
      select ${storylineId}::uuid, ${provider}, span, fetched_at from rewritten
    `.execute(trx);
  });
}

/**
 * All spans one provider has covered for one arc, disjoint and ascending.
 *
 * Disjoint and ascending is the contract the gap subtraction upstairs
 * (`apps/api/src/coverage-gaps.ts`) is written against — it re-merges
 * defensively, but the single sweep it does is only correct over ordered input.
 * `recordStorylineCoverage` is what establishes it; this read only has to not
 * break it.
 */
export async function readStorylineCoverage(
  db: Kysely<Database>,
  storylineId: string,
  provider: string,
): Promise<CoverageSpan[]> {
  const { rows } = await sql<{ from: Date; to: Date }>`
    select lower(span) as "from", upper(span) as "to"
    from storyline_coverage
    where storyline_id = ${storylineId}::uuid and provider = ${provider}
    order by lower(span)
  `.execute(db);

  return rows.map((row) => ({ from: row.from, to: row.to }));
}
