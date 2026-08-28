import { sql, type Kysely } from "kysely";
import { deriveAltKey } from "@zammy/news-client";

/**
 * Re-key `articles.alt_key` under the widened outlet-suffix fold (G5).
 *
 * ADR-0018 states the rule this migration exists to obey: **"Changing the fold
 * is a migration, not an edit."** Keys are stored under a partial unique index
 * and never recomputed, so widening `stripOutletSuffix` splits the archive into
 * rows keyed the old way and rows keyed the new one — and a row keyed the old
 * way stops folding with the very emissions the widening was for.
 *
 * ## What changed, and why it had to
 *
 * `stripOutletSuffix` peeled a trailing ` - Outlet` segment only when the
 * outlet's display name WAS its domain stem. Google News writes the display
 * name, and on a corpus harvested for this phase — 70 real storyline labels off
 * the dev archive, run against Google News RSS, 6,008 items over 1,837 outlets
 * (`fixtures/google-news-source-names.tsv`) — **26.2% of items failed to fold**.
 * Four rules replace the exact match, chosen on a held-out half of the queries
 * and taking that to 6.9%. `stripOutletSuffix` carries the whole experiment,
 * including the two rules it rejected and the display-name MAP it rejected.
 *
 * ## What this costs the archive it re-keys
 *
 * Measured on the dev archive (32,279 articles, 2026-08-28), old fold against
 * new, before running anything:
 *
 *     articles whose key CHANGES        524   (1.62%)
 *     articles that stop being keyable     1
 *     articles that become keyable         0
 *     collision groups, new fold         292   (against 291 under the old one)
 *     rows absorbed by collisions        312   (against 311)
 *
 * The one additional collision is a real duplicate — `cbc.ca` filed "How will
 * the new tariffs hit Canada's economy? | CBC Radio" and the same headline
 * without the suffix — which is the fold doing its job rather than a cost.

 * ## Those three numbers cannot see the error this change actually risks
 *
 * They all count COLLISIONS. A wrong peel that happens to yield a UNIQUE key
 * changes an article's identity to something no twin will ever match, and
 * appears in none of them — invisible by construction, and precisely the failure
 * a widened rule introduces. So the changed rows were classified rather than
 * counted, the way G0 listed its own false positives by name so they could be
 * weighed.
 *
 * All 525 rows whose peel moved, attributed to the rule that first accepted a
 * segment the exact match had refused:
 *
 *     rule                    rows   distinct (domain, segment)
 *     2 affix                  268        89
 *     3 initialism              10        10
 *     4 initials + tail        210         5
 *     5 affix reversed          37        20
 *                                        122
 *
 * **All 122 were read. None is a false positive.** They are section and edition
 * chrome ("CBC Sports" 31 rows, "CNN Politics" 22, "The Philadelphia Inquirer"
 * 18), mastheads the stem spells differently ("Honolulu Star-Advertiser" 42,
 * "The Jerusalem Post" 198, "Mint" for `livemint.com` 13), and site furniture
 * ("Kitco AM Report", "Bloomberg Brief 07/30/2026", "1330 & 101.5 WHBL").
 *
 * Two are worth naming because they are the closest calls, so a later reader can
 * disagree with the judgement rather than re-derive it:
 *
 *  - `space.com` "Space photo of the day for Aug. 4, 2026" — nine words and a
 *    date, which reads like a headline. It is a desk line: the full title is
 *    "ISS astronaut spies a swirling super storm | Space photo of the day for
 *    Aug. 4, 2026", and the peel leaves the story.
 *  - `thehockeywriters.com` "The Hockey Writers Pittsburgh Penguins Latest News,
 *    Analysis & More" — ten words, and still entirely chrome.
 *
 * ## Whether the affix rule wants a word cap: measured, and no
 *
 * `isAttribution` in the tokenizer caps a segment at `MAX_ATTRIBUTION_WORDS`
 * (4); this rule caps nothing, which is the obvious thing to question about it.
 * Accepted segments by length, over the same 525 rows:
 *
 *     1 word    16 segments,  35 rows        5 words   4 segments,  4 rows
 *     2 words   47 segments, 195 rows        6 words   3 segments,  3 rows
 *     3 words   37 segments, 264 rows        9 words   2 segments,  2 rows
 *     4 words   11 segments,  21 rows       10 words   2 segments,  3 rows
 *
 * A 4-word cap would refuse 11 segments over 12 rows, and **all eleven are
 * genuine chrome** — the two above, plus "Robb Report Australia and New
 * Zealand", "Martenson Family of Funeral Homes, INC.", "BBC Sky at Night
 * Magazine". It would prevent nothing, because there is nothing to prevent. A
 * cap is pure loss on this archive and is not taken.
 *
 * That is an argument about THIS archive and it should be re-run rather than
 * inherited: the tokenizer's cap protects a rule that reads only the segment's
 * shape, while this one already requires the segment to name the article's own
 * domain, which is a far narrower bar. If a false positive ever does turn up,
 * the cap is the first lever to reach for.
 *
 * ## `MIN_AFFIX = 3`, and how exposed the archive is to it
 *
 * A three-character domain stem is the shortest thing rule 2 will match on, and
 * short stems are where a coincidental match would come from. Of 2,033 distinct
 * domains in the archive, **112 have a three-character spelling**, and 23 of the
 * 122 accepted segments belong to one: "CBC Sports", "CNN Politics", "BBC
 * Sounds", "PBS News", "ITV News", "IOPscience". Every one is chrome. The floor
 * is doing what it was set for.
 *
 * The corpus this fold was tuned on covers 1,837 outlets the archive has mostly
 * never seen, so none of this is a claim about outlets we have not met — it is
 * the false-positive rate on the only history that can be checked.
 *
 * Without this migration those 524 rows would keep their old keys and quietly
 * fail to fold. 1.62% is small and it decays under retention, so "leave history
 * alone" was a live option; it is refused because the whole point of the
 * widening is cross-provider folding, and the rows a Google News item most wants
 * to fold onto are exactly the recent ones this would have stranded.
 *
 * ## The rule is 0020's, unchanged, and that is deliberate
 *
 * Every key is cleared and then re-derived, and a key is written back only where
 * it is UNIQUE across the archive. 0020 argued that at length and nothing here
 * weakens it: a colliding pair stays two rows, because merging them means
 * DELETING an article row, and `group_id` is a bigint article id carrying no
 * foreign key in either `articles` (0003) or `storyline_groups` (0007) — so a
 * merge would dangle group seeds and orphan storyline attachments with nothing
 * raising.
 *
 * A better-sounding rule was considered and dropped: keep ONE row of each
 * collision group keyed (the lowest id) rather than nulling the whole group, so
 * a future emission folds onto it instead of minting a third row. It is
 * defensible, and it is not worth a second policy to maintain, because the
 * archive says the two rules land in the same place — 31,539 rows keyed under
 * the unique-only rule against the 31,542 keyed today, a difference of three.
 *
 * ## Clearing first is not tidiness
 *
 * `alt_key` sits under a live partial UNIQUE index, and a re-key moves values
 * between rows: article A takes the key article B is holding while B takes a
 * third. Postgres checks a unique index per ROW as a statement proceeds, not at
 * statement end, so a single UPDATE that permutes keys can fail on an
 * intermediate state that the final state would have allowed. Setting the whole
 * column to NULL first makes every subsequent write an insertion into an empty
 * region of the index, and NULLs are outside a partial index in any case.
 *
 * ## What it costs to RUN, measured
 *
 * Against TEMPLATE clones of the dev archive. This migration ships on its own,
 * AFTER 0022, so the number that matters is its own rather than a combined run's
 * — applied to a database already carrying 0021 and 0022, twice from a clean
 * slate plus a no-op third pass:
 *
 *     3.6 s, 7.1 s      31,539 rows keyed, 740 left NULL — identical, so the
 *                       pass is idempotent
 *     58 ms             nothing pending, nothing moved
 *
 * 31,539 against the 31,542 keyed before it: three rows, which is the whole of
 * what the widened fold costs the archive's coverage of itself.
 *
 * Almost all of that time is deriving 32,279 sha256 keys in TypeScript a page at
 * a time. **It contains no `ALTER TABLE` and therefore takes no ACCESS EXCLUSIVE
 * of its own** — `articles` stays readable throughout, and the UPDATEs take row
 * locks that only a concurrent writer of the same rows would wait on.
 *
 * That is a property of shipping it separately, and it is worth stating because
 * it is easy to lose. Run in the SAME pending batch as 0022, this migration
 * inherits 0022's ACCESS EXCLUSIVE on `sightings` for its whole duration —
 * Kysely runs every pending migration in one transaction — and the combined run
 * measured 4.4–10.0 s across six clones, which is five to ten seconds during
 * which `sightings` answers no reads. Deployed apart, 0022 alone is 377 ms of
 * that lock and this is none of it. **Keep them in separate deploys**; if they
 * ever have to go out together, that combined figure is the one for the deploy
 * window.
 *
 * Production held 37,077 articles against this archive's 32,279 when ADR-0018
 * measured both (2026-08-27) — 1.15x — so expect the same order there.
 *
 * ## `down` is a no-op, and says so
 *
 * The inverse of "re-key under the new fold" is "re-key under the old one", and
 * the old fold no longer exists in the code: `down` would have to carry a frozen
 * copy of a function this migration exists to replace. A migration that reverts
 * to a fold nothing computes any more would leave the archive keyed a THIRD way,
 * which is worse than one that does nothing.
 *
 * ## The rollback, which is not `git revert`
 *
 * **A full revert of this change is not a rollback and must not be treated as
 * one.** It removes this migration and the widened rules together, and it
 * removes nothing from the database: production stays keyed under the new fold
 * while the code computes old keys. Every subsequent emission for an affected
 * outlet then fails to fold and mints a duplicate — the exact failure this
 * migration exists to prevent, arriving through the rollback path, silently,
 * and for as long as it takes anyone to notice. 524 rows of the dev archive are
 * in that state on the instant of the revert; production is 1.15x that.
 *
 * Two procedures do work, and they are different from each other:
 *
 *  - **Partial revert.** Undo the new rules in `stripOutletSuffix` ALONE, leave
 *    this migration registered and applied, and re-run it. The pass recomputes
 *    from `title` and `source_domain`, which it never writes, so it is
 *    idempotent and re-running it under the narrowed fold re-keys the archive
 *    back. That this is a partial revert rather than a revert of the change is
 *    the whole of the distinction, and it is why "revert the code and re-run
 *    this" — which an earlier version of this comment said — is not executable:
 *    revert the code and this file goes with it, leaving nothing to re-run.
 *  - **Roll forward.** Ship an `0024` that re-keys under whatever fold is then
 *    current. This is the one to reach for if the fold needs to change again
 *    rather than to go back, and it is the only option once this migration has
 *    been superseded.
 *
 * The bias is deliberate: rolling forward is cheap here — the pass is one
 * bounded sweep with no ALTER — and rolling back is a schema/code split that
 * nothing detects.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE articles SET alt_key = NULL WHERE alt_key IS NOT NULL`.execute(db);
  await rekey(db);
}

export async function down(): Promise<void> {
  // Deliberately empty, and the header says what to do instead. Two things this
  // is NOT: it is not an oversight, and it is not "revert the change" — a full
  // revert leaves the database keyed the new way while the code computes the old
  // one, which silently mints a duplicate per affected outlet from then on. The
  // working rollback is a PARTIAL revert of `stripOutletSuffix` with this
  // migration left registered, then a re-run.
}

/** Read in id order and in pages, so the working set is bounded by the page. */
const PAGE = 5_000;

