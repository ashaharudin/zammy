import type { Kysely } from "kysely";
import type { Redis } from "ioredis";
import type { NewsClient } from "@zammy/news-client";
import {
  ingestSightings,
  readStoryline,
  readStorylineCoverage,
  readStorylineLanguage,
  recordStorylineCoverage,
  resolveStoryline,
  upsertTopic,
  type Database,
} from "@zammy/storage";
import { canonicalKeywords, fingerprintOf, WINDOW_SNAP_MS } from "./canonical.js";
import { deepeningQuery } from "./cloud-query.js";
import { planHorizon, subtractCoverage, type Span } from "./coverage-gaps.js";
import { logIngestOutcome, logUpstreamFetch } from "./observations.js";
import { freshnessTtlMs } from "./page-cache.js";
import { refreshLockKey, release, tryAcquire } from "./single-flight.js";
import type { DeepenJob, IngestQueue } from "./ingest-queue.js";
import {
  groupCreatedArticles,
  groupingDepsFor,
  type GroupingDeps,
} from "./grouping-service.js";

/**
 * THE DEEPENING PLANE (ADR-0019, plan §G5): planning and performing a fetch for
 * one ARC, against that arc's own coverage rows and its own provider.
 *
 * Planner and consumer in one file, unlike the topic path, and for the reason
 * ADR-0019 gives: the two halves are only comprehensible together. The gate the
 * planner applies is re-applied by the consumer against the arc as it stands at
 * FETCH time, the span the planner snapped is re-clamped there against the live
 * horizon, and both write `storyline_coverage` and nothing else. Splitting them
 * would put a module edge through one argument.
 *
 * Nothing here touches the discovery provider or `topic_coverage`. That is the
 * whole of ADR-0019's separation: "providers stop sharing a plan", so the
 * deepening provider records only the spans it actually walked for this arc,
 * and no provider's completion can stand for another's.
 */
export interface StorylineDeepeningDeps {
  db: Kysely<Database>;
  redis: Redis;
  /**
   * The DEEPENING plane's provider (ADR-0019), when one is configured.
   *
   * Absent is the repo default — not production's, which runs with
   * `GOOGLE_NEWS_ENABLED=true` (observed in its boot logs 2026-08-29, and in
   * every trace's environment since). With the flag false,
   * `createGoogleNewsClient` refuses to build, and with no client here
   * `queueStorylineDeepening` answers `unavailable` and spends nothing. So this whole path is behind the same flag G4 put the adapter
   * behind, and turning the flag on is what turns it on.
   *
   * A separate field rather than a second entry in a registry, and separate from
   * the discovery client rather than folded into the composite, because the two
   * are planned against DIFFERENT COVERAGE — `topic_coverage` for the one,
   * `storyline_coverage` for the other — and ADR-0019 is explicit that providers
   * stop sharing a plan. The composite exists to fan ONE plan out to several
   * providers; there is no one plan here to fan.
   *
   * Typed as the narrow `NewsClient` rather than `CurrentsClient`: this path
   * never calls `latestNews`, and nothing here should be able to.
   */
  deepening?: NewsClient;
  /** Only `enqueueDeepen`: one click, one deepening job, nothing else. */
  queue: Pick<IngestQueue, "enqueueDeepen">;
  config: {
    lookbackDays: number;
    /** §14.3's grouping, which here runs in `attachTo` mode and forms nothing. */
    grouping: GroupingDeps["config"];
  };
  now: () => Date;
  /**
   * The labeler the write path's promotion and merge triggers fire (ADR-0011).
   * Absent means no live labelling: `server.ts` builds it when a Gemini key is
   * configured, and the bigram fallback carries it when one is not.
   */
  labeler?: GroupingDeps["labeler"];
  log?: {
    warn: (obj: object, msg: string) => void;
    info?: (obj: object, msg: string) => void;
  };
}

/**
 * What opening a storyline queued on the DEEPENING plane, as the route reports
 * it (ADR-0019, plan §G5).
 *
 * A second union beside `StorylineRefreshOutcome` rather than more cases on it,
 * because the two answer about different subjects and different providers: the
 * refresh plans a TOPIC against `topic_coverage` and the discovery provider,
 * this plans an ARC against `storyline_coverage` and the deepening provider.
 * Merging them would need a discriminant on every case to say which coverage a
 * `fresh` is about.
 */
