import type { Kysely } from "kysely";
import {
  attachGroup,
  mergeGroups,
  readGroupCandidates,
  readGroupStorylines,
  recordGrouping,
  refreshStoryline,
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
import { mergeCollidingLabels } from "./storyline-label-merge-trigger.js";
import { reofferJoinedGroups } from "./storyline-rejoin-trigger.js";
import type { LabelMergeRules } from "./storyline-label-merge.js";
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
    /**
     * The collision-triggered label merge (`storyline-label-merge-trigger.ts`),
     * run at the end of the label tail on the labels it just wrote. Absent —
     * or present with `threshold: 0` — labels are written and collisions wait
     * for the nightly pass, which is the pre-trigger behaviour.
     */
    labelMerge?: { rules: LabelMergeRules; threshold: number };
    /**
     * Re-offer a group to the linker when an arriving article JOINS it
     * (`storyline-rejoin-trigger.ts`). Absent — or false — is the pre-trigger
     * behaviour: only seeded groups are linked, and an enlarged group waits for
     * the nightly sweep.
     *
     * Off by default in `wiring.ts`, and that is a rollout decision rather than a
     * doubt about the mechanism — see the knob's own note in
     * `packages/config/src/index.ts`.
     */
    reofferJoinedGroups?: boolean;
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
   * walk away. A caller that needs to know when it finished hands in something
   * that keeps the promise.
   *
   * Two do. A test needs it for the obvious reason — a dropped tail is a
   * dangling assertion. The §10.1 breadth sample needs it for a subtler one: no
   * reader is waiting on that job, and the cloud it feeds cannot see an
   * unlabelled storyline at all, so returning before the names exist publishes
   * an emptied cloud and caches it (`processSampleJob`). Dropping this promise
   * is a latency decision, and it is only correct where there is latency to
   * protect.
   *
   * What the tail carries grew: it now also runs the collision-triggered label
   * merge (`storyline-label-merge-trigger.ts`), up to four rounds, each able to
   * relabel a survivor with a model call. A caller that keeps this promise
   * therefore waits for merge convergence, not just for names — which is the
   * cost `processSampleJob` accepts and documents at its await.
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
/**
 * What a batch of created articles is FOR, when it is for anything.
 *
 * Empty on every discovery-plane path, which is every path that existed before
 * G5: an article a reader's search or the breadth sample turned up belongs
 * wherever the linker judges it belongs, and nothing about the fetch says
 * otherwise. The deepening plane is the one caller that knows in advance.
 */
export interface GroupingIntent {
  /**
   * The storyline this batch was fetched for (ADR-0019's deepening plane).
   * Present means: attach what these articles seed to this arc, and offer
   * nothing to the linker.
   */
  attachTo?: string;
}

export function groupingDepsFor(
  deps: {
    db: Kysely<Database>;
    config: { grouping: GroupingDeps["config"] };
    labeler?: Omit<LabelerDeps, "db">;
    metrics?: Metrics;
    log?: { warn: (obj: object, msg: string) => void };
  },
  /**
   * The one field a CALLER decides rather than the service wiring: whether it
   * keeps the label tail. Passed here rather than spread over the result so the
   * mapping above stays the only place grouping deps are assembled.
   */
  labelTail?: (task: Promise<void>) => void,
): GroupingDeps {
  return {
    db: deps.db,
    config: deps.config.grouping,
    ...(deps.labeler ? { labeler: deps.labeler } : {}),
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    ...(labelTail ? { labelTail } : {}),
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
  intent: GroupingIntent = {},
): Promise<number> {
  if (created.length === 0) return 0;

  let grouped = 0;
  const seeded: CreatedArticle[] = [];
  /**
   * Groups an article JOINED, for the re-offer trigger below. A group id rather
   * than an article: what changed is the group's majority vocabulary, and that
   * is one fact however many of this batch's articles landed in it.
   */
  const joined: string[] = [];
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
      } else {
        const joinedGroup = await groupArticle(deps, article);
        if (joinedGroup !== null) {
          grouped += 1;
          joined.push(joinedGroup);
        } else seeded.push(article);
      }
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

  // The linker (ADR-0011), INLINE on the seeded groups only. The groups an
  // article merely joined are re-offered on the tail below instead, and the
  // split is about latency rather than about who has a decision left to make:
  //
  //   - a SEEDED group has no storyline at all until the linker gives it one,
  //     and the timeline pages over `storyline_days` — so a birth deferred to a
  //     dropped promise is a card a reader may not see. It stays on the clock.
  //   - a JOINED group inherited its group's storylines, so its membership is
  //     already settled and nothing a reader is waiting on depends on the
  //     answer. What it did NOT inherit is a re-judgement: a group speaks
  //     through the MAJORITY of its members' tokens, so an arrival can widen the
  //     profile the linker last saw, and this path used to be where that widened
  //     profile stopped being asked about (`storyline-rejoin-trigger.ts`).
  //
  // Membership and derivations part company here, and the distinction cost
  // months: a joining article leaves every storyline holding that group with
  // stale day slots and a stale profile, which `groupArticle` re-derives on the
  // spot. That is not deferred to the tail, because a wrong day slot is a wrong
  // lead article on a card a reader is looking at right now.
  //
  // It runs after the df maintenance above deliberately: the arriving group's
  // own tokens belong in the corpus its rarity is measured against, or a story
  // breaking across a dozen simultaneous groups would read each of them as
  // unprecedented.
  //
  // MEASURED, and it is charged to the §6.3 sync-fill deadline: linking one
  // upstream page's worth of seeded groups costs ~190ms — a birth, a corpus
  // read, a candidate scan and an attach per group, all round trips. Against
  // the 1200ms default that is ~16%, and it is the reason a cold search fits
  // fewer upstream calls than it did before the cutover. Worth revisiting if
  // the deadline starts binding: nothing here is on a reader's critical path
  // except by being on the same clock.
  // ATTACHMENT BY PROVENANCE, and the branch that keeps label demand flat
  // (plan §G5, DESIGN-DISCOVERY-AND-DEEPENING §3d).
  //
  // These articles were fetched FOR one arc. They do not go to the linker, and
  // the difference is not a shortcut — it is the constraint the design states in
  // as many words: **deepening-plane articles never form new storylines.**
  // Google News answers one label with up to 100 items; left on the ordinary
  // path each seeded group is offered to the linker, a seed that attaches to
  // nothing becomes a PROVISIONAL storyline, and a provisional storyline that
  // later attracts a second group is promoted and demands a model label. One
  // click could mint dozens of arcs nobody asked for.
  //
  // Two independent reasons that survives its most-quoted justification going
  // out of date. The quota one moved — the labeler is `gemma-4-26b-a4b-it` at a
  // published 30 requests per MINUTE (`gemini.ts`), so the binding limit is
  // pace, not a daily budget, and a burst of labels is a latency problem for the
  // reader who clicked rather than a starved day. The two that do not move:
  //
  //  - **The endogenous loop.** ADR-0019 argues it on its own terms. If deepening
  //    articles form arcs, an arc that reaches the board once is fetched, gains
  //    coverage, ranks higher, is fetched more, with nothing damping it.
  //  - **Arc inventory.** Dozens of provisional storylines per click is a data
  //    problem whatever labelling costs — the cloud reads from that table, the
  //    linker scans it for candidates, and the merge pass has to judge them.
  //
  // Only SEEDED groups are attached. An article that JOINED an existing group
  // inherited that group's storylines and already has a home, and attaching its
  // group here would drag every OTHER article in it into this arc on the
  // strength of one keyword match — which is precisely the judgement the linker
  // exists to make and this path is refusing to make. A seeded group has no such
  // judgement to override: `linkSeededGroups` would have given it a storyline of
  // its own, so nothing is left orphaned by taking this branch instead.
  if (intent.attachTo !== undefined) {
    for (const article of seeded) {
      try {
        // The seed's group id IS its article id — the BEFORE INSERT trigger
        // seeds `group_id = id` for a group of one (§14.3) — but it is read back
        // rather than assumed, because `mergeBridgedGroups` can have moved it
        // between the insert and here.
        const row = await deps.db
          .selectFrom("articles")
          .select("group_id")
          .where("id", "=", article.id)
          .executeTakeFirst();
        if (!row) continue;
        await attachGroup(deps.db, {
          storylineId: intent.attachTo,
          groupId: row.group_id,
          timeZone: deps.config.timeZone,
        });
      } catch (error) {
        // Same contract as the grouping loop above: the articles are stored and
        // paged, and a failed attach costs one card in one arc's timeline.
        deps.log?.warn(
          { err: error, articleId: article.id, storylineId: intent.attachTo },
          "deepening attach failed for one article; it stays outside the arc",
        );
      }
    }
    return grouped;
  }

  if (deps.config.linker) {
    const outcomes = await linkSeededGroups(
      {
        db: deps.db,
        config: deps.config.linker,
        ...(deps.log ? { log: deps.log } : {}),
      },
      await linkableGroups(deps, seeded),
    );

    // THE TAIL: the membership-change re-offer, the promotion and merge
    // triggers, and the collision-triggered label merge. The one thing none of
    // them may be is awaited — a label averages ~8s against a 20s timeout, and
    // the linker above runs inside the §6.3 deadline a reader is waiting on.
    // Every step here never throws, which is what makes starting-and-dropping
    // the whole chain safe.
    //
    // What the tail costs a READER is not nothing, and it is not latency: the
    // ingest response caches on `state === "complete"` (`timeline-service.ts`),
    // so anything that lands here is invisible to `meta.ingest` for the TTL.
    // Measured precedent, `trending-service.ts`: 61 labels landed in the ~3
    // minutes after a cloud of 3 was cached. A retroactive attach is the mildest
    // version of that — the group already renders in its own slot and what it
    // gains is a second arc — but it is the same cost, and it is the price of
    // keeping this off the deadline.
    const reoffer = deps.config.reofferJoinedGroups === true && joined.length > 0;
    if (reoffer || (deps.labeler && outcomes.length > 0)) {
      const labeler = deps.labeler;
      const labelMerge = deps.config.labelMerge;
      const linker = deps.config.linker;
      const tail = (async () => {
        // The re-offer BEFORE the labels, so an arc a re-offer grows or promotes
        // is named in the same tail rather than waiting for the nightly drift
        // pass. Its outcomes join the seeded ones and travel the same path — a
        // retroactive promotion is the same promotion whichever offer caused it.
        const rejoined = reoffer
          ? await reofferJoinedGroups(
              { db: deps.db, config: linker, ...(deps.log ? { log: deps.log } : {}) },
              joined,
            )
          : [];
        const linked = outcomes.length > 0 ? [...outcomes, ...rejoined] : rejoined;
        if (!labeler || linked.length === 0) return;

        const labelled = await labelLinkedStorylines(
          {
            db: deps.db,
            labeler,
            // Deferred formations are resolved in this tail, and performing the
            // merge the linker withheld recomputes day slots.
            formations: { timeZone: linker.timeZone },
            ...(deps.log ? { log: deps.log } : {}),
          },
          linked,
        );

        // The collision-triggered merge, on the names this batch just wrote —
        // the one moment a label collision can come into being. Behind the
        // same dropped promise as the labelling, and safe there for the same
        // reason: it never throws, and the nightly pass is its retry.
        if (!labelMerge || labelMerge.threshold <= 0 || labelled.length === 0) return;
        await mergeCollidingLabels(
          {
            db: deps.db,
            rules: labelMerge.rules,
            threshold: labelMerge.threshold,
            timeZone: deps.config.timeZone,
            labeler,
            ...(deps.log ? { log: deps.log } : {}),
          },
          labelled,
        );
      })();
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

  if (chosen) {
    await mergeBridgedGroups(deps, chosen.groupId, matches);

    // Both storyline derivations are over member ARTICLES, and this arrival
    // changed which articles a member group holds without changing which
    // GROUPS any storyline holds — so nothing keyed on `storyline_groups` can
    // see it. There is no attach, no merge and no formation on this path: the
    // linker is offered SEEDED groups only, because a joining article
    // inherited its group's storylines and has no decision left to make. It
    // does have a derivation left to make, and that is what this is.
    //
    // Reader-visible, not bookkeeping. A day slot IS its day's earliest
    // article, so a piece published earlier than the day's lead joining the
    // group has to move both the lead and the slot's position on the §7.3
    // keyset axis; without this the slot kept yesterday's lead and sat at the
    // wrong place in the page. `refreshProfileTokens` goes stale the same way,
    // which quietly changes which groups the storyline can attract next.
    //
    // After `mergeBridgedGroups`, so a loser's storylines are read as the
    // winner's — `absorbMergedGroup` has already re-pointed them, and
    // re-deriving twice is idempotent. Not the whole of `refreshStoryline`'s
    // case: the two neighbouring gaps are named on that function.
    for (const storylineId of await readGroupStorylines(deps.db, chosen.groupId)) {
      await refreshStoryline(deps.db, {
        storylineId,
        timeZone: deps.config.timeZone,
      });
    }
  }

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
