import { sql, type Kysely } from "kysely";
import type { Database } from "./database.js";

/**
 * Retention (ARCHITECTURE 7.5, ADR-0001). This REPORTS and does not delete:
 * point-in-time recovery protects against accidents, not against a job doing
 * exactly what it was told, and beyond the 30-day upstream lookback our store
 * is the only copy of what it holds. Enabling deletion is a later, deliberate
 * decision.
 */

export interface RetentionOptions {
  /** Articles older than this are prune candidates (default 90, config). */
  retentionDays: number;
  /** A topic hit within this window protects its articles (§7.5: 30 days). */
  topicIdleDays: number;
  now: Date;
}

export interface RetentionReport {
  /** Articles past retention that no recently-hit topic still claims. */
  articleCandidates: number;
  /** Sightings belonging to those articles — they would go with them. */
  sightingCandidates: number;
  /** Fingerprints (hex) of topics idle past the window. */
  idleTopics: string[];
}

export async function retentionReport(
  db: Kysely<Database>,
  options: RetentionOptions,
): Promise<RetentionReport> {
  const publishedCutoff = new Date(
    options.now.getTime() - options.retentionDays * 86_400_000,
  );
  const hitCutoff = new Date(options.now.getTime() - options.topicIdleDays * 86_400_000);

  // An article is protected by membership in ANY recently-hit topic; an
  // article in no topic at all has nobody left to claim it.
  const { rows } = await sql<{ articles: string; sightings: string }>`
    with candidates as (
      select a.id
      from articles a
      where a.published < ${publishedCutoff}
        and not exists (
          select 1
          from topic_articles ta
          join topics t on t.fingerprint = ta.fingerprint
          where ta.article_id = a.id
            and t.last_hit_at >= ${hitCutoff}
        )
    )
    select
      (select count(*) from candidates) as articles,
      (select count(*) from sightings s where s.article_id in (select id from candidates))
        as sightings
  `.execute(db);

  const idle = await db
    .selectFrom("topics")
    .select("fingerprint")
    .where("last_hit_at", "<", hitCutoff)
    .orderBy("last_hit_at")
    .execute();

  return {
    articleCandidates: Number(rows[0]?.articles ?? 0),
    sightingCandidates: Number(rows[0]?.sightings ?? 0),
    idleTopics: idle.map((row) => row.fingerprint.toString("hex")),
  };
}
