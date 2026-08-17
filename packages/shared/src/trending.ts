import { z } from "zod";
import { ResponseMeta } from "./timeline.js";

/**
 * One word in the landing-page cloud (ARCHITECTURE 10): a STORYLINE the window
 * updated, drawn as its label.
 *
 * The cloud used to carry extracted terms scored against a trailing baseline;
 * it now carries the storylines whose coverage moved inside the last
 * TREND_WINDOW_HOURS, most recently updated first
 * ([ADR-0013](../../docs/adr/0013-the-cloud-names-recently-updated-storylines.md)).
 * What that changes about the fields here: `label` is generated once per arc and
 * reused, so nothing about it is per-window, while every count except `size`
 * describes the window and the window only.
 *
 * `sourceCount` is the breadth gate that survives from the term cloud, and it
 * is deliberately measured over the WHOLE arc: a storyline needs >= 2 distinct
 * source domains to appear at all, because one outlet filing eight advisories
 * is not what several newsrooms are covering (PROBE-FINDINGS 6b, where the
 * naive scorer returned a cloud made entirely of one Jenkins CVE burst).
 */
export const TrendingStoryline = z.object({
  /** The storyline's UUID — identity, and the only stable key here (ADR-0011). */
  id: z.string().min(1),
  /**
   * The 2–5 words naming the arc. Never null in this contract: an unlabelled
   * storyline is a valid thing to RENDER in a timeline but has no word to draw
   * here, so it is filtered out rather than shown as "unlabelled storyline".
   */
  label: z.string().min(1),
  /** Distinct member ARTICLES published inside the window — the size input. */
  windowArticles: z.int().min(1),
  /** Distinct member articles over the whole arc, all time. */
  size: z.int().min(1),
  /** Distinct source domains over the whole arc. Gate: >= 2. */
  sourceCount: z.int().min(2),
  /** The newest member article inside the window — the recency channel (§10.3). */
  lastUpdated: z.iso.datetime(),
});
export type TrendingStoryline = z.infer<typeof TrendingStoryline>;

/**
 * The most words any caller may ask for. Exported because the API caches ONE
 * ranked list per language and serves every caller a prefix of it, so this is
 * also what it reads and caches regardless of the asked-for limit (§10.4) —
 * at most this many, since one word per label can shorten the list afterwards.
 */
export const TRENDING_LIMIT_MAX = 100;

/**
 * No `day`: the cloud rolls over a window ending now (ADR-0008), so there are
 * no addressable periods to ask for. A stale `?day=` from the old contract is
 * stripped here rather than rejected — the bookmark lands on the live cloud.
 */
export const TrendingQuery = z.object({
  language: z.string().min(2).max(8).default("en"),
  limit: z.coerce.number().int().min(1).max(TRENDING_LIMIT_MAX).default(50),
});
export type TrendingQuery = z.infer<typeof TrendingQuery>;

export const TrendingResponse = z.object({
  /** The window these counts describe: [windowStart, windowEnd). */
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  language: z.string(),
  /** Most recently updated first — the order the palette and the list read. */
  storylines: z.array(TrendingStoryline),
  meta: ResponseMeta,
});
export type TrendingResponse = z.infer<typeof TrendingResponse>;
