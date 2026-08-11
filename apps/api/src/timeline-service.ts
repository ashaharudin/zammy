import type { Kysely } from "kysely";
import type { Redis } from "ioredis";
import { decodeCursor, encodeCursor, type Article } from "@zammy/shared";
import {
  CurrentsQuotaError,
  type CallPriority,
  type CurrentsClient,
} from "@zammy/currents-client";
import {
  ingestSightings,
  readCoverage,
  readTimelinePage,
  readTopic,
  recordCoverage,
  upsertTopic,
  type Database,
} from "@zammy/storage";
import type { CanonicalQuery } from "./canonical.js";
import { subtractCoverage, type Span } from "./coverage-gaps.js";
import {
  freshnessTier,
  freshnessTtlMs,
  pageCacheKey,
  readCachedPage,
  writeCachedPage,
} from "./page-cache.js";
import type { Metrics } from "./metrics.js";
import { refreshLockKey, release, tryAcquire } from "./single-flight.js";
import { reserveTopicCall } from "./topic-budget.js";
import type { IngestQueue, SegmentJob } from "./ingest-queue.js";

/**
 * The query planner (ARCHITECTURE 6.3) — how a page gets filled, or ideally
 * how it is served without filling anything:
 *
 *   cache → store-if-covered → deadline-bounded synchronous fill of the
 *   newest gap → everything unfinished to the queue.
 *
 * Two §12 invariants run through every branch: the single-flight lock
 * deduplicates UPSTREAM CALLS and never queues READERS, and `page.hasMore`
 * (more in our store) stays independent of `meta.ingest.state` (more may
 * still arrive) — conflating them tells users "that's everything" mid-ingest.
 */

export interface TimelineDeps {
  db: Kysely<Database>;
  redis: Redis;
  currents: CurrentsClient;
  queue: IngestQueue;
  config: {
    syncFillDeadlineMs: number;
    maxSyncUpstreamCalls: number;
    lookbackDays: number;
    /** Subdivision floor (§6.3): below this, truncation is accepted, not recursed. */
    minSegmentMs: number;
    /** §9.4: upstream calls one topic may spend per UTC day, both paths combined. */
    perTopicDailyCallCap: number;
  };
  now: () => Date;
  metrics?: Metrics;
  log?: {
    warn: (obj: object, msg: string) => void;
    info?: (obj: object, msg: string) => void;
  };
}

export interface TimelineReadResult {
  topic: {
    fingerprint: string;
    keywords: string[];
    coverage: { from: string; to: string } | null;
  };
  items: Article[];
  page: { nextCursor: string | null; hasMore: boolean };
  meta: {
    servedFrom: "cache" | "store" | "upstream";
    asOf: string;
    stale: boolean;
    degraded: "quota" | "upstream" | null;
    ingest: { state: "complete" | "in_progress"; pendingJobs: number };
  };
}

/** A malformed cursor is a bad request, not a crash (shared/cursor). */
export class InvalidCursorError extends Error {
  override readonly name = "InvalidCursorError";
}

export async function readTimeline(
  deps: TimelineDeps,
  query: CanonicalQuery,
  page: { limit: number; cursorString?: string },
): Promise<TimelineReadResult> {
  const startedAt = Date.now();
  const result = await planAndRead(deps, query, page);
  deps.metrics?.timelineRead(result.meta.servedFrom, (Date.now() - startedAt) / 1000);
  return result;
}

