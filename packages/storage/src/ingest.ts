import { sql, type Kysely, type RawBuilder, type UpdateObject } from "kysely";
import { altKeyProbe, type Sighting } from "@zammy/news-client";
import { hexToBytea, type Database, type SightingPlane } from "./database.js";
import {
  chooseArticle,
  fieldAuthority,
  DISPLAY_HANDOVER_COLUMNS,
  type ArticleCandidate,
  type DisplayHandoverColumn,
  type FieldAuthority,
  type FoldProbe,
} from "./fold.js";
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
 *
 * **The two DECISIONS this path makes live next door, in `fold.ts`.** Which
 * candidate row wins, and what an arriving sighting is entitled to hand over,
 * are rules the ADRs state as truth tables and neither needs a database to
 * decide — only to fetch the candidates and to apply the result. What stays here
 * is everything Postgres uniquely does: the `ON CONFLICT (dedup_key)`
 * arithmetic, the savepoint fencing the alt-key race, the savepoint fencing the
 * storyline re-derivation, and the retrieval that finds the candidates in the
 * first place.
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
 *     re-emission never rewrites the headline (ADR-0002). **Step 3 has two
 *     exceptions (ADR-0021), and they are the only conditional part of this
 *     function**: a sighting that says its timestamp is a bare date folds
 *     neither timestamp and hands over nothing, and one that says it is an
 *     aggregator's copy hands over no display field — keeping only the
 *     timestamp fold and `provider`, which is a fact about the emission rather
 *     than a rendering of the article. Both are opt-in claims made by the
 *     adapter; every other adapter's path is unchanged. Which fields that
 *     leaves is `fieldAuthority`; the statement is `foldSet`;
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
      // The key that gets STORED is `altKey`; the probe holds the keys the
      // lookup is allowed to MATCH, which is the same one key for every sighting
      // but a bare-dated one (`altKeyProbe`, ADR-0022) — and which can DEGRADE
      // back to the single stored key, so nothing downstream may assume the
      // widened set.
      const probe: FoldProbe = {
        dedupKey: sighting.dedupKey,
        altKeyMatches: altKeyProbe(sighting),
      };
      const published = new Date(sighting.published);

      const article = await resolveArticle(trx, sighting, dedupKey, altKey, probe, published);

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

        // WHAT THIS SIGHTING IS ENTITLED TO HAND OVER (ADR-0021), read from the
        // two claims its adapter made about it. The reading is `fold.ts`'s; what
        // is left here is rendering it into one statement and gating the two
        // derived values a moved clock invalidates.
        const authority = fieldAuthority(sighting);

        // All SET expressions see the OLD row, so every comparison inside
        // `foldSet` is against the article as it stood before this sighting.
        await trx
          .updateTable("articles")
          .set(foldSet(sighting, published, authority))
          .where("id", "=", article.id)
          .execute();

        // The fold may have dragged this article — and therefore its group's
        // position on the §7.3 keyset axis — earlier in time (§14.3). A sighting
        // that was not allowed to move the clock cannot have dragged anything,
        // so `movesTheClock` gates this and the storyline re-derivation below.
        if (authority.movesTheClock) {
          await lowerGroupPosition(trx, { articleId: article.id, published });
        }

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
        if (
          authority.movesTheClock &&
          published < article.published &&
          !createdIds.has(article.id)
        ) {
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

    // A duplicate upstream UUID arriving under a never-seen dedup_key leaves
    // the article created above with zero sightings — visible to no timeline,
    // but a row the Article contract (sightingCount >= 1) forbids. Once
    // guarded as unreachable; production has since deleted 50 (2026-08-26 to
    // 2026-09-24, `pg_stat_statements`).
    //
    // Scoped to what THIS batch created, because nothing else can be at zero:
    // `insertArticle` is the only writer of a 0, every other write to the
    // count increments it, nothing deletes or re-points a sighting, and every
    // transaction runs this sweep before it commits — so no committed row
    // holds a 0 for a later batch to find (production: none of 81,623 on
    // 2026-09-24). A concurrent batch's uncommitted orphan was never visible
    // to a table-wide sweep either.
    //
    // Table-wide was a seq scan — no index covers `sighting_count` — of a
    // 120 MB heap on every non-empty batch, a re-fetch that created nothing
    // included: 1,276ms mean, 31.6s max over 3,480 calls, twice the total
    // time of the next-costliest statement production runs, and 8.6s of one
    // 14.2s cold search (trace 4e3a28c2). An index was the other fix and the
    // worse one: every fold writes this column, so a predicate on it costs
    // every fold its HOT update — the thing production's `fillfactor = 70` on
    // this table (set by hand, in no migration) exists to buy. Scoped, it is
    // a primary-key probe bounded by the page size, and a batch that created
    // nothing skips it.
    if (createdIds.size > 0) {
      const orphans = await trx
        .deleteFrom("articles")
        .where("id", "in", [...createdIds])
        .where("sighting_count", "=", 0)
        .executeTakeFirst();
      result.articlesCreated -= Number(orphans.numDeletedRows);
    }

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
 * The one UPDATE the fold performs, rendered from what the sighting is entitled
 * to hand over (ADR-0002, ADR-0021).
 *
 * ## Why this is rendered rather than written out
 *
 * The entitlement used to be spent ten times, as one hand-written
 * `case when ${gate} then ${field} else ${column} end` per column, on the
 * argument that a column list one field per line reads as ADR-0002's rule with
 * its exceptions marked. It reads as that once; it has to be VERIFIED ten times,
 * and nine of the ten differ only in which pair of names they carry. The rule is
 * one rule, so it is stated once and applied over the list `fold.ts` names.
 *
 * `incoming` is what survives of the per-column writing, and it is a mapping
 * rather than a rule: column ← the sighting field it takes its value from. It is
 * typed against `DISPLAY_HANDOVER_COLUMNS`, so a column the ADR governs with no
 * value here is a type error rather than a silently unwritten field.
 *
 * ## The two gates, and why `provider` is on the first
 *
 * `earlier` is the EMISSION test and `earlierFirstHand` the RECORD test, each
 * neutralized to a constant `false` where the sighting is not entitled. Both
 * comparisons read the OLD row, because that is what an UPDATE's SET expressions
 * see.
 *
 * `provider` is deliberately on the emission test: which upstream reported the
 * earliest emission is a fact about the emission, not a rendering of the
 * article, and `articles.provider` is documented as exactly that. So an article
 * can read `google-news` while every field a reader sees is the newsroom's.
 * Migration 0013's own note — "who got there first, not who is authoritative" —
 * is the rule being followed; its OTHER sentence, that this follows the same rule
 * as every other denormalized display field, stopped being true at ADR-0021.
 *
 * ## What is NOT in here
 *
 * `dedup_key` and `alt_key`. They are IDENTITY, minted once by `insertArticle`
 * and never rewritten, and the two reasons are independent. Rewriting either
 * would change an article's identity underneath a live unique index, so a
 * handover could collide with another row and fail the whole batch. And identity
 * has to be stable for the fold to work at all: a row that stopped answering to
 * the key it was found by would be found again as a new article by the very next
 * sighting of it.
 *
 * The visible consequence, and it is intended: once an earlier sighting under a
 * DIFFERENT url hands over the display fields, `dedup_key` no longer hashes
 * `url`. The key is the identity this row was minted with; `url` is what a
 * reader clicks.
 *
 * Exported for `fold-differential.test.ts`, which replays the hand-written
 * version of this statement beside it over the whole entitlement table and
 * compares every column the two write.
 */
export function foldSet(
  sighting: Sighting,
  published: Date,
  authority: FieldAuthority,
): FoldSet {
  const earlier = authority.movesTheClock ? sql`${published} < published` : sql`false`;
  const earlierFirstHand = authority.handsOver === "all" ? earlier : sql`false`;

  const incoming: Record<DisplayHandoverColumn, RawBuilder<unknown>> = {
    url: sql`${sighting.url}`,
    title: sql`${sighting.title}`,
    description: sql`${sighting.description}`,
    author: sql`${sighting.author}`,
    image_url: sql`${sighting.imageUrl}`,
    language: sql`${sighting.language}`,
    // The two array columns carry their cast, which is the one thing that is not
    // uniform across the nine: `text[]` parameters need it and `text` ones must
    // not have it.
    categories: sql`${sighting.categories}::text[]`,
    source_category: sql`${sighting.sourceCategories}::text[]`,
    source_domain: sql`${sighting.sourceDomain}`,
  };

  // `never` because the loop indexes the column list with a UNION, so one
  // expression stands for nine columns of five different SQL types and cannot be
  // told which it is producing. `RawBuilder<never>` is what satisfies all nine at
  // once, and it is the only type looseness here — the thing worth having is kept
  // by `incoming` above, a TOTAL `Record` over `DISPLAY_HANDOVER_COLUMNS`, so a
  // column ADR-0002 governs with no value is a type error rather than a field
  // that silently stopped folding. That the column→value mapping is the right one
  // is checked column by column against the hand-written statement in
  // `fold-differential.test.ts`, and by Postgres on every write.
  const handedOver = {} as Record<DisplayHandoverColumn, RawBuilder<never>>;
  for (const column of DISPLAY_HANDOVER_COLUMNS) {
    handedOver[column] =
      sql<never>`case when ${earlierFirstHand} then ${incoming[column]} else ${sql.ref(column)} end`;
  }

  return {
    ...handedOver,
    // Outside every guard deliberately: the observation happened whatever its
    // timestamp is worth, and a sighting that may not move the clock is still a
    // sighting.
    sighting_count: sql<number>`sighting_count + 1`,
    published: authority.movesTheClock
      ? sql<Date>`least(published, ${published})`
      : sql<Date>`published`,
    latest_seen: authority.movesTheClock
      ? sql<Date>`greatest(latest_seen, ${published})`
      : sql<Date>`latest_seen`,
    provider: sql<string>`case when ${earlier} then ${sighting.provider} else provider end`,
  };
}

/**
 * The columns the fold writes: the nine ADR-0002 hands over, plus the three the
 * ADRs treat apart and the counter that is outside every guard.
 *
 * `Required`, so every one of the thirteen has to be present. An UPDATE object is
 * all-optional by nature, and on this statement an omitted column is not a
 * smaller write — it is a field that silently stopped folding.
 */
export type FoldSet = Required<
  Pick<
    UpdateObject<Database, "articles">,
    DisplayHandoverColumn | "sighting_count" | "published" | "latest_seen" | "provider"
  >
>;

/**
 * Find the article this sighting belongs to, or mint one: **URL key → alt key →
 * insert** (ADR-0018).
 *
 * The precedence itself is `chooseArticle` next door; what happens here is the
 * retrieval it decides over, the insert, and the fence around the insert. The
 * split is where the seam already was: a candidate set is a question only
 * Postgres can answer, and which candidate wins is a question it never needed to
 * be asked.
 *
 * So the URL-keyed majority behaves precisely as it did before the fallback
 * existed, and an article with `altKey === null` — a source-truncated title, no
 * source domain — takes the pre-ADR-0018 path in full.
 *
 * ## The alt key and the probe, and the difference between them is the point
 *
 * `altKey` is what a NEW article is minted with, and there is exactly one of it.
 * `probe.altKeyMatches` is what the LOOKUP is allowed to match, and for a
 * sighting whose provider sent a bare date instead of a time it holds the
 * adjacent days as well (`altKeyProbe`, ADR-0022). Widening the lookup is not
 * widening the fold: nothing here writes a key it did not derive, so a stored
 * key still means exactly what it meant when the row was minted, and the
 * migration ADR-0018 demands for a fold change is not owed for this one.
 *
 * The two are never independent — `altKeyMatches` is empty exactly when `altKey`
 * is null, and its first element is `altKey` — and they are passed separately
 * rather than derived from each other here so that the insert below cannot
 * accidentally store a probe-only neighbour.
 */
async function resolveArticle(
  trx: Kysely<Database>,
  sighting: Sighting,
  dedupKey: Buffer,
  altKey: Buffer | null,
  probe: FoldProbe,
  published: Date,
): Promise<ResolvedArticle> {
  const chosen = chooseArticle(await findArticleCandidates(trx, probe), probe);
  if (chosen.kind === "match") return resolved(chosen.article);

  // `mint` or `refuse`: no COMMITTED row answers the URL key or the own day, so
  // this sighting gets its own row under its own key either way. What is left is
  // a concurrent transaction that holds one of those keys and has not committed
  // yet — the worker and a user request racing, which §7.4 promises is
  // harmless. The URL half of that
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
    //
    // `refuse` throws here as `mint` does, and that is unchanged behaviour
    // rather than a new decision: the lookup this replaces returned one
    // `undefined` for both. It also provably cannot be reached — a 23505 on
    // `articles_alt_key_idx` can only be raised by the value that was INSERTED,
    // which is `altKey`, which is `altKeyProbe`'s first element, so the winner
    // answers the `own-day` arm and is returned before the refusal is
    // considered (ADR-0022). `chooseArticle` reports which arm matched precisely
    // so that claim is checkable rather than merely argued.
    const winner = chooseArticle(await findArticleCandidates(trx, probe), probe);
    if (winner.kind !== "match") throw error;
    return resolved(winner.article);
  }
}

