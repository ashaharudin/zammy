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
  CurrentsQuotaError,
  type CallPriority,
  type CurrentsClient,
} from "@zammy/currents-client";
import {
  attachStorylineToTopic,
  findSurfacedStorylines,
  ingestSightings,
  readCoverage,
  readStorylineArticleCount,
  readStorylineTimelinePage,
  readTimelinePage,
  resolveStoryline,
  readTopic,
  recordCoverage,
  upsertTopic,
  type Database,
  type SlotMember,
  type StorylineSlot,
  type TimelineSlot,
} from "@zammy/storage";
import type { CanonicalQuery } from "./canonical.js";
import { sliceSpan, subtractCoverage, type Span } from "./coverage-gaps.js";
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
import {
  groupCreatedArticles,
  groupingDepsFor,
  type GroupingDeps,
} from "./grouping-service.js";
import { chooseRepresentative } from "./source-authority.js";
import { singular } from "./grouping.js";
import { storylinePhrase } from "./storyline-phrase.js";

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
    /** §14.3: write-time article grouping (and its storyline layer, ADR-0009),
     * and the day both draw candidates from. */
    grouping: GroupingDeps["config"];
    /**
     * ADR-0011's read path: the timeline pages over `storyline_days` instead of
     * the denormalized columns on `articles`. Off until the backfill has run
     * and been verified — the two models are written independently, so the flag
     * only ever selects which one is READ.
     */
    storylinesV2: boolean;
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
function takeCursor(
  cursorString: string | undefined,
  generation: "v1" | "v2",
): Cursor | null {
  if (cursorString === undefined) return null;
  const cursor = decodeCursor(cursorString);
  if (!cursor || cursorGeneration(cursor) !== generation) {
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
  /** ADR-0010: a storyline the reader arrived from, whose matching articles
   * this topic is seeded with before the page is planned. */
  seedStorylineId?: string;
}

async function planAndRead(
  deps: TimelineDeps,
  query: CanonicalQuery,
  request: ReadRequest,
): Promise<TimelineReadResult> {
  const now = deps.now();

  const cursor = takeCursor(
    request.cursorString,
    deps.config.storylinesV2 ? "v2" : "v1",
  );

  // The topic exists (and counts a hit) from the first request onward, so
  // deferred jobs enqueued below can always recover the search parameters.
  // Unconditional, and ahead of the cache, only when a seed has to land: the
  // attach has a foreign key into `topics`, so the row must exist first.
  let topicUpserted = false;
  const upsert = async () => {
    if (topicUpserted) return;
    topicUpserted = true;
    await upsertTopic(deps.db, {
      fingerprint: query.fingerprint,
      keywords: query.keywords,
      language: query.language,
      country: query.country,
      category: query.category,
    });
  };

  // §6.3 step 1 — page cache. A hit costs nothing and touches nothing.
  const cacheKey = pageCacheKey(
    query.fingerprint,
    query.window,
    request.cursorString ?? null,
    request.limit,
    deps.config.storylinesV2 ? "v2" : "v1",
  );

  // ADR-0010 — a seeded arrival, before the cache is consulted. A page cached
  // a moment ago cannot contain articles this request is about to enroll, and
  // serving it would break the one promise the phrase chip makes: that the
  // slot it came from is in the results. Seeding that inserts NOTHING (the
  // ordinary case once the topic knows the storyline) leaves the cache path
  // exactly as it was.
  let seeded = 0;
  if (request.seedStorylineId !== undefined) {
    await upsert();
    seeded = await attachStorylineToTopic(deps.db, {
      fingerprint: query.fingerprint,
      storylineId: request.seedStorylineId,
      // The keywords as `story_tokens` would have them: the phrase is derived
      // under the same fold, so a storyline's own articles always pass.
      tokens: query.keywords.map(singular),
      language: query.language,
    });
  }

  if (seeded === 0) {
    const cached = await readCachedPage<TimelineReadResult>(deps.redis, cacheKey);
    deps.metrics?.pageCacheRead(freshnessTier(query.window.to, now), cached ? "hit" : "miss");
    if (cached) {
      return { ...cached, meta: { ...cached.meta, servedFrom: "cache" } };
    }
  }

  await upsert();

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
          deferred.push(...(await onTruncated(deps, query.fingerprint, gap, outcome.oldestSeen)));
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
  // §6.3 step 6 reads from the model the flag selects. Everything above this
  // line — coverage, planning, quota, the fill — is about what is STORED and is
  // identical either way; only the shape of a slot differs (ADR-0011).
  const v2 = deps.config.storylinesV2;
  const stored = v2
    ? await readStorylineTimelinePage(deps.db, {
        fingerprint: query.fingerprint,
        from: query.window.from,
        to: query.window.to,
        ...(cursor ? { cursor } : {}),
        limit: request.limit,
        timeZone: deps.config.grouping.timeZone,
      })
    : await readTimelinePage(deps.db, {
        fingerprint: query.fingerprint,
        from: query.window.from,
        to: query.window.to,
        ...(cursor ? { cursor } : {}),
        limit: request.limit,
      });

  // Storylines this SEARCH surfaces, beside the results rather than narrowing
  // them (ADR-0011). Keywords are folded the way `story_tokens` and therefore
  // `profile_tokens` were, or a search for "storms" would miss a profile that
  // says "storm".
  const surfaced = v2
    ? await findSurfacedStorylines(deps.db, {
        tokens: query.keywords.map(singular),
        limit: SURFACED_STORYLINE_LIMIT,
      })
    : [];

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
    items: stored.items.map((slot) =>
      "dayKey" in slot ? toStorylineEntry(slot) : toEntry(slot),
    ),
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
function toEntry(slot: TimelineSlot): TimelineEntry {
  const byGroup = new Map<string, SlotMember[]>();
  for (const member of slot.members) {
    const list = byGroup.get(member.groupId);
    if (list) list.push(member);
    else byGroup.set(member.groupId, [member]);
  }

  // Largest group leads; ties break earliest-published then lowest id, so a
  // replayed read reaches the same slot (§7.4's replay discipline, again).
  let lead: { groupId: string; members: SlotMember[] } | null = null;
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
    // Only where the day produced coverage AROUND the story (ADR-0010): a
    // slot of one story, however many outlets ran it, is an article rather
    // than a topic, and a phrase beside every slot would be furniture.
    // Derived over the headline and the wider coverage — NOT over `related`,
    // whose near-identical copies would let a phrase qualify on syndication
    // alone and then miss the angle pieces the search has to reach.
    storylinePhrase: storylinePhrase(article, moreCoverage),
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
 * storyline's day slots. `attachStorylineToTopic` and its token gate retire
 * with the flag.
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
  // The view pages `storyline_days` whatever the flag says, so its cursors are
  // v2 by construction — a v1 one reaching it is a cursor from somewhere else.
  const cursor = takeCursor(request.cursorString, "v2");

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
  candidate: { groupId: string; members: SlotMember[] },
  incumbent: { groupId: string; members: SlotMember[] },
): boolean {
  if (candidate.members.length !== incumbent.members.length) {
    return candidate.members.length > incumbent.members.length;
  }
  const byTime =
    earliest(candidate.members) - earliest(incumbent.members);
  if (byTime !== 0) return byTime < 0;
  return BigInt(candidate.groupId) < BigInt(incumbent.groupId);
}

function earliest(members: readonly SlotMember[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const member of members) {
    const t = Date.parse(member.article.published);
    if (t < min) min = t;
  }
  return min;
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
        index === 0 ? job.startPage : 1,
        // No reader is waiting: draw only what the interactive reserve spares
        // (§9.4). A refusal fails the job; BullMQ's backoff is the retry pacing.
        "background",
      );
      if (outcome.kind === "truncated") {
        for (const half of await onTruncated(deps, job.fingerprint, slice, outcome.oldestSeen)) {
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
  deadline: number;
  maxCalls: number;
  callsUsed: number;
}

type FillOutcome =
  | { kind: "completed"; callsMade: number }
  | { kind: "deferred"; resumePage: number; callsMade: number }
  /** `oldestSeen`: the frontier the fetched pages reached — null only when
   * normalization dropped everything. */
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

    // §14.3, immediately after the collapse and only over what this call
    // created: the two are one write path — one deduplicates by URL, the other
    // groups what URLs alone cannot. Grouping never throws (see the service),
    // so a reader waiting on this fill cannot be failed by it.
    await groupCreatedArticles(groupingDepsFor(deps), ingested.createdArticles);

    for (const sighting of result.sightings) {
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
): Promise<SegmentJob[]> {
  deps.metrics?.truncatedSegment();

  if (oldestSeen !== null) {
    const boundary = new Date(oldestSeen.getTime() + 1);
    if (boundary.getTime() > segment.from.getTime() && boundary.getTime() < segment.to.getTime()) {
      await recordCoverage(deps.db, fingerprint, { from: boundary, to: segment.to });
      return [segmentJob(fingerprint, { from: segment.from, to: boundary }, 1)];
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
