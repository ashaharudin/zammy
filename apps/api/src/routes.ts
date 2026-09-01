import type { FastifyInstance } from "fastify";
import {
  isStorylineView,
  STORYLINE_UUID,
  TimelineQuery,
  TrendingQuery,
} from "@zammy/shared";
import { countTopicArticles, readCoverage, readTopic } from "@zammy/storage";
import {
  repairedLanguages,
  repairedRegions,
  type CurrentsClient,
} from "@zammy/currents-client";
import type { Redis } from "ioredis";
import { canonicalize, type ReferenceCodes } from "./canonical.js";
import { PLANNED_COVERAGE_PROVIDER } from "./coverage-gaps.js";
import {
  InvalidCursorError,
  readStorylineView,
  readTimeline,
  type TimelineSearchDeps,
} from "./timeline-read.js";
import { queueStorylineRefresh, type StorylineRefreshDeps } from "./storyline-refresh.js";
import {
  queueStorylineDeepening,
  type StorylineDeepeningDeps,
} from "./storyline-deepening.js";
import { readTrending, type TrendingDeps } from "./trending-service.js";

/**
 * The public HTTP surface (ARCHITECTURE 6.1). Thin on purpose: parse with the
 * shared contract, canonicalize, delegate. Everything a browser depends on is
 * typed in @zammy/shared; everything with judgment lives in the planner.
 */

/**
 * What the query routes reach, as the INTERSECTION of the planner modules they
 * delegate to rather than as a bag of its own.
 *
 * A process serving HTTP has one pool, one Redis, one queue and one client
 * behind all four planners, so it hands the same object to each of them — but
 * the type says which modules these routes can call, and each module still
 * states its own dependency list. Nothing can be added here without adding it
 * to a planner that needs it.
 *
 * The last member is the routes' own: `/available/*` is served from here and
 * from nowhere else, so it is the only place `availableLanguages` is reachable.
 */
export type QueryRouteDeps = TimelineSearchDeps &
  StorylineRefreshDeps &
  StorylineDeepeningDeps & {
    redis: Redis;
    currents: Pick<CurrentsClient, "availableLanguages" | "availableRegions">;
  };

export interface QueryRouteOptions {
  deps: QueryRouteDeps;
  defaultLanguage: string;
}

/** 24h, matching the upstream refresh cadence in §9.1. */
const REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

/** What a caller validates against when the cached reference is not there. */
const EMPTY_REFERENCE_CODES: ReferenceCodes = {
  languages: new Set(),
  regions: new Set(),
};

/**
 * The reference lists a picker draws from. No categories since ADR-0020: a
 * reader cannot choose one, so serving the taxonomy would be advertising a
 * control that does not exist — and the next person to see it on the wire
 * would reasonably build the chip back.
 *
 * The Currents adapter still PARSES the taxonomy out of a recorded 400 body
 * and `availableCategories()` is still on the `NewsClient` interface; only the
 * offer goes. That plumbing is expensive to re-derive and cheap to keep, and
 * §10.1's breadth sample still sends categories upstream — what changed is
 * that no reader picks one.
 */
interface ReferenceData {
  languages: Record<string, string>;
  regions: Record<string, string>;
}

