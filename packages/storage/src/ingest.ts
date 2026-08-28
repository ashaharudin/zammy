import { sql, type Kysely } from "kysely";
import type { Sighting } from "@zammy/news-client";
import { hexToBytea, type Database, type SightingPlane } from "./database.js";
import { lowerGroupPosition } from "./grouping.js";
import { readGroupStorylines, refreshStorylineDerivations } from "./storylines.js";
import { markStorylinesLinkDirty } from "./storyline-link-dirty.js";

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
 *  1. resolve the article — URL key, then alt key, then insert (ADR-0018);
 *  2. insert the sighting, `ON CONFLICT (id) DO NOTHING` — the conflict clause
 *     is what makes a re-fetch idempotent: the same upstream UUID twice must
 *     not inflate `sighting_count`;
 *  3. only when the sighting is genuinely new, fold its timestamp into the
 *     article — `published = LEAST`, `latest_seen = GREATEST` — and hand the
 *     display fields to it if it is now the EARLIEST emission, so a later
 *     re-emission never rewrites the headline (ADR-0002);
 *  4. link the article to the topic, per ARTICLE, so one repeatedly-re-emitted
 *     post cannot flood the topic's timeline;
 *  5. and once per batch, re-derive the storylines holding a group whose
 *     article step 3 moved earlier — a fold changes which day an article
 *     belongs to, and a storyline's day slots are derived from exactly that.
 *     Step 5 alone is DERIVED, and fenced by a savepoint accordingly: steps
 *     1–4 commit whether or not it succeeds.
 *
 * The caller must have upserted the topic first (the membership row has a
 * foreign key on it).
 */
