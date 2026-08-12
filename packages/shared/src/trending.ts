import { z } from "zod";
import { ResponseMeta } from "./timeline.js";

/**
 * One word in the landing-page cloud (ARCHITECTURE 10).
 *
 * `uniqueArticles` is the displayed number and the size input. `sourceCount` is
 * the breadth gate: a term needs >= 2 distinct source domains to appear at all,
 * because a single outlet publishing eight near-identical advisories is not a
 * topic of the day. Without that gate the probe's naive scorer returned a cloud
 * made entirely of one Jenkins CVE burst (PROBE-FINDINGS 6b).
 */
export const TrendingTerm = z.object({
  term: z.string().min(1),
  isBigram: z.boolean(),
  /** Distinct ARTICLES, never sightings — the 50x-repeated page counts once. */
  uniqueArticles: z.int().min(1),
  /** Distinct source domains. Gate: >= 2. */
  sourceCount: z.int().min(2),
  score: z.number(),
});
export type TrendingTerm = z.infer<typeof TrendingTerm>;

/**
 * No `day`: the cloud rolls over a window ending now (ADR-0008), so there are
 * no addressable periods to ask for. A stale `?day=` from the old contract is
 * stripped here rather than rejected — the bookmark lands on the live cloud.
 */
export const TrendingQuery = z.object({
  language: z.string().min(2).max(8).default("en"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type TrendingQuery = z.infer<typeof TrendingQuery>;

export const TrendingResponse = z.object({
  /** The window these counts describe: [windowStart, windowEnd). */
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  language: z.string(),
  terms: z.array(TrendingTerm),
  meta: ResponseMeta,
});
export type TrendingResponse = z.infer<typeof TrendingResponse>;
