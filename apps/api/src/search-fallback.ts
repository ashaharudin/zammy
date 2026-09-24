import type { Kysely } from "kysely";
import type { Redis } from "ioredis";
import { isNewsError, type NewsClient } from "@zammy/news-client";
import {
  ingestSightings,
  readCoverage,
  readTopic,
  recordCoverage,
  type Database,
} from "@zammy/storage";
import { WINDOW_SNAP_MS } from "./canonical.js";
import { subtractCoverage, type Span } from "./coverage-gaps.js";
import { logIngestOutcome, logUpstreamFetch } from "./observations.js";
import { refreshLockKey, release, tryAcquire } from "./single-flight.js";
import { reserveFallbackCall, reserveTopicCall } from "./topic-budget.js";
import { ingestJobId, type IngestQueue, type SearchFallbackJob } from "./ingest-queue.js";
import {
  groupCreatedArticles,
  groupingDepsFor,
  type GroupingDeps,
} from "./grouping-service.js";

/**
 * THE SEARCH FALLBACK (ADR-0030): a reader's search that Currents refused on
 * quota, asked again of Google News — for the part of it that provider dates
 * honestly, and recorded under that provider's own coverage rows.
 *
 * Planner and consumer in one file, for `storyline-deepening.ts`'s reason: the
 * clip the planner applies is re-applied by the consumer against a fresh clock,
 * and both halves are one argument about which spans this provider may be asked
 * for and which it may claim.
 *
 * **What it deliberately is not.** It is not a second discovery provider:
 * `PLANNED_COVERAGE_PROVIDER` stays `'currents'`, so nothing here changes which
 * gaps a read plans or what Currents is asked. A refused span is still a
 * Currents gap afterwards — this module never writes a Currents row — so the
 * next reader, on a day with budget, asks Currents for it exactly as before. The
 * fallback fills the reader's timeline in the meantime; it does not stand in for
 * the provider it covers for.
 *
 * And it is not the composite. The composite shares ONE paging plan across
 * providers and lets the primary's failure propagate untouched — which is right
 * for what it does and makes it useless here, where the trigger IS the
 * primary's failure and Google News has no page 2 to share a plan over.
 */

/**
 * How far back a fallback may ask, measured from the moment it asks.
 *
 * Six days, and it is G6's number rather than a guess (DISCOVERY-DEEPENING-PLAN
 * §G6, gating item 3). Google News stops TIMING items at about eight days and
 * sends a bare date at midnight US Pacific instead — 1.7% of items inside that
 * age, 89.4% beyond it. `BOUND_PADDING_MS` in the adapter widens `after:` a day
 * outward so an under-fetch is impossible, so a window whose far edge is D days
 * back puts D+1 on the wire; day 8 already reads 3.9% degraded against 0% at
 * day 7. Seven is therefore the arithmetic ceiling and six is the number with
 * margin.
 *
 * What the clip buys is specific: an article this plane MINTS carries a real
 * publication time, so it orders within its day and falls in the right part of
 * the reader's day. The fold was already safe past the cliff — ADR-0021 refuses
 * a bare date the display fields, ADR-0022 widens the bare date's lookup — so
 * this is about the rows the fallback creates, which nothing else protects.
 *
 * The cost is the history. A reader asking about last month gets, from this
 * provider, only its last six days; the rest stays a Currents gap for a day
 * with budget.
 */
export const SEARCH_FALLBACK_REACH_MS = 6 * 86_400_000;

/**
 * The narrowest span a capped fallback is split into: three days, and NOT the
 * Currents fill's one-hour `minSegmentMs`.
 *
 * Google News cannot be asked for less than a day. `after:`/`before:` take a
 * bare date, and the adapter pads each a day outward so an under-fetch is
 * impossible (`BOUND_PADDING_MS`), so a span of L days reaches the wire as a
 * window of roughly L+2 to L+3. So halving soon stops producing different
 * questions. Measured in review against the real `toQueryParams`, a busy
 * six-day fallback:
 *
 *   floor 1 hour   511 calls, 18 distinct wire queries
 *   floor 1 day     15 calls, 13 distinct
 *   floor 3 days     3 calls,  3 distinct
 *
 * Three days is therefore a TRADE, not the provider's limit: a one-day floor
 * would ask a little deeper and pay two repeated calls for it. At three days one
 * halving of the six-day reach is the whole tree, every call a different
 * question, and a capped refused search costs at most three calls.
 */