export async function ingestSightings(
  db: Kysely<Database>,
  input: {
    fingerprint: string;
    sightings: readonly Sighting[];
    /**
     * WHY this batch was fetched (ADR-0019, migration 0022) — stamped on every
     * sighting row this call inserts.
     *
     * Required, and it has to come from HERE rather than from the `Sighting`s
     * themselves. A plane is a property of the FETCH, not of the emission: the
     * same provider returning the same article answers a reader's search and a
     * cloud-driven deepening fetch, so an adapter cannot know it and must not
     * guess. The caller that PLANNED the fetch is the only one that does, which
     * is ADR-0019's own mitigation for the column being settable wrong.
     *
     * There is no default here for the same reason there is none in the
     * database. A default would be a value invented at the exact layer that has
     * the true one in hand, and the failure it hides is silent and one-sided:
     * anything but `deepening` feeds the ranking (`readTrendingStorylines`), so
     * a forgotten plane re-opens the endogenous loop rather than raising.
     */
    plane: SightingPlane;
    /**
     * The calendar day storyline slots are bucketed by, since a fold can move
     * which day an article belongs to and this re-derives them. Here for the
     * reason `mergeGroups` takes one: the day rule is bucketed in SQL, so the
     * zone is all storage needs to keep a derivation honest — the JUDGEMENT
     * about what belongs with what stays in the api layer.
     */
    timeZone: string;
    /**
     * Where a failed storyline re-derivation goes. The re-derivation is DERIVED
     * and is fenced so it cannot fail the ingest (see the savepoint below), so
     * a warning is the only trace it leaves — without one the fence would hide
     * a broken derivation instead of a broken ingest, which is a worse trade
     * than the one it exists to make.
     */
    log?: { warn: (obj: object, msg: string) => void };
  },
): Promise<IngestResult> {
  const fingerprint = hexToBytea(input.fingerprint);
  const result: IngestResult = {
    sightingsReceived: input.sightings.length,
    sightingsInserted: 0,
    articlesCreated: 0,
    createdArticles: [],
  };
  if (input.sightings.length === 0) return result;

  const createdIds = new Set<string>();
  /** Groups holding an article a fold moved earlier — see the guard below. */
  const movedGroups = new Set<string>();

  await db.transaction().execute(async (trx) => {
    for (const sighting of input.sightings) {
      const dedupKey = hexToBytea(sighting.dedupKey);
      const altKey = sighting.altKey === null ? null : hexToBytea(sighting.altKey);
      const published = new Date(sighting.published);

      const article = await resolveArticle(trx, sighting, dedupKey, altKey, published);

      const inserted = await trx
        .insertInto("sightings")
        .values({
          id: sighting.id,
          article_id: article.id,
          dedup_key: dedupKey,
          published,
          provider: sighting.provider,
          // The plane of the FETCH, uniform across the batch: one call was
          // planned for one reason, and every row it produced carries it.
          plane: input.plane,
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
            // Handed over with the rest of the display fields, so `provider`
            // keeps meaning "whoever reported the earliest emission" even when
            // the second provider is the one that reached further back.
            provider: sql`case when ${published} < published then ${sighting.provider} else provider end`,
            // `dedup_key` and `alt_key` are deliberately NOT in this list. They
            // are IDENTITY, minted once by `resolveArticle` and never rewritten,
            // and the two reasons are independent. Rewriting either would change
            // an article's identity underneath a live unique index, so a
            // handover could collide with another row and fail the whole batch.
            // And identity has to be stable for the fold to work at all: a row
            // that stopped answering to the key it was found by would be found
            // again as a new article by the very next sighting of it.
            //
            // The visible consequence, and it is intended: once an earlier
            // sighting under a DIFFERENT url hands over the display fields,
            // `dedup_key` no longer hashes `url`. The key is the identity this
            // row was minted with; `url` is what a reader clicks.
          })
          .where("id", "=", article.id)
          .execute();

        // The fold may have dragged this article — and therefore its group's
        // position on the §7.3 keyset axis — earlier in time (§14.3).
        await lowerGroupPosition(trx, { articleId: article.id, published });

        // And the storyline layer above it moves too. A day slot IS its day's
        // earliest member article, so an article that moved earlier can leave
        // its storylines' slots stale in either of two ways: on a new day, the
        // storyline has no `storyline_days` row at all and that day's coverage
        // is invisible to a timeline that pages over the table; within the day,
        // the slot keeps a position later than the coverage it stands for.
        //
        // Guarded twice, which is what makes this affordable on the §6.3
        // sync-fill path. The fold must have actually MOVED the article: the
        // overwhelmingly common sighting is a re-emission no earlier than what
        // is stored, and it spends nothing here. And the article must have
        // EXISTED before this batch: one created a moment ago is in no
        // storyline yet — the linker runs after ingest and births one from the
        // article's final state — so collecting it would buy an index scan
        // that can only come back empty. Not a rare case worth skipping
        // cheaply but the common one: upstream returns newest-first, so a
        // cold page routinely creates an article and then folds an earlier
        // emission of it two sightings later.
        //
        // What is left is rare. Measured on the dev archive: 334 articles of
        // 31,308 carry more than one sighting at all, and 33 have sightings
        // that straddle a UTC midnight.
        if (published < article.published && !createdIds.has(article.id)) {
          movedGroups.add(article.group_id);
        }
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
        createdIds.add(article.id);
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
    if (createdIds.size > 0) {
      const rows = await trx
        .selectFrom("articles")
        .select(["id", "title", "description", "language", "published"])
        .where("id", "in", [...createdIds])
        .execute();
      result.createdArticles = rows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        language: row.language,
        published: row.published,
      }));
    }

    // Re-derive every storyline holding a group whose article moved.
    //
    // Once per BATCH, not once per fold: one batch can carry the same URL
    // twice, and a storyline re-derived mid-loop would be re-derived again for
    // the same article. After the orphan sweep for the reason the read above
    // gives — a deleted row is never handed on, and never refreshed either.
    //
    // Inside the transaction, so the day a reader can see is never a day the
    // articles disagree with. Handing the moved ids back for the caller to
    // refresh was the alternative, and it buys a shorter transaction at the
    // price of a window where the timeline is wrong and a second transaction
    // to close it — worth it if this fired often, and it does not. The work
    // also belongs here: a re-derivation is storage's, the way `mergeGroups`
    // re-derives the same slots from the same place and takes the same
    // `timeZone` to do it. What the api layer owns is the JUDGEMENT about what
    // belongs with what, and no judgement is made here.
    //
    // `refreshStorylineDerivations`, not `refreshStoryline`: the latter opens
    // its own transaction, and resolves an alias first — which nothing here
    // needs, because a merged storyline holds no groups for
    // `readGroupStorylines` to find. Both derivations rather than the slots
    // alone, though only the slots can be stale from a fold: `story_tokens`
    // are written by grouping and untouched here, so the profile half is a
    // no-op. One redundant statement on a path this rare beats exporting a
    // second seam into the storyline tables to avoid it.
    //
    // And the change marker with it (migration 0017), because every caller of
    // that re-derivation owes it. This case earns it least of the four — the
    // profile CANNOT widen here, so the arc attracts exactly what it attracted
    // before, and a re-offer can only find what the last one found. What did
    // move is the arc's coverage, which is the other thing `linkGroup` reads
    // about it; at ~0.68ms against a path this rare, one rule for "re-derived,
    // therefore re-offer" is worth more than the statement it saves.
    //
    // Fenced by a SAVEPOINT, which is what lets it be both in the transaction
    // and unable to fail it. Every other derived value on this path is allowed
    // to fail on its own — `recordStoryDfForArticles` catches for the reason it
    // states, "an ingest triggered by a reader's search must not fail because a
    // derived counter did", and grouping never throws for the same reason — but
    // both of those run AFTER this transaction commits, so a plain catch is all
    // they need. In here a plain catch would be worse than none: Postgres
    // aborts the whole transaction on the first failed statement, COMMIT on an
    // aborted transaction is a silent ROLLBACK, and `ingestSightings` would
    // return a result reporting sightings it had just discarded. MEASURED both
    // ways on a throwaway clone: unfenced, one raise inside the re-derivation
    // loses the sighting and fails the reader's search; fenced, the fold
    // commits and the slots stay as stale as they were before this existed.
    //
    // What can fail is not hypothetical. This is the first thing on the ingest
    // path to take write locks on `storyline_days` and `storylines`, tables the
    // merge and attach paths also write under their own lock order, so a
    // deadlock (40P01) or a serialization failure is exactly the shape of error
    // to expect — and losing a paid upstream page to one is strictly worse than
    // the stale day slot this fix exists to prevent. A stale slot is repaired
    // by the next merge or a `backfill:storylines --restart`; a dropped
    // emission is repaired by nothing.
    //
    // Only when there is work: the guard's whole point is that the common
    // sighting spends nothing here, and two unconditional round trips for
    // SAVEPOINT and RELEASE would undo that.
    //
    // What one moved group costs, MEASURED over 400 real storyline-holding
    // groups on a clone of the dev archive: mean 2.9ms, p90 3.6, p99 5.8 for
    // the read plus a refresh per storyline plus the marker. The widest arc
    // this archive holds — 124 groups, 219 articles — is 7ms. The N is bounded
    // by the batch, and a batch is ONE upstream page (`CURRENTS_MAX_PAGE_SIZE`,
    // 20 by default), so the ceiling is ~54ms against §6.3's 1,200ms even in
    // the case where every sighting on the page moves a different group — a
    // case the 33-of-31,308 population above says will not happen. Worth
    // re-measuring if that page size is ever raised toward its 200 cap.
    if (movedGroups.size > 0) {
      await sql`savepoint storyline_derivations`.execute(trx);
      try {
        const dirty: string[] = [];
        for (const groupId of movedGroups) {
          for (const storylineId of await readGroupStorylines(trx, groupId)) {
            await refreshStorylineDerivations(trx, storylineId, input.timeZone);
            dirty.push(storylineId);
          }
        }
        await markStorylinesLinkDirty(trx, dirty);
        await sql`release savepoint storyline_derivations`.execute(trx);
      } catch (error) {
        // ROLLBACK TO leaves the savepoint in place, so it still needs
        // releasing; and if THIS throws the connection itself is gone, which is
        // not a derived failure and must not be swallowed.
        await sql`rollback to savepoint storyline_derivations`.execute(trx);
        await sql`release savepoint storyline_derivations`.execute(trx);
        input.log?.warn(
          { err: error, groups: movedGroups.size },
          "storyline day slots not re-derived for this batch; a group merge or a --restart backfill repairs them",
        );
      }
    }
  });

  return result;
}

