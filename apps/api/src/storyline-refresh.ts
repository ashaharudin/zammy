import type { Kysely } from "kysely";
import {
  readCoverage,
  readStoryline,
  readStorylineLanguage,
  resolveStoryline,
  upsertTopic,
  type Database,
} from "@zammy/storage";
import { WINDOW_SNAP_MS, type CanonicalizeResult } from "./canonical.js";
import { storylineKeywords } from "./cloud-query.js";
import { PLANNED_COVERAGE_PROVIDER, subtractCoverage } from "./coverage-gaps.js";
import { freshnessTtlMs } from "./page-cache.js";
import type { Metrics } from "./metrics.js";
import { segmentJob, type IngestQueue, type SegmentJob } from "./ingest-queue.js";

/**
 * ADR-0017's refresh planner: opening a storyline queues one background top-up
 * of the TOPIC the arc's own coverage names.
 *
 * A planner and nothing else. It reads the arc, derives an ask from it, diffs a
 * window against `topic_coverage` and publishes at most one job — and the
 * load-bearing part, argued at length below, is that **no upstream call happens
 * on this request path**. That is why nothing here can reach a news client: the
 * only thing this module knows about the discovery provider is how wide one of
 * its calls may be.
 *
 * It is deliberately NOT the deepening plane's planner, which lives beside it in
 * `storyline-deepening.ts` and plans the same click against `storyline_coverage`
 * and a different provider (ADR-0019). The two answer about different subjects,
 * and the header on `StorylineDeepenOutcome` says why they are not one union.
 */
export interface StorylineRefreshDeps {
  db: Kysely<Database>;
  /** Only `enqueueSegment`, and at most one per call: §9.4's whole argument. */
  queue: Pick<IngestQueue, "enqueueSegment">;
  /**
   * The discovery provider's per-call range ceiling (§2 — 7 days, observed
   * 2026-08-11). Read off the client rather than configured separately so this
   * planner and `coverage-fill.ts`'s fetcher cannot come to disagree about it,
   * and narrowed to `limits` so a planner that must not spend a call cannot.
   */
  currents: { limits: { maxRangeDays: number } };
  config: { lookbackDays: number };
  now: () => Date;
  metrics?: Metrics;
}


/**
 * What opening a storyline queued, as the route reports it (ADR-0017).
 *
 * A discriminated union rather than a boolean, because only two of the five are
 * errors — a UUID nobody holds is a 404, a language upstream no longer lists is
 * a 400 — and the other three are all a 202 that says what it did or did not
 * spend. `fresh` in particular is not a failure: it is the freshness gate
 * working.
 */
export type StorylineRefreshOutcome =
  /** No such storyline, alias chain followed. A stale link, not a bad request. */
  | { status: "unknown" }
  /** Nothing the coverage says: no label and an empty profile (`storylineKeywords`). */
  | { status: "no_keywords"; storylineId: string }
  /**
   * `canonicalize` refused, which for this caller is defensive rather than
   * expected: the keywords are ours and at most two words, and the route drops a
   * language the reference lists do not hold rather than passing it on to be
   * refused. Carries `canonicalize`'s own field errors so a future rule that
   * does refuse something says which.
   */
  | { status: "invalid"; storylineId: string; errors: Record<string, string> }
  /** Coverage reaches inside the staleness tier already: nothing to ask for. */
  | { status: "fresh"; storylineId: string; fingerprint: string; keywords: string[] }
  | {
      status: "queued";
      storylineId: string;
      fingerprint: string;
      keywords: string[];
      job: SegmentJob;
    };

