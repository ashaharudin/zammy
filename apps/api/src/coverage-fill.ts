import type { Kysely } from "kysely";
import type { Redis } from "ioredis";
import {
  NewsQuotaError,
  type CallPriority,
  type CurrentsClient,
} from "@zammy/currents-client";
import {
  ingestSightings,
  readCoverage,
  readTopic,
  recordCoverage,
  type Database,
  type SightingPlane,
} from "@zammy/storage";
import type { CanonicalQuery } from "./canonical.js";
import { planHorizon, sliceSpan, subtractCoverage, type Span } from "./coverage-gaps.js";
import { freshnessTtlMs } from "./page-cache.js";
import type { Metrics } from "./metrics.js";
import { refreshLockKey, release, tryAcquire } from "./single-flight.js";
import { reserveTopicCall } from "./topic-budget.js";
import { segmentJob, type IngestQueue, type SegmentJob } from "./ingest-queue.js";
import {
  groupCreatedArticles,
  groupingDepsFor,
  type GroupingDeps,
} from "./grouping-service.js";

/**
 * COVERAGE FILL: everything that spends an upstream call against a topic and
 * everything that writes `topic_coverage`. Both halves of §6.3 step 4 —
 * the deadline-bounded fill a reader waits on, and the queue consumer that
 * finishes what the deadline cut — plus the paging engine underneath them.
 *
 * The module boundary is drawn around the coverage WRITE deliberately, and it
 * is the reason this file is one file. §2 argues at length that the fetch-time
 * clamp is a correctness mechanism rather than an optimisation: `fillSegment`
 * records coverage for the span it is HANDED, so every caller owes it a span
 * that is at or above the live lookback horizon AT FETCH TIME. Get that wrong
 * and days are marked fetched that nobody fetched, with no error anywhere. That
 * obligation is only checkable if every call site is in view, so all three of
 * them are here:
 *
 *   - `fillWindowForRead` — spans straight off `subtractCoverage`, which clamps
 *     to `planHorizon(now)` itself, and fetched in the same request.
 *   - `processSegmentJob` — a span off a queue message of unbounded age, so it
 *     re-clamps against a fresh horizon immediately before calling in.
 *   - `onTruncated` — records the frontier and hands the remainder back as a
 *     job; it never fetches.
 *
 * Two §12 invariants also run through this file: the single-flight lock
 * deduplicates UPSTREAM CALLS and never queues READERS, and the store's
 * `hasMore` (more in our store) stays independent of `meta.ingest.state` (more
 * may still arrive) — the read path owns the second one, and what this module
 * hands back is the raw material for it.
 */
export interface CoverageFillDeps {
  db: Kysely<Database>;
  redis: Redis;
  /**
   * The discovery provider, narrowed to what a fill actually calls.
   *
   * `latestNews` is deliberately out of reach: the breadth sample is the only
   * caller of it (§10.1), it records no coverage, and nothing on this path
   * should be able to reach for it. Same argument the deepening plane's
   * `NewsClient` narrowing makes one module over.
   */
  currents: Pick<CurrentsClient, "search" | "limits" | "coverageProvider">;
  /**
   * Only `enqueueSegment`: a fill defers pages and truncation remainders and
   * nothing else. It cannot start a breadth sample or a deepening fetch, and it
   * cannot read a pending count — that is the read path's question.
   */
  queue: Pick<IngestQueue, "enqueueSegment">;
  config: {
    syncFillDeadlineMs: number;
    maxSyncUpstreamCalls: number;
    lookbackDays: number;
    /** Subdivision floor (§6.3): below this, truncation is accepted, not recursed. */
    minSegmentMs: number;
    /** §9.4: upstream calls one topic may spend per UTC day, both paths combined. */
    perTopicDailyCallCap: number;
    /** §14.3: write-time article grouping (and its storyline layer, ADR-0009),
     * and the day both draw candidates from. */
    grouping: GroupingDeps["config"];
  };
  now: () => Date;
  /**
   * The labeler the write path's promotion and merge triggers fire (ADR-0011).
   * Absent means no live labelling: `server.ts` builds it when a Gemini key is
   * configured, and the bigram fallback carries it when one is not.
   */
  labeler?: GroupingDeps["labeler"];
  metrics?: Metrics;
  log?: {
    warn: (obj: object, msg: string) => void;
    info?: (obj: object, msg: string) => void;
  };
}

