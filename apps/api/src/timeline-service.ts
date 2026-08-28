import type { Kysely } from "kysely";
import type { Redis } from "ioredis";
import {
  cursorGeneration,
  decodeCursor,
  encodeCursor,
  type Cursor,
  type SurfacedStoryline,
  type TimelineEntry,
} from "@zammy/shared";
import {
  NewsQuotaError,
  type CallPriority,
  type CurrentsClient,
} from "@zammy/currents-client";
import type { NewsClient } from "@zammy/news-client";
import {
  findSurfacedStorylines,
  ingestSightings,
  readCoverage,
  readStorylineArticleCount,
  readStorylineTimelinePage,
  type StorylineSlotMember,
  readStoryline,
  readStorylineLanguage,
  resolveStoryline,
  readStorylineCoverage,
  readTopic,
  recordCoverage,
  recordStorylineCoverage,
  upsertTopic,
  type Database,
  type SightingPlane,
  type StorylineSlot,
} from "@zammy/storage";
import {
  canonicalKeywords,
  fingerprintOf,
  WINDOW_SNAP_MS,
  type CanonicalizeResult,
  type CanonicalQuery,
} from "./canonical.js";
import { deepeningQuery, storylineKeywords } from "./cloud-query.js";
import { planHorizon, sliceSpan, subtractCoverage, type Span } from "./coverage-gaps.js";
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
import type { DeepenJob, IngestQueue, SegmentJob } from "./ingest-queue.js";
import {
  groupCreatedArticles,
  groupingDepsFor,
  type GroupingDeps,
} from "./grouping-service.js";
import { chooseRepresentative } from "./source-authority.js";
import { labelWords } from "./storyline-label-merge.js";

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
  /**
   * The DEEPENING plane's provider (ADR-0019), when one is configured.
   *
   * Absent is the default and the shipped production state: `GOOGLE_NEWS_ENABLED`
   * is false, `createGoogleNewsClient` refuses to build without it, and with no
   * client here `queueStorylineDeepening` answers `unavailable` and spends
   * nothing. So this whole path is behind the same flag G4 put the adapter
   * behind, and turning the flag on is what turns it on.
   *
   * A separate field rather than a second entry in a registry, and separate from
   * `currents` rather than folded into the composite, because the two are
   * planned against DIFFERENT COVERAGE — `topic_coverage` for the one,
   * `storyline_coverage` for the other — and ADR-0019 is explicit that providers
   * stop sharing a plan. The composite exists to fan ONE plan out to several
   * providers; there is no one plan here to fan.
   *
   * Typed as the narrow `NewsClient` rather than `CurrentsClient`: this path
   * never calls `latestNews`, and nothing here should be able to.
   */
  deepening?: NewsClient;
  queue: IngestQueue;
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