async function planAndRead(
  deps: TimelineDeps,
  query: CanonicalQuery,
  page: { limit: number; cursorString?: string },
): Promise<TimelineReadResult> {
  const now = deps.now();

  const cursor = page.cursorString ? decodeCursor(page.cursorString) : null;
  if (page.cursorString && !cursor) {
    throw new InvalidCursorError(`unusable cursor: ${page.cursorString.slice(0, 40)}`);
  }

  // §6.3 step 1 — page cache. A hit costs nothing and touches nothing.
  const cacheKey = pageCacheKey(
    query.fingerprint,
    query.window,
    page.cursorString ?? null,
    page.limit,
  );
  const cached = await readCachedPage<TimelineReadResult>(deps.redis, cacheKey);
  deps.metrics?.pageCacheRead(freshnessTier(query.window.to, now), cached ? "hit" : "miss");
  if (cached) {
    return { ...cached, meta: { ...cached.meta, servedFrom: "cache" } };
  }

  // The topic exists (and counts a hit) from the first request onward, so
  // deferred jobs enqueued below can always recover the search parameters.
  await upsertTopic(deps.db, {
    fingerprint: query.fingerprint,
    keywords: query.keywords,
    language: query.language,
    country: query.country,
    category: query.category,
  });

  // §6.3 steps 2–3 — is the window covered? If not, where exactly isn't it?
  const covered = await readCoverage(deps.db, query.fingerprint);
  const gaps = subtractCoverage(query.window, covered, {
    now,
    lookbackDays: deps.config.lookbackDays,
  });

  let servedFrom: TimelineReadResult["meta"]["servedFrom"] = "store";
  let degraded: TimelineReadResult["meta"]["degraded"] = null;
  let lockLostToPeer = false;
  let stale = false;
  let capped = false;

  // §6.4 refresh-on-read: a window reaching the present is never "fully
  // covered" — time itself keeps opening a sliver past max(coverage.upper).
  // Inside the staleness tier that sliver IS fresh enough; beyond it, the
  // reader is served instantly and the repair happens behind them. Only real
  // gaps — a cold topic, missing interior history — reach the sync fill.
  const sliver = trailingSliver(query.window, gaps, covered, now);
  if (sliver) {
    const age = now.getTime() - sliver.from.getTime();
    if (age > freshnessTtlMs(query.window.to, now)) {
      stale = true;
      await deps.queue.enqueueSegment({
        ...segmentJob(query.fingerprint, sliver, 1),
        kind: "topup",
      });
    }
  } else if (gaps.length > 0) {
    // §6.3 steps 4–5 — fill what fits the wall-clock deadline, newest gap
    // first (that is where the reader is looking), defer the rest.
    const budget: FillBudget = {
      deadline: Date.now() + deps.config.syncFillDeadlineMs,
      maxCalls: deps.config.maxSyncUpstreamCalls,
      callsUsed: 0,
    };
    const deferred: SegmentJob[] = [];

    for (const gap of gaps) {
      if (budget.callsUsed >= budget.maxCalls || (budget.callsUsed > 0 && Date.now() >= budget.deadline)) {
        deferred.push(segmentJob(query.fingerprint, gap, 1));
        continue;
      }

      const lockKey = refreshLockKey(query.fingerprint, gap);
      const token = await tryAcquire(deps.redis, lockKey, 10_000);
      if (!token) {
        // Someone else is already fetching this segment. Their calls, their
        // enqueues; we serve the store immediately and say "in progress".
        lockLostToPeer = true;
        continue;
      }

      try {
        const outcome = await fillSegment(deps, query, gap, budget, 1, "interactive");
        if (outcome.callsMade > 0) servedFrom = "upstream";
        if (outcome.kind === "deferred") {
          deferred.push(segmentJob(query.fingerprint, gap, outcome.resumePage));
        } else if (outcome.kind === "truncated") {
          deferred.push(...(await onTruncated(deps, query.fingerprint, gap)));
        } else if (outcome.kind === "capped") {
          capped = true;
        }
      } catch (error) {
        degraded = error instanceof CurrentsQuotaError ? "quota" : "upstream";
        deps.log?.warn(
          { err: error, fingerprint: query.fingerprint },
          "synchronous fill failed; serving from store",
        );
        break;
      } finally {
        await release(deps.redis, lockKey, token);
      }

      if (capped) break;
    }

    // A capped topic enqueues nothing: queued IOUs would only no-op against
    // the same cap, and tomorrow's reader re-plans the gaps anyway (§9.4).
    if (!degraded && !capped) {
      for (const job of deferred) await deps.queue.enqueueSegment(job);
    }
  }

  // §6.3 step 6 — ALWAYS answer from Postgres, never from the raw upstream
  // response, which is neither deduplicated nor ordered across sliced calls.
  const stored = await readTimelinePage(deps.db, {
    fingerprint: query.fingerprint,
    from: query.window.from,
    to: query.window.to,
    ...(cursor ? { cursor } : {}),
    limit: page.limit,
  });

  const pendingJobs = await deps.queue.pendingCount(query.fingerprint);
  const state: "complete" | "in_progress" =
    pendingJobs > 0 || lockLostToPeer ? "in_progress" : "complete";

  const coverageNow = gaps.length > 0 ? await readCoverage(deps.db, query.fingerprint) : covered;
  const first = coverageNow[0];
  const last = coverageNow.at(-1);

  const result: TimelineReadResult = {
    topic: {
      fingerprint: query.fingerprint,
      keywords: query.keywords,
      coverage:
        first && last
          ? { from: first.from.toISOString(), to: last.to.toISOString() }
          : null,
    },
    items: stored.items,
    page: {
      nextCursor: stored.nextCursor ? encodeCursor(stored.nextCursor) : null,
      hasMore: stored.hasMore,
    },
    meta: {
      servedFrom,
      asOf: now.toISOString(),
      stale,
      degraded,
      ingest: { state, pendingJobs },
    },
  };

  // Cache only settled pages. A cached in_progress response would freeze the
  // progressive fill for its whole TTL — the front end polls expecting growth
  // (§6.5 point 4) — a degraded one would outlive the outage, and a capped one
  // has unfilled, unqueued gaps that tomorrow's budget is meant to repair.
  // Stale is checked on its own because the in-process consumer can finish
  // the top-up before pendingCount runs, making a stale read look settled.
  if (state === "complete" && degraded === null && !capped && !stale) {
    await writeCachedPage(
      deps.redis,
      cacheKey,
      result,
      freshnessTtlMs(query.window.to, now),
    );
  }

  return result;
}

