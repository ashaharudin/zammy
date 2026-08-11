import type { TrendingResponse } from "@zammy/shared";
import {
  ingestSightings,
  readDailyTerms,
  readDayCorpus,
  readTermBaseline,
  refreshTermBaseline,
  replaceDailyTerms,
  upsertTopic,
} from "@zammy/storage";
import { zonedDayBounds, zonedDayKey } from "./app-day.js";
import { fingerprintOf } from "./canonical.js";
import { samplePendingId, type SampleJob } from "./ingest-queue.js";
import { readCachedPage, writeCachedPage } from "./page-cache.js";
import { scoreTerms } from "./term-scoring.js";
import type { TimelineDeps } from "./timeline-service.js";

/**
 * The landing-page cloud (ARCHITECTURE 10). Same posture as every other read
 * path: serve what is stored instantly, repair freshness behind the reader,
 * spend upstream calls only when a real visitor implies demand.
 *
 * The daily breadth sample exists because demand-driven ingestion alone
 * cannot feed a cloud — it must know what is prominent before anyone
 * searches (§10.1). It is triggered by the first visitor of the day, never
 * by a cron: a day with no visitors costs nothing.
 */

export interface TrendingConfig {
  appTimezone: string;
  /** Curated v2-taxonomy categories, comma-joined into ONE call (§10.1). */
  sampleCategories: readonly string[];
  /** Pages per sample. 1 by default; the lever if ~20 proves thin (§10.1). */
  samplePages: number;
  /** How long a snapshot stays fresh; the cadence knob (§10.1, default 60). */
  sampleRefreshMinutes: number;
  baselineWindowDays: number;
}

export interface TrendingDeps extends TimelineDeps {
  trending: TrendingConfig;
}

/** §10.4: trending:<day>:<language>, ~15 minutes. */
const TRENDING_CACHE_TTL_MS = 15 * 60 * 1000;

export async function readTrending(
  deps: TrendingDeps,
  query: { day?: string; language: string; limit: number },
): Promise<TrendingResponse> {
  const now = deps.now();
  const today = zonedDayKey(now, deps.trending.appTimezone);
  const day = query.day ?? today;
  const cacheKey = `trending:${day}:${query.language}`;

  const cached = await readCachedPage<TrendingResponse>(deps.redis, cacheKey);
  if (cached) {
    return { ...cached, meta: { ...cached.meta, servedFrom: "cache" } };
  }

  // The first visitor after the last snapshot staled elects the next sample
  // (§10.1): the lock's TTL IS the freshness window, so cost scales with the
  // clock (≤24 calls/day per language), never with readers. It also keeps N
  // Fargate tasks' simultaneous visitors to one election; the jobId dedup
  // backstops it. Closed days never sample — they are frozen (§10.1).
  if (day === today) {
    try {
      // Day-keyed so the window resets at rollover: the new day's first
      // visitor samples immediately instead of waiting out last night's TTL.
      const elected = await deps.redis.set(
        `lock:sample:${day}:${query.language}`,
        "1",
        "PX",
        Math.max(1, Math.round(deps.trending.sampleRefreshMinutes * 60_000)),
        "NX",
      );
      if (elected === "OK") {
        await deps.queue.enqueueSample({ kind: "sample", day, language: query.language });
      }
    } catch {
      // Redis down: no sample this visit; the stored cloud still serves (§11).
    }
  }

  const terms = await readDailyTerms(deps.db, {
    day,
    language: query.language,
    limit: query.limit,
  });
  const pendingJobs = await deps.queue.pendingCount(samplePendingId({ day, language: query.language }));
  const state: "complete" | "in_progress" = pendingJobs > 0 ? "in_progress" : "complete";

  const response: TrendingResponse = {
    day,
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
  // be a lock-race artifact on the day's very first concurrent visitors —
  // freezing that for 15 minutes would blank the landing page it exists to fill.
  if (state === "complete" && response.terms.length > 0) {
    await writeCachedPage(deps.redis, cacheKey, response, TRENDING_CACHE_TTL_MS);
  }

  return response;
}

/**
 * Queue-consumer handler for the §10.1 breadth sample. Idempotent end to end
 * — category fetches upsert into ordinary topics, the aggregate is replaced
 * wholesale — so BullMQ's at-least-once redelivery after a deploy is safe.
 */
export async function processSampleJob(deps: TrendingDeps, job: SampleJob): Promise<void> {
  const now = deps.now();
  const bounds = zonedDayBounds(job.day, deps.trending.appTimezone);
  const to = new Date(Math.min(bounds.to.getTime(), now.getTime()));

  // Yesterday closed when this day's first visitor arrived: fold it into the
  // rolling baseline BEFORE scoring, so today is judged against history that
  // does not include today (§10.3).
  await refreshTermBaseline(deps.db, {
    language: job.language,
    upToDay: job.day,
    windowDays: deps.trending.baselineWindowDays,
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
      // the day's stored articles beat a blank cloud, and the next visitor
      // past the freshness window tries again (§11).
      deps.log?.warn(
        { err: error, day: job.day },
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
    if (result.isLastPage) break;
  }

  // Recompute the day's aggregate over BOTH corpus sources — the sample and
  // everything user searches already stored today (§10.1).
  const corpus = await readDayCorpus(deps.db, {
    language: job.language,
    from: bounds.from,
    to,
  });
  const baseline = await readTermBaseline(deps.db, job.language);
  await replaceDailyTerms(deps.db, {
    day: job.day,
    language: job.language,
    terms: scoreTerms(corpus, baseline),
  });

  // Next poll must see the fresh aggregate, not a pre-sample cache entry.
  try {
    await deps.redis.del(`trending:${job.day}:${job.language}`);
  } catch {
    // 15 minutes of staleness at worst; the cache is not correctness (§7.1).
  }
}
