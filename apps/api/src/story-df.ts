import type { Kysely } from "kysely";
import {
  readStoryDf,
  recordStoryDf,
  type Database,
  type StoryDfContribution,
  type TrailingCorpus,
} from "@zammy/storage";
import { zonedDayKey } from "./app-day.js";

/**
 * The trailing corpus, in app terms (ADR-0011): which days the window covers,
 * and what "rare" reads as against them.
 *
 * Storage counts and this file decides what to count over. The split matters
 * because the window is a rolling span of APP_TIMEZONE days — Intl lives here,
 * not in the storage layer (§10.1) — and because the linker (S3) should be
 * handed a corpus, not a query.
 */

export interface StoryDfConfig {
  /** STORYLINE_DF_WINDOW_DAYS — how many days back rarity is measured. */
  windowDays: number;
  /** The calendar the days are counted in (§10.1's rule, not UTC). */
  timeZone: string;
}

/**
 * The window's inclusive day keys, ending on `now`'s own day.
 *
 * The current day is INCLUDED, unlike the wordcloud baseline, which excludes
 * the window it scores (§10.3). The two exclusions answer different fears: the
 * baseline suppresses a term using its own history, so counting the live
 * window would let a term suppress itself. Here the corpus is a denominator —
 * an arriving group's own day is part of "what is normal right now", and
 * excluding it would measure a story's name against a fortnight that has not
 * heard of it yet, which is exactly the blindness the trailing corpus exists
 * to remove.
 */
export function trailingWindow(
  now: Date,
  config: StoryDfConfig,
): { from: string; to: string } {
  const to = zonedDayKey(now, config.timeZone);
  const from = zonedDayKey(
    new Date(now.getTime() - Math.max(0, config.windowDays - 1) * 86_400_000),
    config.timeZone,
  );
  return { from, to };
}

/** The day a `published` instant is counted under. */
export function storyDfDay(published: Date, config: Pick<StoryDfConfig, "timeZone">): string {
  return zonedDayKey(published, config.timeZone);
}

export interface StoryDfDeps {
  db: Kysely<Database>;
  config: StoryDfConfig;
  log?: { warn: (obj: object, msg: string) => void };
}

/**
 * The trailing corpus for one language, as the linker will ask for it: the df
 * of the tokens it cares about and the size to divide them by.
 *
 * Language-scoped, like every corpus in this codebase: rarity within English
 * says nothing about a Spanish token, and the grouping layer above already
 * buckets by language.
 */
export async function readTrailingCorpus(
  deps: StoryDfDeps,
  input: { language: string | null; now: Date; tokens: readonly string[] },
): Promise<TrailingCorpus> {
  const window = trailingWindow(input.now, deps.config);
  return readStoryDf(deps.db, {
    language: input.language,
    from: window.from,
    to: window.to,
    tokens: input.tokens,
  });
}

/**
 * Fold newly-stored articles into the window's counters. Called on the ingest
 * path once per batch, from `groupCreatedArticles` — the same place
 * `story_tokens` are written, because the counters are an aggregate OF those
 * tokens and a write that produced one without the other would be a
 * disagreement no reader could detect.
 *
 * Never throws, for the reason grouping never throws: an ingest triggered by a
 * reader's search must not fail because a derived counter did. A lost
 * contribution costs one article's worth of df in a fortnight-wide corpus and
 * is repaired wholesale by `rebuildStoryDf`.
 */
export async function recordStoryDfForArticles(
  // Only the calendar, not the window: what a day BUCKET is does not depend on
  // how many buckets the linker later reads, and demanding the window here
  // would make every write path carry a number it has no use for.
  deps: {
    db: Kysely<Database>;
    config: Pick<StoryDfConfig, "timeZone">;
    log?: { warn: (obj: object, msg: string) => void };
  },
  articles: readonly { published: Date; language: string | null; storyTokens: readonly string[] }[],
): Promise<void> {
  if (articles.length === 0) return;
  const contributions: StoryDfContribution[] = articles.map((article) => ({
    day: storyDfDay(article.published, deps.config),
    language: article.language,
    tokens: article.storyTokens,
  }));
  try {
    await recordStoryDf(deps.db, contributions);
  } catch (error) {
    deps.log?.warn(
      { err: error, articles: contributions.length },
      "trailing-corpus df not recorded for this batch; rebuild repairs it",
    );
  }
}
