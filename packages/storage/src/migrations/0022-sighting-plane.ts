import { sql, type Kysely } from "kysely";

/**
 * Why a fetch was made, on the row that records it (ADR-0019; plan §G5).
 *
 * `search` — a reader typed keywords. `breadth` — the periodic sample
 * (ARCHITECTURE 10.1). `deepening` — the cloud, or a storyline refresh, pointed
 * at an arc we already hold. The distinction is not "interactive vs background"
 * and it is not "which provider": it is **whether our own ranking chose the
 * target**, which is the property that decides what may feed the ranking back.
 *
 * This is the column ADR-0019 names, and G2's `DISCOVERY_PROVIDERS` list is
 * what it replaces. That list said so itself — it was correct only while every
 * provider was unsteered, and G5 is the phase that makes one provider serve a
 * reader's search and a cloud-driven deepening fetch on the same day. No
 * provider-level predicate can be right about both.
 *
 * ## The column is NULLABLE, and that is a deviation from the plan worth
 * ## reading before it is "fixed"
 *
 * §G5 asks for "every existing sighting backfilled to a non-deepening plane".
 * The obvious reading is migration 0013's shape — `NOT NULL DEFAULT 'search'` —
 * and it is the one thing the archive can prove false.
 *
 * 0013 and 0021 could both invent history because the invented value was
 * verifiably TRUE of it: there was exactly one provider, so `'currents'`
 * described every existing row (0021 re-verified this: all 383 coverage rows).
 * Here no single value describes history. Measured on the dev archive
 * (2026-08-28, 32,279 articles / 33,533 sightings):
 *
 *     articles whose ONLY topic membership is a keyword-less topic   1,791
 *     articles in some keyword-less topic                            1,949
 *     articles in no topic at all                                        0
 *
 * The keyword-less topic is the breadth sample's own fingerprint
 * (`processSampleJob`: "unreachable by users, who cannot canonicalize an empty
 * search"), so those 1,791 articles — 5.5% — were fetched by the breadth
 * sample and by nothing else. A `DEFAULT 'search'` would state, of rows a
 * single query disproves, that a reader asked for them.
 *
 * Backfilling those 1,791 as `'breadth'` and the rest as `'search'` was the
 * next candidate and it does not survive either: a sighting has no topic of its
 * own — `topic_articles` is per ARTICLE — so an article in both a keyword-less
 * and a keyword topic cannot say which of its sightings came from which fetch.
 * And ADR-0017's storyline refresh has been running since #162 under a topic
 * shaped exactly like a reader's two-word search, so an unknown number of
 * existing rows are `deepening` under ADR-0019's own definition and are
 * indistinguishable from the rest.
 *
 * So the honest value for a row minted before this column existed is **no
 * value**: its reason was not recorded, and NULL is what a database says for
 * that. It costs the `NOT NULL` guard, and that guard is bought back one layer
 * up — `plane` is required on `ingestSightings`' input and on the Kysely row
 * type, so a caller that forgets it does not compile. ADR-0019 already puts the
 * mitigation there: "`plane` is set in the few places that PLAN fetches, not in
 * the many that perform them."
 *
 * What it does NOT cost is the plan's actual requirement, which is that the
 * cloud be unchanged — see the predicate note below, and the proof recorded in
 * `trending-storylines.ts`.
 *
 * ## The CHECK, which `provider` does not have
 *
 * `provider` names an open set — a new adapter is a new value — so a constraint
 * there would be a migration per provider. `plane` is a closed set of three,
 * fixed by ADR-0019, and its predicate makes a typo dangerous in one direction
 * only: `plane is distinct from 'deepening'` is TRUE of `'deepning'`, so a
 * misspelled deepening fetch joins the discovery plane and re-opens exactly the
 * endogenous loop this column exists to close, silently. The CHECK is what
 * turns that into a failed insert. NULL is admitted by it because history is
 * NULL; nothing else outside the three is.
 *
 * ## No new index
 *
 * The ranker's semi join resolves through `sightings_article_idx` (migration
 * 0001) and did so under G2's provider predicate too. Measured on a TEMPLATE
 * clone of the dev archive with this column in place — 33,533 sightings, all
 * `plane` NULL — `EXPLAIN (ANALYZE, BUFFERS)` on `readTrendingStorylines`'
 * exact query over a 168h window (`TREND_WINDOW_HOURS`' ceiling) ending at the
 * archive's newest article, five runs each:
 *
 *     predicate                            buffers    execution time
 *     provider = any('{currents,gnews}')   325,399    167.6-176.2 ms
 *     plane is distinct from 'deepening'   325,399    168.6-176.5 ms
 *
 * Identical buffer counts, identical plans, and two wall-clock ranges that
 * overlap almost exactly — the predicate is a `Filter:` on a heap tuple the
 * index lookup has already fetched (`Index Cond: (article_id = a.id)`, one row
 * per lookup over 1,249 lookups), so which column it reads costs nothing.
 *
 * `sightings_provider_idx` was used by neither: the semi join enters on
 * `article_id`, and a three-valued column cannot narrow what the article id has
 * already narrowed to one row. G2's note on the composite `(article_id,
 * provider)` index it built and rejected applies here unchanged.
 *
 * ## What it locks, measured — the same hazard 0020 documented
 *
 * `ALTER TABLE ... ADD COLUMN` takes ACCESS EXCLUSIVE on `sightings`, which
 * conflicts with ACCESS SHARE and so blocks plain `SELECT`s, and Kysely runs
 * every pending migration in ONE transaction on Postgres
 * (`supportsTransactionalDdl`, and `disableTransactions` is not set) — so the
 * lock is taken by the first statement and held until the whole run commits,
 * not just this migration's part of it.
 *
 * Measured on the same clone, five runs, this migration alone:
 *
 *     up     ~12 ms   ADD COLUMN 0.9-1.2 ms, ADD CONSTRAINT 9.4-12.1 ms
 *     down   ~1.4 ms
 *
 * **The CHECK is nine tenths of the cost**, and that is worth stating because
 * it is the opposite of the intuition that made this column nullable. A
 * nullable column with no default is catalog-only, so `ADD COLUMN` touches no
 * row — but `ADD CONSTRAINT ... CHECK` scans the table to validate it, even
 * over a column that is entirely NULL. The alternative shape this rejects,
 * `NOT NULL DEFAULT 'search'` with no CHECK, measured on the same clone: 1.2-1.5
 * ms, because Postgres 11+ stores a non-volatile default without rewriting. So
 * the honest summary is that the nullability is free and the constraint costs
 * ~10 ms, not the other way round.
 *
 * Ten milliseconds of a fully blocked `sightings` is not a reason to reach for
 * `NOT VALID` — which would be SOUND here, since every existing row is NULL and
 * NULL satisfies the constraint — because a constraint left unvalidated is a
 * second state for a later reader to reason about, bought for 10 ms. 0020 held
 * `articles` for ~1.8 s and stated it plainly; this holds `sightings` for ~12 ms.
 *
 * Production held 37,077 articles against this archive's 32,279 when ADR-0018
 * measured both (2026-08-27) — 1.15x — so expect the same order there. Its
 * sighting count has not been measured from here and is not assumed.
 *
 * The number to quote to anyone choosing a deploy window is the whole pending
 * run's, not this migration's: every pending migration commits under one lock.
 * Measured on a clone carrying neither, 0021 and 0022 together apply in 377 ms.
 * What must NOT join them is 0023's re-key, which holds this lock for seconds
 * while it derives a key per article — see its own note, and keep the two in
 * separate deploys.
 *
 * ## Rows added: none
 *
 * A column on an existing table, no new table, no backfill, no index.
 * `pg_total_relation_size('sightings')` is 36 MB before and 36 MB after on the
 * clone — unchanged, because the fast ALTER rewrites nothing and existing
 * tuples are never touched. What this phase adds to production is the deepening
 * plane's articles themselves, which G6 is what counts.
  */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sightings ADD COLUMN plane text`.execute(db);

  await sql`
    ALTER TABLE sightings ADD CONSTRAINT sightings_plane_check
      CHECK (plane IS NULL OR plane IN ('search', 'breadth', 'deepening'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // The constraint goes with the column it constrains; naming it explicitly
  // anyway, because a later migration that drops only the constraint would
  // otherwise make this `down` fail on a re-run.
  await sql`ALTER TABLE sightings DROP CONSTRAINT IF EXISTS sightings_plane_check`.execute(db);
  await sql`ALTER TABLE sightings DROP COLUMN IF EXISTS plane`.execute(db);
}