/**
 * What a read's fill did, in the terms the response's `meta` is written in.
 *
 * Deliberately not the response itself: this module decides how much of the
 * window got fetched, and `timeline-read.ts` decides what to tell the reader
 * about it — including the cache gate, which reads four of these five fields.
 */
export interface ReadFillReport {
  /** `"upstream"` the moment a call was made; the read never downgrades it. */
  servedFrom: "store" | "upstream";
  degraded: "quota" | "upstream" | null;
  /** §6.4: a trailing sliver older than its tier. The top-up is already queued. */
  stale: boolean;
  /** §9.4: the topic's daily cap is spent. Nothing further was fetched OR queued. */
  capped: boolean;
  /**
   * A peer holds the segment lock, so their fetch is this read's `in_progress`
   * — the §12 invariant that a reader never QUEUES on someone else's ingest.
   */
  lockLostToPeer: boolean;
  /** Coverage as it stood BEFORE the fill, for a caller that needs no re-read. */
  coverageBefore: readonly Span[];
  /**
   * Whether the window had gaps at all — which is exactly the condition under
   * which coverage may have moved, and so whether `coverageBefore` is still
   * the answer. Returned rather than resolved here so the caller keeps its own
   * ordering: the read re-reads coverage at the END of its statement sequence,
   * after the page and the pending count.
   */
  plannedGaps: boolean;
}

/**
 * §6.3 steps 2–5 for a reader who is waiting: diff the window against coverage,
 * fill what fits the wall-clock deadline newest-gap-first, defer the rest.
 *
 * Split out of `readTimeline` rather than left inline, because this is the half
 * that fetches and the half that decides what the reader is told are answerable
 * separately — and because every `fillSegment` call site belongs in this file
 * (see the module header). The caller's obligations are only two: mint the
 * topic BEFORE calling, so a deferred job can recover the search parameters,
 * and treat the report's `plannedGaps` as "coverage may have moved".
 */
export async function fillWindowForRead(
  deps: CoverageFillDeps,
  query: CanonicalQuery,
  /**
   * The instant the read is being served at, HANDED IN rather than re-read off
   * `deps.now()`. The gap diff, the sliver's shape test and the freshness tier
   * all have to be judged against the same clock reading the response's `asOf`
   * reports, or a read can call a sliver fresh and stamp itself a moment later.
   * The fill's own wall-clock deadline is the exception and reads the live
   * clock: it measures elapsed time rather than answering about an instant.
   */
  now: Date,
): Promise<ReadFillReport> {
  // §6.3 steps 2–3 — is the window covered? If not, where exactly isn't it?
  // Gaps are pre-sliced to the per-call range ceiling (7 days, observed
  // 2026-08-11), so every planned segment is individually fetchable. This
  // also scopes refresh-on-read naturally: a trailing gap wider than the
  // ceiling arrives as several slices, fails the single-gap sliver test
  // below, and takes the sync fill — 16 idle days is missing history, not
  // staleness.
  const covered = await readCoverage(deps.db, query.fingerprint);
  const gaps = subtractCoverage(query.window, covered, {
    now,
    lookbackDays: deps.config.lookbackDays,
    maxSpanMs: deps.currents.limits.maxRangeDays * 86_400_000,
  });

  const report: ReadFillReport = {
    servedFrom: "store",
    degraded: null,
    stale: false,
    capped: false,
    lockLostToPeer: false,
    coverageBefore: covered,
    plannedGaps: gaps.length > 0,
  };

  // §6.4 refresh-on-read: a window reaching the present is never "fully
  // covered" — time itself keeps opening a sliver past max(coverage.upper).
  // Inside the staleness tier that sliver IS fresh enough; beyond it, the
  // reader is served instantly and the repair happens behind them. Only real
  // gaps — a cold topic, missing interior history — reach the sync fill.
  const sliver = trailingSliver(query.window, gaps, covered, now);
  if (sliver) {
    const age = now.getTime() - sliver.from.getTime();
    if (age > freshnessTtlMs(query.window.to, now)) {
      report.stale = true;
      await deps.queue.enqueueSegment({
        ...segmentJob(query.fingerprint, sliver, 1, "search"),
        kind: "topup",
      });
    }
    return report;
  }

  if (gaps.length === 0) return report;

  // §6.3 steps 4–5 — fill what fits the wall-clock deadline, newest gap
  // first (that is where the reader is looking), defer the rest.
  const budget: FillBudget = {
    deadline: deps.now().getTime() + deps.config.syncFillDeadlineMs,
    maxCalls: deps.config.maxSyncUpstreamCalls,
    callsUsed: 0,
  };
  const deferred: SegmentJob[] = [];

  for (const gap of gaps) {
    if (
      budget.callsUsed >= budget.maxCalls ||
      (budget.callsUsed > 0 && deps.now().getTime() >= budget.deadline)
    ) {
      deferred.push(segmentJob(query.fingerprint, gap, 1, "search"));
      continue;
    }

    const lockKey = refreshLockKey(query.fingerprint, gap);
    const token = await tryAcquire(deps.redis, lockKey, 10_000);
    if (!token) {
      // Someone else is already fetching this segment. Their calls, their
      // enqueues; we serve the store immediately and say "in progress".
      report.lockLostToPeer = true;
      continue;
    }

    try {
      // The span is `subtractCoverage`'s own, which clamped it to
      // `planHorizon(now)` a few statements up and is being fetched in the same
      // request — so the fetch-time clamp `processSegmentJob` needs has already
      // happened here, at plan time, with nothing in between that can age.
      const outcome = await fillSegment(deps, query, gap, budget, 1, "interactive", "search");
      if (outcome.callsMade > 0) report.servedFrom = "upstream";
      if (outcome.kind === "deferred") {
        deferred.push(segmentJob(query.fingerprint, gap, outcome.resumePage, "search"));
      } else if (outcome.kind === "truncated") {
        deferred.push(
          ...(await onTruncated(deps, query.fingerprint, gap, outcome.oldestSeen, "search")),
        );
      } else if (outcome.kind === "capped") {
        report.capped = true;
      }
    } catch (error) {
      report.degraded = error instanceof NewsQuotaError ? "quota" : "upstream";
      deps.log?.warn(
        { err: error, fingerprint: query.fingerprint },
        "synchronous fill failed; serving from store",
      );
      break;
    } finally {
      await release(deps.redis, lockKey, token);
    }

    if (report.capped) break;
  }

  // A capped topic enqueues nothing: queued IOUs would only no-op against
  // the same cap, and tomorrow's reader re-plans the gaps anyway (§9.4).
  if (!report.degraded && !report.capped) {
    for (const job of deferred) await deps.queue.enqueueSegment(job);
  }

  return report;
}

