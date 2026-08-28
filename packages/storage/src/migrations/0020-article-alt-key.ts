import { sql, type Kysely } from "kysely";
import { deriveAltKey } from "@zammy/news-client";

/**
 * A FALLBACK article identity, so a story published under several URLs is one
 * article (ADR-0018).
 *
 * ADR-0002 made the canonical URL the whole of an article's identity, and
 * explicitly disabled a `(title, source)` secondary key on the evidence
 * available then: 42 unique URLs against 41 unique title+source pairs in the
 * probe, so it would have merged exactly one pair. On the archive we now have
 * that is no longer true. Measured read-only against production 2026-08-27,
 * 37,077 articles collapse to 36,666 `(source_domain, folded title, UTC day)`
 * keys — 411 rows (1.1%) are duplicates URL identity is already failing to
 * catch. `deriveAltKey` is the derivation and carries the argument in full.
 *
 * The index is PARTIAL, which is what lets the column be added to a table that
 * already contains collisions: a `NULL` key is outside a unique index, so the
 * rows this cannot key — and the rows the backfill declines to key — cost
 * nothing and behave exactly as they did before.
 *
 * ## The backfill, and why it leaves collisions NULL
 *
 * Forward-only. It populates `alt_key` only for rows whose computed key is
 * UNIQUE across the archive, and leaves every colliding row NULL.
 *
 * The alternative — merging the colliding rows — is not merely more work, it is
 * the silent-data-loss class this schema is built to avoid. `group_id` is a
 * bigint article id carrying NO foreign key, in two places: `articles.group_id`
 * (migration 0003) and `storyline_groups.group_id` (migration 0007). Both
 * migrations argue for that deliberately, so that a dangling seed degrades a
 * group to loose members rather than blocking a delete. The consequence here is
 * exact: deleting an article row to merge it into another would dangle every
 * group seeded on it and orphan the storyline attachments hanging off those
 * groups, and NOTHING would raise. A historical merge is a separate chore that
 * has to re-seat those seeds first; it is not a line in a migration.
 *
 * What the unique-only backfill buys instead is most of the value at none of
 * that risk: new articles fold onto backfilled history from the first ingest
 * after this runs, rather than waiting for history to age out. What it does not
 * buy is the collapse of the existing duplicates — those stay as two rows, and
 * a third URL of the same story will mint a third, because neither of the first
 * two carries the key it would match. That is the accepted cost, and it decays:
 * retention removes those rows in time and nothing new joins them.
 *
 * ## Why the backfill computes keys in TypeScript
 *
 * It calls the SAME `deriveAltKey` the ingest path calls, over rows read back
 * from the table. An SQL twin of the fold would be the obvious alternative and
 * it is the wrong one, because the two would have to agree EXACTLY and Postgres
 * cannot express what the fold does: the fold is Unicode-aware (`\p{L}\p{N}`,
 * and an NFD fold restricted to Latin combining marks), and Postgres' regex
 * engine has no Unicode property classes at all. An ASCII approximation would
 * fold every Arabic, Chinese, Greek and Cyrillic headline to the empty string —
 * so the backfill and the ingest path would disagree about a large part of the
 * archive, and disagree SILENTLY: backfilled rows that no future sighting can
 * ever match. `@zammy/storage` already depends on `@zammy/news-client` at run
 * time (`ingest.ts`), so this costs no new dependency edge.
 *
 * The cost of that choice, stated plainly: this migration's behaviour depends on
 * live application code, so a later change to the fold changes what a fresh run
 * of 0020 computes. That is acceptable in both directions — a fresh database has
 * no rows to backfill, and a database that has already run this has already
 * recorded it in the ledger. If the fold is ever changed, the repair is a new
 * migration that re-keys, exactly as `TOKENIZER_VERSION` demands a repair run.
 *
 * It holds every computed key in memory to decide uniqueness, which is a
 * one-time catch-up sized for this table as it stands (37k rows in production,
 * ~4MB of keys). A table two orders of magnitude larger would want the whole
 * pass pushed into the staging table instead.
 *
 * ## What it costs, measured
 *
 * Run against a TEMPLATE clone of the dev archive — 32,279 articles, the real
 * corpus rather than a seeded one:
 *
 * ```
 * up      1.83s   31,542 rows keyed, 737 left NULL, index 1,848 kB
 * down    0.02s
 * re-up   1.49s   31,542 rows keyed — identical, so the pass is idempotent
 * ```
 *
 * The 737 account for themselves exactly: 135 rows this cannot key at all (134
 * source-truncated titles, one that folds to nothing) plus the 602 rows making
 * up 291 collision groups. Production holds 37,077 articles, so expect the same
 * shape and a little more of it.
 *
 * ## What it locks, which is more than it looks
 *
 * `ALTER TABLE … ADD COLUMN` takes **ACCESS EXCLUSIVE** on `articles`, and that
 * conflicts with ACCESS SHARE — so it blocks plain `SELECT`s, not only writers.
 * And Kysely's migrator runs every pending migration in ONE transaction on
 * Postgres (`supportsTransactionalDdl`, and `disableTransactions` is not set),
 * so the lock is taken by the first statement here and held until that whole run
 * commits: this backfill, this index build, and any other migration pending in
 * the same deploy.
 *
 * On the dev numbers above that is ~1.8s during which no reader of `articles`
 * gets an answer — and worse, every query arriving behind it queues too, so the
 * request path sees a stall rather than a slow query. Small, and stated plainly
 * because "1.8 seconds" is what somebody will use to decide whether to run this
 * at peak, and the honest version of that sentence is "1.8 seconds of a fully
 * blocked `articles`".
 *
 * Deliberately NOT bounded with `lock_timeout` the way 0019 bounds its own wait.
 * That trade — fail the re-runnable deploy step rather than stall the request
 * path — is available here too and would be worth taking if this table's reads
 * ever got long enough to make the ACCESS EXCLUSIVE queue behind them. It is
 * left off because 0019 bounds the WAIT for a change that is then instant,
 * whereas this holds the lock for the backfill's duration whatever happens, so a
 * timeout would bound the smaller half of the cost.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE articles ADD COLUMN alt_key bytea`.execute(db);
  await backfill(db);

  // After the backfill, not before: building the index once over the finished
  // column is cheaper than maintaining it across every UPDATE, and a partial
  // unique index cannot be built at all over a column that still holds the
  // duplicates the backfill is there to skip.
  await sql`
    CREATE UNIQUE INDEX articles_alt_key_idx ON articles (alt_key) WHERE alt_key IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS articles_alt_key_idx`.execute(db);
  await sql`ALTER TABLE articles DROP COLUMN IF EXISTS alt_key`.execute(db);
}

/** Read in id order and in pages, so the working set is bounded by the page. */
const PAGE = 5_000;