interface ArticleRow {
  id: string;
  source_domain: string | null;
  title: string;
  published: Date;
}

async function rekey(db: Kysely<unknown>): Promise<void> {
  // 0020's staging table, verbatim in shape and for its reason: "keep only the
  // keys that appear once" is a GROUP BY over the whole set, and expressing it
  // in SQL keeps it O(n log n) instead of a scan per row.
  await sql`
    CREATE TEMP TABLE alt_key_rekey (
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
      // The SAME `deriveAltKey` ingest calls, over rows read back from the
      // table — 0020's reason, unchanged: an SQL twin of the fold would have to
      // agree with it exactly, and the two would drift the first time either
      // moved. This migration exists because one of them moved.
      const key = deriveAltKey(row.source_domain, row.title, row.published.toISOString());
      if (key === null) continue;
      ids.push(row.id);
      keys.push(key);
    }
    if (ids.length === 0) continue;

    await sql`
      INSERT INTO alt_key_rekey (article_id, alt_key)
      SELECT id::bigint, decode(hex, 'hex')
        FROM unnest(${ids}::text[], ${keys}::text[]) AS t(id, hex)
    `.execute(db);
  }

  await sql`
    WITH unique_keys AS (
      SELECT alt_key FROM alt_key_rekey GROUP BY alt_key HAVING count(*) = 1
    )
    UPDATE articles a
       SET alt_key = b.alt_key
      FROM alt_key_rekey b
      JOIN unique_keys u ON u.alt_key = b.alt_key
     WHERE a.id = b.article_id
  `.execute(db);

  // Explicitly, not `ON COMMIT DROP`: the migrator runs every pending migration
  // in one transaction, so a table left to the commit would outlive this
  // migration and be visible to the next one in the same run.
  await sql`DROP TABLE alt_key_rekey`.execute(db);
}