/**
 * Opening a storyline queues one background top-up of the topic its own
 * coverage names (§9.1, ADR-0017).
 *
 * This is the §6.3 planner with the reader taken out of it: mint the topic,
 * diff the window against coverage, hand the newest gap to the queue, and
 * return. No page is read, no cache is written, and — the load-bearing part —
 * **no upstream call happens on this request path**. A click must not wait on
 * ingestion it is not going to be shown; the caller is a fire-and-forget POST
 * beside a route transition (`App.openStoryline`), and everything it enqueues is
 * fetched at `"background"` priority behind the interactive reserve (§9.4).
 *
 * **At most ONE job per click**, and which one is the whole of the judgment:
 *
 *  - **A warm topic** — its trailing edge inside the staleness tier — queues
 *    nothing. `freshnessTtlMs` is 60 s on a window ending now, so a storyline
 *    two readers open in the same minute costs one enqueue, and the second
 *    click is a Redis read and a 202.
 *  - **A stale trailing edge** queues the §6.4 top-up, deduplicated by its
 *    leading edge alone — the identity that exists precisely because a repeated
 *    ask re-reads "now" and must not mint a fresh job each time.
 *  - **A cold topic** queues the NEWEST gap and nothing else, bounded to one
 *    call, which is §9.4's "backfill is never automatic" applied to a click: an
 *    arc with 30 days of missing history is worth one 7-day slice of freshness,
 *    not five calls the reader never asked for. Deeper history is what searching
 *    the words is for.
 *  - **An interior hole under a covered present** queues nothing. It is missing
 *    history rather than staleness, and by the previous bullet a click does not
 *    buy history.
 *
 * **A segment's span is snapped onto the window grid, and that is not
 * cosmetic.** `subtractCoverage` clamps its newest gap to `now` exactly and
 * `sliceSpan` measures every boundary back from that edge, so the same coverage
 * planned a second later yields different span endpoints — and `ingestJobId`
 * derives a job's content address from exactly those endpoints. Unsnapped, every
 * click mints a distinct job and spends its own upstream call, the queue's dedup
 * defeated on precisely the surface most likely to be clicked twice. Snapped, a
 * quarter-hour of clicks on one arc is one job. It costs at most the freshest
 * quarter-hour of a cold topic's first fetch, which the next reader's own
 * interactive fill covers anyway.
 *
 * Only this path needs it. The read path plans against the live clock and is
 * right to — the reader is waiting on the newest gap, and what it defers is
 * bounded by a deadline rather than by a click rate. The top-up branch needs no
 * snapping either: its identity omits its upper edge by construction, for this
 * same reason one layer down (§6.4). And FRESHNESS is judged against the real
 * clock throughout — how stale a trailing edge is has nothing to do with a grid,
 * and planning the sliver test on a snapped clock would have hidden every
 * staleness younger than the last grid line.
 *
 * **Every part of the ask comes off the arc's own coverage, and none of it off
 * the reader.** The keywords are what its label and profile say
 * (`storylineKeywords`); the language is what its member articles are actually
 * written in (`readStorylineLanguage`); there is no country and no category,
 * because a storyline is not defined by either. Passing the reader's filter
 * chips instead was the obvious shape and it is the wrong one: the cloud is
 * built for English alone (§10.1), so a reader whose chip says Malay clicking an
 * English cloud word would mint a Malay topic that cannot match the arc, and a
 * background call that cannot match anything is exactly the spend §9.4 exists to
 * refuse. It also means this route needs no request body and no query string —
 * a UUID is the whole of the ask.
 *
 * `canonicalize` arrives as a callback because the ordering demands it: neither
 * the keywords nor the language is known until the storyline is read, and
 * validating a language against the reference lists is the route's job
 * (`loadReference`) rather than the planner's. One trip through here keeps the
 * sequence — resolve, derive, canonicalize, plan — in one place instead of
 * splitting it across the route.
 */
