import type { TrendingResponse } from "@zammy/shared";
import {
  hourBucket,
  ingestSightings,
  readTermBaseline,
  readTrendingTerms,
  readWindowCorpus,
  recordTermSnapshot,
  refreshTermBaseline,
  replaceTrendingTerms,
  upsertTopic,
} from "@zammy/storage";
import { fingerprintOf } from "./canonical.js";
import { groupCreatedArticles, groupingDepsFor } from "./grouping-service.js";
import { samplePendingId, type SampleJob } from "./ingest-queue.js";
import { readCachedPage, writeCachedPage } from "./page-cache.js";
import { scoreTerms } from "./term-scoring.js";
import type { TimelineDeps } from "./timeline-service.js";

/**
 * The landing-page cloud (ARCHITECTURE 10). Same posture as every other read
 * path: serve what is stored instantly, repair freshness behind the reader,
 * spend upstream calls only when a real visitor implies demand.
 *
 * The breadth sample exists because demand-driven ingestion alone cannot feed
 * a cloud — it must know what is prominent before anyone searches (§10.1). It
 * is triggered by the first visitor after the last snapshot staled, never by a
 * cron: an hour with no visitors costs nothing.
 *
 * The window rolls with `now` rather than resetting at midnight (ADR-0008), so
 * nothing here is keyed by day: one live cloud per language, one lock, one
 * cache entry, and no period that can be closed or asked about after the fact.
 */

export interface TrendingConfig {
  /** Curated v2-taxonomy categories, comma-joined into ONE call (§10.1). */
  sampleCategories: readonly string[];
  /** Pages per sample. 1 by default; the lever if ~20 proves thin (§10.1). */
  samplePages: number;
  /** How long a snapshot stays fresh; the cadence knob (§10.1, default 60). */
  sampleRefreshMinutes: number;
  /** How far back the cloud looks, in hours (§10.1, default 24). */
  windowHours: number;
  /** Recency half-life in hours (§10.3, default 8). */
  halfLifeHours: number;
  baselineWindowDays: number;
}

export interface TrendingDeps extends TimelineDeps {
  trending: TrendingConfig;
}

/** §10.4: trending:<language>, ~15 minutes. */
const TRENDING_CACHE_TTL_MS = 15 * 60 * 1000;

/** The window ending at `now`, as the corpus read and the response want it. */
function windowBounds(now: Date, windowHours: number): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - windowHours * 3_600_000), to: now };
}

export async function readTrending(
  deps: TrendingDeps,
  query: { language: string; limit: number },
): Promise<TrendingResponse> {
  const now = deps.now();
  const { from } = windowBounds(now, deps.trending.windowHours);
  const cacheKey = `trending:${query.language}`;

  const cached = await readCachedPage<TrendingResponse>(deps.redis, cacheKey);
  if (cached) {
    return { ...cached, meta: { ...cached.meta, servedFrom: "cache" } };
  }

  // The first visitor after the last snapshot staled elects the next sample
  // (§10.1): the lock's TTL IS the freshness window, so cost scales with the
  // clock (≤24 calls/day per language), never with readers. It also keeps N
  // Fargate tasks' simultaneous visitors to one election; the jobId dedup
  // backstops it. No day in the key — the TTL alone governs cadence now, where
  // the frozen-day design had to reset it at each rollover (ADR-0008).
  try {
    const elected = await deps.redis.set(
      `lock:sample:${query.language}`,
      "1",
      "PX",
      Math.max(1, Math.round(deps.trending.sampleRefreshMinutes * 60_000)),
      "NX",
    );
    if (elected === "OK") {
      await deps.queue.enqueueSample({ kind: "sample", language: query.language });
    }
  } catch {
    // Redis down: no sample this visit; the stored cloud still serves (§11).
  }

  const terms = await readTrendingTerms(deps.db, {
    language: query.language,
    limit: query.limit,
  });
  const pendingJobs = await deps.queue.pendingCount(
    samplePendingId({ language: query.language }),
  );
  const state: "complete" | "in_progress" = pendingJobs > 0 ? "in_progress" : "complete";

  const response: TrendingResponse = {
    windowStart: from.toISOString(),
    windowEnd: now.toISOString(),
    language: query.language,
    terms: terms.map((t) => ({
      term: t.term,
      isBigram: t.isBigram,
      uniqueArticles: t.dfArticles,
      sourceCount: t.dfDomains,
      score: t.score,
    })),
    meta: {
      servedFrom: "store",
      asOf: now.toISOString(),
      stale: false,
      degraded: null,
      ingest: { state, pendingJobs },
    },
  };

  // Cache only a settled, non-empty cloud: an in_progress one must keep
  // growing under the front end's poll (§6.5), and an empty "complete" can
  // be a lock-race artifact on the very first concurrent visitors — freezing
  // that for 15 minutes would blank the landing page it exists to fill.
  if (state === "complete" && response.terms.length > 0) {
    await writeCachedPage(deps.redis, cacheKey, response, TRENDING_CACHE_TTL_MS);
  }

  return response;
}

