import { z } from "zod";

/**
 * An article after normalization by the Currents client.
 *
 * Every upstream quirk is absorbed before this shape exists — see ARCHITECTURE 5.2.
 * Nothing downstream should ever see a raw Currents payload.
 */
export const NormalizedArticle = z.object({
  /** Upstream UUID. Unique per emission, NOT per story — see `dedupKey`. */
  id: z.uuid(),
  url: z.url(),
  /**
   * sha256 of the normalized URL, hex. Articles sharing this are the same story
   * re-emitted; upstream sent one link-roundup post 50 times in 100 results.
   * NOT unique in `articles` — see ARCHITECTURE 7.4.
   */
  dedupKey: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string().min(1),
  description: z.string().nullable(),
  author: z.string().nullable(),
  /** Null when upstream sent the literal string "None", which it often does. */
  imageUrl: z.url().nullable(),
  language: z.string().nullable(),
  categories: z.array(z.string()),
  /** Undocumented upstream field, kept verbatim (PROBE-FINDINGS 1). */
  sourceCategories: z.array(z.string()),
  sourceDomain: z.string().nullable(),
  /** ISO-8601. Upstream sends "2026-08-04 20:45:56 +0000", which `new Date()` mis-parses. */
  published: z.iso.datetime(),
});
export type NormalizedArticle = z.infer<typeof NormalizedArticle>;

/**
 * One row of the timeline: a cluster of articles sharing a `dedupKey`, represented
 * by its earliest-published member. The timeline pages over clusters, not articles,
 * so a repeatedly re-ingested post occupies one row instead of fifty.
 */
export const TimelineItem = NormalizedArticle.extend({
  /** Number of upstream emissions collapsed into this row. 1 for most articles. */
  memberCount: z.int().min(1),
  /** Most recent re-emission — rendered as "updated <relative time>" when > 1. */
  latestSeen: z.iso.datetime(),
});
export type TimelineItem = z.infer<typeof TimelineItem>;
