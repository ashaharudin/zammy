import { sql, type Kysely } from "kysely";
import { hexToBytea, type Database } from "./database.js";

/**
 * topic_coverage (ARCHITECTURE 7.2): which time windows have actually been
 * fetched for a topic. This is what makes "do I need an upstream call?" an
 * exact question instead of a guess — including after a zero-result fetch,
 * which records coverage so we never re-ask (§11).
 */

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
        span: sql<string>`tstzrange(${span.from}, ${span.to}, '[)')`,
      })
      .execute();

    // range_agg folds everything into a multirange, which coalesces overlaps
    // and adjacency; unnest hands back the disjoint spans.
    await sql`
      with all_spans as (
        select span, fetched_at from topic_coverage where fingerprint = ${key}
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
        delete from topic_coverage where fingerprint = ${key}
      )
      insert into topic_coverage (fingerprint, span, fetched_at)
      select ${key}, span, fetched_at from rewritten
    `.execute(trx);
  });
}

/** All covered spans for a topic, disjoint and ascending. */
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