/**
 * Queue-consumer handler for the §10.1 breadth sample. Idempotent end to end
 * — category fetches upsert into ordinary topics, the cloud is replaced
 * wholesale, the snapshot upserts on its hour — so BullMQ's at-least-once
 * redelivery after a deploy is safe.
 */
export async function processSampleJob(deps: TrendingDeps, job: SampleJob): Promise<void> {
  const now = deps.now();
  const { from, to } = windowBounds(now, deps.trending.windowHours);

  // Fold the snapshot history into the baseline BEFORE scoring. The refresh
  // reads only snapshots older than one window, so the corpus about to be
  // scored cannot contribute to what suppresses it (§10.3).
  await refreshTermBaseline(deps.db, {
    language: job.language,
    now,
    windowHours: deps.trending.windowHours,
    baselineWindowDays: deps.trending.baselineWindowDays,
  });

  // Corpus source 2: ONE /v2/latest-news call carrying the whole curated
  // category list (PROBE-FINDINGS 6c) — comma-joined, page shared across
  // categories. Sampled sightings ingest under the keyword-less all-category
  // topic: same fingerprint scheme, same collapse; unreachable by users, who
  // cannot canonicalize an empty search. Coverage is NOT recorded — a
  // snapshot of the moment is not coverage of anything.
  const identity = {
    keywords: [] as string[],
    language: job.language,
    country: null,
    category: null,
  };
  const fingerprint = fingerprintOf(identity);
  await upsertTopic(deps.db, { fingerprint, ...identity });

  for (let pageNumber = 1; pageNumber <= deps.trending.samplePages; pageNumber += 1) {
    let result;
    try {
      result = await deps.currents.latestNews(
        {
          language: job.language,
          categories: deps.trending.sampleCategories,
          pageNumber,
        },
        { priority: "background" },
      );
    } catch (error) {
      // Quota or upstream trouble: keep what we have and still recompute —
      // the window's stored articles beat a blank cloud, and the next visitor
      // past the freshness window tries again (§11).
      deps.log?.warn(
        { err: error },
        "latest-news sample failed; scoring with the stored corpus only",
      );
      break;
    }
    deps.metrics?.upstreamCall({
      received: result.normalization.received,
      dropped: result.normalization.received - result.normalization.kept,
    });
    const ingested = await ingestSightings(deps.db, {
      fingerprint,
      sightings: result.sightings,
    });
    deps.metrics?.articlesIngested(ingested.articlesCreated);
    // The sample is a write path into `articles` like any other, so it owes
    // grouping the same call the timeline fill makes (§14.3). It is also the
    // most syndication-dense source we have — one latest-news page spans every
    // category and outlet — and an article ingested here without tokens is
    // both un-groupable itself and invisible as a candidate to every article
    // ingested after it.
    await groupCreatedArticles(groupingDepsFor(deps), ingested.createdArticles);
    if (result.isLastPage) break;
  }

  // Recompute over BOTH corpus sources — the sample and everything user
  // searches already stored inside the window (§10.1).
  const corpus = await readWindowCorpus(deps.db, { language: job.language, from, to });
  const baseline = await readTermBaseline(deps.db, job.language);
  const scored = scoreTerms(corpus, baseline, {
    now,
    halfLifeHours: deps.trending.halfLifeHours,
  });

  await replaceTrendingTerms(deps.db, {
    language: job.language,
    windowStart: from,
    windowEnd: to,
    terms: scored,
  });

  // Record what this recompute saw, at RAW counts, under the hour it ran:
  // tomorrow's baseline is made of these rows and nothing else (§10.3).
  await recordTermSnapshot(deps.db, {
    language: job.language,
    bucketHour: hourBucket(now),
    terms: scored,
  });

  // Next poll must see the fresh cloud, not a pre-sample cache entry.
  try {
    await deps.redis.del(`trending:${job.language}`);
  } catch {
    // 15 minutes of staleness at worst; the cache is not correctness (§7.1).
  }
}
