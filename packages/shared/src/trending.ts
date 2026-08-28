import { z } from "zod";
import { ResponseMeta } from "./timeline.js";

/**
 * One word in the landing-page cloud (ARCHITECTURE 10): a STORYLINE the window
 * updated, drawn as its label.
 *
 * The cloud used to carry extracted terms scored against a trailing baseline;
 * it now carries the storylines whose coverage moved inside the last
 * TREND_WINDOW_HOURS
 * ([ADR-0013](../../docs/adr/0013-the-cloud-names-recently-updated-storylines.md)),
 * ordered by how much moved and how recently
 * ([ADR-0014](../../docs/adr/0014-the-cloud-ranks-by-volume-and-searches-what-the-coverage-says.md)).
 * What that changes about the fields here: `label` is generated once per arc and
 * reused, so nothing about it is per-window, while every count except `size`
 * describes the window and the window only.
 *
 * `windowSources` is the breadth gate: a storyline needs >= 2 distinct source
 * domains INSIDE the window to appear at all, because one outlet filing eight
 * advisories is not what several newsrooms are covering (PROBE-FINDINGS 6b,
 * where the naive scorer returned a cloud made entirely of one Jenkins CVE
 * burst). ADR-0013 asked that over the whole arc and ADR-0014 moved it to the
 * window; `sourceCount` is the arc's own breadth, which stays as a fact the
 * response reports rather than as the thing it gates on.
 *
 * **The window fields and the arc fields count different corpora, and that is
 * deliberate.** Everything describing the window counts only articles the
 * DISCOVERY plane saw — the rule that the plane which measures is the plane
 * that is not steered (`DISCOVERY_PROVIDER` in `@zammy/storage`) — while `size`
 * and `sourceCount` describe the arc as the store actually holds it, because
 * they are what a click delivers. Today those are the same corpus and every
 * field agrees; the distinction is on the wire before it has to be, not after.
 * No field here distinguishes "articles we have" in the window from "articles
 * that voted" — if that ever needs saying, it is a new field and a
 * `PAGE_SHAPE_VERSION` bump, not a redefinition of one of these.
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
  /**
   * The search a click on this word runs — the label's own words that the arc's
   * coverage actually says, capped at two terms (`cloudQuery`, ADR-0014).
   *
   * On the wire rather than derived in the browser because it is a fact about
   * the CORPUS: the front end has the label but not the headline vocabulary
   * behind it, and guessing from the label is what returned empty timelines.
   * Almost always a substring of `label` — never assume it, since a label whose
   * words the coverage does not say falls back to the profile's own tokens.
   *
   * Spelled as the LABEL spells it, lowercased, not as the corpus folds it: this
   * string is shown to a reader (the command bar, the hero placeholder) and sent
   * upstream, and the fold is lossy enough to be visible — `singular` takes
   * "crisis" to `crisi`. The exception is that fallback, which has no surface to
   * offer and can still hand over a folded token.
   */
  query: z.string().min(1),
  /** Distinct DISCOVERY-plane articles published inside the window — the size input. */
  windowArticles: z.int().min(1),
  /**
   * Distinct discovery-plane source domains inside the window. The gate: >= 2.
   *
   * The floor still holds under the plane restriction, and by the same argument
   * as before: the gate and this field are one expression over one corpus, so
   * anything that appears cleared 2.
   */
  windowSources: z.int().min(2),
  /** Distinct member articles over the whole arc, all time, every plane. */
  size: z.int().min(1),
  /**
   * Distinct source domains over the whole arc, every plane. Reported, not the gate.
   *
   * Still >= 2: the window's discovery-plane domains are a subset of the arc's
   * domains over every plane, so clearing the gate on the narrower corpus
   * clears this floor on the wider one.
   */
  sourceCount: z.int().min(2),
  /** The newest discovery-plane article inside the window — the recency channel (§10.3). */
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
  /**
   * Busiest-and-freshest first (ADR-0014), so every `limit` is a prefix of the
   * same ranking. The palette does NOT read this order — it keys on
   * `lastUpdated`, or colour would answer the same question size does.
   */
  storylines: z.array(TrendingStoryline),
  meta: ResponseMeta,
});
export type TrendingResponse = z.infer<typeof TrendingResponse>;