export async function queueStorylineRefresh(
  deps: StorylineRefreshDeps,
  input: {
    storylineId: string;
    /**
     * `language` is what the arc's coverage says, and `undefined` when it says
     * nothing — which the route reads as "use the configured default", the same
     * meaning an omitted `?language=` has on the timeline read.
     */
    canonicalize: (input: {
      keywords: string;
      language: string | undefined;
    }) => CanonicalizeResult;
  },
): Promise<StorylineRefreshOutcome> {
  // Aliases first: a merged-away UUID is still on every page that was rendered
  // before the merge, and the arc worth refreshing is the survivor. Its own row
  // is the one holding a profile — `mergeStorylines` empties the loser's.
  const storylineId = await resolveStoryline(deps.db, input.storylineId);
  if (storylineId === null) return { status: "unknown" };
  const storyline = await readStoryline(deps.db, storylineId);
  if (storyline === undefined) return { status: "unknown" };

  const keywords = storylineKeywords({
    label: storyline.label,
    profileTokens: storyline.profileTokens,
  });
  if (keywords === null) {
    deps.metrics?.storylineRefresh("no_keywords");
    return { status: "no_keywords", storylineId };
  }

  const language = await readStorylineLanguage(deps.db, storylineId);
  const canonical = input.canonicalize({ keywords, language: language ?? undefined });
  if (!canonical.ok) {
    deps.metrics?.storylineRefresh("invalid");
    return { status: "invalid", storylineId, errors: canonical.errors };
  }
  const query = canonical.query;
  const now = deps.now();

  // The topic exists from here on, for the same reason the read path mints it
  // before planning: a queued segment carries only the fingerprint, and the
  // topic row is where the consumer recovers what it means (§9.1). It also
  // counts the hit, which is the honest record — a click IS demand, and it is
  // what keeps this topic ahead of retention's idle cutoff (§7.5).
  await upsertTopic(deps.db, {
    fingerprint: query.fingerprint,
    keywords: query.keywords,
    language: query.language,
    country: query.country,
    category: query.category,
  });

  const maxSpanMs = deps.currents.limits.maxRangeDays * 86_400_000;
  const covered = await readCoverage(deps.db, query.fingerprint, PLANNED_COVERAGE_PROVIDER);

  const settled = {
    storylineId,
    fingerprint: query.fingerprint,
    keywords: query.keywords,
  };

  // The newest gap UNSLICED, which is the only version of it whose lower edge is
  // a fact about coverage: `sliceSpan` counts back from `now`, so a slice's own
  // `from` moves with the clock even when nothing about the coverage did.
  const [gap] = subtractCoverage(query.window, covered, {
    now,
    lookbackDays: deps.config.lookbackDays,
  });
  if (gap === undefined) {
    deps.metrics?.storylineRefresh("fresh");
    return { status: "fresh", ...settled };
  }

  // Does the newest gap REACH the present? `subtractCoverage` clamps its upper
  // bound to min(window.to, now) and pushes a trailing gap only if the sweep did
  // not already run past it, so a gap ending at that clamp is the leading edge,
  // and a gap ending earlier is a hole with coverage above it.
  //
  // **Two things this deliberately is not**, both of which were tried and both
  // of which failed silently — worth the lines, because the failure mode of a
  // wrong answer here is an arc that never advances and never complains.
  //
  // Not `trailingSliver`, which is what the read path uses: it additionally
  // requires the whole window to reduce to ONE sliced gap. That is right there —
  // it separates "stale edge, repair behind the reader" from "missing history,
  // take the synchronous fill" — and wrong here, because a topic minted by a
  // click is multi-gap from its first click onward BY CONSTRUCTION: the click
  // fills the newest 7 days of a 30-day window and never reaches the rest, so
  // the window is permanently four slices plus an edge. Under the shape test the
  // edge was never a sliver, the freshness gate below was unreachable, and what
  // a click did depended on where the clock sat inside the quarter-hour —
  // measured, an arc whose edge was 45 SECONDS old got a 15-second segment job
  // and one upstream call, while the same arc a few minutes earlier got nothing.
  // There is no synchronous fill on this path for a shape test to choose
  // between, so the only question an edge poses here is how stale it is.
  //
  // And not `max(coverage.upper)`, which replaced the shape test and is the more
  // instructive mistake: "the newest gap does not start at max(coverage.upper)"
  // is not the same claim as "the present is covered". `readCoverage` is
  // unfiltered by window, so a topic whose whole coverage has aged BELOW the
  // lookback horizon satisfies the first while contradicting the second — and
  // read `fresh` on every click, forever, with nothing else in the system to
  // advance it. The gap's own upper edge cannot make that mistake: below the
  // horizon there is no coverage inside the window at all, so the gap runs to
  // the clamp and the topic is treated as the cold one it is.
  const leadingEdgeMs = Math.min(query.window.to.getTime(), now.getTime());
  if (gap.to.getTime() !== leadingEdgeMs) {
    // An interior hole under a covered present. Not a freshness question at all,
    // and §9.4 says a click does not buy history: left for a reader who searches
    // the words.
    deps.metrics?.storylineRefresh("fresh");
    return { status: "fresh", ...settled };
  }

  // At the leading edge. Is it a TRAILING EDGE — coverage running right up to
  // where the gap starts — or is the window simply uncovered from the horizon
  // forward, which is a cold topic however old its rows are?
  //
  // This is where `max(coverage.upper)` IS the right question, and the contrast
  // with the paragraph above is the whole point: it decides what kind of edge
  // this is, not whether the present is covered.
  //
  // The highest coverage bound AT OR BELOW the leading edge, not `covered.at(-1)`.
  // Those are the same row except when coverage reaches past `now`, which the app
  // cannot write (`processSegmentJob` clamps its own span) but two replicas on
  // skewed clocks can: an island at `now+1h` above a stale edge at `now-1h` makes
  // the global max disagree with the gap's start, and the edge silently stops
  // being a top-up. It still gets one bounded job, so nothing runs away — but a
  // segment's identity carries its upper bound, so every quarter-hour of clicks
  // would mint a fresh one and spend its own call, which is the dedup the
  // snapping note above exists to protect.
  const leadingEdgeCoverage = covered.reduce<number | undefined>((highest, span) => {
    const upper = span.to.getTime();
    if (upper > leadingEdgeMs) return highest;
    return highest === undefined || upper > highest ? upper : highest;
  }, undefined);
  if (leadingEdgeCoverage !== undefined && gap.from.getTime() === leadingEdgeCoverage) {
    if (now.getTime() - gap.from.getTime() <= freshnessTtlMs(query.window.to, now)) {
      deps.metrics?.storylineRefresh("fresh");
      return { status: "fresh", ...settled };
    }
    // A stale edge narrow enough to fetch in one call is the §6.4 top-up, whose
    // identity omits its upper bound — so a click a minute later asks for the
    // same thing rather than minting a fresh job, and no snapping is needed. An
    // edge WIDER than one call is not an edge any more; it falls through to the
    // bounded, grid-snapped segment below rather than becoming a top-up the
    // consumer would fan out into several calls off one click.
    if (gap.to.getTime() - gap.from.getTime() <= maxSpanMs) {
      const job: SegmentJob = {
        // `deepening`, and ADR-0019 argues it against the obvious reading: a
        // reader's click is the TRIGGER, but the target is an arc our own cloud
        // named, and the test is whether our ranking chose it. Everything this
        // job ingests is therefore kept out of the ranking that chose it.
        ...segmentJob(query.fingerprint, gap, 1, "deepening"),
        kind: "topup",
      };
      await deps.queue.enqueueSegment(job);
      deps.metrics?.storylineRefresh("queued");
      return { status: "queued", ...settled, job };
    }
  }

  // A cold topic, or a trailing edge too wide to top up. Onto the grid, and BOTH
  // edges — the note above says why. `to` snaps down to the last grid line;
  // `from` is then measured back from it, so a cold topic's 7-day slice has two
  // fixed endpoints instead of two that follow the clock. The gap's own start
  // still wins where it is later, or the ask would reach below the gap into
  // coverage already recorded.
  const to = new Date(Math.floor(gap.to.getTime() / WINDOW_SNAP_MS) * WINDOW_SNAP_MS);
  const from = new Date(Math.max(gap.from.getTime(), to.getTime() - maxSpanMs));
  if (to.getTime() <= from.getTime()) {
    // The gap does not reach back past the last grid line. Only reachable for a
    // cold topic in the first quarter-hour of its window, since a trailing edge
    // narrower than the grid is a top-up above; the next click asks for it.
    deps.metrics?.storylineRefresh("fresh");
    return { status: "fresh", ...settled };
  }

  const job = segmentJob(query.fingerprint, { from, to }, 1, "deepening");
  await deps.queue.enqueueSegment(job);
  deps.metrics?.storylineRefresh("queued");
  return { status: "queued", ...settled, job };
}

