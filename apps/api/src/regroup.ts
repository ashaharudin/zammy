import type { Kysely } from "kysely";
import {
  countStaleTokenArticles,
  mergeGroups,
  readGroupCandidates,
  readStaleTokenArticles,
  recordGrouping,
  type Database,
  type StoredArticle,
} from "@zammy/storage";
import { zonedDayBounds, zonedDayKey } from "./app-day.js";
import { groupArticle, type GroupingDeps } from "./grouping-service.js";
import { headlineFigures, headlineTokens, rankedMatches, TOKENIZER_VERSION } from "./grouping.js";
import { storyTokens } from "./storyline.js";
import { rebuildDayStorylines } from "./storyline-service.js";

/**
 * Bring stored grouping state up to the current rules (ADR-0005, ADR-0009).
 *
 * Four passes, in this order and for a reason:
 *
 *  1. **re-derive tokens** for every row behind `TOKENIZER_VERSION` — headline
 *     AND story tokens, one version clock for both — so candidates stop being
 *     compared against the vocabulary of an older tokenizer;
 *  2. **re-run the grouping decision** for articles that are still a group of
 *     one, which can only be worth doing once (1) has given everything the
 *     same vocabulary;
 *  3. **merge bridged groups** (ADR-0009): walk the window in arrival order
 *     and act on bridge evidence — an article whose matches span other groups
 *     proves the split should not exist. This is what heals splits that
 *     locked in before merging existed, which pass 2 cannot touch (its
 *     subjects are singletons; these are not);
 *  4. **rebuild storylines** per day and language, biggest-group-first — the
 *     canonical clustering that live attachment order-dependence heals into.
 *
 * Passes 2–4 move rows under live cursors, which is why this is an operator
 * command over a bounded window rather than a background chore — the blast
 * radius is chosen deliberately, once, by someone who knows what they are
 * re-deriving (ADR-0005's posture, unchanged by the new passes).
 */

export interface RegroupOptions {
  /** How far back to go. The blast radius, chosen by the caller. */
  days: number;
  /** Skip passes 2–4 — re-derive tokens and change no groupings at all. */
  tokensOnly?: boolean;
  /** Rows per batch. Bounds the transaction count, not correctness. */
  batchSize?: number;
  /** Injectable clock — the window is relative to it. */
  now?: () => Date;
}

export interface RegroupResult {
  /** Rows whose tokens were behind the current tokenizer when we started. */
  stale: number;
  retokenized: number;
  /** Groups of one that found a group under the current rules. */
  regrouped: number;
  /** Groups merged away on bridge evidence (ADR-0009). */
  merged: number;
  /** Groups whose storyline changed in the rebuild (ADR-0009). */
  reclustered: number;
}

/** Same bound, same reasoning as the ingest path's candidate read. */
const CANDIDATE_LIMIT = 200;

