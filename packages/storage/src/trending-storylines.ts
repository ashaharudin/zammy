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
  /** Distinct member ARTICLES published inside the window — the size input. */
  windowArticles: number;
  /** Distinct member articles over the whole arc. */
  size: number;
  /** Distinct source domains over the whole arc — the breadth gate. */
  sourceCount: number;
  /** The newest member article inside the window: "most recently updated". */
  lastUpdated: Date;
}

/**
 * The breadth gate, carried over from the term cloud intact: fewer than two
 * distinct outlets over the whole arc and the storyline does not appear.
 *
 * A constant rather than config because it is not a tuning knob — it is the one
 * mechanism that measurably had to exist for the cloud to work at all
 * (PROBE-FINDINGS 6b), and the value is "more than one newsroom", which has no
 * second sensible setting.
 *
 * Measured over the ARC and not over the window, unlike everything else here.
 * The question the gate asks is whether several newsrooms have covered this
 * event, which is a fact about the story rather than about the last few hours:
 * a three-week storyline that eleven outlets have carried is not disqualified
 * because today's single new article came from one of them.
 */
const MIN_SOURCE_DOMAINS = 2;

/**
 * The cloud: storylines with at least one member article published inside
 * `[from, to)`, most recently updated first.
 *
 * Three exclusions, each with a reason that is not "tidiness":
 *
 *  - **Aliases** (`merged_into is not null`) are pointers, not storylines. The
 *    survivor carries the coverage and the label.
 *  - **Provisional** storylines are storylines-of-one — the ordinary timeline
 *    slot, not a story (ADR-0011's Lifecycle). Offering one as a topic of the
 *    day says a single group is an event.
 *  - **Unlabelled** storylines have no word to draw. `findSurfacedStorylines`
 *    learned this the hard way with eight pills reading "unlabelled storyline"
 *    while the backfill's label pass was still running; a cloud of them would
 *    be worse, since a label IS the word here.
 *
 * `language` filters the member ARTICLES, which is the same per-language corpus
 * the term cloud scored (§10.1): a storyline is not language-scoped — nothing
 * about an event is — but its coverage is, so a storyline appears in the cloud
 * of every language that covered it, sized by that language's articles.
 */
export async function readTrendingStorylines(
  db: Kysely<Database>,
  input: { language: string; from: Date; to: Date; limit: number },
): Promise<TrendingStoryline[]> {
  // Written out rather than assembled in Kysely: the arc-wide aggregate is a
  // lateral over a different join than the windowed one, which the builder
  // expresses far less clearly than SQL does (ADR-0003).
  const { rows } = await sql<{
    id: string;
    label: string;
    window_articles: number;
    size: number;
    source_count: number;
    last_updated: Date;
  }>`
    select s.id,
           s.label,
           count(distinct a.id)::int as window_articles,
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
       and arc.source_count >= ${MIN_SOURCE_DOMAINS}
     group by s.id, s.label, arc.size, arc.source_count
     order by max(a.published) desc, s.id
     limit ${input.limit}
  `.execute(db);

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    windowArticles: row.window_articles,
    size: row.size,
    sourceCount: row.source_count,
    lastUpdated: row.last_updated,
  }));
}