/**
 * Queue-consumer handler (§9.1): finish what a deadline cut off. Runs with no
 * deadline and no call ceiling of its own — the queue's retry/backoff is the
 * pacing — but still under the segment lock, so a background fill and a
 * user-triggered fill of the same segment cannot double-spend.
 */
export async function processSegmentJob(
  deps: CoverageFillDeps,
  job: SegmentJob,
): Promise<void> {
  const topic = await readTopic(deps.db, job.fingerprint);
  if (!topic) throw new Error(`segment job for unknown topic ${job.fingerprint}`);

  // The lock key is derived from the span as ENQUEUED, not from the clamped one
  // below, so it is stable across redeliveries of the same message. The clamp
  // moves with the clock; the identity of the message does not.
  //
  // It does NOT follow that this key matches whatever the interactive path
  // holds for "the same" gap, and for the OLDEST gap it provably cannot:
  // `subtractCoverage` starts that gap at `planHorizon(now)`, which strictly
  // increases, so a re-plan a minute later mints a different span and therefore
  // a different key. Two fetchers can hold two keys over spans that clamp to
  // nearly the same interval and both spend a call. That predates the clamp —
  // before it, `clampSearchParams` collapsed the two spans downstream just the
  // same — and keying on the clamped span would not close it either, since the
  // two clamps happen at different instants. Recorded rather than fixed: the
  // cost is a duplicate fetch on one segment, and the collapse makes it
  // idempotent.
  const requested: Span = { from: new Date(job.from), to: new Date(job.to) };
  const lockKey = refreshLockKey(job.fingerprint, requested);
  const token = await tryAcquire(deps.redis, lockKey, 30_000);
  // Held by someone else: fail so BullMQ redelivers after backoff, by which
  // time the other fetcher has either finished (re-run is idempotent and
  // cheap: coverage already recorded) or crashed (lock expired).
  if (!token) throw new Error(`segment ${lockKey} is locked; retrying later`);

  try {
    // Re-clamp to the lookback horizon as it stands NOW, not as it stood when
    // this job was planned. The plan leaves slack (`LOOKBACK_PLAN_SLACK_MS`),
    // but nothing bounds the delay: the drain route only looks at entries
    // already `DRAIN_MIN_AGE_MS` old — the whole slack, by construction — and
    // `onTruncated` re-enqueues remainders that keep the original `from` under
    // a fresh retention, so a truncation chain walks the same lower edge
    // forward indefinitely.
    //
    // Clamping HERE rather than letting `clampSearchParams` do it downstream is
    // the difference between honest coverage and silent loss: the client's
    // clamp narrows the request and returns an adjustment nobody on this path
    // reads, while `fillSegment` would go on to record coverage for the span it
    // ASKED for. The narrowed remainder would be marked fetched forever. This is
    // the same reasoning that makes the per-call range ceiling throw instead of
    // narrowing (see `clampSearchParams`).
    //
    // It sits in the same file as the `recordCoverage` it protects, and that is
    // the whole point of where the `timeline-service` split drew this module's
    // boundary: the clamp and the coverage write are a pair, and a split that
    // put a module edge between them would have made the pairing invisible.
    const horizon = planHorizon(deps.now(), deps.config.lookbackDays);
    const segment: Span =
      requested.from.getTime() >= horizon.getTime()
        ? requested
        : { from: horizon, to: requested.to };

    if (segment.from.getTime() >= segment.to.getTime()) {
      // The whole span aged out of the archive while it sat in the queue.
      // Nothing to fetch and nothing to record: recording it would claim
      // coverage over articles no call ever saw, and the next planner clamps
      // this span out of the window anyway, so it cannot re-plan forever.
      deps.log?.warn(
        { fingerprint: job.fingerprint, from: job.from, to: job.to },
        "segment job fell below the lookback horizon before it was fetched; dropping",
      );
      return;
    }

    const query: CanonicalQuery = {
      fingerprint: topic.fingerprint,
      keywords: topic.keywords,
      language: topic.language,
      country: topic.country,
      category: topic.category,
      window: segment,
    };
    // Sliced to the per-call range ceiling. New jobs arrive pre-sliced, but
    // top-ups and jobs enqueued before the ceiling existed can be wider —
    // at-least-once delivery means a deploy must never strand queued work
    // behind a 400 it can no longer avoid.
    const slices = sliceSpan(segment, deps.currents.limits.maxRangeDays * 86_400_000);
    for (const [index, slice] of slices.entries()) {
      const outcome = await fillSegment(
        deps,
        query,
        slice,
        { deadline: Number.POSITIVE_INFINITY, maxCalls: Number.POSITIVE_INFINITY, callsUsed: 0 },
        // The resume page belongs to the slice the deadline actually cut.
        //
        // A stored page number survives the clamp above because upstream sorts
        // `published` DESC (PROBE-FINDINGS §1, verified monotonic): raising a
        // span's lower edge drops articles from the TAIL of that ordering, so
        // pages 1..N-1 hold the same newest articles either way and the
        // narrowed query simply runs out of pages sooner. Resuming at N then
        // reads a short or empty page, which is the honest end-of-results
        // signal for the clamped span — everything in it was already seen.
        index === 0 ? job.startPage : 1,
        // No reader is waiting: draw only what the interactive reserve spares
        // (§9.4). A refusal fails the job; BullMQ's backoff is the retry pacing.
        "background",
        // The plane the PLANNER recorded, never one inferred here. A deferred
        // page of a reader's search and a storyline refresh's top-up arrive at
        // this function looking identical.
        job.plane,
      );
      if (outcome.kind === "truncated") {
        for (const half of await onTruncated(
          deps,
          job.fingerprint,
          slice,
          outcome.oldestSeen,
          job.plane,
        )) {
          await deps.queue.enqueueSegment(half);
        }
      } else if (outcome.kind === "capped") {
        break; // the topic is done spending today; the gap stays visible (§9.4)
      }
    }
  } finally {
    await release(deps.redis, lockKey, token);
  }
}

