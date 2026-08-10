import { sql, type Kysely } from "kysely";
import { hexToBytea, type Database } from "./database.js";

/**
 * Topic reads. A queued segment job carries only the fingerprint (§9.1); the
 * topic row is where it recovers the search parameters — the topics table is
 * the durable record of what a fingerprint MEANS.
 */

export interface TopicRecord {
  fingerprint: string;
  keywords: string[];
  language: string | null;
  country: string | null;
  category: string | null;
  /** Reserved for the later summary phase; null until then (§7.2). */
  summary: string | null;
  createdAt: Date;
  lastHitAt: Date;
  hitCount: number;
}

export async function readTopic(
  db: Kysely<Database>,
  fingerprint: string,
): Promise<TopicRecord | null> {
  const row = await db
    .selectFrom("topics")
    .selectAll()
    .where("fingerprint", "=", hexToBytea(fingerprint))
    .executeTakeFirst();
  if (!row) return null;

  return {
    fingerprint: row.fingerprint.toString("hex"),
    keywords: row.keywords,
    language: row.language,
    country: row.country,
    category: row.category,
    summary: row.summary,
    createdAt: row.created_at,
    lastHitAt: row.last_hit_at,
    hitCount: Number(row.hit_count),
  };
}

/** How many ARTICLES a topic has accumulated — the §6.1 topic metadata count. */
export async function countTopicArticles(
  db: Kysely<Database>,
  fingerprint: string,
): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    select count(*) as n from topic_articles where fingerprint = ${hexToBytea(fingerprint)}
  `.execute(db);
  return Number(rows[0]?.n ?? 0);
}