export async function regroup(
  deps: GroupingDeps & { db: Kysely<Database> },
  options: RegroupOptions,
): Promise<RegroupResult> {
  const batchSize = options.batchSize ?? 500;
  const now = options.now?.() ?? new Date();
  const from = windowStart(options.days, deps.config.timeZone, now);

  const result: RegroupResult = {
    stale: await countStaleTokenArticles(deps.db, { version: TOKENIZER_VERSION, from }),
    retokenized: 0,
    regrouped: 0,
    merged: 0,
    reclustered: 0,
  };

  for (;;) {
    const batch = await readStaleTokenArticles(deps.db, {
      version: TOKENIZER_VERSION,
      from,
      limit: batchSize,
    });
    if (batch.length === 0) break;

    for (const article of batch) {
      await retokenize(deps, article);
      result.retokenized += 1;
    }
    deps.log?.warn(
      { retokenized: result.retokenized, of: result.stale },
      "regroup: re-deriving headline and story tokens",
    );
  }

  if (options.tokensOnly) return result;

  // Everything is at the current version now, so asking for the NEXT version
  // returns the whole window back rather than re-querying by a different
  // predicate. Oldest first, which reproduces arrival order and therefore the
  // decisions the same articles would have received under today's rules.
  const window = await readStaleTokenArticles(deps.db, {
    version: TOKENIZER_VERSION + 1,
    from,
    limit: Number.MAX_SAFE_INTEGER,
  });

  // Pass 2 — the original maintenance move: singletons may join groups.
  for (const article of window) {
    if (!article.isGroupOfOne) continue;
    // Count moves, not verdicts: an article whose best match is inside its own
    // group has not been regrouped, it has been confirmed.
    const joined = await groupArticle(deps, article);
    if (joined !== null && joined !== article.groupId) result.regrouped += 1;
  }

  // Pass 3 — bridge-evidence merges (ADR-0009). Every article gets the same
  // one look it had at arrival, under today's rules; where its matches span
  // groups other than its own, those groups are one story and merge. Group
  // membership is re-read per article because earlier merges change it.
  for (const article of window) {
    result.merged += await mergeBridges(deps, article);
  }

  // Pass 4 — canonical storyline clustering, per day-language bucket.
  const buckets = new Map<string, { day: string; language: string | null }>();
  for (const article of window) {
    const day = zonedDayKey(article.published, deps.config.timeZone);
    buckets.set(`${day}|${article.language ?? "∅"}`, { day, language: article.language });
  }
  for (const bucket of buckets.values()) {
    const bounds = zonedDayBounds(bucket.day, deps.config.timeZone);
    result.reclustered += await rebuildDayStorylines(
      {
        db: deps.db,
        config: {
          enabled: deps.config.enabled && deps.config.storyline.enabled,
          rules: deps.config.storyline,
          timeZone: deps.config.timeZone,
        },
        ...(deps.log ? { log: deps.log } : {}),
      },
      { from: bounds.from, to: bounds.to, language: bucket.language },
    );
  }

  return result;
}

/** Re-derive one row's tokens — both derivations, one version — touching
 * nothing else about it. */
async function retokenize(
  deps: GroupingDeps,
  article: StoredArticle,
): Promise<void> {
  await recordGrouping(deps.db, {
    articleId: article.id,
    titleTokens: headlineTokens(article.title),
    storyTokens: storyTokens(article.title, article.description),
    tokensVersion: TOKENIZER_VERSION,
    groupId: null, // null means "leave the grouping alone", not "ungroup"
  });
}

/**
 * One article's bridge evidence, acted on: merge every OTHER group its
 * matches span into the best match's group — its own included, so a pole
 * that formed apart from its story rejoins it. Returns groups merged away.
 */
async function mergeBridges(
  deps: GroupingDeps,
  article: StoredArticle,
): Promise<number> {
  const tokens = headlineTokens(article.title);
  if (tokens.length < 2) return 0;

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
  const matches = rankedMatches(
    { tokens, figures: headlineFigures(article.title) },
    candidates,
    { threshold: deps.config.threshold },
  );
  if (matches.length === 0) return 0;

  // The article's CURRENT group — pass 2 or an earlier merge may have moved it
  // since the window was read.
  const current = await deps.db
    .selectFrom("articles")
    .select("group_id")
    .where("id", "=", article.id)
    .executeTakeFirst();
  if (!current) return 0;

  const winner = matches[0]!.groupId;
  let merged = 0;
  const losers = new Set<string>();
  for (const match of matches) losers.add(match.groupId);
  losers.add(current.group_id);
  losers.delete(winner);

  for (const loser of losers) {
    if (merged >= 10) break;
    const outcome = await mergeGroups(deps.db, { winnerGroupId: winner, loserGroupId: loser });
    if (outcome.merged) merged += 1;
  }
  return merged;
}

/** Midnight, `days` local days ago (§10.1's calendar, not a rolling 24h). */
function windowStart(days: number, timeZone: string, now: Date): Date {
  const start = new Date(now.getTime() - Math.max(0, days - 1) * 86_400_000);
  return zonedDayBounds(zonedDayKey(start, timeZone), timeZone).from;
}