interface FillBudget {
  /**
   * Epoch ms on `deps.now()`'s clock — the injected one, never `Date.now()`.
   * In production the two are the same live clock, so nothing changes there;
   * in a test they are not, and a deadline read from a clock the test cannot
   * move turns "how many calls fit" into a race against whatever else the
   * machine is doing. One clock for the planner, deadline included.
   */
  deadline: number;
  maxCalls: number;
  callsUsed: number;
}

type FillOutcome =
  | { kind: "completed"; callsMade: number }
  | { kind: "deferred"; resumePage: number; callsMade: number }
  /** `oldestSeen`: the frontier the fetched pages reached, over the
   * coverage-bearing provider's sightings alone (ADR-0012) — null when
   * normalization dropped everything that provider sent. */
  | { kind: "truncated"; callsMade: number; oldestSeen: Date | null }
  /** §9.4: the topic's daily cap is spent. Stop deepening; resume tomorrow. */
  | { kind: "capped"; callsMade: number };

/**
 * Page through one gap segment (§6.3 step 4). A short page is the clean
 * end-of-results signal and records coverage; a full FINAL page means
 * "truncated by the 100-cap", never "finished" — treating it as complete
 * would silently and permanently hide history.
 *
 * **`segment` is fetched AND recorded verbatim.** Nothing in here clamps, and
 * that is the contract §2 depends on: coverage is recorded for the span
 * actually fetched, so a caller handing in a span below the live lookback
 * horizon gets a narrowed request from `clampSearchParams` and a full-width
 * coverage row from here. Both call sites are in this file for that reason.
 */