/**
 * Queue-consumer handler (§9.1): finish what a deadline cut off. Runs with no
 * deadline and no call ceiling of its own — the queue's retry/backoff is the
 * pacing — but still under the segment lock, so a background fill and a
 * user-triggered fill of the same segment cannot double-spend.
 */
export async function processSegmentJob(deps: TimelineDeps, job: SegmentJob): Promise<void> {
  const topic = await readTopic(deps.db, job.fingerprint);
  if (!topic) throw new Error(`segment job for unknown topic ${job.fingerprint}`);

  const segment: Span = { from: new Date(job.from), to: new Date(job.to) };
  const lockKey = refreshLockKey(job.fingerprint, segment);
  const token = await tryAcquire(deps.redis, lockKey, 30_000);
  // Held by someone else: fail so BullMQ redelivers after backoff, by which
  // time the other fetcher has either finished (re-run is idempotent and
  // cheap: coverage already recorded) or crashed (lock expired).
  if (!token) throw new Error(`segment ${lockKey} is locked; retrying later`);

  try {
    const query: CanonicalQuery = {
      fingerprint: topic.fingerprint,
      keywords: topic.keywords,
      language: topic.language,
      country: topic.country,
      category: topic.category,
      window: segment,
    };
    const outcome = await fillSegment(
      deps,
      query,
      segment,
      { deadline: Number.POSITIVE_INFINITY, maxCalls: Number.POSITIVE_INFINITY, callsUsed: 0 },
      job.startPage,
      // No reader is waiting: draw only what the interactive reserve spares
      // (§9.4). A refusal fails the job; BullMQ's backoff is the retry pacing.
      "background",
    );
    if (outcome.kind === "truncated") {
      for (const half of await onTruncated(deps, job.fingerprint, segment)) {
        await deps.queue.enqueueSegment(half);
      }
    }
  } finally {
    await release(deps.redis, lockKey, token);
  }
}

interface FillBudget {
  deadline: number;
  maxCalls: number;
  callsUsed: number;
}

type FillOutcome =
  | { kind: "completed"; callsMade: number }
  | { kind: "deferred"; resumePage: number; callsMade: number }
  | { kind: "truncated"; callsMade: number }
  /** §9.4: the topic's daily cap is spent. Stop deepening; resume tomorrow. */
  | { kind: "capped"; callsMade: number };

/**
 * Page through one gap segment (§6.3 step 4). A short page is the clean
 * end-of-results signal and records coverage; a full FINAL page means
 * "truncated by the 100-cap", never "finished" — treating it as complete
 * would silently and permanently hide history.
 */
async function fillSegment(
  deps: TimelineDeps,
  query: CanonicalQuery,
  segment: Span,
  budget: FillBudget,
  startPage: number,
  priority: CallPriority,
): Promise<FillOutcome> {
  const { maxPageSize, maxRetrievableResults } = deps.currents.limits;
  const maxPages = Math.floor(maxRetrievableResults / maxPageSize);
  let callsMade = 0;

  for (let pageNumber = startPage; pageNumber <= maxPages; pageNumber += 1) {
    // The floor of one call is unconditional: the first synchronous call is
    // the only content a cold topic can have (§11). Every later call must fit
    // both the wall-clock deadline and the call ceiling.
    if (
      budget.callsUsed > 0 &&
      (budget.callsUsed >= budget.maxCalls || Date.now() >= budget.deadline)
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

    const ingested = await ingestSightings(deps.db, {
      fingerprint: query.fingerprint,
      sightings: result.sightings,
    });
    deps.metrics?.articlesIngested(ingested.articlesCreated);

    if (result.isLastPage) {
      await recordCoverage(deps.db, query.fingerprint, segment);
      return { kind: "completed", callsMade };
    }
  }

  return { kind: "truncated", callsMade };
}

/**
 * Adaptive subdivision (§6.3 step 4): the only way to reach articles the
 * 100-cap hides. Depth-limited — at the floor the truncation is accepted and
 * the segment recorded as covered, or a pathologically dense keyword would
 * recurse until it consumed the whole daily quota.
 */
async function onTruncated(
  deps: TimelineDeps,
  fingerprint: string,
  segment: Span,
): Promise<SegmentJob[]> {
  deps.metrics?.truncatedSegment();
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
    segmentJob(fingerprint, { from: segment.from, to: mid }, 1),
    segmentJob(fingerprint, { from: mid, to: segment.to }, 1),
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

function segmentJob(fingerprint: string, segment: Span, startPage: number): SegmentJob {
  return {
    fingerprint,
    from: segment.from.toISOString(),
    to: segment.to.toISOString(),
    startPage,
  };
}
