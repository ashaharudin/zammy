import { sql, type Kysely } from "kysely";
import type { Database, SightingPlane } from "./database.js";

/**
 * Wordcloud storage (ARCHITECTURE 10.4) — one read, and nothing derived.
 *
 * The cloud names the STORYLINES the rolling window updated (ADR-0013), and a
 * storyline is already a maintained row: the linker attaches groups as they
 * arrive, the labeler names it, and `storyline_days` is refreshed at write
 * time. So the cloud is a question the schema can answer directly, and the
 * three tables that used to stand behind it — `trending_terms` for the
 * computed cloud, `term_snapshots` for the history, `term_baseline` for the
 * suppressor — went with the terms they existed for (migration 0014).
 *
 * That is the whole shape of this file, and the reason it is short. Nothing
 * here is a snapshot of anything: the window ends at `now` on every call, and
 * a storyline that gains an article at 14:03 is one place higher at 14:04
 * without a recompute having run.
 */

export interface TrendingStoryline {
  id: string;
  /** Non-null by construction: the query refuses unlabelled storylines. */
  label: string;
  /**
   * The arc's headline vocabulary — what the API turns into the search a click
   * runs (`cloudQuery`). Carried out of the read rather than fetched per word
   * because it is one more column on a row the aggregate already groups by.
   */
  profileTokens: string[];
  /**
   * Distinct DISCOVERY-PLANE member articles published inside the window — the
   * size input, and the ranking's volume term. See `STEERED_PLANE`: this counts
   * articles some unsteered fetch saw, not every article we hold.
   */
  windowArticles: number;
  /** Distinct discovery-plane source domains inside the window — the gate (>= 2). */
  windowSources: number;
  /**
   * Distinct member articles over the whole arc, EVERY plane. Not `windowArticles`
   * measured over a longer span: this is how big the story is in the store, which
   * is what a reader clicking through will find in the timeline.
   */
  size: number;
  /** Distinct source domains over the whole arc, every plane. Reported, not the gate. */
  sourceCount: number;
  /**
   * The newest discovery-plane member article inside the window: how recently
   * this moved. The recency half of the score and the colour channel, so it is
   * steered and therefore discovery-plane only (`STEERED_PLANE`, surface 6).
   */
  lastUpdated: Date;
}

/**
 * The breadth gate: fewer than two distinct outlets and the storyline does not
 * appear. Not a tuning knob — it is the one mechanism that measurably had to
 * exist for the cloud to work at all (PROBE-FINDINGS 6b), and its value is
 * "more than one newsroom", which has no second sensible setting.
 *
 * Measured over the WINDOW, which is where ADR-0014 moved it from the arc.
 * ADR-0013 asked the gate a question about the story — have several newsrooms
 * ever covered this event — and answering it over the arc let a storyline
 * qualify on strength it earned weeks ago: on live data 18 of 32 qualifying
 * storylines had exactly one article from one outlet inside the window, and
 * because the ordering was pure recency those were the words at the top of the
 * board. Asked over the window, the gate answers the question the landing page
 * is actually posing — are several newsrooms covering this NOW.
 *
 * This subsumes the arc-wide gate rather than joining it: a window's articles
 * are a subset of the arc's, so two domains inside the window are two domains
 * over the arc. `sourceCount` stays in the row as a reported fact.
 */
const MIN_SOURCE_DOMAINS = 2;