async function fillSegment(
  deps: CoverageFillDeps,
  query: CanonicalQuery,
  segment: Span,
  budget: FillBudget,
  startPage: number,
  priority: CallPriority,
  plane: SightingPlane,
): Promise<FillOutcome> {
  const { maxPageSize, maxRetrievableResults } = deps.currents.limits;
  const maxPages = Math.floor(maxRetrievableResults / maxPageSize);
  let callsMade = 0;
  let oldestSeen: Date | null = null;

  for (let pageNumber = startPage; pageNumber <= maxPages; pageNumber += 1) {
    // The floor of one call is unconditional: the first synchronous call is
    // the only content a cold topic can have (§11). Every later call must fit
    // both the wall-clock deadline and the call ceiling.
    if (
      budget.callsUsed > 0 &&
      (budget.callsUsed >= budget.maxCalls || deps.now().getTime() >= budget.deadline)
    ) {
      return { kind: "deferred", resumePage: pageNumber, callsMade };
    }

    // The cap binds before every call, INCLUDING the floor-of-one: a capped
    // topic spends nothing today, on either path (§9.4).
    const withinCap = await reserveTopicCall(
      deps.redis,
      query.fingerprint,
      deps.config.perTopicDailyCallCap,
      deps.now(),
    );
    if (!withinCap) {
      deps.log?.warn(
        { fingerprint: query.fingerprint, cap: deps.config.perTopicDailyCallCap },
        "per-topic daily call cap reached; topic stops deepening until tomorrow",
      );
      return { kind: "capped", callsMade };
    }

    const result = await deps.currents.search(
      {
        ...(query.keywords.length > 0 ? { keywords: query.keywords } : {}),
        ...(query.language ? { language: query.language } : {}),
        ...(query.country ? { country: query.country } : {}),
        ...(query.category ? { category: query.category } : {}),
        startDate: segment.from,
        endDate: segment.to,
        pageNumber,
        pageSize: maxPageSize,
      },
      { priority },
    );
    budget.callsUsed += 1;
    callsMade += 1;
    deps.metrics?.upstreamCall({
      received: result.normalization.received,
      dropped: result.normalization.received - result.normalization.kept,
    });
    // The discovery plane's half of the same counter (ADR-0021). Kept even
    // though no discovery provider dates its items today: the metric is a SHARE
    // and a share needs its denominator, so a run with no `date_only` rows here
    // is what "the other providers still time their output" looks like.
    deps.metrics?.sightingsStamped(result.sightings);

    const ingested = await ingestSightings(deps.db, {
      fingerprint: query.fingerprint,
      sightings: result.sightings,
      plane,
      timeZone: deps.config.grouping.timeZone,
      // The storyline re-derivation inside it is fenced and cannot fail this
      // fill; the warning is the only place a failed one surfaces.
      ...(deps.log ? { log: deps.log } : {}),
    });
    deps.metrics?.articlesIngested(ingested.articlesCreated);

    // §14.3, immediately after the collapse and only over what this call
    // created: the two are one write path — one deduplicates by URL, the other
    // groups what URLs alone cannot. Grouping never throws (see the service),
    // so a reader waiting on this fill cannot be failed by it.
    await groupCreatedArticles(groupingDepsFor(deps), ingested.createdArticles);

    // Coverage-bearing sightings only (ADR-0012). The composite merges in
    // supplement sightings, and a supplement that is sparser in this window
    // reaches OLDER than the primary's 100-cap frontier — folding one in would
    // move `oldestSeen` back and record coverage over a span the coverage-
    // bearing provider never fetched, permanently hiding its articles there.
    for (const sighting of result.sightings) {
      if (sighting.provider !== deps.currents.coverageProvider) continue;
      const published = new Date(sighting.published);
      if (oldestSeen === null || published < oldestSeen) oldestSeen = published;
    }

    if (result.isLastPage) {
      await recordCoverage(deps.db, query.fingerprint, segment);
      return { kind: "completed", callsMade };
    }
  }

  return { kind: "truncated", callsMade, oldestSeen };
}