export async function registerQueryRoutes(
  app: FastifyInstance,
  options: QueryRouteOptions,
): Promise<void> {
  const { deps } = options;

  app.get("/api/v1/timeline", async (request, reply) => {
    const parsed = TimelineQuery.safeParse(request.query);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        fields[String(issue.path[0] ?? "query")] ??= issue.message;
      }
      return reply.status(400).send({ error: { message: "invalid query", fields } });
    }

    // The STORYLINE VIEW (ADR-0011): a UUID with an empty search box. It has no
    // keywords, so it has no topic, no coverage and no fill — it is a read of
    // one storyline's day slots and nothing else. Handled before
    // canonicalization because there is nothing to canonicalize.
    if (isStorylineView(parsed.data)) {
      try {
        const view = await readStorylineView(deps, {
          storylineId: parsed.data.storyline!,
          limit: parsed.data.limit,
          ...(parsed.data.cursor ? { cursorString: parsed.data.cursor } : {}),
        });
        if (view === null) {
          return reply.status(404).send({ error: { message: "unknown storyline" } });
        }
        return await reply.send(view);
      } catch (error) {
        // The same mapping the search branch gets below. A cursor minted by the
        // other model reaches THIS branch too — a reader mid-scroll in the view
        // when the flag flips — and an unmapped throw here is the 500 the
        // cursor guard exists to prevent.
        if (error instanceof InvalidCursorError) {
          return reply.status(400).send({
            error: { message: "invalid query", fields: { cursor: "unusable cursor" } },
          });
        }
        throw error;
      }
    }

    // Validating filters against the cached reference lists catches a bad
    // language locally instead of spending a quota token to learn it (§6.2).
    const reference = await loadReference(deps);
    const canonical = canonicalize(
      {
        // Non-null past the storyline-view branch: the schema's refinement
        // makes `q` optional only for that case.
        q: parsed.data.q!,
        language: parsed.data.language,
        country: parsed.data.country,
        // No category, and nothing above dropped one: `TimelineQuery` never
        // named it, so a bookmarked `?category=technology` was stripped by the
        // schema and this is the same search without the filter (ADR-0020).
        from: parsed.data.from ? new Date(parsed.data.from) : undefined,
        to: parsed.data.to ? new Date(parsed.data.to) : undefined,
      },
      {
        reference: referenceCodes(reference),
        defaultLanguage: options.defaultLanguage,
        lookbackDays: deps.config.lookbackDays,
        now: deps.now(),
      },
    );
    if (!canonical.ok) {
      return reply
        .status(400)
        .send({ error: { message: "invalid query", fields: canonical.errors } });
    }

    try {
      // No `storyline` is passed on, and none is dropped: the only request that
      // carries one with a search box is impossible — `isStorylineView` above
      // takes every UUID that arrives without keywords, and `TimelineQuery`
      // rejects the rest. `ReadRequest` last had a field for it under ADR-0010's
      // seed, which ADR-0011 replaced with the view; the line that kept passing
      // it went with the split.
      const result = await readTimeline(deps, canonical.query, {
        limit: parsed.data.limit,
        ...(parsed.data.cursor ? { cursorString: parsed.data.cursor } : {}),
      });
      return await reply.send(result);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        return reply.status(400).send({
          error: { message: "invalid query", fields: { cursor: "unusable cursor" } },
        });
      }
      throw error;
    }
  });

  /**
   * POST /api/v1/storylines/:id/refresh (§9.1, ADR-0017) — opening a storyline
   * queues one background top-up of the topic its own coverage names.
   *
   * A POST because it mints a topic and publishes to the queue, and a route of
   * its own rather than a flag on the timeline read because the two answer
   * different questions: the storyline view reads day slots by UUID and must
   * not wait on ingestion, and this asks for ingestion and has nothing to
   * render. The caller is fire-and-forget (`refreshStoryline` in the browser),
   * so the body is for operators and tests — nothing on the page reads it.
   *
   * **A UUID is the whole request**: no keywords, no filters, no window. The
   * planner derives every part of the ask from the arc's own coverage, and the
   * reason it must is in `queueStorylineRefresh`. What is left here is the one
   * thing the planner cannot do — checking the derived language against the
   * reference lists, since only the route holds them (`loadReference`) — and see
   * the callback below for why a language they do not list is DROPPED rather
   * than refused. A 400 is therefore about the UUID's shape and nothing else.
   */
  app.post<{ Params: { id: string } }>(
    "/api/v1/storylines/:id/refresh",
    async (request, reply) => {
      const { id } = request.params;
      if (!STORYLINE_UUID.test(id)) {
        return reply.status(400).send({
          error: { message: "invalid query", fields: { id: "must be a storyline UUID" } },
        });
      }

      // The CACHED reference only — never `loadReference`, which spends three
      // interactive upstream calls on a cold cache. See `cachedReference`.
      const cached = await cachedReference(deps);
      const codes = cached === null ? null : referenceCodes(cached);
      const outcome = await queueStorylineRefresh(deps, {
        storylineId: id,
        // The window is the default lookback ending now — no `from`/`to` is
        // accepted, because a background refresh is about the leading edge and
        // an arbitrary window would let a caller aim the queue at any span of
        // the archive it liked.
        canonicalize: ({ keywords, language }) => {
          // An arc's own language is an ARTICLE's `language` field, and that is
          // not drawn from the same vocabulary as `/available/languages`, which
          // is what a query may be narrowed by. The reference table is mostly
          // ISO-639-1 but not entirely — `{"Malay": "msa"}`, three letters,
          // recorded in PROBE-FINDINGS 6 with the warning never to derive a code
          // — so an article saying `ms` names a language upstream will not
          // accept as a filter.
          //
          // Dropped rather than passed on to be refused. A 400 here would be
          // silent by construction (the caller is fire-and-forget with no error
          // path) and permanent for that arc, which is the worst available
          // outcome: a refresh in the configured default is worth more than no
          // refresh for as long as the arc exists.
          const filter =
            language !== undefined && codes !== null && codes.languages.has(language);
          if (language !== undefined && !filter) {
            deps.log?.warn(
              { storyline: id, language, cachedReference: codes !== null },
              "storyline refresh: the arc's own language is not a query code; falling back to the default",
            );
          }
          return canonicalize(
            { q: keywords, ...(filter ? { language } : {}) },
            {
              // An empty set on a cache miss, which costs nothing: the only field
              // being validated is the language, and `filter` above has already
              // dropped it. A country is never sent from here.
              reference: codes ?? EMPTY_REFERENCE_CODES,
              defaultLanguage: options.defaultLanguage,
              lookbackDays: deps.config.lookbackDays,
              now: deps.now(),
            },
          );
        },
      });

      if (outcome.status === "unknown") {
        return reply.status(404).send({ error: { message: "unknown storyline" } });
      }
      if (outcome.status === "invalid") {
        return reply
          .status(400)
          .send({ error: { message: "invalid query", fields: outcome.errors } });
      }
      // The DEEPENING plane's half of the same click (ADR-0019, plan §G5),
      // planned separately and reported separately.
      //
      // Two plans rather than one, because ADR-0019 is explicit that providers
      // stop sharing a plan: the refresh above asks a TOPIC of the discovery
      // provider against `topic_coverage`, this asks an ARC of the deepening
      // provider against `storyline_coverage`, and neither completion may stand
      // for the other's. They can and will disagree about whether this arc is
      // fresh, which is the point of per-provider coverage rather than a defect.
      //
      // After the refresh and awaited, not raced: both enqueue and neither
      // fetches, so the cost is two Redis round trips on a fire-and-forget POST.
      // Sequential keeps the failure story simple — a throw here fails the
      // request AFTER the refresh has been queued, which is the same partial
      // outcome any two-write route has, rather than an unhandled rejection.
      //
      // It answers `unavailable` and spends nothing whenever no deepening
      // provider is configured, which is the shipped default
      // (`GOOGLE_NEWS_ENABLED=false`). So this route's behaviour is unchanged
      // for anyone who has not turned the flag on.
      const deepened = await queueStorylineDeepening(deps, { storylineId: id });

      // 202 for every outcome that reached the planner, `fresh` included: the
      // request was accepted and what it cost is a fact about coverage, not a
      // different kind of answer. `queued: false` is the honest report of a
      // storyline whose trailing edge is already inside the staleness tier.
      //
      // `queued` stays the REFRESH's answer and the deepening plane reports
      // under its own key. OR-ing the two would have been the smaller diff and
      // it would make the field mean "something was queued somewhere", which no
      // caller could act on — and this body is read by operators and tests, both
      // of whom are asking which plane spent what.
      return reply.status(202).send({
        storyline: outcome.storylineId,
        queued: outcome.status === "queued",
        ...(outcome.status === "no_keywords"
          ? { keywords: [] }
          : { keywords: outcome.keywords, fingerprint: outcome.fingerprint }),
        deepening: {
          status: deepened.status,
          queued: deepened.status === "queued",
        },
      });
    },
  );

  app.get("/api/v1/reference", async (_request, reply) => {
    // Verbatim upstream CODES for what a reader can still narrow by: languages
    // and regions. The category taxonomy is no longer served (ADR-0020) — a
    // list nothing can be picked from is an offer, not information. The region
    // and language NAMES are spell-checked (`repairedRegions`,
    // `repairedLanguages`) — they are display text, and five of them are typed
    // wrong upstream.
    return reply.send(await loadReference(deps));
  });

  app.get<{ Params: { fingerprint: string } }>(
    "/api/v1/topics/:fingerprint",
    async (request, reply) => {
      const { fingerprint } = request.params;
      if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
        return reply.status(400).send({
          error: { message: "fingerprint must be 64 hex characters" },
        });
      }

      const topic = await readTopic(deps.db, fingerprint);
      if (!topic) {
        return reply.status(404).send({ error: { message: "unknown topic" } });
      }

      const [articleCount, coverage] = await Promise.all([
        countTopicArticles(deps.db, fingerprint),
        // The planner's provider, so an operator reading this route sees the
        // spans the fetcher actually treats as done. Other providers' rows are
        // real and are deliberately not summed in here: coverage stopped having
        // a single answer (ADR-0019), and a union of two providers' spans would
        // be a number that describes no provider's walk.
        readCoverage(deps.db, fingerprint, PLANNED_COVERAGE_PROVIDER),
      ]);
      const first = coverage[0];
      const last = coverage.at(-1);

      return reply.send({
        fingerprint: topic.fingerprint,
        keywords: topic.keywords,
        language: topic.language,
        country: topic.country,
        // Still reported, and it is not an offer: this route states what a
        // STORED topic is, and 29 of them were minted with a category before
        // ADR-0020. Hiding it would make an operator reading a row's coverage
        // unable to see what the row's fingerprint actually means.
        category: topic.category,
        articleCount,
        coverage:
          first && last
            ? { from: first.from.toISOString(), to: last.to.toISOString() }
            : null,
        summary: topic.summary,
        createdAt: topic.createdAt.toISOString(),
        lastHitAt: topic.lastHitAt.toISOString(),
      });
    },
  );
}