/**
 * Find the article this sighting belongs to, or mint one: **URL key → alt key →
 * insert** (ADR-0018).
 *
 * The ordering is the whole design and is not an implementation detail. Titles
 * drift and URLs do not, so a `(domain, title, day)` key consulted FIRST would
 * split an article whose headline was edited between two emissions — a
 * regression URL identity does not have. Consulted SECOND, it can only ever
 * catch a URL that has never been seen before, which is exactly the case URL
 * identity was already failing: 411 rows of the production archive (1.1%) are
 * one story filed under several URLs.
 *
 * So the URL-keyed majority behaves precisely as it did before this existed, and
 * an article with `altKey === null` — a source-truncated title, no source domain
 * — takes the pre-ADR-0018 path in full.
 */
async function resolveArticle(
  trx: Kysely<Database>,
  sighting: Sighting,
  dedupKey: Buffer,
  altKey: Buffer | null,
  published: Date,
): Promise<ResolvedArticle> {
  const existing = await findArticle(trx, dedupKey, altKey);
  if (existing) return { ...existing, was_created: false };

  // Nothing COMMITTED holds either key. What is left is a concurrent
  // transaction that holds one and has not committed yet — the worker and a
  // user request racing, which §7.4 promises is harmless. The URL half of that
  // race is handled by `ON CONFLICT (dedup_key)` inside the insert, as it always
  // was; the alt-key half cannot be, because `ON CONFLICT` takes ONE arbiter and
  // that one is spoken for. So the insert is fenced, and a lost race is
  // re-resolved rather than raised.
  //
  // Fenced only when there is an alt key to collide on, which is what keeps the
  // two extra round trips off the path of an article that has none.
  //
  // MEASURED against the local dev Postgres, five runs of the 100-sighting
  // duplication fixture: 287ms fenced against 248ms with every alt key nulled —
  // ~0.95ms per fenced insert, and an UPPER bound, since the null variant also
  // skips the alt-key half of the lookup. A batch is ONE upstream page
  // (`CURRENTS_MAX_PAGE_SIZE`, 20 by default), so the ceiling is ~19ms against
  // §6.3's 1,200ms even where every sighting on the page mints an article — and
  // the fixture's own 100 is four times the real page size. Worth re-measuring
  // if that page size is ever raised toward its 200 cap.
  //
  // A plain
  // catch would be no fence at all: Postgres aborts the whole transaction on the
  // first failed statement, COMMIT on an aborted transaction is a silent
  // ROLLBACK, and `ingestSightings` would return a result reporting sightings it
  // had just discarded — the same reasoning the storyline savepoint below
  // records, reached from the opposite direction.
  if (altKey === null) return insertArticle(trx, sighting, dedupKey, null, published);

  await sql`savepoint article_insert`.execute(trx);
  try {
    const created = await insertArticle(trx, sighting, dedupKey, altKey, published);
    await sql`release savepoint article_insert`.execute(trx);
    return created;
  } catch (error) {
    if (!isAltKeyConflict(error)) throw error;
    // ROLLBACK TO leaves the savepoint in place, so it still needs releasing.
    await sql`rollback to savepoint article_insert`.execute(trx);
    await sql`release savepoint article_insert`.execute(trx);

    // The winner committed between our lookup and our insert, so it is visible
    // now. If it somehow is not, the conflict was not the one this fence is for
    // and hiding it would be worse than failing the batch.
    const winner = await findArticle(trx, dedupKey, altKey);
    if (!winner) throw error;
    return { ...winner, was_created: false };
  }
}