export type StorylineDeepenOutcome =
  /** No such storyline, alias chain followed. */
  | { status: "unknown" }
  /** No deepening provider configured. The default; nothing is spent. */
  | { status: "unavailable"; storylineId: string }
  /**
   * The confidence gate refused (`deepeningQuery`). An arc whose label shares
   * nothing with its own coverage is one we cannot say the subject of, and on
   * this plane a wrong subject is not a wasted call — it is an attachment.
   */
  | { status: "ungrounded"; storylineId: string }
  /** This provider's coverage of the arc already reaches the present. */
  | { status: "fresh"; storylineId: string; keywords: string }
  | { status: "queued"; storylineId: string; keywords: string; job: DeepenJob };

/**
 * Opening a storyline queues one deepening fetch for the arc itself
 * (plan §G5, ADR-0019).
 *
 * This is the repoint ADR-0017's refresh owed. That refresh laundered an arc
 * through a synthetic TOPIC — two words off the label, canonicalized, planned
 * against `topic_coverage` — and it stays exactly where it is, because a
 * Currents fetch against a topic really does cover that topic's span and
 * recording it there is honest. What it never was is a claim about the ARC.
 * This is, and it is planned against the arc's own coverage rows.
 *
 * Three things differ from the topic path, and each is a decision the plan
 * names:
 *
 *  - **The query is the whole label, not its grounded pair.** `cloudQuery`
 *    shortens a label because Currents ANDs terms against body text we never
 *    receive; the deepening provider does not, and the full label measurably
 *    out-performs the pair there — 100 items over 63 domains against 92 over 55,
 *    probed live 2026-08-27. `deepeningQuery` carries the argument.
 *  - **The grounding becomes a gate rather than a rewriter.** An ungrounded
 *    label spends nothing at all. On the topic path an ungrounded label falls
 *    back to two arbitrary profile tokens and costs a call that returns little;
 *    here it would cost an ATTACHMENT, because everything this fetch returns
 *    joins the arc by provenance.
 *  - **Coverage goes to `storyline_coverage`** — `(storyline_id, provider,
 *    span)`, per ADR-0019 and migration 0021 — so this provider records only the
 *    spans it actually walked for this arc, and no provider's completion can
 *    stand for another's.
 *
 * **One call per click, and the span is grid-snapped**, both for the reasons
 * `queueStorylineRefresh` gives at length one function up: a click buys
 * freshness rather than history (§9.4), and an unsnapped span mints a distinct
 * job per click on the surface most likely to be clicked twice. Google News has
 * no offset parameter at all, so one job IS one call and depth can only come
 * from subdividing the window — which is G7's crawl frontier, not this.
 *
 * **§9 survives**: a click is still the trigger. G7 is where that is traded.
 */
export async function queueStorylineDeepening(
  deps: StorylineDeepeningDeps,
  input: { storylineId: string },
): Promise<StorylineDeepenOutcome> {
  const storylineId = await resolveStoryline(deps.db, input.storylineId);
  if (storylineId === null) return { status: "unknown" };

  const deepening = deps.deepening;
  if (!deepening) {
    // Not an error and not logged as one: no deepening provider is the shipped
    // configuration, and the caller is a fire-and-forget POST.
    return { status: "unavailable", storylineId };
  }

  const storyline = await readStoryline(deps.db, storylineId);
  if (storyline === undefined) return { status: "unknown" };

  const query = deepeningQuery({
    label: storyline.label,
    profileTokens: storyline.profileTokens,
  });
  if (query === null) {
    return { status: "ungrounded", storylineId };
  }

  const now = deps.now();
  // The window is the archive's, not the provider's. Google News reaches back
  // years (`GOOGLE_NEWS_MAX_LOOKBACK_DAYS` defaults to 730) and nothing here
  // wants that: fetching below `lookbackDays` would ingest articles retention is
  // about to remove, and record coverage over a span the archive will not hold.
  const window: Span = { from: planHorizon(now, deps.config.lookbackDays), to: now };
  const covered = await readStorylineCoverage(deps.db, storylineId, deepening.provider);

  const [gap] = subtractCoverage(window, covered, {
    now,
    lookbackDays: deps.config.lookbackDays,
  });
  if (gap === undefined) {
    return { status: "fresh", storylineId, keywords: query.keywords };
  }

  // Freshness, judged against the REAL clock — the same separation
  // `queueStorylineRefresh` draws: how stale an edge is has nothing to do with a
  // grid, and judging it on a snapped clock would hide every staleness younger
  // than the last grid line.
  if (now.getTime() - gap.from.getTime() <= freshnessTtlMs(window.to, now)) {
    return { status: "fresh", storylineId, keywords: query.keywords };
  }

  // Onto the grid, both edges, so a quarter-hour of clicks on one arc is one
  // job rather than one job per click.
  const to = new Date(Math.floor(gap.to.getTime() / WINDOW_SNAP_MS) * WINDOW_SNAP_MS);
  const from = new Date(
    Math.max(gap.from.getTime(), to.getTime() - DEEPEN_SPAN_MS),
  );
  if (to.getTime() <= from.getTime()) {
    // The gap does not reach back past the last grid line. Only reachable in the
    // first quarter-hour of a cold arc's window; the next click asks for it.
    return { status: "fresh", storylineId, keywords: query.keywords };
  }

  const job: DeepenJob = {
    kind: "deepen",
    storylineId,
    from: from.toISOString(),
    to: to.toISOString(),
  };
  await deps.queue.enqueueDeepen(job);
  return { status: "queued", storylineId, keywords: query.keywords, job };
}

