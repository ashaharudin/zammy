import { sql, type Kysely } from "kysely";
import type { Database } from "./database.js";

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
  /** Distinct member ARTICLES published inside the window — the size input. */
  windowArticles: number;
  /** Distinct source domains inside the window — the breadth gate (>= 2). */
  windowSources: number;
  /** Distinct member articles over the whole arc. */
  size: number;
  /** Distinct source domains over the whole arc. Reported, no longer the gate. */
  sourceCount: number;
  /** The newest member article inside the window: how recently this moved. */
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
 * Four exclusions, each with a reason that is not "tidiness":
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
           count(distinct a.id)::int as window_articles,
           count(distinct a.source_domain)::int as window_sources,
           max(a.published) as last_updated,
           arc.size,
           arc.source_count
      from storylines s
      join storyline_groups sg on sg.storyline_id = s.id
      join articles a on a.group_id = sg.group_id
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
       and a.language = ${input.language}
       and a.published >= ${input.from}
       and a.published < ${input.to}
     group by s.id, s.label, s.profile_tokens, arc.size, arc.source_count
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