export interface TimelineReadResult {
  topic: {
    fingerprint: string;
    keywords: string[];
    coverage: { from: string; to: string } | null;
  };
  /** Storylines this search surfaced (ADR-0011). Empty under the old model. */
  storylines: SurfacedStoryline[];
  items: TimelineEntry[];
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

/**
 * Decode a cursor, and refuse one minted by the model this request is not
 * serving.
 *
 * The flag selects which model is READ, and it flips under readers who are
 * mid-scroll: their next request carries a cursor whose id half belongs to the
 * other generation — a bigint reaching `::uuid`, or a UUID reaching `::bigint`
 * — and Postgres answers a cast error, which is a 500 for something that is
 * plainly a bad request. Both directions, because the flag flips both ways.
 *
 * This is the layer that knows the flag, which is why the check lives here
 * rather than in `decodeCursor`: the cursor is well-formed, it is only
 * well-formed for the other model. The reader loses their place and starts the
 * page again, which is the whole cost.
 */
function takeCursor(cursorString: string | undefined): Cursor | null {
  if (cursorString === undefined) return null;
  const cursor = decodeCursor(cursorString);
  // Only v2 cursors exist now. The generation check survives the cutover on
  // purpose: a cursor minted before it carries a bigint slot id, and feeding
  // that to a UUID comparison is a 500 rather than an empty page. A reader
  // holding one gets a 400 and a fresh first page, which is the right answer —
  // the slots it named are not there any more.
  if (!cursor || cursorGeneration(cursor) !== "v2") {
    throw new InvalidCursorError(`unusable cursor: ${cursorString.slice(0, 40)}`);
  }
  return cursor;
}

export async function readTimeline(
  deps: TimelineDeps,
  query: CanonicalQuery,
  request: ReadRequest,
): Promise<TimelineReadResult> {
  const startedAt = Date.now();
  const result = await planAndRead(deps, query, request);
  deps.metrics?.timelineRead(result.meta.servedFrom, (Date.now() - startedAt) / 1000);
  return result;
}

export interface ReadRequest {
  limit: number;
  cursorString?: string;
}

async function planAndRead(
  deps: TimelineDeps,
  query: CanonicalQuery,
  request: ReadRequest,
): Promise<TimelineReadResult> {
  const now = deps.now();

  const cursor = takeCursor(request.cursorString);

  // §6.3 step 1 — page cache. A hit costs nothing and touches nothing.
  //
  // Consulted before anything is written, which it could not be while ADR-0010's
  // seed existed: a seeded arrival had to enroll articles first, or it would be
  // served a page cached a moment before its own enrolment. The storyline view
  // replaced the seed with a UUID (ADR-0011), nothing is enrolled by reading,
  // and the cache is back to being the first step.
  const cacheKey = pageCacheKey(
    query.fingerprint,
    query.window,
    request.cursorString ?? null,
    request.limit,
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
        ...segmentJob(query.fingerprint, sliver, 1, "search"),
        kind: "topup",
      });
    }
  } else if (gaps.length > 0) {
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
        lockLostToPeer = true;
        continue;
      }

      try {
        const outcome = await fillSegment(deps, query, gap, budget, 1, "interactive", "search");
        if (outcome.callsMade > 0) servedFrom = "upstream";
        if (outcome.kind === "deferred") {
          deferred.push(segmentJob(query.fingerprint, gap, outcome.resumePage, "search"));
        } else if (outcome.kind === "truncated") {
          deferred.push(
            ...(await onTruncated(deps, query.fingerprint, gap, outcome.oldestSeen, "search")),
          );
        } else if (outcome.kind === "capped") {
          capped = true;
        }
      } catch (error) {
        degraded = error instanceof NewsQuotaError ? "quota" : "upstream";
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
  const stored = await readStorylineTimelinePage(deps.db, {
    fingerprint: query.fingerprint,
    from: query.window.from,
    to: query.window.to,
    ...(cursor ? { cursor } : {}),
    limit: request.limit,
    timeZone: deps.config.grouping.timeZone,
  });

  // Storylines this SEARCH surfaces, beside the results rather than narrowing
  // them (ADR-0011). One folded spelling per keyword, answering BOTH the
  // vocabularies a storyline speaks in — `profile_tokens` and `label_words` —
  // because `normalizeLabel` folds a label the same way the corpus folded its
  // headlines, so the two columns hold the same spelling of the same word.
  //
  // `labelWords` is that fold and is deliberately the same function the label
  // side is written with: one definition, used on both sides of the comparison.
  // It matters that it is ALL THREE steps — `trimWordPunctuation`, then
  // `foldDiacritics` (version 8, so a keyword typed `nino` reaches a corpus that
  // wrote `niño`), then
  // `singular`. `canonicalize` lowercases and splits on whitespace and stops
  // there, so a keyword still carries its punctuation, and `singular` alone
  // strands the apostrophe: "dillard's" becomes `dillard'`, which no corpus and
  // no label holds. A search for "storms" reaching a profile that says "storm"
  // is the other half, and the reason the fold was ever here.
  //
  // A keyword that folds to no word at all (pure punctuation) is kept as the
  // empty string rather than dropped: dropping it would let a keyword nothing
  // can match quietly widen the search instead of refusing it.
  //
  // Load-bearing beyond the reader who typed. `cloudQuery` emits a cloud click's
  // keywords in the label's OWN spelling rather than the fold, precisely so the
  // reader is never shown `crisi` — which means the click's own arc is surfaced
  // only because this line folds those keywords back. It used to hold by
  // construction (every emitted term came straight out of `profile_tokens`); now
  // it holds because of this fold. Removing it loses the pill for exactly the
  // click that produced the search.
  const surfaced = await findSurfacedStorylines(deps.db, {
    keywords: query.keywords.map((keyword) => labelWords(keyword).join(" ")),
    limit: SURFACED_STORYLINE_LIMIT,
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
    items: stored.items.map(toStorylineEntry),
    storylines: surfaced.map((storyline) => ({
      id: storyline.id,
      label: storyline.label,
      from: storyline.spanFrom,
      to: storyline.spanTo,
      size: storyline.size,
      dormant: storyline.status === "dormant",
    })),
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
 * A stored storyline → the slot the browser renders (§14.3, ADR-0009).
 *
 * The slot's LEAD GROUP is its most-syndicated group — the story itself,
 * rather than an angle piece that happens to cite a tier-1 domain — and the
 * headline is chosen from the lead group's members that matched this search,
 * per topic and per read: a slot-wide choice could surface an article that
 * never matched the user's keywords and hide the matching one under
 * "related". The split the disclosure renders falls out of the same
 * structure: lead-group members are the same story syndicated (`related`),
 * every other group's members are the day's wider coverage (`coverage`).
 * The slot's position is not chosen here and never changes with the
 * headline: `published` is the storyline's (§7.3).
 */
function toEntry(slot: {
  id: string;
  published: string;
  members: StorylineSlotMember[];
}): TimelineEntry {
  const byGroup = new Map<string, StorylineSlotMember[]>();
  for (const member of slot.members) {
    const list = byGroup.get(member.groupId);
    if (list) list.push(member);
    else byGroup.set(member.groupId, [member]);
  }

  // Largest group leads; ties break earliest-published then lowest id, so a
  // replayed read reaches the same slot (§7.4's replay discipline, again).
  let lead: { groupId: string; members: StorylineSlotMember[] } | null = null;
  for (const [groupId, members] of byGroup) {
    if (!lead || leadBeats({ groupId, members }, lead)) lead = { groupId, members };
  }
  const leadMembers = lead?.members ?? [];

  const article = chooseRepresentative(leadMembers.map((member) => member.article));
  const moreCoverage = slot.members
    .filter((member) => member.groupId !== lead?.groupId)
    .map((member) => member.article);

  return {
    storylineId: slot.id,
    published: slot.published,
    // Members are newest first, so the head is the slot's latest coverage.
    // This is what the UI shows as "updated", the same treatment ADR-0002
    // gives an article whose later sightings do not move it.
    updatedAt: slot.members[0]?.article.published ?? slot.published,
    article,
    related: leadMembers
      .map((member) => member.article)
      .filter((member) => member.id !== article.id),
    moreCoverage,
    // The old model has no storyline to describe: its slots are day-bounded
    // storylines with no identity a reader could open. `toStorylineEntry` fills
    // this in when the flag is on.
    storyline: null,
  };
}

/**
 * The STORYLINE VIEW (ADR-0011): the timeline filtered to one storyline,
 * alias-resolving, with the label echoed back.
 *
 * It replaces ADR-0010's `?storyline=<bigint>` seeding, and the replacement is
 * a simplification rather than a translation. The seed had to enroll articles
 * into a topic because the phrase it came from WAS a search, and the superset
 * guarantee made that enrolment load-bearing. A UUID is not a search: nothing
 * needs enrolling, no keywords need gating, and the read is a plain page of one
 * storyline's day slots. `attachStorylineToTopic` and its token gate went with
 * the cutover.
 *
 * Returns null for a UUID this database has never held — a stale link, which
 * the route turns into a 404. A MERGED one resolves to its survivor instead
 * and serves that: nothing holding a storyline UUID may dangle, which is the
 * whole reason the loser's row survives as an alias.
 */
export async function readStorylineView(
  deps: TimelineDeps,
  request: { storylineId: string; limit: number; cursorString?: string },
): Promise<TimelineReadResult | null> {
  const now = deps.now();
  const cursor = takeCursor(request.cursorString);

  const resolved = await resolveStoryline(deps.db, request.storylineId);
  if (resolved === null) return null;

  const stored = await readStorylineTimelinePage(deps.db, {
    fingerprint: null,
    storylineId: resolved,
    ...(cursor ? { cursor } : {}),
    limit: request.limit,
    timeZone: deps.config.grouping.timeZone,
  });

  const first = stored.items[0];
  // Whole-life, so page two says what page one said (the wire contract's own
  // wording). One extra count for a read that is already three statements deep.
  const size = first ? await readStorylineArticleCount(deps.db, resolved) : 0;
  return {
    // No topic: the view is not a search, and inventing a fingerprint for it
    // would put a keyword-less row in `topics` that nothing could ever hit
    // again. Coverage is null for the same reason — nothing was fetched FOR
    // this view; its articles were fetched for the searches that found them.
    topic: { fingerprint: EMPTY_FINGERPRINT, keywords: [], coverage: null },
    storylines: first
      ? [
          {
            id: resolved,
            label: first.label,
            from: first.spanFrom,
            to: first.spanTo,
            size,
            dormant: first.status === "dormant",
          },
        ]
      : [],
    items: stored.items.map(toStorylineEntry),
    page: {
      nextCursor: stored.nextCursor ? encodeCursor(stored.nextCursor) : null,
      hasMore: stored.hasMore,
    },
    meta: {
      servedFrom: "store",
      asOf: now.toISOString(),
      stale: false,
      degraded: null,
      // Nothing is being fetched for a storyline view, so it is never
      // "in_progress": what it shows is what is stored, whole.
      ingest: { state: "complete", pendingJobs: 0 },
    },
  };
}

/** The all-zero fingerprint: the storyline view has no topic (§6.2). */
const EMPTY_FINGERPRINT = "0".repeat(64);

/**
 * How many storylines a search may surface. A row of pills, not a second
 * timeline — S8's verdict — and a search whose keywords are a subset of two
 * hundred profiles has told us nothing worth rendering.
 *
 * MEASURED IN THE BROWSER, and worth knowing before this is raised: S8 sized
 * the pills row's cost at "~56px on a phone when the pills wrap", against three
 * matched storylines. Eight wrap to five rows at 375px — roughly a third of the
 * viewport. The handle recovers all of it and the collapsed state persists, which
 * is the mitigation the verdict already required; but eight is the point where
 * the row stops being chrome and starts being a screen.
 */
const SURFACED_STORYLINE_LIMIT = 8;

/**
 * A storyline-DAY → the slot the browser renders (ADR-0011).
 *
 * Deliberately the same shape and the same choices as `toEntry` above: the lead
 * group is the slot's most-syndicated, the headline is chosen from it by source
 * authority among the members that matched this search, and the split the
 * disclosure renders falls out of group membership. What changes is only which
 * members are in the slot — one storyline's coverage on ONE day, rather than a
 * day-bounded storyline's whole membership — and the storyline metadata riding
 * alongside it.
 *
 * A PROVISIONAL storyline gets `storyline: null`: it is invisible as a
 * storyline, and its slot is the ordinary article slot (ADR-0011's Lifecycle).
 * That is the whole of what the front end needs to know to render it as it
 * always did.
 */
function toStorylineEntry(slot: StorylineSlot): TimelineEntry {
  const base = toEntry({
    id: slot.storylineId,
    published: slot.published,
    members: slot.members,
  });
  return {
    ...base,
    storyline:
      slot.status === "provisional"
        ? null
        : { label: slot.label, from: slot.spanFrom, to: slot.spanTo },
  };
}

function leadBeats(
  candidate: { groupId: string; members: StorylineSlotMember[] },
  incumbent: { groupId: string; members: StorylineSlotMember[] },
): boolean {
  if (candidate.members.length !== incumbent.members.length) {
    return candidate.members.length > incumbent.members.length;
  }
  const byTime =
    earliest(candidate.members) - earliest(incumbent.members);
  if (byTime !== 0) return byTime < 0;
  return BigInt(candidate.groupId) < BigInt(incumbent.groupId);
}

function earliest(members: readonly StorylineSlotMember[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const member of members) {
    const t = Date.parse(member.article.published);
    if (t < min) min = t;
  }
  return min;
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
  deps: TimelineDeps,
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
  const covered = await readCoverage(deps.db, query.fingerprint);

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
  deps: TimelineDeps,
  input: { storylineId: string },
): Promise<StorylineDeepenOutcome> {
  const storylineId = await resolveStoryline(deps.db, input.storylineId);
  if (storylineId === null) return { status: "unknown" };

  const deepening = deps.deepening;
  if (!deepening) {
    // Not an error and not logged as one: no deepening provider is the shipped
    // configuration, and the caller is a fire-and-forget POST.
    deps.metrics?.storylineDeepen("unavailable");
    return { status: "unavailable", storylineId };
  }

  const storyline = await readStoryline(deps.db, storylineId);
  if (storyline === undefined) return { status: "unknown" };

  const query = deepeningQuery({
    label: storyline.label,
    profileTokens: storyline.profileTokens,
  });
  if (query === null) {
    deps.metrics?.storylineDeepen("ungrounded");
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
    deps.metrics?.storylineDeepen("fresh");
    return { status: "fresh", storylineId, keywords: query.keywords };
  }

  // Freshness, judged against the REAL clock — the same separation
  // `queueStorylineRefresh` draws: how stale an edge is has nothing to do with a
  // grid, and judging it on a snapped clock would hide every staleness younger
  // than the last grid line.
  if (now.getTime() - gap.from.getTime() <= freshnessTtlMs(window.to, now)) {
    deps.metrics?.storylineDeepen("fresh");
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
    deps.metrics?.storylineDeepen("fresh");
    return { status: "fresh", storylineId, keywords: query.keywords };
  }

  const job: DeepenJob = {
    kind: "deepen",
    storylineId,
    from: from.toISOString(),
    to: to.toISOString(),
  };
  await deps.queue.enqueueDeepen(job);
  deps.metrics?.storylineDeepen("queued");
  return { status: "queued", storylineId, keywords: query.keywords, job };
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
export async function processDeepenJob(deps: TimelineDeps, job: DeepenJob): Promise<void> {
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
    deps.metrics?.storylineDeepen("ungrounded");
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

    const result = await deepening.search(
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
    deps.metrics?.upstreamCall({
      received: result.normalization.received,
      dropped: result.normalization.received - result.normalization.kept,
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
    deps.metrics?.articlesIngested(ingested.articlesCreated);

    // ATTACHMENT BY PROVENANCE. The seam is `groupCreatedArticles`' intent, and
    // the whole of the rule lives there: seeded groups join this arc, nothing is
    // offered to the linker, and no storyline is formed.
    await groupCreatedArticles(groupingDepsFor(deps), ingested.createdArticles, {
      attachTo: storylineId,
    });

    // Coverage LAST, and only on a clean end of results.
    //
    // `isLastPage` on this provider means `rawCount < 100`, which is the honest
    // "there was nothing further in this window" — a FULL page means the 100-cap
    // truncated it, and there is no page 2 to ask for. So a truncated span
    // records nothing and the next click re-plans the same gap. That is a
    // deliberate difference from `onTruncated`, which advances a frontier and
    // enqueues the remainder: doing that here would need subdivision, and
    // subdivision without a reader asking for it is the crawl frontier G7 has
    // to argue for on its own.
    if (result.isLastPage) {
      await recordStorylineCoverage(deps.db, storylineId, deepening.provider, span);
    } else {
      deps.metrics?.truncatedSegment();
      deps.log?.info?.(
        { storylineId, from: span.from, to: span.to, items: result.rawCount },
        "deepening span hit the item cap; coverage not recorded, the gap stays open",
      );
    }
  } finally {
    await release(deps.redis, lockKey, token);
  }
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
 */
async function fillSegment(
  deps: TimelineDeps,
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
 */
async function onTruncated(
  deps: TimelineDeps,
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

function segmentJob(
  fingerprint: string,
  segment: Span,
  startPage: number,
  plane: SightingPlane,
): SegmentJob {
  return {
    fingerprint,
    from: segment.from.toISOString(),
    to: segment.to.toISOString(),
    startPage,
    plane,
  };
}
