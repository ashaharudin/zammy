import type { Kysely } from "kysely";
import type { Redis } from "ioredis";
import { TRENDING_LIMIT_MAX, type TrendingResponse } from "@zammy/shared";
import type { CurrentsClient } from "@zammy/currents-client";
import {
  ingestSightings,
  readTrendingStorylines,
  upsertTopic,
  type Database,
} from "@zammy/storage";
import { fingerprintOf } from "./canonical.js";
import { cloudQuery } from "./cloud-query.js";
import {
  groupCreatedArticles,
  groupingDepsFor,
  type GroupingDeps,
} from "./grouping-service.js";
import { samplePendingId, type IngestQueue, type SampleJob } from "./ingest-queue.js";
import type { Metrics } from "./metrics.js";
import { readCachedPage, writeCachedPage } from "./page-cache.js";

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
  /**
   * The ranking decay's half-life in hours (§10.3, default 8) — how fast an
   * article's contribution to a storyline's position ages out. Back from
   * ADR-0008, which chose exponential decay and this default over a linear
   * ramp, and which ADR-0013 deleted along with the score it weighted.
   */
  halfLifeHours: number;
}

/**
 * What the cloud needs, stated rather than inherited.
 *
 * It used to read `extends TimelineDeps`, which handed the landing page a
 * deepening provider, a segment queue and every knob the §6.3 planner owns —
 * none of which a cloud read or a breadth sample can reach. The list below is
 * the whole of it, and the two narrowings are the ones that were actually
 * wrong: `latestNews` is the only upstream call on this path (§10.1), and the
 * sample is the only thing that may publish, one job per language.
 *
 * `config.grouping` rather than a bag: the sample is a write path into
 * `articles` like any other, so it owes grouping the same call the timeline
 * fill makes, judged at the same bar (`wiring.ts`).
 */