/**
 * Coverage frontier (§6.3 step 4): a truncated segment's five pages are not
 * wasted work — they covered [oldest sighting seen → segment end], so record
 * exactly that and enqueue only the remainder. Every 5 calls advance ~100
 * articles, monotonically, with nothing refetched; under the 7-day range
 * ceiling (§2 drift) the old halve-and-refetch converged so slowly that a
 * dense keyword burned its whole §9.4 cap re-buying page 1.
 *
 * The boundary sits 1ms PAST the frontier: sightings tied at the frontier
 * timestamp may exist beyond the 100-cap, so the covered claim must exclude
 * the frontier instant and leave it to the remainder — re-fetching the tied
 * instant is free (idempotent collapse), silently skipping it is data loss.
 *
 * Halving survives only as the fallback for a frontier that cannot advance
 * (a timestamp pileup), depth-limited at the floor as before.
 *
 * Returns the remainders rather than enqueuing them, because the two callers
 * differ on when they may be published: the read path holds them until it knows
 * the topic is neither degraded nor capped, and the consumer publishes each one
 * as it is produced.
 */
async function onTruncated(
  deps: CoverageFillDeps,
  fingerprint: string,
  segment: Span,
  oldestSeen: Date | null,
  /**
   * The plane the truncated fetch was made on, carried onto its remainder.
   * A remainder is the SAME fetch continued, so re-deciding its reason here
   * would let a deepening walk re-enter the ranking one subdivision at a time.
   */
  plane: SightingPlane,
): Promise<SegmentJob[]> {
  deps.metrics?.truncatedSegment();

  if (oldestSeen !== null) {
    const boundary = new Date(oldestSeen.getTime() + 1);
    if (boundary.getTime() > segment.from.getTime() && boundary.getTime() < segment.to.getTime()) {
      await recordCoverage(deps.db, fingerprint, { from: boundary, to: segment.to });
      return [segmentJob(fingerprint, { from: segment.from, to: boundary }, 1, plane)];
    }
  }

  const length = segment.to.getTime() - segment.from.getTime();
  if (length <= deps.config.minSegmentMs) {
    await recordCoverage(deps.db, fingerprint, segment);
    deps.log?.warn(
      { fingerprint, from: segment.from, to: segment.to },
      "segment truncated at minimum subdivision; accepting partial history",
    );
    return [];
  }

  const mid = new Date(segment.from.getTime() + Math.floor(length / 2));
  return [
    segmentJob(fingerprint, { from: segment.from, to: mid }, 1, plane),
    segmentJob(fingerprint, { from: mid, to: segment.to }, 1, plane),
  ];
}

/**
 * The §6.4 staleness sliver: the requested window reaches the present and all
 * of it is covered except the stretch time itself opened since the last fetch.
 * Identified by shape — a single gap starting exactly at max(coverage.upper) —
 * so a cold topic (no coverage at all) and missing interior history are NOT
 * slivers and still take the synchronous fill the reader is waiting on.
 */
function trailingSliver(
  window: Span,
  gaps: readonly Span[],
  covered: readonly Span[],
  now: Date,
): Span | null {
  if (gaps.length !== 1 || window.to.getTime() < now.getTime()) return null;
  const gap = gaps[0]!;
  const coverageUpper = covered.at(-1)?.to;
  if (!coverageUpper || gap.from.getTime() !== coverageUpper.getTime()) return null;
  return gap;
}
