import { TRENDING_LIMIT_MAX, type TrendingResponse } from "@zammy/shared";
import { ingestSightings, readTrendingStorylines, upsertTopic } from "@zammy/storage";
import { fingerprintOf } from "./canonical.js";
import { groupCreatedArticles, groupingDepsFor } from "./grouping-service.js";
import { samplePendingId, type SampleJob } from "./ingest-queue.js";
import { readCachedPage, writeCachedPage } from "./page-cache.js";
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
 *
 * What the cloud NAMES is storylines, not extracted terms (ADR-0013), and the
 * consequence for this file is that the sample no longer computes a cloud. It
 * ingests and groups, the linker attaches what it created, and the read
 * aggregates `storylines` directly — so the two halves below are now
 * independent: the sample feeds the corpus, and nothing has to run for the
 * window to have rolled.
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
}

export interface TrendingDeps extends TimelineDeps {
  trending: TrendingConfig;
}

/** §10.4: the cached cloud, ~15 minutes. */
const TRENDING_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Both keys are scoped to the ingest queue, exactly as its pending keys are.
 * Replicas share the "ingest" queue and so still elect ONE sampler between
 * them, while a differently-named queue cannot reach this one's state — which
 * matters now that the day is gone from the key (ADR-0008): `lock:sample:en`
 * would otherwise be the SAME string in a test run and in the local dev
 * server sharing that Redis, and a 60-minute lock left by either would
 * silence the other's sampling.
 */
const cacheKeyFor = (deps: TrendingDeps, language: string): string =>
  `${deps.queue.name}:trending:${language}`;

const sampleLockFor = (deps: TrendingDeps, language: string): string =>
  `${deps.queue.name}:lock:sample:${language}`;

/** The window ending at `now`, as the storyline read and the response want it. */
function windowBounds(now: Date, windowHours: number): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - windowHours * 3_600_000), to: now };
}

export async function readTrending(
  deps: TrendingDeps,
  query: { language: string; limit: number },
): Promise<TrendingResponse> {
  const now = deps.now();
  const { from, to } = windowBounds(now, deps.trending.windowHours);
  const cacheKey = cacheKeyFor(deps, query.language);

  const cached = await readCachedPage<TrendingResponse>(deps.redis, cacheKey);
  if (cached) {
    return {
      ...cached,
      storylines: cached.storylines.slice(0, query.limit),
      meta: { ...cached.meta, servedFrom: "cache" },
    };
  }

  // The first visitor after the last snapshot staled elects the next sample
  // (§10.1): the lock's TTL IS the freshness window, so cost scales with the
  // clock (≤24 calls/day per language), never with readers. It also keeps N
  // Fargate tasks' simultaneous visitors to one election; the jobId dedup
  // backstops it. No day in the key — the TTL alone governs cadence now, where
  // the frozen-day design had to reset it at each rollover (ADR-0008).
  try {
    const elected = await deps.redis.set(
      sampleLockFor(deps, query.language),
      "1",
      "PX",
      Math.max(1, Math.round(deps.trending.sampleRefreshMinutes * 60_000)),
      "NX",
    );
    if (elected === "OK") {
      await deps.queue.enqueueSample({ kind: "sample", language: query.language });
    }
  } catch {
    // Redis down: no sample this visit; the stored corpus still answers (§11).
  }

  // The FULL ranked list, not this caller's slice: the cache key names a
  // language and nothing else, so a `?limit=4` request would otherwise cache
  // a four-word cloud and every reader behind it would see one for the next
  // fifteen minutes. Storylines come back most recently updated first (§10.4),
  // so every limit is a prefix of the same list and readers never disagree
  // about what leads.
  const storylines = await readTrendingStorylines(deps.db, {
    language: query.language,
    from,
    to,
    limit: TRENDING_LIMIT_MAX,
  });
  const pendingJobs = await deps.queue.pendingCount(
    samplePendingId({ language: query.language }),
  );
  const state: "complete" | "in_progress" = pendingJobs > 0 ? "in_progress" : "complete";

  const response: TrendingResponse = {
    windowStart: from.toISOString(),
    windowEnd: to.toISOString(),
    language: query.language,
    storylines: dedupeByLabel(storylines).map((storyline) => ({
      id: storyline.id,
      label: storyline.label,
      windowArticles: storyline.windowArticles,
      size: storyline.size,
      sourceCount: storyline.sourceCount,
      lastUpdated: storyline.lastUpdated.toISOString(),
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
  if (state === "complete" && response.storylines.length > 0) {
    await writeCachedPage(deps.redis, cacheKey, response, TRENDING_CACHE_TTL_MS);
  }

  return { ...response, storylines: response.storylines.slice(0, query.limit) };
}

/**
 * One word per label, keeping the most recently updated claimant.
 *
 * Labels are deliberately non-unique (ADR-0011): two storylines may be named
 * the same thing, and the dev archive holds three called "Trump
 * Administration". A timeline can tell them apart, because a pill has room for
 * a date qualifier; a cloud cannot — it would simply draw the same word twice,
 * at two sizes, in two colours, and a reader clicking either gets the same
 * search. So the cloud is a set of WORDS, and the freshest claimant keeps it.
 *
 * The rows arrive most-recently-updated first, so "first wins" IS "freshest
 * wins" and this needs no comparison of its own.
 */
function dedupeByLabel<T extends { label: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.label.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Queue-consumer handler for the §10.1 breadth sample: ingest a page of
 * `/v2/latest-news`, group what it creates, and let the linker do the rest.
 *
 * Idempotent end to end — category fetches upsert into ordinary topics,
 * re-ingested articles collapse into their existing rows (§7.4), and grouping
 * re-derives rather than re-homing — so BullMQ's at-least-once redelivery after
 * a deploy is safe.
 *
 * It no longer computes anything for the cloud. Under the term design this
 * handler scored the window and replaced `trending_terms`; the cloud is a
 * query over storylines now (ADR-0013), and what makes a storyline appear in it
 * is the linker running on the write path, which `groupCreatedArticles` already
 * calls. So this job's only product is corpus.
 */
export async function processSampleJob(deps: TrendingDeps, job: SampleJob): Promise<void> {
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
      // Quota or upstream trouble: the window's stored storylines still make a
      // cloud, and the next visitor past the freshness window tries again
      // (§11). Nothing is left half-computed, because nothing is computed.
      deps.log?.warn(
        { err: error },
        "latest-news sample failed; the cloud stands on the stored corpus",
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
    // grouping the same call the timeline fill makes (§14.3) — and grouping is
    // what runs the linker, so this is also the only thing that puts a sampled
    // story into a storyline the cloud can name. It is the most
    // syndication-dense source we have: one latest-news page spans every
    // category and outlet, and an article ingested here without tokens is both
    // un-groupable itself and invisible as a candidate to every article
    // ingested after it.
    await groupCreatedArticles(groupingDepsFor(deps), ingested.createdArticles);
    if (result.isLastPage) break;
  }

  // Next poll must see the storylines this sample grew, not a pre-sample entry.
  try {
    await deps.redis.del(cacheKeyFor(deps, job.language));
  } catch {
    // 15 minutes of staleness at worst; the cache is not correctness (§7.1).
  }
}
