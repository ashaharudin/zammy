import { z } from "zod";
import { Article } from "./article.js";

export const MAX_KEYWORDS_LENGTH = 200;
export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;

/** Query parameters accepted by `GET /api/v1/timeline` (ARCHITECTURE 6.1). */
export const TimelineQuery = z.object({
  q: z.string().trim().min(1).max(MAX_KEYWORDS_LENGTH),
  language: z.string().min(2).max(8).optional(),
  country: z.string().min(2).max(8).optional(),
  category: z.string().min(1).max(40).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  /** Opaque keyset cursor from a previous response. */
  cursor: z.string().max(512).optional(),
  /**
   * A CEILING, not a promise. One upstream call is 20 raw sightings, which after
   * collapsing can be as few as 6 articles — so a short page is normal. Distinguish
   * "still arriving" from "that's all" via `meta.ingest`, never via item count.
   */
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});
export type TimelineQuery = z.infer<typeof TimelineQuery>;

export const ServedFrom = z.enum(["cache", "store", "upstream"]);
export type ServedFrom = z.infer<typeof ServedFrom>;

export const DegradedReason = z.enum([
  "quota",
  "upstream",
  "ingest_timeout",
  "cache_unavailable",
]);
export type DegradedReason = z.infer<typeof DegradedReason>;

export const IngestState = z.enum(["complete", "in_progress"]);
export type IngestState = z.infer<typeof IngestState>;

/**
 * `ingest` and `page.hasMore` answer DIFFERENT questions and both are required:
 *   hasMore      — more rows exist past your cursor in our store
 *   ingest.state — more rows may still arrive from upstream for this window
 *
 * "You've reached the end" requires hasMore === false AND state === "complete".
 * Conflating them tells users "that's everything" while a job is still running.
 */
export const ResponseMeta = z.object({
  servedFrom: ServedFrom,
  asOf: z.iso.datetime(),
  stale: z.boolean(),
  degraded: DegradedReason.nullable(),
  ingest: z.object({
    state: IngestState,
    pendingJobs: z.int().min(0),
  }),
});
export type ResponseMeta = z.infer<typeof ResponseMeta>;

export const TopicSummary = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  keywords: z.array(z.string()),
  /** The time span we have actually fetched for this topic. Null before any fetch. */
  coverage: z
    .object({ from: z.iso.datetime(), to: z.iso.datetime() })
    .nullable(),
});
export type TopicSummary = z.infer<typeof TopicSummary>;

/**
 * One slot in the timeline: a story as this topic saw it covered (§14.3).
 *
 * Most slots are one article. Where several outlets ran the same story at
 * different URLs — which URL-based dedup deliberately does not collapse, since
 * the wordcloud's breadth signal counts those rows (§10.3) — the slot carries
 * one member as the headline and the rest as `related`.
 */
export const TimelineEntry = z.object({
  /** Stable per group; the id half of this page's cursor. */
  groupId: z.string().regex(/^\d+$/),
  /**
   * The group's earliest published, NOT the representative's.
   *
   * This is both where the slot sits and the time the UI shows, and the two
   * must agree: positioning a slot at 6 hours ago while showing the
   * representative's own "3 hours ago" reads as a bug in a time-ordered
   * timeline. Render the difference as an "updated" badge instead — the
   * pattern ADR-0002 already uses for an article's earliest sighting.
   */
  published: z.iso.datetime(),
  /** The newest member's published. Equals `published` for a group of one. */
  updatedAt: z.iso.datetime(),
  /**
   * The headline: any tier-1 source in the group, else its earliest member.
   * Chosen per topic, so it is always an article that matched this search.
   */
  article: Article,
  /** The group's other members in this topic, newest first. Usually empty. */
  related: z.array(Article),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const TimelinePage = z.object({
  topic: TopicSummary,
  /** Slots, not articles: `limit` counts these (§7.3 keyset over groups). */
  items: z.array(TimelineEntry),
  page: z.object({
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
  meta: ResponseMeta,
});
export type TimelinePage = z.infer<typeof TimelinePage>;

/** True only when the store is exhausted AND nothing further is being ingested. */
export function isTerminalPage(page: TimelinePage): boolean {
  return !page.page.hasMore && page.meta.ingest.state === "complete";
}