export const SEARCH_FALLBACK_MIN_SPAN_MS = 3 * 86_400_000;

export interface SearchFallbackDeps {
  db: Kysely<Database>;
  redis: Redis;
  /**
   * The provider a refused search falls back to — the SAME Google News client
   * the deepening plane holds, handed in under its own name by `server.ts` only
   * when `SEARCH_FALLBACK_ENABLED` is on. Absent is the shipped state, and every
   * function here then does nothing.
   *
   * Its own field rather than a read of `deepening`, because the two answer
   * different questions about one client: whether an arc may be deepened, and
   * whether a refused search may be retried. A deployment can want the first
   * without the second, and the absence of this field is how it says so.
   */
  searchFallback?: NewsClient;
  /** Only `enqueueSegment`: the halves of a capped span are fallback jobs too. */
  queue: Pick<IngestQueue, "enqueueSegment">;
  config: {
    lookbackDays: number;
    /**
     * §9.4's per-topic cap — counted on THIS provider's own counter, so a refused
     * search's fallback can never spend the Currents calls the topic's next read
     * may still be entitled to.
     */
    perTopicDailyCallCap: number;
    /** ADR-0030: this plane's share of the provider's day, across every topic. */
    searchFallbackDailyCallCap: number;
    grouping: GroupingDeps["config"];
  };
  now: () => Date;
  labeler?: GroupingDeps["labeler"];
  log?: {
    warn: (obj: object, msg: string) => void;
    info?: (obj: object, msg: string) => void;
  };
}

/**
 * Whether a failure is the kind this plane exists for: a QUOTA refusal — the
 * governor's own, below the interactive reserve, or upstream's.
 *
 * Structural rather than `instanceof NewsQuotaError`, for the reason
 * `isPermanentIngestFailure` gives: the error crosses a package boundary, and a
 * duplicated `@zammy/news-client` in the graph would make `instanceof` quietly
 * false — which here would mean a fallback that never fires and says nothing.
 *
 * Only quota, and deliberately. An upstream that is DOWN (a 5xx, an open
 * breaker) is a fault the queue's redelivery is for and the next minute may
 * heal; a spent budget is a fact about the rest of the day, and it is the one
 * failure a second provider is the answer to.
 */
export function isQuotaRefusal(error: unknown): boolean {
  return isNewsError(error) && error.kind === "quota";
}

/**
 * The fallback job for one refused span of a search, or `null` when none is
 * owed: no fallback provider, or nothing of the span inside the reach.
 *
 * **Both edges go onto the window grid, and that is not cosmetic** — it is
 * `queueStorylineRefresh`'s argument arriving from the other side. A refused
 * read re-plans on every 1.5-second poll, and the gap it refuses on ends at
 * `now`; an unsnapped job's content address would move with the clock, and each
 * poll would publish a fresh message and spend a fresh call. Snapped, a
 * quarter-hour of polls is one job — and the NEXT quarter-hour's is a different
 * one, so the queue's 900-second dedup cannot swallow it.
 *
 * `to` snaps DOWN, so the freshest few minutes are left for the next grid line.
 * The reach's own edge snaps UP, so the clip can only ever tighten it: a floor
 * rounded down would reach a few minutes past six days, which is the side of the
 * number that was measured to be the cliff's.
 */
export function searchFallbackJob(
  fingerprint: string,
  refused: Span,
  now: Date,
): SearchFallbackJob | null {
  const to = Math.floor(Math.min(refused.to.getTime(), now.getTime()) / WINDOW_SNAP_MS) * WINDOW_SNAP_MS;
  const reach =
    Math.ceil((now.getTime() - SEARCH_FALLBACK_REACH_MS) / WINDOW_SNAP_MS) * WINDOW_SNAP_MS;
  const from = Math.max(refused.from.getTime(), reach);
  if (to <= from) return null;
  return {
    kind: "fallback",
    fingerprint,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  };
}

/**
 * How long one fallback address is held after it is published: the queue's own
 * dedup window, `INGEST_RETENTION_SECONDS` (900 s), restated here rather than
 * imported because this planner must not learn which transport it runs on.
 * `search-fallback.test.ts` pins the two equal.
 */
export const FALLBACK_PUBLISH_HOLD_SECONDS = 900;

