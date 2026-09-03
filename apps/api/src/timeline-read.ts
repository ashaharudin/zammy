import type { Kysely } from "kysely";
import type { Redis } from "ioredis";
import {
  cursorGeneration,
  decodeCursor,
  encodeCursor,
  type Article,
  type Cursor,
  type StorylineSummary,
  type TimelineEntry,
  type TimelinePage,
} from "@zammy/shared";
import {
  findSurfacedStorylines,
  readCoverage,
  readGroupMemberships,
  readStorylineArticleCount,
  readStorylineTimelinePage,
  resolveStoryline,
  upsertTopic,
  type Database,
  type StorylineSlot,
} from "@zammy/storage";
import type { CanonicalQuery } from "./canonical.js";
import { fillWindowForRead, type CoverageFillDeps } from "./coverage-fill.js";
import { PLANNED_COVERAGE_PROVIDER } from "./coverage-gaps.js";
import {
  freshnessTier,
  freshnessTtlMs,
  pageCacheKey,
  readCachedPage,
  writeCachedPage,
} from "./page-cache.js";
import { TIMELINE_READ_MESSAGE } from "./observations.js";
import type { IngestQueue } from "./ingest-queue.js";
import { chooseHeading } from "@zammy/representative";
import { labelWords } from "./storyline-label-merge.js";

/**
 * The reader's read path (ARCHITECTURE 6.3) — how a page gets filled, or
 * ideally how it is served without filling anything:
 *
 *   cache → store-if-covered → deadline-bounded synchronous fill of the
 *   newest gap → everything unfinished to the queue.
 *
 * Only the third step reaches upstream, and it is `coverage-fill.ts`'s job; what
 * is here is the sequence around it and the slot rendering at the end. The §12
 * invariant this file owns is that `page.hasMore` (more in our store) stays
 * independent of `meta.ingest.state` (more may still arrive) — conflating them
 * tells users "that's everything" mid-ingest.
 */

/**
 * What `readStorylineView` needs, which is genuinely three things.
 *
 * Split out and named because the storyline view is the one read in the system
 * that cannot fetch: a UUID is not a search, nothing is enrolled by reading it,
 * and until the `timeline-service` split it was nonetheless handed a Currents
 * client, a queue, a labeler and the grouping threshold, and touched none of
 * them.
 */
export interface StorylineViewDeps {
  db: Kysely<Database>;
  now: () => Date;
  config: {
    /**
     * The calendar day slots are paged by (§7.3). Read off the GROUPING config
     * rather than given a field of its own, because it has to be the same zone
     * the write path filed those slots under — two settings would be two days.
     */
    grouping: { timeZone: string };
  };
}

/**
 * What the timeline read adds on top: the page cache, and the pending count
 * that separates "that is everything" from "more is still arriving".
 */
export interface TimelineReadDeps extends StorylineViewDeps {
  redis: Redis;
  /** Only `pendingCount`. Enqueuing is the fill's business, never the read's. */
  queue: Pick<IngestQueue, "pendingCount">;
}

