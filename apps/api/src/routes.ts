import type { FastifyInstance } from "fastify";
import { TimelineQuery, TrendingQuery } from "@zammy/shared";
import { countTopicArticles, readCoverage, readTopic } from "@zammy/storage";
import { canonicalize, type ReferenceCodes } from "./canonical.js";
import {
  InvalidCursorError,
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

    // Validating filters against the cached reference lists catches a bad
    // language locally instead of spending a quota token to learn it (§6.2).
    const reference = await loadReference(deps);
    const canonical = canonicalize(
      {
        q: parsed.data.q,
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

  app.get("/api/v1/reference", async (_request, reply) => {
    // Verbatim upstream values, junk categories included: filtering belongs
    // to the UI picker, because a stored sighting may legitimately carry one.
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