interface ArticleRow {
  id: string;
  source_domain: string | null;
  title: string;
  published: Date;
}

async function backfill(db: Kysely<unknown>): Promise<void> {
  // A staging table rather than an id list threaded back through the UPDATE:
  // "keep only the keys that appear once" is a GROUP BY over the whole set, and
  // expressing it in SQL keeps it O(n log n) instead of a scan per row.
  await sql`
    CREATE TEMP TABLE alt_key_backfill (
      article_id bigint PRIMARY KEY,
      alt_key    bytea NOT NULL
    )
  `.execute(db);

  let after = "0";
  for (;;) {
    const { rows } = await sql<ArticleRow>`
      SELECT id, source_domain, title, published
        FROM articles
       WHERE id > ${after}::bigint
       ORDER BY id
       LIMIT ${PAGE}
    `.execute(db);
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.id;

    const ids: string[] = [];
    const keys: string[] = [];
    for (const row of rows) {
      const key = deriveAltKey(row.source_domain, row.title, row.published.toISOString());
      // A refusal is not a failure: an article with no key is identified by its
      // URL alone, which is exactly what every article was before this ran.
      if (key === null) continue;
      ids.push(row.id);
      keys.push(key);
    }
    if (ids.length === 0) continue;

    // Hex over the wire and `decode` on arrival, rather than a `bytea[]`
    // parameter: the array literal encoding for bytea is driver-specific, and a
    // text array of 64 hex characters is unambiguous.
    await sql`
      INSERT INTO alt_key_backfill (article_id, alt_key)
      SELECT id::bigint, decode(hex, 'hex')
        FROM unnest(${ids}::text[], ${keys}::text[]) AS t(id, hex)
    `.execute(db);
  }

  await sql`
    WITH unique_keys AS (
      SELECT alt_key FROM alt_key_backfill GROUP BY alt_key HAVING count(*) = 1
    )
    UPDATE articles a
       SET alt_key = b.alt_key
      FROM alt_key_backfill b
      JOIN unique_keys u ON u.alt_key = b.alt_key
     WHERE a.id = b.article_id
  `.execute(db);

  // Explicitly, not `ON COMMIT DROP`: the migrator runs every pending migration
  // in one transaction, so a table left to the commit would outlive this
  // migration and be visible to the next one in the same run.
  await sql`DROP TABLE alt_key_backfill`.execute(db);
}