/**
 * Queue the fallback for the spans a search was refused on — the one entry point
 * the Currents fill calls, from both of its paths (`coverage-fill.ts`).
 *
 * A no-op without a fallback provider, which is what keeps the flag's off state
 * the code as it was: nothing is planned, nothing enqueued, no field read.
 *
 * **Two guards stand between a refused poll and a publish, and both exist
 * because the Currents gap does NOT close when the fallback lands.** A degraded
 * read re-plans on every poll, and the span it was refused on stays a Currents
 * gap until a day with budget — so unlike a segment, whose re-plan stops the
 * moment its coverage is recorded, this plan would be made again on every poll
 * for as long as the reader waits. A republish inside the queue's 900-second
 * dedup window is swallowed but still re-adds its pending entry
 * (`isPermanentIngestFailure` in the Vercel driver says so), and a pending entry
 * for a message nothing will deliver holds the reader at `in_progress` for the
 * full `STALE_PENDING_MS`. So:
 *
 *  - **A span this provider has already covered is not planned at all.** Once
 *    the fallback lands, the reader's next poll finds it covered and the topic
 *    reads complete.
 *  - **One address is published at most once per dedup window** (`SET NX` for
 *    `FALLBACK_PUBLISH_HOLD_SECONDS`), so the polls between a publish and its
 *    delivery never write a ledger entry the transport will not honour. The grid
 *    moves the address every fifteen minutes — the same length as the hold — so a
 *    reader still waiting after that gets a fresh one, which the consumer's own
 *    coverage check makes cheap.
 *
 * Both fail OPEN on a Redis or Postgres error: a duplicate publish costs a
 * pending entry and, at worst, one call the consumer's coverage check refuses;
 * a lost one costs the reader the fallback.
 *
 * Never throws for the caller's sake. Both callers are in the middle of handling
 * a DIFFERENT failure — the quota refusal — and one of them is about to rethrow
 * it; an error escaping here would replace that error with one about a fallback,
 * and the queue's redelivery of the Currents job is worth more than this plane's
 * attempt. The miss is logged.
 */
export async function queueSearchFallback(
  deps: Pick<SearchFallbackDeps, "db" | "redis" | "searchFallback" | "queue" | "log">,
  fingerprint: string,
  refused: readonly Span[],
  now: Date,
): Promise<number> {
  const client = deps.searchFallback;
  if (!client) return 0;

  const jobs = refused
    .map((span) => searchFallbackJob(fingerprint, span, now))
    .filter((job): job is SearchFallbackJob => job !== null);
  if (jobs.length === 0) return 0;

  let covered: Span[] = [];
  try {
    covered = await readCoverage(deps.db, fingerprint, client.provider);
  } catch (error) {
    deps.log?.warn(
      { err: error, fingerprint },
      "search fallback could not read its own coverage; planning as if uncovered",
    );
  }

  let queued = 0;
  for (const job of jobs) {
    const from = Date.parse(job.from);
    const to = Date.parse(job.to);
    // Whole-span only. A span partly covered still has a gap, and the consumer
    // subtracts the covered part before it spends anything.
    if (covered.some((span) => span.from.getTime() <= from && span.to.getTime() >= to)) {
      continue;
    }
    try {
      const held = await deps.redis
        .set(
          `fallback:published:${ingestJobId(job)}`,
          "1",
          "EX",
          FALLBACK_PUBLISH_HOLD_SECONDS,
          "NX",
        )
        .catch(() => "OK" as const);
      if (held === null) continue;
      await deps.queue.enqueueSegment(job);
      queued += 1;
    } catch (error) {
      deps.log?.warn(
        { err: error, fingerprint, from: job.from, to: job.to },
        "search fallback could not be queued; the refused span waits for Currents",
      );
    }
  }
  return queued;
}

/**
 * Queue-consumer handler for a search fallback: fetch what Google News has for
 * the topic's words over the clipped span, fold it in as a SEARCH, and record
 * coverage only for what was walked to a clean end.
 *
 * The shape is `processDeepenJob`'s and the differences are the subject's: the
 * query is the topic's own keywords rather than an arc's label, what comes back
 * is grouped and linked as any search's articles are (a search has no arc to
 * attach them to), and the coverage row is `topic_coverage` under this
 * provider's name.
 */
