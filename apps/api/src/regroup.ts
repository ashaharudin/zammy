import type { Kysely } from "kysely";
import {
  countStaleTokenArticles,
  readStaleTokenArticles,
  recordGrouping,
  type Database,
  type StoredArticle,
} from "@zammy/storage";
import { zonedDayBounds, zonedDayKey } from "./app-day.js";
import { groupArticle, type GroupingDeps } from "./grouping-service.js";
import { headlineTokens, TOKENIZER_VERSION } from "./grouping.js";

/**
 * Bring stored grouping state up to the current rules (ADR-0005).
 *
 * Two passes, in this order and for a reason:
 *
 *  1. **re-derive tokens** for every row behind `TOKENIZER_VERSION`, so
 *     candidates stop being compared against the vocabulary of an older
 *     tokenizer;
 *  2. **re-run the grouping decision** for articles that are still a group of
 *     one, which can only be worth doing once (1) has given everything the
 *     same vocabulary.
 *
 * Pass 2 is what §14.3 declined to do continuously, and the reason stands: it
 * moves rows under live cursors, because an article folding into a group takes
 * that group's position. That is why this is an operator command over a bounded
 * window rather than a background chore — the blast radius is chosen
 * deliberately, once, by someone who knows what they are re-deriving.
 *
 * Never regroups an article that already has company. Only groups of one move
 * (`recordGrouping` enforces it in SQL), so the pass can add members to groups
 * and can never take one apart.
 */

export interface RegroupOptions {
  /** How far back to go. The blast radius, chosen by the caller. */
  days: number;
  /** Skip pass 2 — re-derive tokens and change no groupings at all. */
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
}

export async function regroup(
  deps: GroupingDeps & { db: Kysely<Database> },
  options: RegroupOptions,
): Promise<RegroupResult> {
  const batchSize = options.batchSize ?? 500;
  const from = windowStart(options.days, deps.config.timeZone, options.now?.() ?? new Date());

  const result: RegroupResult = {
    stale: await countStaleTokenArticles(deps.db, { version: TOKENIZER_VERSION, from }),
    retokenized: 0,
    regrouped: 0,
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
      "regroup: re-deriving headline tokens",
    );
  }

  if (options.tokensOnly) return result;

  // Pass 2 walks the window oldest-first, which reproduces arrival order and
  // therefore the grouping the same articles would have received had they
  // arrived under today's rules.
  for (const article of await readStaleTokenArticles(deps.db, {
    // Everything is at the current version now, so ask for the NEXT one to get
    // the whole window back rather than re-querying by a different predicate.
    version: TOKENIZER_VERSION + 1,
    from,
    limit: Number.MAX_SAFE_INTEGER,
  })) {
    if (!article.isGroupOfOne) continue;
    // Count moves, not verdicts: an article whose best match is inside its own
    // group has not been regrouped, it has been confirmed.
    const joined = await groupArticle(deps, article);
    if (joined !== null && joined !== article.groupId) result.regrouped += 1;
  }

  return result;
}

/** Re-derive one row's tokens, touching nothing else about it. */
async function retokenize(
  deps: GroupingDeps,
  article: StoredArticle,
): Promise<void> {
  await recordGrouping(deps.db, {
    articleId: article.id,
    titleTokens: headlineTokens(article.title),
    tokensVersion: TOKENIZER_VERSION,
    groupId: null, // null means "leave the grouping alone", not "ungroup"
  });
}

/** Midnight, `days` local days ago (§10.1's calendar, not a rolling 24h). */
function windowStart(days: number, timeZone: string, now: Date): Date {
  const start = new Date(now.getTime() - Math.max(0, days - 1) * 86_400_000);
  return zonedDayBounds(zonedDayKey(start, timeZone), timeZone).from;
}