/** GET /api/v1/trending (§10.4) — the landing-page cloud. */
export function registerTrendingRoute(
  app: FastifyInstance,
  options: { deps: TrendingDeps },
): void {
  app.get("/api/v1/trending", async (request, reply) => {
    const parsed = TrendingQuery.safeParse(request.query);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        fields[String(issue.path[0] ?? "query")] ??= issue.message;
      }
      return reply.status(400).send({ error: { message: "invalid query", fields } });
    }

    return reply.send(
      await readTrending(options.deps, {
        language: parsed.data.language,
        limit: parsed.data.limit,
      }),
    );
  });
}

/**
 * The cached /available/* values (§7.1: ref:* keys, 24h). In live mode this is
 * what turns three quota tokens a day into zero on the hot path; in fixture
 * mode it simply mirrors the recorded bodies.
 */
async function loadReference(deps: QueryRouteDeps): Promise<ReferenceData> {
  const reference = await fetchReference(deps);
  // Names are repaired on the way OUT, not on the way into the cache, and that
  // is the point: `ref:*` holds upstream's body for a day, so repairing before
  // the `set` would leave every already-warm cache — and every fixture bundle —
  // serving "United State" until tomorrow, and would make the tables' next edit
  // wait on a TTL. Codes are untouched, so `referenceCodes` still validates a
  // filter against exactly what upstream accepts (§2).
  //
  // The browser caches this response for a day of its own (`useReference`), so a
  // tab that loaded before a table changed keeps the old name until it reloads.
  // Server-side is the half this can control.
  return {
    ...reference,
    regions: repairedRegions(reference.regions),
    languages: repairedLanguages(reference.languages),
  };
}