/**
 * The plane a fetch was made on, and the one value that may not feed a ranking.
 *
 * **The plane that measures is the plane that is not steered**
 * (DESIGN-DISCOVERY-AND-DEEPENING §3a) — this cloud ranks on articles that were
 * fetched for some reason other than the cloud having named them.
 *
 * The failure it forecloses is a loop, not an inaccuracy. A deepening provider
 * takes the cloud's own output as its work list; if what it returns then counts
 * toward the volume the cloud selects on, the score is endogenous — an arc that
 * reaches the board once is fetched, gains articles, ranks higher, is fetched
 * more, with nothing damping it. The cloud would stop answering "what is the
 * world covering" and start answering "what have we been fetching", and the
 * second question looks exactly like the first from the outside.
 *
 * The gate goes the same way for a sharper reason: Google News returns 20–82
 * domains for a single query, so an arc it touched would clear
 * `MIN_SOURCE_DOMAINS` for free and the one mechanism PROBE-FINDINGS 6b showed
 * had to exist would stop selecting anything.
 *
 * ## This replaced a PROVIDER list, and why it had to
 *
 * The shipped form of this rule was `provider = any('{currents,gnews}')`, and
 * its own comment gave it a shelf life: correct while every provider was
 * unsteered, and wrong the moment one served two roles. G5 is that moment.
 * ADR-0019 relocates the asymmetry rather than softening it — the honest test is
 * a property of the FETCH, not of whoever answered it, because Google News
 * answers a reader's search, a breadth sample and a cloud-driven deepening fetch
 * with the same provider name on the same day, and no provider-level predicate
 * can be true of the first two and false of the third.
 *
 * The boundary case ADR-0019 resolves, restated because it is the one that will
 * be re-litigated: ADR-0017's storyline refresh is `deepening` even though a
 * reader's click triggers it. **The test is whether OUR OWN RANKING chose the
 * target**, not what fired the request. A reader's search and a breadth sample
 * are demand we did not manufacture; a refresh points at an arc this cloud
 * named.
 *
 * ## GNews' rows stay in, and the reason is now structural rather than listed
 *
 * The old list held two names, and the tempting reading of it was "= currents".
 * That reading was measured and rejected: GNews ran for four days in August 2026
 * and 1,424 of the dev archive's 33,533 sightings are still its, against the
 * same window this file scores. Held to Currents alone the dev archive's cloud
 * went from 503 storylines to 363 — 140 dropped for no longer clearing two
 * domains, 103 volumes, 103 breadths and 36 recencies moved — which is not the
 * loop this guards against, only discarded coverage. (Production was the same
 * shape at its own scale: 412 volumes, 411 breadths, 82 recencies, 140 dropped.)
 *
 * Under a plane predicate that argument no longer has to be maintained as a
 * list. Every one of those 1,424 rows carries a NULL plane and passes, and every
 * GNews row written from here on carries the plane of the fetch that asked for
 * it — `search` or `breadth`, because ADR-0012's fan-out sends a reader's search
 * and the breadth sample to every provider. A supplement that bears no coverage
 * and ends no walk is still a real outlet answering an unsteered question, and
 * the gate asking "are several newsrooms covering this NOW" should count it.
 *
 * ## `is distinct from`, and what the bare `<>` costs — measured
 *
 * Every sighting written before migration 0022 carries `plane = NULL`, because
 * no single value describes history and the migration would not invent one.
 * `plane <> 'deepening'` is NULL for those rows, and a NULL predicate filters
 * the row out.
 *
 * That is not a theoretical footnote. Measured on a clone of the dev archive
 * over a 168h window ending at the archive's newest article, the same query
 * three ways:
 *
 *     provider = any('{currents,gnews}')    136 storylines   (the shipped cloud)
 *     plane is distinct from 'deepening'    136 storylines   BYTE-IDENTICAL
 *     plane <> 'deepening'                    0 storylines   the whole cloud gone
 *
 * The middle line is the proof §G5 asks for — "re-run G2's byte-identical proof
 * against the new predicate ... and if it does not hold, the backfill default is
 * wrong". It holds, and it holds precisely because the NULL is admitted rather
 * than because a value was invented. The third line is the same mistake the
 * `label_source` guard below already pays for, in a place where it would have
 * emptied the landing page rather than trimming it.
 *
 * ## Membership is by SIGHTING, not by a column on `articles`
 *
 * There is no `articles.plane` to reach for, and there should not be. The
 * cheap-column temptation the provider list documented survives the reshaping
 * intact: migration 0013 defines `articles.provider` as the provider
 * of the EARLIEST sighting, so it reads "who got here first" where this needs
 * "was this article ever seen on a plane nobody steered". A denormalized plane
 * would have to answer the same way and could not — an article the deepening
 * plane reported first and a reader's search reported later belongs in this
 * count, and a first-sighting column would drop it.
 *
 * That is not a hypothetical ordering, it is a measured rate: the dev archive
 * holds 33 articles whose earliest sighting is from one provider and which
 * another provider also saw.
 *
 * Measured cost of asking the honest question, unchanged by the column swap:
 * `EXPLAIN (ANALYZE, BUFFERS)` gives 325,399 shared buffers and an identical
 * plan under both predicates, five runs each, with wall-clock ranges that
 * overlap (167.6–176.2 ms against 168.6–176.5 ms). The semi join resolves
 * through `sightings_article_idx` (migration 0001) at one row per lookup and the
 * predicate is a `Filter:` on a heap tuple already fetched, so which column it
 * reads is free. Migration 0022 carries the table.
 *
 * No new index, and `sightings_provider_idx` is used by neither form: all the
 * selectivity is in `article_id`. G2 built and rejected a composite
 * `(article_id, provider)` for buying 0.07–0.28% of buffers, and a
 * `(article_id, plane)` would be the same index with a narrower column.
 *
 * A CONSTANT rather than an inline literal, so the one string this rule turns on
 * is named once and the two places that must agree — this predicate and
 * `SightingPlane` — are one edit apart.
 */