export interface TimelineReadResult {
  topic: {
    fingerprint: string;
    keywords: string[];
    coverage: { from: string; to: string } | null;
  };
  /** Storylines this search surfaced (ADR-0011). Empty under the old model. */
  storylines: StorylineSummary[];
  /**
   * Which storylines each GROUP on this page is filed in, and the arcs that
   * answer those names — the wire contract's `memberships`, whose own comment
   * carries why it is keyed by group and page-level rather than hung on an
   * entry.
   *
   * Both entry points fill it. A reader inside one arc needs it as much as a
   * searcher does: the storyline view is precisely the place where "this piece
   * also runs somewhere else" is a way out, and it is the one view where the
   * gutter beside every row says the same thing.
   */
  memberships: TimelinePage["memberships"];
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

/**
 * The dependency list of a search read, which is the union of two modules'
 * and is written as one rather than hidden behind a facade.
 *
 * §6.3 is explicit that serving a search MAY spend an upstream call — a cold
 * topic's first page exists only because the read fetched it — so the honest
 * statement is that this entry point needs both the reader's half
 * (`TimelineReadDeps`) and the fetcher's (`CoverageFillDeps`). What the split
 * bought is that each half is separately small and separately satisfiable:
 * `readStorylineView` takes three fields, and a test that seeds coverage can
 * drive this one without a Currents client that could ever answer.
 */
export type TimelineSearchDeps = TimelineReadDeps & CoverageFillDeps;

export async function readTimeline(
  deps: TimelineSearchDeps,
  query: CanonicalQuery,
  request: ReadRequest,
): Promise<TimelineReadResult> {
  const startedAt = Date.now();
  // Read here, at the same instant `startedAt` is taken, so the tier this line
  // reports is the one the cache lookup inside will make its decision on.
  const tier = freshnessTier(query.window.to, deps.now());
  const result = await planAndRead(deps, query, request);
  // §12's read-path numbers as log fields, which since ADR-0015 deleted
  // `/metrics` is where they live. Two of the five §12 names in one line,
  // because they are answered by the same read: **cache hit ratio by tier**
  // (§6.4) and **p95 latency by `servedFrom`**.
  //
  // `cache` is derived from `servedFrom` rather than plumbed up from the lookup,
  // and the two cannot drift: `planAndRead` returns `servedFrom: "cache"` on
  // exactly the branch the cache answered on, and no other branch can produce
  // that value.
  //
  // The platform reports invocation latency, which is why the ADR says platform
  // observability covers latency — but it cannot report it BY `servedFrom`, and
  // "how slow is a read that had to fetch" is the only version of the question
  // §6.3 is about.
  deps.log?.info?.(
    {
      fingerprint: query.fingerprint,
      tier,
      cache: result.meta.servedFrom === "cache" ? "hit" : "miss",
      servedFrom: result.meta.servedFrom,
      seconds: (Date.now() - startedAt) / 1000,
    },
    TIMELINE_READ_MESSAGE,
  );
  return result;
}

export interface ReadRequest {
  limit: number;
  cursorString?: string;
}

async function planAndRead(
  deps: TimelineSearchDeps,
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
  if (cached) {
    return { ...cached, meta: { ...cached.meta, servedFrom: "cache" } };
  }

  // The topic exists (and counts a hit) from the first request onward, so
  // deferred jobs enqueued below can always recover the search parameters.
  // Before the fill for exactly that reason, and unconditional so that a read
  // finding nothing to fetch still keeps the topic ahead of retention (§7.5).
  await upsertTopic(deps.db, {
    fingerprint: query.fingerprint,
    keywords: query.keywords,
    language: query.language,
    country: query.country,
    category: query.category,
  });

  // §6.3 steps 2–5. Everything that reaches upstream is in there, and what
  // comes back is only what the response's `meta` has to say about it.
  const fill = await fillWindowForRead(deps, query, now);

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

  // Which storylines the page's groups are filed in (`memberships`). After the
  // page is settled and over its groups alone, so it costs one indexed statement
  // per page rather than a wider join in the keyset scan
  // (`readGroupMemberships`).
  const memberships = await readGroupMemberships(deps.db, groupsOn(stored.items));

  const pendingJobs = await deps.queue.pendingCount(query.fingerprint);
  const state: "complete" | "in_progress" =
    pendingJobs > 0 || fill.lockLostToPeer ? "in_progress" : "complete";

  // Re-read only where the fill could have moved it, which is exactly where it
  // found gaps to plan. Last of the four reads, as it has always been.
  const coverageNow = fill.plannedGaps
    ? await readCoverage(deps.db, query.fingerprint, PLANNED_COVERAGE_PROVIDER)
    : fill.coverageBefore;
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
    storylines: surfaced.map(toSummary),
    memberships: {
      byGroup: Object.fromEntries(memberships.byGroup),
      storylines: memberships.storylines.map(toSummary),
    },
    page: {
      nextCursor: stored.nextCursor ? encodeCursor(stored.nextCursor) : null,
      hasMore: stored.hasMore,
    },
    meta: {
      servedFrom: fill.servedFrom,
      asOf: now.toISOString(),
      stale: fill.stale,
      degraded: fill.degraded,
      ingest: { state, pendingJobs },
    },
  };