/** A chosen candidate, as the fold's caller needs it: no keys, and not new. */
function resolved(article: ArticleCandidate): ResolvedArticle {
  return {
    id: article.id,
    published: article.published,
    group_id: article.group_id,
    was_created: false,
  };
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
 * Every `articles` row that answers to any key in the probe — both keys in one
 * statement, and **no decision at all**.
 *
 * This is the half of ADR-0018's lookup that needs a database: an index probe
 * over a live archive, which nothing in a test process can fake and nothing
 * above the storage layer can perform. `chooseArticle` is the other half, and
 * the precedence that used to live in this statement's `order by` lives there
 * now.
 *
 * `alt_key in (…)` never matches a NULL, so no `is not null` guard is needed;
 * the partial index migration 0020 builds has the same predicate and serves this
 * lookup directly. It is one `Bitmap Index Scan` whether the probe holds one key
 * or three, inside this one statement — measured at 24–25 ms against 41–43 ms
 * over 5,000 lookups, about 3.5 µs of widening per lookup, and only bare-dated
 * sightings pay it (ADR-0022).
 *
 * ## Why the two keys come back as hex, rather than as booleans
 *
 * The statement could compute `dedup_key = $1` and `alt_key = $2` itself, and it
 * used to. Handing over the keys instead is what makes the caller's decision a
 * decision over DOMAIN VALUES: it classifies each candidate against the probe
 * rather than being told the answer, so the truth tables ADR-0018 and ADR-0022
 * state can be exercised — exhaustively, and without a database — against the
 * same function production runs. Two `encode()`s over at most four rows.
 *
 * ## Why the `limit` cannot decide anything, which is what let the order go
 *
 * **Four is the most that can match**: the URL key names at most one row
 * (`articles_dedup_key_idx` is unique), and the probe holds at most three alt
 * keys naming at most three rows (`articles_alt_key_idx` likewise). No fifth row
 * is reachable, so the limit is a ceiling rather than a choice — it never
 * truncates, and a limit that never truncates cannot change which rows come
 * back however they are ordered. That argument is what makes moving the
 * precedence out a re-expression rather than a change: the `order by` used to
 * carry the decision, and now it carries only determinism.
 *
 * `id asc` stays for exactly that: a limit over an unordered read is a different
 * article on different days, and that failure would be silent.
 */
export async function findArticleCandidates(
  trx: Kysely<Database>,
  probe: FoldProbe,
): Promise<ArticleCandidate[]> {
  const dedupKey = hexToBytea(probe.dedupKey);
  const altKeyMatches = probe.altKeyMatches.map(hexToBytea);

  return trx
    .selectFrom("articles")
    .select([
      "id",
      "published",
      "group_id",
      sql<string>`encode(dedup_key, 'hex')`.as("dedupKey"),
      // Nullable, and it stays nullable: a row identified by URL alone carries
      // no alt key at all, and `encode(null, 'hex')` is null rather than an
      // empty string, so a keyless row cannot be mistaken for one keyed on
      // nothing.
      sql<string | null>`encode(alt_key, 'hex')`.as("altKey"),
    ])
    .where((eb) =>
      altKeyMatches.length === 0
        ? eb("dedup_key", "=", dedupKey)
        : eb.or([eb("dedup_key", "=", dedupKey), eb("alt_key", "in", altKeyMatches)]),
    )
    .orderBy("id", "asc")
    .limit(4)
    .execute();
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
