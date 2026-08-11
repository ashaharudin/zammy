import type { Kysely } from "kysely";
import {
  readGroupCandidates,
  recordGrouping,
  type CreatedArticle,
  type Database,
} from "@zammy/storage";
import { zonedDayBounds, zonedDayKey } from "./app-day.js";
import { headlineFigures, headlineTokens, rankedMatches } from "./grouping.js";
import type { Metrics } from "./metrics.js";

/**
 * Grouping, wired up (ARCHITECTURE 14.3): run over the articles an ingest call
 * just created, once each, at write time.
 *
 * Write time is not an optimization here, it is the design. ADR-0002 rejected
 * collapsing at READ time because a page of 25 can collapse to 3, making page
 * size unpredictable and `hasMore` unreliable — and that objection is about
 * paging, so grouping does not escape it by being a gentler operation. The
 * group is materialized on the row; the read stays a keyset scan (§7.3).
 */

export interface GroupingDeps {
  db: Kysely<Database>;
  config: {
    /** §14.3 was explicit that whether to build this at all stayed open. */
    enabled: boolean;
    threshold: number;
    /** The calendar day candidates are drawn from — §10.1's rule, not UTC. */
    timeZone: string;
  };
  metrics?: Metrics;
  log?: { warn: (obj: object, msg: string) => void };
}

/**
 * Narrow a caller's deps to what grouping needs.
 *
 * Every write path into `articles` owes the same call, so the wiring lives
 * here rather than at each site: an ingest that skips grouping leaves articles
 * without tokens, which silently makes them un-groupable AND invisible as
 * candidates to everything ingested afterwards. The sampler was exactly that
 * bug for one release.
 */
export function groupingDepsFor(deps: {
  db: Kysely<Database>;
  config: { grouping: GroupingDeps["config"] };
  metrics?: Metrics;
  log?: { warn: (obj: object, msg: string) => void };
}): GroupingDeps {
  return {
    db: deps.db,
    config: deps.config.grouping,
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  };
}

/**
 * Safety valve for a pathological day, not a tuning knob: a token appearing in
 * thousands of same-day headlines would otherwise make grouping one article an
 * unbounded scan. Taking the most recent N yields a worse grouping, never a
 * wrong row — grouping fails soft, which is the whole reason §14.3 judged this
 * a materially better risk profile than merging.
 *
 * It binds harder since members became candidates (ADR-0005): a 9-article wire
 * cluster now occupies nine slots rather than one.
 */
const CANDIDATE_LIMIT = 200;

/**
 * How many groups of one a single arrival may adopt.
 *
 * Adoption happens inside the request that triggered the ingest, so this
 * bounds write amplification rather than correctness: ten is far above what
 * real coverage produces (the largest live case adopted two), and a day
 * pathological enough to exceed it gets a slightly worse grouping, never a
 * wrong row.
 */
const ADOPT_LIMIT = 10;

/**
 * Group each newly-created article, and return how many joined an existing
 * group.
 *
 * Never throws. A grouping failure must not fail the read that triggered the
 * ingest: the articles are already stored and already paged, and the worst
 * case of skipping this is a timeline that shows two cards where it could have
 * shown one. Reserving that judgement for the caller would mean every caller
 * making it correctly.
 */
export async function groupCreatedArticles(
  deps: GroupingDeps,
  created: readonly CreatedArticle[],
): Promise<number> {
  if (!deps.config.enabled || created.length === 0) return 0;

  let grouped = 0;
  for (const article of created) {
    try {
      if (await groupOne(deps, article)) grouped += 1;
    } catch (error) {
      deps.log?.warn(
        { err: error, articleId: article.id },
        "grouping failed for one article; it stays a group of one",
      );
    }
  }

  deps.metrics?.articlesGrouped(grouped);
  return grouped;
}

async function groupOne(deps: GroupingDeps, article: CreatedArticle): Promise<boolean> {
  const tokens = headlineTokens(article.title);

  // A headline that reduces to fewer than two tokens can never clear the
  // shared-token floor, in either direction. Recording the tokens anyway keeps
  // one rule — "an article's tokens are what its headline says" — rather than
  // a column that is sometimes populated and sometimes not.
  if (tokens.length < 2) {
    await recordGrouping(deps.db, {
      articleId: article.id,
      titleTokens: tokens,
      groupId: null,
    });
    return false;
  }

  const day = zonedDayBounds(
    zonedDayKey(article.published, deps.config.timeZone),
    deps.config.timeZone,
  );

  const candidates = await readGroupCandidates(deps.db, {
    from: day.from,
    to: day.to,
    language: article.language,
    titleTokens: tokens,
    excludeArticleId: article.id,
    limit: CANDIDATE_LIMIT,
  });

  const headline = { tokens, figures: headlineFigures(article.title) };
  const matches = rankedMatches(headline, candidates, { threshold: deps.config.threshold });
  const chosen = matches[0] ?? null;

  await recordGrouping(deps.db, {
    articleId: article.id,
    titleTokens: tokens,
    groupId: chosen?.groupId ?? null,
  });

  if (chosen) await adoptStragglers(deps, chosen.groupId, matches);

  return chosen !== null;
}

/**
 * Pull every OTHER group of one this article matched into the group it joined.
 *
 * Grouping evaluates an article once, at creation, so an article that arrives
 * before its story's coverage exists never gets another chance — and
 * best-match-wins meant a later arrival could match it, join somewhere better,
 * and leave it stranded. This is the moment both articles are known to be the
 * same story, so it is the moment to act.
 *
 * Only groups of ONE are adopted. Merging two real groups is transitive
 * merging, which is the chaining the day window exists to bound; adopting a
 * singleton keeps every member within one hop of the article that pulled it in.
 * `recordGrouping` enforces the singleton rule in SQL, so a candidate that
 * gained members since the query is refused rather than stranding them.
 */
async function adoptStragglers(
  deps: GroupingDeps,
  groupId: string,
  matches: readonly { id: string; groupId: string; titleTokens: string[] }[],
): Promise<void> {
  let adopted = 0;
  for (const match of matches) {
    if (adopted >= ADOPT_LIMIT) break;
    // Already in the group, or plainly not a group of one.
    if (match.groupId === groupId || match.id !== match.groupId) continue;

    await recordGrouping(deps.db, {
      articleId: match.id,
      titleTokens: match.titleTokens,
      groupId,
    });
    adopted += 1;
  }
}