/**
 * How long a clean deepening walk lets the arc's Currents refresh defer to the
 * deepening plane (`STORYLINE_REFRESH_DEFERS_TO_DEEPENING`, ADR-0017 amended):
 * a day, the scale of the historical freshness tier.
 *
 * **A POSITIVE mark, set only on a result, and that direction is the point.**
 * `queued` at plan time is a promise, and two ways it goes unkept are common:
 *
 *  - **A busy arc is capped on every call.** 100 items of a seven-day span means
 *    `isLastPage` is false, so no coverage is recorded and the next click plans
 *    the same fetch again — `queued`, every time. And a capped answer is 100
 *    relevance-ranked items that need not include the newest ones.
 *  - **Google News' day is spent.** The plan still says `queued`; the job is
 *    refused later.
 *
 * Deferring on the plan alone takes the Currents refresh away from exactly the
 * arcs with the most news. A mark of FAILURE with a short life does not fix
 * that — it was tried, and review showed it protects only clicks inside the hour
 * after a capped result, leaving the first open of every busy arc, and every open
 * more than an hour apart, deferring to a plan that will cap again. So the mark
 * says the opposite: this arc's last deepening fetch walked its span to a clean
 * end. It is written when coverage is, and DELETED when a later fetch caps or
 * fails, so a busy arc never holds one and its Currents refresh always runs.
 */
const DEEPENING_SERVED_TTL_SECONDS = 24 * 60 * 60;

function servedKey(storylineId: string): string {
  return `deepening:served:${storylineId}`;
}

/**
 * Record how this arc's deepening fetch went: served (a clean end of results) or
 * not (capped, or the call failed). Never throws — a lost write degrades to the
 * refresh running, or to one more deferral on an arc that WAS served recently.
 */
async function recordDeepeningServed(
  redis: Redis,
  storylineId: string,
  served: boolean,
): Promise<void> {
  try {
    if (served) {
      await redis.set(servedKey(storylineId), "1", "EX", DEEPENING_SERVED_TTL_SECONDS);
    } else {
      await redis.del(servedKey(storylineId));
    }
  } catch {
    // Best effort: see above.
  }
}

/**
 * Whether the deepening plane's last fetch for this arc, within a day, walked it
 * to a clean end — the one condition under which it may stand in for the arc's
 * Currents refresh. Pass the RESOLVED id: the mark is written against the
 * survivor a job re-resolved to, and an alias would never find it.
 *
 * Fails CLOSED, to "not served": a Redis error means the refresh runs, which
 * spends one background Currents call — the behaviour before the flag existed —
 * where the other answer could leave an arc refreshed by nobody.
 */
export async function deepeningServedLately(
  redis: Pick<Redis, "exists">,
  storylineId: string,
): Promise<boolean> {
  try {
    return (await redis.exists(servedKey(storylineId))) === 1;
  } catch {
    return false;
  }
}

/**
 * How wide a span one deepening call may ask for.
 *
 * Seven days, and it is a guess with a stated reason rather than a measured
 * ceiling — there is no per-call range limit on this provider to transcribe
 * (`googleNewsClientLimits` sets `maxRangeDays` to the lookback for exactly that
 * reason). What there IS is the 100-item cap and no offset, so the only question
 * a span width answers is "how much does one call see". Probed 2026-08-27: five
 * weekly slices of one arc returned 433 items where the unsliced query returned
 * 92, so a week is already wide enough to be truncated on a busy arc and
 * narrower slices are how depth is bought. That is G7's job.
 *
 * Matching `maxRangeDays` on the Currents side is a coincidence worth naming so
 * nobody derives one from the other: that seven days is a 400 from upstream,
 * this seven days is a judgement about yield.
 */