/**
 * The cached reference, or `null` — for the one caller that must not spend an
 * upstream call to learn a language code (`/storylines/:id/refresh`).
 *
 * `fetchReference` below falls through a cold or faulted cache to three
 * `interactive` upstream calls, which on a request path advertised as spending
 * nothing is the worst shape available: the reference load exists there only to
 * decide whether to KEEP the arc's own language, and the route is already willing
 * to drop it. A cold `ref:*` (dev Redis evicts under `volatile-lru`) or an
 * Upstash blip would therefore have turned every label click into three calls at
 * the moment the per-IP limiter also fails open (`skipOnError`) — a reader
 * clicking through the cloud draining a day's quota, invisibly, since the caller
 * has no error path.
 *
 * So a miss means "no codes", which means the language is dropped and the
 * configured default is used. Same answer the route already gives a language the
 * table does not list, reached without asking anyone.
 */
async function cachedReference(deps: QueryRouteDeps): Promise<ReferenceData | null> {
  try {
    const [languages, regions] = await deps.redis.mget("ref:languages", "ref:regions");
    if (languages && regions) {
      return {
        languages: JSON.parse(languages) as Record<string, string>,
        regions: JSON.parse(regions) as Record<string, string>,
      };
    }
  } catch {
    // Redis down — a miss, same as a cold key. Never an upstream call here.
  }
  return null;
}

async function fetchReference(deps: QueryRouteDeps): Promise<ReferenceData> {
  const keys = ["ref:languages", "ref:regions"] as const;
  const cached = await cachedReference(deps);
  if (cached) return cached;

  // Two calls, not three: `availableCategories()` is no longer asked for, since
  // nothing downstream can use the answer (ADR-0020). `ref:categories` is left
  // unwritten and whatever a pre-G8 instance cached there expires on its own.
  const [languages, regions] = await Promise.all([
    deps.currents.availableLanguages(),
    deps.currents.availableRegions(),
  ]);

  try {
    await deps.redis.set(keys[0], JSON.stringify(languages), "PX", REFERENCE_TTL_MS);
    await deps.redis.set(keys[1], JSON.stringify(regions), "PX", REFERENCE_TTL_MS);
  } catch {
    // Next request fetches again; two calls a day is an acceptable worst case.
  }

  return { languages, regions };
}

/** Name→code maps reduce to their VALUES — never derive codes from names (§2). */
function referenceCodes(reference: ReferenceData): ReferenceCodes {
  return {
    languages: new Set(Object.values(reference.languages)),
    regions: new Set(Object.values(reference.regions)),
  };
}
