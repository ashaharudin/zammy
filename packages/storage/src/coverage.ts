import { sql, type Kysely } from "kysely";
import { hexToBytea, type Database } from "./database.js";

/**
 * topic_coverage (ARCHITECTURE 7.2): which time windows have actually been
 * fetched for a topic, BY WHICH PROVIDER. This is what makes "do I need an
 * upstream call?" an exact question instead of a guess — including after a
 * zero-result fetch, which records coverage so we never re-ask (§11).
 *
 * ## Coverage is `(subject, provider, span)`, in both directions
 *
 * The governing decision is **ADR-0019**: no provider is privileged, each
 * records only the spans it actually walked, and the gap planner asks each
 * about its own gaps. (ADR-0012, which ranked providers and named this column
 * as deferred work, is superseded by it. Its core argument dissolves rather
 * than being overruled: its fear was a combined end-of-results signal claiming
 * days one provider never looked at, and per-provider rows cannot express that
 * claim.) Migration 0021 landed the column; this module is the half that reads
 * and writes through it.
 *
 * ADR-0019 is explicit that **"is this span covered" stops having a single
 * answer**, so neither function here asks it that way. `readCoverage` and
 * `recordCoverage` both take the provider, mirroring
 * `recordStorylineCoverage`/`readStorylineCoverage` next door — one concept,
 * one shape.
 *
 * **Why the read had to gain the provider in the same change as the write.**
 * A provider-blind read of a single-writer table is exact, and that is what
 * this was: every row was `'currents'` because `recordCoverage` hardcoded it.
 * The moment a second provider's rows land, a blind read unions them and hands
 * the gap planner spans the provider being planned for never walked — silent
 * under-fetching, producing permanent gaps the system believes are filled. That
 * is the expensive direction (ADR-0001), and it is why a half-applied version
 * of this change — a predicate on one side and not the other — would have been
 * worse than none.
 *
 * **What this module does NOT decide** is which provider a caller asks about.
 * That is a planner question and it lives with the planner
 * (`apps/api/src/coverage-gaps.ts`), which is also why no provider name appears
 * in this package any more: `@zammy/news-client` states the rule that a
 * provider-agnostic package must never learn one, and storage has no better
 * excuse than the client does.
 */

export interface CoverageSpan {
  from: Date;
  to: Date;
}

/**
 * Record a span ONE PROVIDER fetched for a topic, merging overlapping and
 * adjacent spans on write so the table stays small and reads see disjoint
 * ranges (§7.2).
 *
 * The merged span keeps the OLDEST contributing fetched_at — understating
 * freshness costs at worst a redundant top-up call; overstating it hides
 * staleness with no error anywhere.
 *
 * Merges within ONE provider's rows. The fold is a delete-and-rewrite, so an
 * unscoped one would take a foreign provider's rows into the `range_agg`,
 * coalesce them with this provider's spans, and write the union back under this
 * provider's name — one provider claiming spans another walked, which is exactly
 * what "no provider can claim what another fetched" (ADR-0019) forbids, arriving
 * through the back door of a write that was not thinking about providers at all.
 * Per-provider rows are what make that claim inexpressible, and they only do so
 * if the writes respect them.
 */
export async function recordCoverage(
  db: Kysely<Database>,
  fingerprint: string,
  provider: string,
  span: CoverageSpan,
): Promise<void> {
  const key = hexToBytea(fingerprint);

  await db.transaction().execute(async (trx) => {
    // Serialize writers per topic. Two concurrent recorders would otherwise
    // each merge from a snapshot missing the other's insert, and the
    // delete-and-rewrite below would drop one of the spans.
    //
    // Deliberately per TOPIC and not per `(topic, provider)`, unlike
    // `recordStorylineCoverage`, which locks the pair. Narrowing it would be
    // free contention relief and is not worth what it costs to get there: two
    // builds are live at once during a deploy, and a key change means the old
    // build's lock and the new build's lock are different keys over the same
    // rows — the interleaving this lock exists to prevent, arriving exactly
    // once and only in production. The pair-scoped lock is correct the day
    // there is no build holding the topic-scoped one.
    await sql`select pg_advisory_xact_lock(hashtext(${fingerprint}))`.execute(trx);

    await trx
      .insertInto("topic_coverage")
      .values({
        fingerprint: key,
        provider,
        span: sql<string>`tstzrange(${span.from}, ${span.to}, '[)')`,
      })
      .execute();

    // range_agg folds everything into a multirange, which coalesces overlaps
    // and adjacency; unnest hands back the disjoint spans.
    await sql`
      with all_spans as (
        select span, fetched_at from topic_coverage
         where fingerprint = ${key} and provider = ${provider}
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
         where fingerprint = ${key} and provider = ${provider}
      )
      insert into topic_coverage (fingerprint, provider, span, fetched_at)
      select ${key}, ${provider}, span, fetched_at from rewritten
    `.execute(trx);
  });
}

/**
 * All spans ONE PROVIDER has covered for a topic, disjoint and ascending.
 *
 * The provider predicate is the load-bearing half of this function, not a
 * refinement of it: without it the gap planner unions every provider's rows and
 * subtracts them from the window it is planning for one provider, so a span
 * another provider walked reads as covered and is never fetched. There is no
 * error, no metric and no retry, because coverage says the work is done — the
 * failure ADR-0001 exists to prevent, in its unrecoverable direction.
 *
 * Disjoint and ascending is the contract the gap subtraction upstairs
 * (`apps/api/src/coverage-gaps.ts`) is written against — it re-merges
 * defensively, but the single sweep it does is only correct over ordered input.
 * `recordCoverage` is what establishes it; this read only has to not break it.
 *
 * Rows written before migration 0021 read normally: that migration's column
 * defaulted every existing row to `'currents'`, which was exactly true of all of
 * them, so an existing deployment's coverage is found by asking for Currents'.
 */
export async function readCoverage(
  db: Kysely<Database>,
  fingerprint: string,
  provider: string,
): Promise<CoverageSpan[]> {
  const { rows } = await sql<{ from: Date; to: Date }>`
    select lower(span) as "from", upper(span) as "to"
    from topic_coverage
    where fingerprint = ${hexToBytea(fingerprint)} and provider = ${provider}
    order by lower(span)
  `.execute(db);

  return rows.map((row) => ({ from: row.from, to: row.to }));
}