const DEEPEN_SPAN_MS = 7 * 86_400_000;

/**
 * Queue-consumer handler for a deepening fetch: one call, one arc.
 *
 * The shape is `processSegmentJob`'s and the differences are all consequences of
 * the subject being a storyline rather than a topic — read them together.
 */
export async function processDeepenJob(
  deps: StorylineDeepeningDeps,
  job: DeepenJob,
): Promise<void> {
  const deepening = deps.deepening;
  if (!deepening) {
    // A message published before the flag was turned off. Dropped rather than
    // retried: no amount of backoff makes a provider that is not configured
    // answer, and a redelivery loop on it is the failure mode the parse guard
    // in `parseIngestJob` exists to avoid one layer up.
    deps.log?.warn(
      { storylineId: job.storylineId },
      "deepening job delivered with no deepening provider configured; dropping",
    );
    return;
  }

  // Re-resolved, because a storyline can be merged away between enqueue and
  // delivery and the arc worth deepening is the survivor. Its own row holds the
  // profile — `mergeStorylines` empties the loser's — so re-deriving the query
  // below against a merged-away id would read as `ungrounded` rather than as
  // "ask the survivor".
  const storylineId = await resolveStoryline(deps.db, job.storylineId);
  if (storylineId === null) {
    deps.log?.warn({ storylineId: job.storylineId }, "deepening job for unknown storyline; dropping");
    return;
  }
  const storyline = await readStoryline(deps.db, storylineId);
  if (storyline === undefined) return;

  // Re-derived rather than carried on the job, following `processSegmentJob`,
  // which carries a fingerprint and re-reads the topic. Both the label and the
  // profile can move between enqueue and delivery — the labeler runs on a tail
  // and the profile is re-derived on every attach — and the gate has to be
  // asked about the arc as it stands, not as it stood. An arc that LOST its
  // grounding in the interval is one we no longer trust enough to attach to.
  const query = deepeningQuery({
    label: storyline.label,
    profileTokens: storyline.profileTokens,
  });
  if (query === null) {
    deps.log?.warn(
      { storylineId },
      "deepening job's arc no longer grounds its own label; dropping rather than attaching",
    );
    return;
  }

  const requested: Span = { from: new Date(job.from), to: new Date(job.to) };
  // Re-clamped to the horizon as it stands NOW — `processSegmentJob`'s reason,
  // unchanged: nothing bounds how long a message sits, and recording coverage
  // for a span the clamp narrowed would mark the remainder fetched forever.
  const horizon = planHorizon(deps.now(), deps.config.lookbackDays);
  const span: Span =
    requested.from.getTime() >= horizon.getTime()
      ? requested
      : { from: horizon, to: requested.to };
  if (span.from.getTime() >= span.to.getTime()) {
    deps.log?.warn(
      { storylineId, from: job.from, to: job.to },
      "deepening job fell below the lookback horizon before it was fetched; dropping",
    );
    return;
  }

  // Single-flight on the arc and the span as ENQUEUED, so the key is stable
  // across redeliveries the way `processSegmentJob`'s is.
  const lockKey = refreshLockKey(`storyline:${storylineId}`, requested);
  const token = await tryAcquire(deps.redis, lockKey, 30_000);
  if (!token) throw new Error(`deepening ${lockKey} is locked; retrying later`);

  try {
    const language = await readStorylineLanguage(deps.db, storylineId);

    // The arc's own topic, minted here rather than carried on the job so it is
    // derived from the label as it stands at fetch time — the same reason the
    // query above is. `canonicalKeywords` rather than a second normalization:
    // the identity a reader typing this label would land on has to be this one,
    // or the same words sit under two fingerprints.
    const topicKeywords = canonicalKeywords(query.keywords);
    const fingerprint = fingerprintOf({
      keywords: topicKeywords,
      language: language ?? null,
      country: null,
      category: null,
    });
    await upsertTopic(deps.db, {
      fingerprint,
      keywords: topicKeywords,
      language,
      country: null,
      category: null,
    });

    let result;
    try {
      result = await deepening.search(
        {
          // The label VERBATIM and unsplit, which is what the provider is asked —
          // word order is part of a phrase query and `topicKeywords` above has
          // sorted it away for identity purposes. The two are deliberately
          // different strings and neither can stand in for the other.
          keywords: [query.keywords],
          ...(language ? { language } : {}),
          startDate: span.from,
          endDate: span.to,
          pageNumber: 1,
          pageSize: deepening.limits.maxPageSize,
        },
        // No reader is waiting; draw only what the interactive reserve spares.
        { priority: "background" },
      );
    } catch (error) {
      // Any failure to answer — a spent day, an upstream fault — is an arc this
      // fetch did not serve, so its Currents refresh must stop deferring to it.
      // Rethrown unchanged: the job's own retry story is untouched.
      await recordDeepeningServed(deps.redis, storylineId, false);
      throw error;
    }
    // What came back, and how much of what this provider just sent is DATED
    // rather than timed (plan §G6, ADR-0021). Recorded here rather than inside
    // `ingestSightings` because storage should not grow an opinion about
    // observability, and before the fold so a throwing one cannot take the
    // observation with it.
    //
    // This plane wrote these fields first and now shares their shape with the
    // other two: the numbers are ratios ACROSS the planes, so a line only this
    // one wrote made every one of them wrong by a plane. `observations.ts`
    // carries the argument and the ordering rule.
    logUpstreamFetch(deps.log, {
      plane: "deepening",
      provider: deepening.provider,
      storylineId,
      span,
      sightings: result.sightings,
      normalization: result.normalization,
    });

    const ingested = await ingestSightings(deps.db, {
      // The arc's own topic, minted below rather than skipped, and this is the
      // part of the plan's "not a synthetic topic" that is NOT taken. What the
      // plan asks to move is the COVERAGE CLAIM, and it moves: nothing here
      // writes `topic_coverage`, so a reader who later searches this label gets
      // a cold topic and fetches for themselves, which is the truth.
      //
      // The topic ROW stays because `topic_articles` is what CLAIMS an article
      // against retention — "an article in no topic at all has nobody left to
      // claim it" (`retentionReport`) — and a storyline is not a claimant that
      // table knows about. Dropping the topic would leave every deepening
      // article looking like a prune candidate, and teaching retention about
      // storylines is a larger change than this phase should make. Recorded as
      // the cost it is: one `topics` row per deepened arc plus one
      // `topic_articles` row per article, and a `hit_count` bump on a fetch
      // rather than on a reader.
      fingerprint,
      sightings: result.sightings,
      plane: "deepening",
      timeZone: deps.config.grouping.timeZone,
      ...(deps.log ? { log: deps.log } : {}),
    });
    logIngestOutcome(deps.log, {
      plane: "deepening",
      provider: deepening.provider,
      storylineId,
      created: ingested.articlesCreated,
    });

    // ATTACHMENT BY PROVENANCE. The seam is `groupCreatedArticles`' intent, and
    // the whole of the rule lives there: seeded groups join this arc, nothing is
    // offered to the linker, and no storyline is formed.
    await groupCreatedArticles(groupingDepsFor(deps), ingested.createdArticles, {
      attachTo: storylineId,
    });

    // Coverage LAST, and only on a clean end of results.
    //
    // Read off THIS provider's own `completeness` entry rather than the
    // top-level `isLastPage`, which is the shared paging plan's terminator and
    // says nothing about who walked what. Today the two agree — this is a
    // single-provider client, so its entry is the only one — and asking the
    // right question costs a lookup, while the day a fan-out arrives here the
    // top-level answer would silently be someone else's.
    //
    // End of results on this provider means `rawCount < 100`, which is the
    // honest "there was nothing further in this window" — a FULL page means the
    // 100-cap truncated it, and there is no page 2 to ask for. So a truncated
    // span records nothing and the next click re-plans the same gap. That is a
    // deliberate difference from `onTruncated`, which advances a frontier and
    // enqueues the remainder: doing that here would need subdivision, and
    // subdivision without a reader asking for it is the crawl frontier G7 has
    // to argue for on its own.
    const walked = result.completeness.find((page) => page.provider === deepening.provider);
    if (walked?.isLastPage) {
      await recordStorylineCoverage(deps.db, storylineId, deepening.provider, span);
      await recordDeepeningServed(deps.redis, storylineId, true);
    } else {
      // Capped: served in part, and planned again on the next click — the case
      // `DEEPENING_SERVED_TTL_SECONDS` is about. The mark goes.
      await recordDeepeningServed(deps.redis, storylineId, false);
      deps.log?.info?.(
        { storylineId, from: span.from, to: span.to, items: result.rawCount },
        "deepening span hit the item cap; coverage not recorded, the gap stays open",
      );
    }
  } finally {
    await release(deps.redis, lockKey, token);
  }
}
