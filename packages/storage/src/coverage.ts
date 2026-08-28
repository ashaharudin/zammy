import { sql, type Kysely } from "kysely";
import { hexToBytea, type Database } from "./database.js";

/**
 * topic_coverage (ARCHITECTURE 7.2): which time windows have actually been
 * fetched for a topic. This is what makes "do I need an upstream call?" an
 * exact question instead of a guess — including after a zero-result fetch,
 * which records coverage so we never re-ask (§11).
 *
 * ## The provider column, and why the reads here ignore it — for now
 *
 * Migration 0021 gave the table a `provider`. The governing decision is
 * **ADR-0019**: coverage is `(subject, provider, span)` and **no provider is
 * privileged** — each records only the spans it actually walked, and the gap
 * planner asks each about its own gaps. (ADR-0012, which ranked providers and
 * named this column as deferred work, is superseded by it. Its core argument
 * dissolves rather than being overruled: its fear was a combined end-of-results
 * signal claiming days one provider never looked at, and per-provider rows
 * cannot express that claim.)
 *
 * ADR-0019 is explicit that **"is this span covered" stops having a single
 * answer**. The reads below still ask it that way, and that is a decision about
 * sequencing rather than a disagreement: Currents is the only thing wired up to
 * write topic coverage TODAY — a fact about what exists, not a rule about what
 * may — so every row is `'currents'` (verified on the dev archive: 383 of 383)
 * and `where fingerprint = $1` selects exactly what
 * `... and provider = 'currents'` would.
 *
 * Adding the predicate in this phase would be a change with no case to test it
 * against, in a read whose answer decides whether an upstream call is spent. A
 * half-applied one would be worse than none: a provider predicate on
 * `readCoverage` with none on the gap arithmetic upstairs, or vice versa, is a
 * planner that subtracts one provider's coverage from another's window.
 *
 * **What has to change together, and G5 is when.** Google News serves search and
 * breadth as well as deepening (ADR-0019's second section), so it writes topic
 * coverage; the second writer is scheduled, not hypothetical. It is one change
 * with four parts, and doing any subset of it is the bug:
 *
 *   1. `recordCoverage` takes the provider instead of assuming it (below);
 *   2. `readCoverage` takes it and filters on it;
 *   3. every caller in `apps/api` — `timeline-service.ts` plans and records,
 *      `routes.ts` reports — decides WHICH provider's coverage it is asking
 *      about. This is the planner question ADR-0019 raises and not a mechanical
 *      substitution: each provider is planned against its own limits and its own
 *      coverage rows, so two providers can hold an open gap over the same span
 *      and both get asked. More calls is the accepted cost.
 *   4. `topic_coverage_gist` gets re-measured, since a provider predicate that
 *      nothing issues today was measured as buying zero (migration 0021).
 *
 * The WRITE path is already scoped, because it is not symmetric with the reads:
 * a provider-blind read of a single-writer table is exact, but a provider-blind
 * delete-and-rewrite would destroy rows it did not create.
 */

/**
 * The provider `recordCoverage` stamps its rows with.
 *
 * `'currents'` because Currents is the only caller wired to this function today,
 * NOT because the schema or an ADR privileges it — ADR-0019 removed that
 * privilege, and a second writer of topic coverage arrives with Google News in
 * G5. At that point this stops being a constant and becomes a parameter, along
 * with the three other parts listed above.
 *
 * Naming it is what lets the merge below scope itself without a magic string,
 * and what makes that coupling greppable from the phase that will trip it.
 */
const TOPIC_COVERAGE_PROVIDER = "currents";

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
 * `'currents'` — one provider claiming spans another walked, which is exactly
 * what "no provider can claim what another fetched" (ADR-0019) forbids, arriving
 * through the back door of a write that was not thinking about providers at all.
 * It is the same failure ADR-0012 was written to prevent; per-provider rows are
 * what make it inexpressible, and only if the writes respect them.
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
        provider: TOPIC_COVERAGE_PROVIDER,
        span: sql<string>`tstzrange(${span.from}, ${span.to}, '[)')`,
      })
      .execute();

    // range_agg folds everything into a multirange, which coalesces overlaps
    // and adjacency; unnest hands back the disjoint spans.
    await sql`
      with all_spans as (
        select span, fetched_at from topic_coverage
         where fingerprint = ${key} and provider = ${TOPIC_COVERAGE_PROVIDER}
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
         where fingerprint = ${key} and provider = ${TOPIC_COVERAGE_PROVIDER}
      )
      insert into topic_coverage (fingerprint, provider, span, fetched_at)
      select ${key}, ${TOPIC_COVERAGE_PROVIDER}, span, fetched_at from rewritten
    `.execute(trx);
  });
}

/**
 * All covered spans for a topic, disjoint and ascending.
 *
 * Provider-blind, and exact only while Currents is the sole writer. ADR-0019
 * retires the single-answer form of this question; the module header says what
 * has to change together, and that G5 is when.
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
