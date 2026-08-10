import { sql, type Kysely } from "kysely";
import type { Sighting } from "@zammy/currents-client";
import { hexToBytea, type Database } from "./database.js";

/**
 * The sighting→article collapse (ARCHITECTURE 7.4, ADR-0002).
 *
 * This lives in the storage layer, not the client: it needs state across
 * responses that a single upstream page cannot have. Every step is an
 * idempotent upsert, so a fetch is safely repeatable and the worker and a user
 * request can race harmlessly.
 */

export interface TopicInput {
  /** sha256 hex of the canonical query (§6.2). */
  fingerprint: string;
  keywords: string[];
  language?: string | null;
  country?: string | null;
  category?: string | null;
}

/**
 * Create the topic if it is new; count a hit either way. `last_hit_at` drives
 * worker prioritization and retention (§7.2).
 */
export async function upsertTopic(db: Kysely<Database>, topic: TopicInput): Promise<void> {
  await db
    .insertInto("topics")
    .values({
      fingerprint: hexToBytea(topic.fingerprint),
      keywords: topic.keywords,
      language: topic.language ?? null,
      country: topic.country ?? null,
      category: topic.category ?? null,
      hit_count: "1",
    })
    .onConflict((oc) =>
      oc.column("fingerprint").doUpdateSet({
        last_hit_at: sql`now()`,
        hit_count: sql`topics.hit_count + 1`,
      }),
    )
    .execute();
}

export interface IngestResult {
  sightingsReceived: number;
  /** New upstream UUIDs. A re-fetch of known emissions contributes 0. */
  sightingsInserted: number;
  /**
   * Articles that did not exist before this call. Feeds the
   * unique-articles-per-upstream-call metric (§12) — baseline ~8 of 20;
   * a fall means upstream duplication is worsening.
   */
  articlesCreated: number;
}

/**
 * Fold one batch of sightings into storage, in one transaction (§7.4):
 *
 *  1. upsert the article on `dedup_key`;
 *  2. insert the sighting, `ON CONFLICT (id) DO NOTHING` — the conflict clause
 *     is what makes a re-fetch idempotent: the same upstream UUID twice must
 *     not inflate `sighting_count`;
 *  3. only when the sighting is genuinely new, fold its timestamp into the
 *     article — `published = LEAST`, `latest_seen = GREATEST` — and hand the
 *     display fields to it if it is now the EARLIEST emission, so a later
 *     re-emission never rewrites the headline (ADR-0002);
 *  4. link the article to the topic, per ARTICLE, so one repeatedly-re-emitted
 *     post cannot flood the topic's timeline.
 *
 * The caller must have upserted the topic first (the membership row has a
 * foreign key on it).
 */
export async function ingestSightings(
  db: Kysely<Database>,
  input: { fingerprint: string; sightings: readonly Sighting[] },
): Promise<IngestResult> {
  const fingerprint = hexToBytea(input.fingerprint);
  const result: IngestResult = {
    sightingsReceived: input.sightings.length,
    sightingsInserted: 0,
    articlesCreated: 0,
  };
  if (input.sightings.length === 0) return result;

  await db.transaction().execute(async (trx) => {
    for (const sighting of input.sightings) {
      const dedupKey = hexToBytea(sighting.dedupKey);
      const published = new Date(sighting.published);

      // Upsert-and-return-id in one statement. The conflict branch is a
      // deliberate no-op assignment purely so RETURNING fires for existing
      // rows too; `xmax = 0` distinguishes a fresh insert from that no-op.
      const article = await trx
        .insertInto("articles")
        .values({
          dedup_key: dedupKey,
          url: sighting.url,
          title: sighting.title,
          description: sighting.description,
          author: sighting.author,
          image_url: sighting.imageUrl,
          language: sighting.language,
          categories: sighting.categories,
          source_category: sighting.sourceCategories,
          source_domain: sighting.sourceDomain,
          published,
          latest_seen: published,
          // 0, not the DEFAULT 1: step 3 increments per genuinely-new
          // sighting, and counting the insert as well would double-count.
          sighting_count: 0,
        })
        .onConflict((oc) =>
          oc.column("dedup_key").doUpdateSet({
            dedup_key: (eb) => eb.ref("excluded.dedup_key"),
          }),
        )
        .returning(["id", sql<boolean>`(xmax = 0)`.as("was_created")])
        .executeTakeFirstOrThrow();

      const inserted = await trx
        .insertInto("sightings")
        .values({
          id: sighting.id,
          article_id: article.id,
          dedup_key: dedupKey,
          published,
          raw: JSON.stringify(sighting.raw),
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .returning("id")
        .executeTakeFirst();

      if (inserted) {
        result.sightingsInserted += 1;

        // All SET expressions see the OLD row, so every comparison below is
        // against the article as it stood before this sighting.
        await trx
          .updateTable("articles")
          .set({
            sighting_count: sql`sighting_count + 1`,
            published: sql`least(published, ${published})`,
            latest_seen: sql`greatest(latest_seen, ${published})`,
            url: sql`case when ${published} < published then ${sighting.url} else url end`,
            title: sql`case when ${published} < published then ${sighting.title} else title end`,
            description: sql`case when ${published} < published then ${sighting.description} else description end`,
            author: sql`case when ${published} < published then ${sighting.author} else author end`,
            image_url: sql`case when ${published} < published then ${sighting.imageUrl} else image_url end`,
            language: sql`case when ${published} < published then ${sighting.language} else language end`,
            categories: sql`case when ${published} < published then ${sighting.categories}::text[] else categories end`,
            source_category: sql`case when ${published} < published then ${sighting.sourceCategories}::text[] else source_category end`,
            source_domain: sql`case when ${published} < published then ${sighting.sourceDomain} else source_domain end`,
          })
          .where("id", "=", article.id)
          .execute();
      }

      // Per ARTICLE and unconditional: a sighting already seen under another
      // topic must still enroll its article in this one.
      await trx
        .insertInto("topic_articles")
        .values({ fingerprint, article_id: article.id })
        .onConflict((oc) => oc.columns(["fingerprint", "article_id"]).doNothing())
        .execute();

      if (article.was_created) result.articlesCreated += 1;
    }

    // A duplicate upstream UUID arriving under a never-seen dedup_key would
    // leave the article created above with zero sightings — visible to no
    // timeline, but a row the Article contract (sightingCount >= 1) forbids.
    // Unreachable from any payload observed so far; guarded because upstream
    // has already shipped three things the spec says it can't.
    const orphans = await trx
      .deleteFrom("articles")
      .where("sighting_count", "=", 0)
      .executeTakeFirst();
    result.articlesCreated -= Number(orphans.numDeletedRows);
  });

  return result;
}