export async function processSearchFallbackJob(
  deps: SearchFallbackDeps,
  job: SearchFallbackJob,
): Promise<void> {
  const client = deps.searchFallback;
  if (!client) {
    // Published before the flag went off. Dropped rather than retried, for
    // `processDeepenJob`'s reason: no backoff makes an absent provider answer.
    deps.log?.warn(
      { fingerprint: job.fingerprint },
      "search fallback delivered with no fallback provider configured; dropping",
    );
    return;
  }

  const topic = await readTopic(deps.db, job.fingerprint);
  if (!topic) {
    deps.log?.warn(
      { fingerprint: job.fingerprint },
      "search fallback for an unknown topic; dropping",
    );
    return;
  }

  // Re-clipped against the clock as it stands NOW. The planner clipped at
  // publish time, and a message can sit: a fallback delivered an hour late would
  // otherwise ask for an hour past the reach, which is the hour nearest the
  // cliff. The same move `processSegmentJob` makes against the lookback horizon,
  // for the same kind of reason.
  const now = deps.now();
  const requested: Span = { from: new Date(job.from), to: new Date(job.to) };
  const reach = now.getTime() - SEARCH_FALLBACK_REACH_MS;
  const span: Span =
    requested.from.getTime() >= reach ? requested : { from: new Date(reach), to: requested.to };
  if (span.from.getTime() >= span.to.getTime()) {
    deps.log?.warn(
      { fingerprint: job.fingerprint, from: job.from, to: job.to },
      "search fallback aged past its reach before it was fetched; dropping",
    );
    return;
  }

  // Keyed on the span as ENQUEUED, so the key is stable across redeliveries, and
  // on its own subject so it can never be mistaken for the Currents fill's lock
  // over the same span — the two are different providers' fetches and must not
  // serialize each other.
  const lockKey = refreshLockKey(`fallback:${job.fingerprint}`, requested);
  const token = await tryAcquire(deps.redis, lockKey, 30_000);
  if (!token) throw new Error(`search fallback ${lockKey} is locked; retrying later`);

  try {
    // Against THIS provider's rows, never Currents': a span Currents covered
    // after the refusal is still one Google News has not walked, and a span this
    // plane already walked is not re-bought by the next refused poll.
    const covered = await readCoverage(deps.db, job.fingerprint, client.provider);
    const gaps = subtractCoverage(span, covered, {
      now,
      lookbackDays: deps.config.lookbackDays,
    });

    for (const gap of gaps) {
      // Both budgets before every call. The plane's first, because the
      // provider's day is shared with the deepening plane and that plane must
      // not be starved by this one — and first so a refusal here leaves the
      // topic's counter untouched. Then the topic's, §9.4's, on this PROVIDER's
      // own counter: charging the topic's Currents counter would let a fallback
      // spend the calls the topic's next read may still be entitled to, since a
      // background refusal below the reserve says nothing about the interactive
      // budget above it.
      if (
        !(await reserveFallbackCall(
          deps.redis,
          client.provider,
          deps.config.searchFallbackDailyCallCap,
          now,
        ))
      ) {
        deps.log?.warn(
          { fingerprint: job.fingerprint, cap: deps.config.searchFallbackDailyCallCap },
          "search fallback's daily share is spent; refused spans wait for Currents",
        );
        return;
      }
      if (
        !(await reserveTopicCall(
          deps.redis,
          job.fingerprint,
          deps.config.perTopicDailyCallCap,
          now,
          client.provider,
        ))
      ) {
        deps.log?.warn(
          { fingerprint: job.fingerprint, cap: deps.config.perTopicDailyCallCap },
          "per-topic daily call cap reached; the search fallback stops until tomorrow",
        );
        return;
      }

      let result;
      try {
        result = await client.search(
          {
            ...(topic.keywords.length > 0 ? { keywords: topic.keywords } : {}),
            // An EDITION on this provider rather than a filter (G4): it biases
            // which outlets answer, and says so in the adapter.
            ...(topic.language ? { language: topic.language } : {}),
            ...(topic.country ? { country: topic.country } : {}),
            // Forwarded rather than dropped, so the adapter's refusal is the one
            // that answers: Google News silently DISCARDS a category given beside
            // a keyword, and a legacy category topic filled here would fill with
            // everything (ADR-0019).
            ...(topic.category ? { category: topic.category } : {}),
            startDate: gap.from,
            endDate: gap.to,
            pageNumber: 1,
            pageSize: client.limits.maxPageSize,
          },
          // No reader is waiting on this call — the one who asked was served
          // from the store and is polling — so it draws below the reserve.
          { priority: "background" },
        );
      } catch (error) {
        // A query this provider cannot express will not become expressible on
        // redelivery. Dropped, loudly, and the span stays a Currents gap.
        if (isNewsError(error) && error.kind === "invalid_query") {
          deps.log?.warn(
            { err: error, fingerprint: job.fingerprint },
            "search fallback refused locally; this topic cannot be asked of the fallback provider",
          );
          return;
        }
        // A spent Google News day is dropped too, like the two budgets above.
        // It will not recover inside the ~10-minute redelivery budget, and every
        // redelivery would take both counters again for a call that cannot be
        // made — and republish, inside the dedup window, halves an earlier gap
        // already published, re-adding ledger entries nothing will settle.
        if (isQuotaRefusal(error)) {
          deps.log?.warn(
            { err: error, fingerprint: job.fingerprint },
            "search fallback refused on the fallback provider's own quota; dropping",
          );
          return;
        }
        throw error;
      }

      logUpstreamFetch(deps.log, {
        plane: "search",
        provider: client.provider,
        fingerprint: job.fingerprint,
        span: gap,
        sightings: result.sightings,
        normalization: result.normalization,
      });

      const ingested = await ingestSightings(deps.db, {
        fingerprint: job.fingerprint,
        sightings: result.sightings,
        // A reader's search: demand we did not manufacture, so it feeds the
        // ranking (ADR-0019). The ADR this plane lands with says what that
        // costs, and it is not nothing — see ADR-0030.
        plane: "search",
        timeZone: deps.config.grouping.timeZone,
        ...(deps.log ? { log: deps.log } : {}),
      });
      logIngestOutcome(deps.log, {
        plane: "search",
        provider: client.provider,
        fingerprint: job.fingerprint,
        created: ingested.articlesCreated,
      });

      // Grouped and linked as a search's articles always are. A search has no
      // arc for `attachTo` to name, so the linker decides — which is what a
      // Currents search of the same words would have been given.
      await groupCreatedArticles(groupingDepsFor(deps), ingested.createdArticles);

      // Coverage LAST, and only on this provider's own clean end of results —
      // `rawCount < 100`. A full answer means the cap cut it.
      const walked = result.completeness.find((page) => page.provider === client.provider);
      if (walked?.isLastPage) {
        await recordCoverage(deps.db, job.fingerprint, client.provider, gap);
        continue;
      }

      // Capped. **No frontier**, and this is the one place the Currents fill's
      // machinery must not be borrowed: `onTruncated` records [oldest seen, end)
      // as covered on the strength of upstream answering NEWEST-FIRST, which
      // Currents does and Google News does not — the recorded capture
      // `fixtures/google-news-search-capped.xml` has 2,564 of its 4,950 item
      // pairs out of date order, which is no order at all. A frontier over it
      // would claim, as fetched, days whose newest items were never returned:
      // the silent over-coverage ADR-0001 ranks as the worst failure there is.
      //
      // So a capped span is halved and each half asked again, and a half that
      // comes back short is claimed. At the floor a capped span is accepted, the
      // Currents fill's own rule (§6.3), and what the row then says is narrower
      // than "walked": that this span was asked, capped, and not split further.
      // It is a claim in THIS provider's rows only, whose sole reader is this
      // plane. The floor is a trade rather than a limit — narrower questions do
      // exist down to a day, but below three days most of them repeat a question
      // already asked (`SEARCH_FALLBACK_MIN_SPAN_MS`).
      const length = gap.to.getTime() - gap.from.getTime();
      if (length <= SEARCH_FALLBACK_MIN_SPAN_MS) {
        await recordCoverage(deps.db, job.fingerprint, client.provider, gap);
        deps.log?.warn(
          { fingerprint: job.fingerprint, from: gap.from, to: gap.to, provider: client.provider },
          "search fallback span capped at the three-day floor; accepting partial history",
        );
        continue;
      }
      const mid = new Date(gap.from.getTime() + Math.floor(length / 2));
      deps.log?.info?.(
        { fingerprint: job.fingerprint, from: gap.from, to: gap.to, items: result.rawCount },
        "search fallback span hit the item cap; halving",
      );
      for (const half of [
        { from: gap.from, to: mid },
        { from: mid, to: gap.to },
      ]) {
        await deps.queue.enqueueSegment({
          kind: "fallback",
          fingerprint: job.fingerprint,
          from: half.from.toISOString(),
          to: half.to.toISOString(),
        });
      }
    }
  } finally {
    await release(deps.redis, lockKey, token);
  }
}
