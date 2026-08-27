import type { FastifyInstance } from "fastify";
import {
  isStorylineView,
  STORYLINE_UUID,
  TimelineQuery,
  TrendingQuery,
} from "@zammy/shared";
import { countTopicArticles, readCoverage, readTopic } from "@zammy/storage";
import { repairedLanguages, repairedRegions } from "@zammy/currents-client";
import { canonicalize, type ReferenceCodes } from "./canonical.js";
import {
  InvalidCursorError,
  queueStorylineRefresh,
  readStorylineView,
  readTimeline,
  type TimelineDeps,
} from "./timeline-service.js";
import { readTrending, type TrendingDeps } from "./trending-service.js";

/**
 * The public HTTP surface (ARCHITECTURE 6.1). Thin on purpose: parse with the
 * shared contract, canonicalize, delegate. Everything a browser depends on is
 * typed in @zammy/shared; everything with judgment lives in the planner.
 */

export interface QueryRouteOptions {
  deps: TimelineDeps;
  defaultLanguage: string;
}

/** 24h, matching the upstream refresh cadence in §9.1. */
const REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

interface ReferenceData {
  languages: Record<string, string>;
  regions: Record<string, string>;
  categories: string[];
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
        category: parsed.data.category,
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
      const result = await readTimeline(deps, canonical.query, {
        limit: parsed.data.limit,
        ...(parsed.data.cursor ? { cursorString: parsed.data.cursor } : {}),
        ...(parsed.data.storyline ? { seedStorylineId: parsed.data.storyline } : {}),
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

      const reference = await loadReference(deps);
      const codes = referenceCodes(reference);
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
          const filter = language !== undefined && codes.languages.has(language);
          if (language !== undefined && !filter) {
            deps.log?.warn(
              { storyline: id, language },
              "storyline refresh: the arc's own language is not a query code; falling back to the default",
            );
          }
          return canonicalize(
            { q: keywords, ...(filter ? { language } : {}) },
            {
              reference: codes,
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
      // 202 for every outcome that reached the planner, `fresh` included: the
      // request was accepted and what it cost is a fact about coverage, not a
      // different kind of answer. `queued: false` is the honest report of a
      // storyline whose trailing edge is already inside the staleness tier.
      return reply.status(202).send({
        storyline: outcome.storylineId,
        queued: outcome.status === "queued",
        ...(outcome.status === "no_keywords"
          ? { keywords: [] }
          : { keywords: outcome.keywords, fingerprint: outcome.fingerprint }),
      });
    },
  );

  app.get("/api/v1/reference", async (_request, reply) => {
    // Verbatim upstream CODES, junk categories included: filtering belongs
    // to the UI picker, because a stored sighting may legitimately carry one.
    // The region and language NAMES are spell-checked (`repairedRegions`,
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
        readCoverage(deps.db, fingerprint),
      ]);
      const first = coverage[0];
      const last = coverage.at(-1);

      return reply.send({
        fingerprint: topic.fingerprint,
        keywords: topic.keywords,
        language: topic.language,
        country: topic.country,
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
async function loadReference(deps: TimelineDeps): Promise<ReferenceData> {
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

async function fetchReference(deps: TimelineDeps): Promise<ReferenceData> {
  const keys = ["ref:languages", "ref:regions", "ref:categories"] as const;
  try {
    const [languages, regions, categories] = await deps.redis.mget(...keys);
    if (languages && regions && categories) {
      return {
        languages: JSON.parse(languages) as Record<string, string>,
        regions: JSON.parse(regions) as Record<string, string>,
        categories: JSON.parse(categories) as string[],
      };
    }
  } catch {
    // Redis down → fetch through the client; degraded, not down (§11).
  }

  const [languages, regions, categories] = await Promise.all([
    deps.currents.availableLanguages(),
    deps.currents.availableRegions(),
    deps.currents.availableCategories(),
  ]);

  try {
    await deps.redis.set(keys[0], JSON.stringify(languages), "PX", REFERENCE_TTL_MS);
    await deps.redis.set(keys[1], JSON.stringify(regions), "PX", REFERENCE_TTL_MS);
    await deps.redis.set(keys[2], JSON.stringify(categories), "PX", REFERENCE_TTL_MS);
  } catch {
    // Next request fetches again; three calls a day is an acceptable worst case.
  }

  return { languages, regions, categories };
}

/** Name→code maps reduce to their VALUES — never derive codes from names (§2). */
function referenceCodes(reference: ReferenceData): ReferenceCodes {
  return {
    languages: new Set(Object.values(reference.languages)),
    regions: new Set(Object.values(reference.regions)),
    categories: new Set(reference.categories),
  };
}