interface ResolvedArticle {
  id: string;
  /**
   * The article's `published` as it stood BEFORE this sighting — what makes the
   * storyline guard further up free, since the alternative is asking the row
   * again after the fold.
   */
  published: Date;
  group_id: string;
  was_created: boolean;
}

/**
 * Both keys in one statement, URL first.
 *
 * `order by (dedup_key = …) desc` is what expresses the precedence: in the rare
 * case where one row matches by URL and a DIFFERENT row matches by alt key — a
 * title that has since drifted onto another article's key — the URL match is
 * taken, and the alt key stays what it has always been, a fallback.
 *
 * `alt_key = …` never matches a NULL, so no `is not null` guard is needed; the
 * partial index has the same predicate and serves this lookup directly.
 */
async function findArticle(
  trx: Kysely<Database>,
  dedupKey: Buffer,
  altKey: Buffer | null,
): Promise<{ id: string; published: Date; group_id: string } | undefined> {
  return trx
    .selectFrom("articles")
    .select(["id", "published", "group_id"])
    .where((eb) =>
      altKey === null
        ? eb("dedup_key", "=", dedupKey)
        : eb.or([eb("dedup_key", "=", dedupKey), eb("alt_key", "=", altKey)]),
    )
    .orderBy(sql`(dedup_key = ${dedupKey})`, "desc")
    .limit(1)
    .executeTakeFirst();
}