const STEERED_PLANE: SightingPlane = "deepening";

/**
 * The cloud: storylines several newsrooms covered inside `[from, to)`, the
 * busiest and freshest first.
 *
 * **The ordering is a score, not a recency sort** (ADR-0014). ADR-0013 ordered
 * by `max(published)` alone and gave the two visual channels one question each,
 * which read well and ranked badly: on live data "Trade Deal" (17 articles, 11
 * outlets) sat at position 24 in cool blue while a single-article storyline led
 * the board in red. So volume returns to the ordering, decayed by age exactly
 * as ADR-0008 decayed it — `0.5 ^ (age / halfLifeHours)`, exponential for the
 * reasons that ADR argued at length — and the two channels stay honest because
 * the front end reads recency off `lastUpdated` rather than off array position.
 *
 * The decay is why this needs `to` as an instant and not just as a bound: age
 * is measured from the window's end, so a cached response and a fresh one agree
 * about the board while the cache lives.
 *
 * Five exclusions, each with a reason that is not "tidiness":
 *
 *  - **Aliases** (`merged_into is not null`) are pointers, not storylines. The
 *    survivor carries the coverage and the label.
 *  - **Provisional** storylines are storylines-of-one — the ordinary timeline
 *    slot, not a story (ADR-0011's Lifecycle). Offering one says a single group
 *    is an event.
 *  - **Unlabelled** storylines have no word to draw. `findSurfacedStorylines`
 *    learned this the hard way with eight pills reading "unlabelled storyline"
 *    while the backfill's label pass was still running; a cloud of them would
 *    be worse, since a label IS the word here.
 *  - **One newsroom inside the window** — see `MIN_SOURCE_DOMAINS`. A `having`
 *    rather than a `where`, because it is a question about the group.
 *  - **Articles no unsteered fetch ever saw** — see `STEERED_PLANE`.
 *    Unlike the other four this excludes ARTICLES rather than storylines, and a
 *    storyline whose entire window coverage came from somewhere else falls out
 *    as a consequence rather than by its own clause. That is the right outcome:
 *    such a storyline has no evidence that several newsrooms are covering it
 *    now, only evidence that we went and fetched it.
 *
 * `language` filters the member ARTICLES, which is the same per-language corpus
 * the term cloud scored (§10.1): a storyline is not language-scoped — nothing
 * about an event is — but its coverage is, so a storyline appears in the cloud
 * of every language that covered it, sized by that language's articles.
 */