export interface TrendingDeps {
  db: Kysely<Database>;
  redis: Redis;
  currents: Pick<CurrentsClient, "latestNews">;
  queue: Pick<IngestQueue, "name" | "enqueueSample" | "pendingCount">;
  config: { grouping: GroupingDeps["config"] };
  now: () => Date;
  labeler?: GroupingDeps["labeler"];
  metrics?: Metrics;
  log?: { warn: (obj: object, msg: string) => void };
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
  // fifteen minutes. Storylines come back busiest-and-freshest first (§10.4),
  // so every limit is a prefix of the same list and readers never disagree
  // about what leads.
  const storylines = await readTrendingStorylines(deps.db, {
    language: query.language,
    from,
    to,
    halfLifeHours: deps.trending.halfLifeHours,
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
      // The click's search, resolved here rather than in the browser: it is a
      // fact about the arc's coverage, and the front end holds no profile
      // tokens to derive it from (ADR-0014, `cloudQuery`).
      query: cloudQuery(storyline),
      windowArticles: storyline.windowArticles,
      windowSources: storyline.windowSources,
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
 * One word per label, keeping the highest-ranked claimant.
 *
 * Labels are deliberately non-unique (ADR-0011): two storylines may be named
 * the same thing, and the dev archive holds three called "Trump
 * Administration". A timeline can tell them apart, because a pill has room for
 * a date qualifier; a cloud cannot — it would simply draw the same word twice,
 * at two sizes, in two colours, and a reader clicking either gets the same
 * search. So the cloud is a set of WORDS, and one claimant keeps it.
 *
 * The rows arrive in rank order, so "first wins" IS "best wins" and this needs
 * no comparison of its own. Which claimant that names changed with ADR-0014 —
 * the busiest-and-freshest rather than simply the freshest — and it changed for
 * the better: of two storylines called "Climate Change", the one carrying six
 * articles from six outlets is the one whose word this should be, and under a
 * pure recency sort it lost to a one-article namesake that moved minutes later.
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
 * `/v2/latest-news`, group what it creates, let the linker do the rest, and
 * wait for the labeller to name what the linker promoted.
 *
 * Idempotent end to end — category fetches upsert into ordinary topics,
 * re-ingested articles collapse into their existing rows (§7.4), and grouping
 * re-derives rather than re-homing — so BullMQ's at-least-once redelivery after
 * a deploy is safe.
 *
 * It computes nothing for the cloud. Under the term design this handler scored
 * the window and replaced `trending_terms`; the cloud is a query over
 * storylines now (ADR-0013), and what makes a storyline appear in it is the
 * linker running on the write path, which `groupCreatedArticles` already calls.
 * So this job's product is corpus — but corpus is not enough for the cloud to
 * READ it, because the query wants a label, and the label arrives on a tail
 * every other caller drops. This job holds that tail; see the await below.
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

  // The label tails this sample starts, kept rather than dropped — see the
  // await below for why this job is the one caller that must not walk away.
  const labelTails: Promise<void>[] = [];

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
    // The breadth plane's contribution to the stamp-quality share (ADR-0021).
    // Every `ingestSightings` call site owes this, because the metric is a SHARE
    // and one missing plane makes the denominator quietly wrong — and this is
    // the densest of the three. No `date_only` row can originate here today
    // (`server.ts` wires the deepening provider to the deepening plane alone),
    // which is exactly why it is worth counting: this is what a plane that
    // times its output looks like.
    deps.metrics?.sightingsStamped(result.sightings);
    const ingested = await ingestSightings(deps.db, {
      fingerprint,
      sightings: result.sightings,
      // `breadth` (ADR-0019). Nobody asked for these articles and no ranking
      // chose them — the sample is a periodic slice of whatever upstream is
      // carrying — so they are demand we did not manufacture, and they COUNT
      // toward the cloud. That is the distinction the plane exists to draw:
      // not "did a human trigger it" but "did our own output pick the target".
      plane: "breadth",
      // The same day rule grouping runs on: a fold moves which day an article
      // belongs to, and the ingest keeps its storylines' slots in step.
      timeZone: deps.config.grouping.timeZone,
      // That re-derivation is fenced and cannot fail the sample; the warning is
      // the only place a failed one surfaces.
      ...(deps.log ? { log: deps.log } : {}),
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
    await groupCreatedArticles(
      // The tail is caught HERE rather than at the await below; see that
      // comment for why the two windows are different.
      groupingDepsFor(deps, (task) =>
        labelTails.push(
          task.catch((error: unknown) => {
            deps.log?.warn({ err: error }, "label tail rejected during breadth sample");
          }),
        ),
      ),
      ingested.createdArticles,
    );
    if (result.isLastPage) break;
  }

  // Labelling is not a garnish on this job, it is the last step of it: the
  // cloud reads `s.label is not null`, so a storyline the linker just promoted
  // is INVISIBLE to it until the tail names the thing. The linker starts that
  // tail and drops it (`void tail`, grouping-service), which is right on the
  // timeline's sync-fill path — a label averages ~8s against the §6.3 deadline
  // a reader is waiting on — and wrong here, where the only thing waiting is a
  // queue worker.
  //
  // Dropping it here cost a measured outage of the landing page. On the dev
  // archive a sample ingested at 15:05:27, the job returned and cleared the
  // cache at ~15:05:35, and 61 labels landed between 15:05:36 and 15:08:15. The
  // visitor who arrived in that gap read a cloud of 3 — the leftovers from the
  // previous day, the only rows already named — and because the sample job was
  // finished, `state` was "complete" and the read cached those 3 for the full
  // §10.4 fifteen minutes. Sixteen storylines that qualified on every other
  // count were named seconds too late to be in it, and nothing re-invalidated.
  // At a 60-minute refresh that is the whole hour's cloud, and the visitor who
  // triggers the sample is the one guaranteed to see it.
  //
  // `allSettled`, not `all`: the tail's contract is that it never throws for a
  // model reason, and today it keeps it — `labelLinkedStorylines` wraps each
  // storyline, and `resolvePendingFormations` wraps each outcome, so no known
  // path rejects. This does not lean on that. If one ever does we still want
  // the invalidation below: skipping it would leave a stale cloud cached AND
  // fail a job whose ingest already succeeded, re-fetching a page on retry.
  //
  // Which is also why the `.catch` above is attached where the tail is PUSHED
  // rather than here. This await is after the page loop, so a page-1 rejection
  // arriving while page 2 ingests would be unhandled — process-ending by
  // default — before `allSettled` is ever reached. `allSettled` covers the
  // window from here on; the push-time catch covers the window before it.
  await Promise.allSettled(labelTails);

  // Next poll must see the storylines this sample grew and the labeller reached,
  // not a pre-sample entry. Awaiting above is what makes this line true rather
  // than merely early; it also keeps the job in the pending set while the
  // labeller runs, so a read landing mid-sample sees `in_progress` and declines
  // to cache a half-named cloud — a backstop, not the fix, since `pendingCount`
  // prunes entries after STALE_PENDING_MS and a long label pass can outlive even
  // the fifteen minutes that now allows (at ~4 s a call, ~225 labels' worth).
  //
  // "Reached", not "named": waiting closes the gap between a promotion and its
  // name, and nothing more. §10.3 also excludes a `label_source` of `bigram`,
  // so a storyline the model declined and the extractor named stays out of the
  // cloud however long this job waits, and with no `labeler` wired there is no
  // tail to wait for and this clears exactly as it did before.
  //
  // The cost is a worker: `startConsumer` runs at concurrency 1, so the sample
  // now holds the only consumer for the whole label pass (~3 minutes measured)
  // and the segment jobs a reader polls on §6.5 queue behind it. That is the
  // right trade while the cloud is the thing being fixed — a segment job is
  // late, whereas the cloud was wrong for an hour — but it is the first thing
  // to revisit if §6.5 latency regresses.
  //
  // That hold got longer, and this is where to look when it bites. The tail now
  // carries the collision-triggered label merge as well: per model-written name
  // one indexed count, and on a collision up to four rounds of the nightly
  // merge pass, each of which can spend a model call relabelling a survivor. It
  // is free when nothing collides — which is the ordinary case — and on the
  // afternoon that motivated it (six colliding arcs) it would have been the
  // difference between a correct cloud and a wrong one, so the trade still
  // holds. Raising the consumer's concurrency is the lever, not dropping the
  // await: this job's whole point is that nothing else is waiting on it.
  try {
    await deps.redis.del(cacheKeyFor(deps, job.language));
  } catch {
    // 15 minutes of staleness at worst; the cache is not correctness (§7.1).
  }
}