  // Cache only settled pages. A cached in_progress response would freeze the
  // progressive fill for its whole TTL — the front end polls expecting growth
  // (§6.5 point 4) — a degraded one would outlive the outage, and a capped one
  // has unfilled, unqueued gaps that tomorrow's budget is meant to repair.
  // Stale is checked on its own because the in-process consumer can finish
  // the top-up before pendingCount runs, making a stale read look settled.
  if (state === "complete" && fill.degraded === null && !fill.capped && !fill.stale) {
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
 * Which member holds the headline is NOT decided here, and the reason is that
 * it is not decided here alone: the rail cuts this slot again in the browser
 * and heads each part of the reader's day by the same rule. It lives in
 * `@zammy/representative`, whole, and this function is one of its two callers.
 * What it owes the rule is clause 1 — `slot.members` are the members that
 * matched THIS search, per topic and per read, because a slot-wide choice could
 * surface an article the user's keywords never found and hide the matching one
 * under "related" (`packages/storage/src/storyline-timeline.ts`, step 2).
 *
 * The slot's position is not chosen here and never changes with the headline:
 * `published` is the storyline's (§7.3).
 *
 * The group ids are no longer SPENT here. They ride on to the browser on every
 * article (`Article.groupId`), because the rail cuts a slot again — into the
 * parts of the reader's day — and needs the same "these are one piece" fact
 * this function reads. It used to reconstruct it from exact title equality,
 * which folds two unrelated "Live updates" into one card.
 */
function toEntry(slot: {
  id: string;
  published: string;
  members: Article[];
}): TimelineEntry {
  // Clauses 2 and 3 of the representative rule, whole and named
  // (`@zammy/representative`). `within` is left at its default: a slot takes
  // §14.3's own rule — largest group leads, source authority picks inside it,
  // ties breaking earliest-published then lowest id so a replayed read reaches
  // the same slot (§7.4's replay discipline, again). The rail applies the SAME
  // function to a card it cuts out of a later part of the reader's day, which
  // is what makes the two agreeing a test rather than two doc comments.
  //
  // `coverage` comes back flattened, and each member still names its group in
  // `groupId` — the split is a READING of the members, not a re-shaping of
  // them, so the wire keeps the one order the disclosure renders in while the
  // rail can still recover which of these are one piece.
  const { representative, related, coverage } = chooseHeading(slot.members);

  return {
    storylineId: slot.id,
    published: slot.published,
    // Members are newest first, so the head is the slot's latest coverage.
    // This is what the UI shows as "updated", the same treatment ADR-0002
    // gives an article whose later sightings do not move it.
    updatedAt: slot.members[0]?.published ?? slot.published,
    article: representative,
    related,
    moreCoverage: coverage,
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
  deps: StorylineViewDeps,
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
  const memberships = await readGroupMemberships(deps.db, groupsOn(stored.items));
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
    memberships: {
      byGroup: Object.fromEntries(memberships.byGroup),
      storylines: memberships.storylines.map(toSummary),
    },
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

/**
 * Every group the page holds an article from — what membership is asked about.
 *
 * The SLOT's members, not the entry's headline: a slot's articles are split into
 * three lists by `toEntry` and all three are on screen, so asking about the lead
 * group alone would leave every "more coverage" row unanswered — which is
 * exactly where the crossings the feature exists for actually live.
 *
 * Asking about `related` costs nothing and reports nothing, and that asymmetry
 * is the design rather than an oversight: "same story" is the lead group's OTHER
 * MEMBERS, so those rows carry the lead's own `groupId` and are in precisely the
 * headline's storylines, always. They are already in this list by virtue of the
 * lead being in it.
 */
function groupsOn(slots: readonly StorylineSlot[]): string[] {
  return slots.flatMap((slot) => slot.members.map((member) => member.groupId));
}

/**
 * A stored storyline → the summary a page names it by, for both of the lists
 * that carry one: the search's surfaced storylines and the membership
 * directory. One mapper, because the two differ in why the storyline is on the
 * page and in nothing about the storyline.
 *
 * `dormant` rather than the status, per the wire contract: `provisional` never
 * reaches either list, so running-or-quiet is the whole distinction left.
 */
function toSummary(storyline: {
  id: string;
  label: string | null;
  spanFrom: string;
  spanTo: string;
  size: number;
  status: string;
}): StorylineSummary {
  return {
    id: storyline.id,
    label: storyline.label,
    from: storyline.spanFrom,
    to: storyline.spanTo,
    size: storyline.size,
    dormant: storyline.status === "dormant",
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
 * Deliberately the same shape and the same choices as `toEntry` above, by
 * calling it: one representative rule, applied once. What changes is only which
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