export async function readTrendingStorylines(
  db: Kysely<Database>,
  input: {
    language: string;
    from: Date;
    to: Date;
    /** The decay's half-life in hours. Must be > 0; config's floor is 0.5. */
    halfLifeHours: number;
    limit: number;
  },
): Promise<TrendingStoryline[]> {
  // Written out rather than assembled in Kysely: the arc-wide aggregate is a
  // lateral over a different join than the windowed one, which the builder
  // expresses far less clearly than SQL does (ADR-0003).
  const { rows } = await sql<{
    id: string;
    label: string;
    profile_tokens: string[];
    window_articles: number;
    window_sources: number;
    size: number;
    source_count: number;
    last_updated: Date;
  }>`
    select s.id,
           s.label,
           s.profile_tokens,
           -- (1) Volume. The leading ORDER BY term and the font-size channel,
           -- so it is the single most steerable number here: discovery plane
           -- only, by the WHERE below.
           count(distinct a.id)::int as window_articles,
           -- (2) Window breadth. Reported, never ordered on -- but it is the
           -- SAME expression as the gate on (3), and it has to stay that way.
           -- The front end renders it as the justification for the word being
           -- on the board ("2 articles from 2 outlets", cloudLabels.ts), so a
           -- version of it that counted domains the gate did not would print
           -- manufactured breadth under a word that never earned it. Reported
           -- and gated must be the same count or the sentence is a lie.
           count(distinct a.source_domain)::int as window_sources,
           -- (6) Recency, and the one that is easy to miss. This is not a
           -- display field: it is the decay's numerator in the ORDER BY, the
           -- tiebreaker under it, and the value TrendingCloud.tsx sorts by to
           -- assign colour. One deepening-plane article newer than everything
           -- else in the arc would re-rank the arc on its own, with the volume
           -- count untouched -- a steering channel that survives fixing (1).
           -- Discovery plane only, by the same WHERE.
           max(a.published) as last_updated,
           arc.size,
           arc.source_count
      from storylines s
      join storyline_groups sg on sg.storyline_id = s.id
      join articles a on a.group_id = sg.group_id
      -- (4) and (5): the arc's own size and breadth, over EVERY plane, and
      -- deliberately not filtered. These are the only two figures here that are
      -- statements about the store rather than about the ranking -- nothing
      -- orders on them, no visual channel reads them, and "size" is rendered as
      -- "N in all", which is a promise about what a click will show. A reader
      -- who follows the word gets the timeline, and the timeline holds every
      -- plane's articles; a discovery-only "size" would advertise 4 and deliver
      -- 100. ADR-0014 already records source_count as a fact the row reports
      -- rather than gates on; this keeps that true instead of quietly
      -- redefining which articles the fact is about.
      --
      -- The residual risk is named rather than denied: a big "N in all" may
      -- attract clicks, and clicks are what drive deepening, so there is a loop
      -- here too. It runs through a human choosing, not through an aggregate
      -- feeding itself, and paying for it with a number that contradicts the
      -- page it links to is the worse trade. If G6's yield numbers show it
      -- biting, the fix is a second field -- "articles we have" beside
      -- "articles that voted" -- and a PAGE_SHAPE_VERSION bump to carry it.
      -- Not one today: nothing about the wire's SHAPE changes here, only which
      -- articles feed fields that already exist.
      cross join lateral (
        select count(distinct a2.id)::int as size,
               count(distinct a2.source_domain)::int as source_count
          from storyline_groups sg2
          join articles a2 on a2.group_id = sg2.group_id
         where sg2.storyline_id = s.id
      ) arc
     where s.merged_into is null
       and s.status <> 'provisional'
       and s.label is not null
       -- Not a bigram label. The fallback extractor names vocabulary rather
       -- than events ("Investing Com" over four unrelated earnings templates,
       -- "Second Quarter" over three unrelated companies), and the cloud is the
       -- one place a label's words are EXECUTED as a search (ADR-0013/0014) --
       -- so a vocabulary label here mints a topic for a story that does not
       -- exist. readLabelMergeCandidates has excluded these from merge evidence
       -- since ADR-0011 for the same reason; the cloud never got the same guard.
       --
       -- coalesce, NOT a bare "s.label_source <> 'bigram'": that comparison is
       -- NULL for a row whose provenance predates migration 0011, and a NULL
       -- predicate filters the row out. Spelled bare it would silently drop
       -- every pre-migration label too -- 1,601 of 3,458 eligible rows in the
       -- dev archive, over half the cloud, for a change meant to remove 323.
       -- The merge query DOES require a known source, and the asymmetry is
       -- deliberate: a merge is destructive and earns "prove it is a model
       -- label", while the cloud is presentation and only needs "not one we
       -- know to be vocabulary".
       and coalesce(s.label_source, '') <> 'bigram'
       and a.language = ${input.language}
       and a.published >= ${input.from}
       and a.published < ${input.to}
       -- The discovery-plane restriction, reaching surfaces (1), (2), (3) and
       -- (6) at once -- every aggregate over "a", which is every number that
       -- steers. A WHERE rather than four "filter (where ...)" clauses because
       -- one predicate cannot drift out of step with itself, and because the
       -- alternative leaves a group standing with a zero count and a null
       -- "last_updated" for the "having" to discard anyway.
       --
       -- "exists" over "sightings", not a column on "a": see "STEERED_PLANE"
       -- for why a denormalized plane would answer a different question, and
       -- for the measured cost of asking the right one.
       --
       -- "is distinct from", NOT "<>". Every sighting predating migration 0022
       -- carries a NULL plane, "<>" is NULL for those rows, and a NULL
       -- predicate filters the row out -- measured, the bare form returns ZERO
       -- storylines against this form's 136 on the dev archive. Same trap as
       -- the "label_source" coalesce above, one order of magnitude worse.
       --
       -- Still a no-op on every row in the store today, deliberately: nothing
       -- has written a plane yet, so every row is NULL and every NULL is
       -- non-steered. It starts excluding rows on the day the deepening plane
       -- writes its first sighting.
       and exists (
         select 1
           from sightings ds
          where ds.article_id = a.id
            and ds.plane is distinct from ${STEERED_PLANE}
       )
     group by s.id, s.label, s.profile_tokens, arc.size, arc.source_count
    -- (3) The gate. Reads unchanged and means something different: "a" is now
    -- discovery-plane articles, so this asks "are several newsrooms covering
    -- this NOW" of the plane nobody steered. Unguarded it is the surface that
    -- fails hardest under a deepening provider -- Google News returns 20-82
    -- domains for one query, so a two-domain bar is not a bar at all on any arc
    -- it touches, and the gate PROBE-FINDINGS 6b showed was load-bearing would
    -- pass everything it was pointed at.
    having count(distinct a.source_domain) >= ${MIN_SOURCE_DOMAINS}
     -- volume x recency (ADR-0014). The age is non-negative by construction:
     -- the where clause bounds every member article above, so max < the end.
     order by count(distinct a.id)
                * power(
                    0.5,
                    extract(epoch from (${input.to}::timestamptz - max(a.published)))
                      / 3600.0
                      / ${input.halfLifeHours}
                  ) desc,
              max(a.published) desc,
              s.id
     limit ${input.limit}
  `.execute(db);

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    profileTokens: row.profile_tokens,
    windowArticles: row.window_articles,
    windowSources: row.window_sources,
    size: row.size,
    sourceCount: row.source_count,
    lastUpdated: row.last_updated,
  }));
}
