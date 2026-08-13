import { sql, type Kysely } from "kysely";
import type { Sighting } from "@zammy/currents-client";
import { hexToBytea, type Database } from "./database.js";
import { lowerGroupPosition } from "./grouping.js";

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
  /**
   * The articles this call brought into existence, as they stand after the
   * fold — the input to grouping (§14.3), which runs afterwards and outside
   * this transaction because the decision is the API layer's, not storage's.
   *
   * Only NEW articles: an article that already existed has already been
   * offered a group, and regrouping it on every re-sighting would let a group
   * drift with no bound.
   */
  createdArticles: CreatedArticle[];
}

/** What grouping — and the storyline layer above it — needs to know about a
 * newly-created article. Description included because story tokens derive
 * from title AND description (ADR-0009). */
export interface CreatedArticle {
  id: string;
  title: string;
  description: string | null;
  language: string | null;
  published: Date;
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
    createdArticles: [],
  };
  if (input.sightings.length === 0) return result;

  const createdIds: string[] = [];

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

        // The fold may have dragged this article — and therefore its group's
        // position on the §7.3 keyset axis — earlier in time (§14.3).
        await lowerGroupPosition(trx, { articleId: article.id, published });
      }

      // Per ARTICLE and unconditional: a sighting already seen under another
      // topic must still enroll its article in this one.
      await trx
        .insertInto("topic_articles")
        .values({ fingerprint, article_id: article.id })
        .onConflict((oc) => oc.columns(["fingerprint", "article_id"]).doNothing())
        .execute();

      if (article.was_created) {
        result.articlesCreated += 1;
        createdIds.push(article.id);
      }
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

    // Read back rather than remember: one batch can carry the same URL twice,
    // and the later sighting may have rewritten the title and published of a
    // row created earlier in this very loop. Grouping must see the article as
    // it ended up, and this runs after the orphan sweep so a deleted row is
    // never handed on.
    if (createdIds.length > 0) {
      const rows = await trx
        .selectFrom("articles")
        .select(["id", "title", "description", "language", "published"])
        .where("id", "in", createdIds)
        .execute();
      result.createdArticles = rows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        language: row.language,
        published: row.published,
      }));
    }
  });

  return result;
}
