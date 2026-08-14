import type { Kysely } from "kysely";
import {
  mergeGroups,
  readGroupCandidates,
  recordGrouping,
  type CreatedArticle,
  type Database,
} from "@zammy/storage";
import { zonedDayBounds, zonedDayKey } from "./app-day.js";
import {
  headlineFigures,
  headlineTokens,
  rankedMatches,
  TOKENIZER_VERSION,
} from "./grouping.js";
import { storyTokens } from "./storyline.js";
import { recordStoryDfForArticles } from "./story-df.js";
import {
  linkSeededGroups,
  type LinkableGroup,
  type LinkerConfig,
} from "./storyline-linker.js";
import { labelLinkedStorylines, type LabelerDeps } from "./storyline-label-service.js";
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
    /**
     * The storyline layer (ADR-0011), switchable independently of grouping —
     * off leaves articles grouped and storyline-less, which the read path
     * renders as plain slots.
     */
    linker: LinkerConfig;
  };
  /**
   * The labeler, for the promotion and merge triggers (ADR-0011). Absent means
   * no live labelling — the nightly pass and the CLI still name what the linker
   * built, so this being unset costs freshness rather than labels.
   */
  labeler?: Omit<LabelerDeps, "db">;
  /**
   * Where the label tail goes. Labelling runs AFTER the batch, off the §6.3
   * sync-fill deadline a reader is waiting on, so the default is to start it and
   * walk away. A caller that needs to know when it finished — a test, or a
   * script that exits — hands in something that keeps the promise.
   */
  labelTail?: (task: Promise<void>) => void;
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
  labeler?: Omit<LabelerDeps, "db">;
  metrics?: Metrics;
  log?: { warn: (obj: object, msg: string) => void };
}): GroupingDeps {
  return {
    db: deps.db,
    config: deps.config.grouping,
    ...(deps.labeler ? { labeler: deps.labeler } : {}),
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
 * How many groups a single arrival may merge into the one it joined.
 *
 * Merging happens inside the request that triggered the ingest, so this
 * bounds write amplification rather than correctness: ten is far above what
 * real coverage produces (the largest live adoption case pulled two, and the
 * ADR-0009 sweep saw no arrival bridge more than a handful), and a day
 * pathological enough to exceed it gets a slightly worse grouping, never a
 * wrong row.
 */
const MERGE_LIMIT = 10;

/**
 * Group each newly-created article, and return how many joined an existing
 * group.
 *
 * With grouping DISABLED this still runs, and must: it writes the article's
 * tokens and births its storyline, and the timeline pages over storylines now
 * (migration 0012). Skipping it outright — which is what the flag used to do —
 * leaves an article in no storyline, and an article in no storyline is in no
 * timeline. The old model survived the same flag because a database trigger
 * seeded identity on INSERT whatever the app thought; this is that trigger's
 * job, moved up a layer with the storyline itself.
 *
 * So `enabled: false` means what it always meant — nothing is MATCHED, every
 * article is its own group and its own slot — rather than "nothing happens".
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
  if (created.length === 0) return 0;

  let grouped = 0;
  const seeded: CreatedArticle[] = [];
  const counted: {
    published: Date;
    language: string | null;
    storyTokens: readonly string[];
  }[] = [];
  for (const article of created) {
    try {
      if (!deps.config.enabled) {
        // Tokens without a verdict: the article stays the group of one the
        // insert made it, and is offered to the linker as one.
        await recordGrouping(deps.db, {
          articleId: article.id,
          titleTokens: headlineTokens(article.title),
          storyTokens: storyTokens(article.title, article.description),
          tokensVersion: TOKENIZER_VERSION,
          groupId: null,
        });
        seeded.push(article);
      } else if ((await groupArticle(deps, article)) !== null) grouped += 1;
      else seeded.push(article);
      // Only after the decision was recorded: `groupArticle` is what writes
      // `story_tokens`, and counting an article whose tokens never landed
      // would put the aggregate and its source out of step in the one
      // direction a rebuild cannot explain.
      counted.push({
        published: article.published,
        language: article.language,
        // Re-derived rather than threaded out of `groupArticle`: the same pure
        // function over the same strings gives the same list by construction,
        // and it costs a MEASURED 22.9µs per article against the several DB
        // round-trips the decision already spends — cheaper than widening a
        // decision function's return type to carry a counter's input.
        storyTokens: storyTokens(article.title, article.description),
      });
    } catch (error) {
      deps.log?.warn(
        { err: error, articleId: article.id },
        "grouping failed for one article; it stays a group of one",
      );
    }
  }

  // The trailing corpus the v2 linker measures rarity against (ADR-0011),
  // maintained here because this is where `story_tokens` are written. One
  // batched statement pair, and unconditional on the storyline flag: the
  // window must be WARM when the linker starts asking, and a fortnight is
  // exactly how long a cold one takes to become useful.
  await recordStoryDfForArticles(
    { db: deps.db, config: { timeZone: deps.config.timeZone }, ...(deps.log ? { log: deps.log } : {}) },
    counted,
  );

  // The linker (ADR-0011), on the seeded groups only — an article that
  // JOINED a group inherited that group's storylines, so only the ones that
  // SEEDED a group have a decision left to make. It runs after the df
  // maintenance above deliberately: the arriving group's own tokens belong in
  // the corpus its rarity is measured against, or a story breaking across a
  // dozen simultaneous groups would read each of them as unprecedented.
  //
  // MEASURED, and it is charged to the §6.3 sync-fill deadline: linking one
  // upstream page's worth of seeded groups costs ~190ms — a birth, a corpus
  // read, a candidate scan and an attach per group, all round trips. Against
  // the 1200ms default that is ~16%, and it is the reason a cold search fits
  // fewer upstream calls than it did before the cutover. Worth revisiting if
  // the deadline starts binding: nothing here is on a reader's critical path
  // except by being on the same clock.
  if (deps.config.linker) {
    const outcomes = await linkSeededGroups(
      {
        db: deps.db,
        config: deps.config.linker,
        ...(deps.log ? { log: deps.log } : {}),
      },
      await linkableGroups(deps, seeded),
    );

    // The promotion and merge triggers (ADR-0011), and the one thing they must
    // not be is awaited: a label averages ~8s against a 20s timeout, and the
    // linker above runs inside the §6.3 deadline a reader is waiting on. The
    // tail never throws, which is what makes starting-and-dropping it safe.
    if (deps.labeler && outcomes.length > 0) {
      const tail = labelLinkedStorylines(
        {
          db: deps.db,
          labeler: deps.labeler,
          ...(deps.log ? { log: deps.log } : {}),
        },
        outcomes,
      );
      if (deps.labelTail) deps.labelTail(tail);
      else void tail;
    }
  }

  deps.metrics?.articlesGrouped(grouped);
  return grouped;
}

/**
 * The seeded groups, as the linker needs to see them: every member's story
 * tokens, so the group speaks through its MAJORITY vocabulary rather than any
 * one member's. Read back from storage rather than assembled from the batch —
 * a group seeded by this batch may already have been joined by a later article
 * in the same batch, and linking on the seed article alone would compare the
 * story against one outlet's wording of it.
 */
async function linkableGroups(
  deps: GroupingDeps,
  seeded: readonly CreatedArticle[],
): Promise<LinkableGroup[]> {
  if (!deps.config.linker?.enabled || seeded.length === 0) return [];
  const rows = await deps.db
    .selectFrom("articles")
    .select(["group_id", "story_tokens", "language", "published"])
    .where(
      "group_id",
      "in",
      seeded.map((article) => article.id),
    )
    .execute();

  const byGroup = new Map<string, LinkableGroup & { memberTokens: string[][] }>();
  for (const row of rows) {
    const existing = byGroup.get(row.group_id);
    if (existing) {
      existing.memberTokens.push(row.story_tokens);
      if (row.published < existing.published) existing.published = row.published;
      continue;
    }
    byGroup.set(row.group_id, {
      groupId: row.group_id,
      memberTokens: [row.story_tokens],
      language: row.language,
      published: row.published,
    });
  }
  return [...byGroup.values()];
}

/**
 * Decide one article's group and write it. Exported because the maintenance
 * pass (`regroup`) re-runs exactly this for articles that are still a group of
 * one — a second implementation of the decision would be a second set of rules
 * to keep in step.
 */
export async function groupArticle(
  deps: GroupingDeps,
  article: CreatedArticle,
): Promise<string | null> {
  const tokens = headlineTokens(article.title);
  const story = storyTokens(article.title, article.description);

  // A headline that reduces to fewer than two tokens can never clear the
  // shared-token floor, in either direction. Recording the tokens anyway keeps
  // one rule — "an article's tokens are what its headline says" — rather than
  // a column that is sometimes populated and sometimes not.
  if (tokens.length < 2) {
    await recordGrouping(deps.db, {
      articleId: article.id,
      titleTokens: tokens,
      storyTokens: story,
      tokensVersion: TOKENIZER_VERSION,
      groupId: null,
    });
    return null;
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
    storyTokens: story,
    tokensVersion: TOKENIZER_VERSION,
    groupId: chosen?.groupId ?? null,
  });

  if (chosen) await mergeBridgedGroups(deps, chosen.groupId, matches);

  // The group joined, so a caller re-running this over stored rows can tell a
  // real move from a verdict that merely confirmed where the article already
  // is. `null` also tells the batch layer this article SEEDED a group, which
  // is what queues it for the storyline attach decision (ADR-0009).
  return chosen?.groupId ?? null;
}

/**
 * Merge every OTHER group this article matched into the group it joined.
 *
 * Grouping evaluates an article once, at creation, so one story's coverage
 * can form two poles that drift apart on wording ("to leave" / "to step
 * down") — and once both poles had members, nothing could reunite them:
 * ADR-0005 allowed only singletons to move, fearing transitive chaining. The
 * newcomer whose matches span BOTH groups is direct evidence they are one
 * story — both sides cleared the full grouping bar against the same headline,
 * shared-token floor and figures veto included — and ADR-0009 measured what
 * acting on it does: 66 merges over a 31-day live corpus, every sampled one
 * genuine syndication, largest healed split the Leavitt departure's 5+7.
 *
 * Singleton matches ride the same path: merging a group of one IS the old
 * adoption, one mechanism instead of two. Merged rows keep their stored
 * tokens and version — a stale row must not look fresh, and the regroup
 * command remains the one place staleness is repaired.
 */
async function mergeBridgedGroups(
  deps: GroupingDeps,
  groupId: string,
  matches: readonly { id: string; groupId: string }[],
): Promise<void> {
  let merged = 0;
  const seen = new Set<string>([groupId]);
  for (const match of matches) {
    if (merged >= MERGE_LIMIT) break;
    if (seen.has(match.groupId)) continue;
    seen.add(match.groupId);

    const outcome = await mergeGroups(deps.db, {
      winnerGroupId: groupId,
      loserGroupId: match.groupId,
      timeZone: deps.config.timeZone,
    });
    if (outcome.merged) merged += 1;
  }
}