/**
 * Upsert-and-return-id in one statement. The conflict branch is a deliberate
 * no-op assignment purely so RETURNING fires for existing rows too; `xmax = 0`
 * distinguishes a fresh insert from that no-op.
 */
async function insertArticle(
  trx: Kysely<Database>,
  sighting: Sighting,
  dedupKey: Buffer,
  altKey: Buffer | null,
  published: Date,
): Promise<ResolvedArticle> {
  return trx
    .insertInto("articles")
    .values({
      dedup_key: dedupKey,
      alt_key: altKey,
      url: sighting.url,
      title: sighting.title,
      description: sighting.description,
      author: sighting.author,
      image_url: sighting.imageUrl,
      language: sighting.language,
      categories: sighting.categories,
      source_category: sighting.sourceCategories,
      source_domain: sighting.sourceDomain,
      provider: sighting.provider,
      published,
      latest_seen: published,
      // 0, not the DEFAULT 1: step 3 increments per genuinely-new sighting, and
      // counting the insert as well would double-count.
      sighting_count: 0,
    })
    .onConflict((oc) =>
      oc.column("dedup_key").doUpdateSet({
        dedup_key: (eb) => eb.ref("excluded.dedup_key"),
      }),
    )
    // `published` and `group_id` are read back as they stood BEFORE this
    // sighting: the conflict branch's assignment touches `dedup_key` and nothing
    // else, so RETURNING reports the stored row.
    .returning([
      "id",
      "published",
      "group_id",
      sql<boolean>`(xmax = 0)`.as("was_created"),
    ])
    .executeTakeFirstOrThrow();
}

/** The partial unique index migration 0020 builds. */
const ALT_KEY_INDEX = "articles_alt_key_idx";

/**
 * A `unique_violation` (23505) raised by the alt-key index and nothing else.
 *
 * Narrow on purpose. The only other unique index on `articles` is the one
 * `ON CONFLICT (dedup_key)` already absorbs, so a 23505 from anywhere else is a
 * fact about a bug rather than about a lost race, and re-resolving would report
 * a success that did not happen. `constraint` is absent only on error shapes
 * Postgres does not produce for a unique index; treating that as a match keeps
 * the fence working rather than failing closed on a driver detail.
 */
function isAltKeyConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (code !== "23505") return false;
  return constraint === ALT_KEY_INDEX || constraint === undefined;
}
