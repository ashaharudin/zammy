import { z } from "zod";
import { Article } from "./article.js";

export const MAX_KEYWORDS_LENGTH = 200;
export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;

/** Query parameters accepted by `GET /api/v1/timeline` (ARCHITECTURE 6.1). */
/** A storyline UUID, which is what `?storyline=` means under STORYLINES_V2. */
export const STORYLINE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TimelineQuery = z.object({
  /**
   * Optional ONLY in the storyline view (ADR-0011): clicking a label opens the
   * timeline filtered to a UUID with the search box empty, so there are no
   * keywords to send. Every other request must carry one — see the refinement
   * below, which is what keeps `q`-less requests from becoming a way to page
   * the whole archive.
   */
  q: z.string().trim().min(1).max(MAX_KEYWORDS_LENGTH).optional(),
  language: z.string().min(2).max(8).optional(),
  country: z.string().min(2).max(8).optional(),
  category: z.string().min(1).max(40).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  /** Opaque keyset cursor from a previous response. */
  cursor: z.string().max(512).optional(),
  /**
   * A storyline whose articles this topic should be SEEDED with (ADR-0010) —
   * what a `storylinePhrase` chip sends when it opens the story it names.
   *
   * Deliberately absent from the fingerprint: it says where the reader came
   * from, never what they searched for, so the same phrase reached from a
   * chip and from the search box is one topic. It admits only articles that
   * carry every keyword, so it can add provenance to a topic but never
   * membership the keywords do not support.
   */
  storyline: z.string().trim().min(1).max(64).optional(),
  /**
   * A CEILING, not a promise. One upstream call is 20 raw sightings, which after
   * collapsing can be as few as 6 articles — so a short page is normal. Distinguish
   * "still arriving" from "that's all" via `meta.ingest`, never via item count.
   */
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
})
  .refine((query) => query.q !== undefined || isStorylineView(query), {
    path: ["q"],
    message: "q is required unless the request is a storyline view (?storyline=<uuid>)",
  });
export type TimelineQuery = z.infer<typeof TimelineQuery>;

/**
 * Is this the STORYLINE VIEW — the timeline filtered to one storyline by UUID
 * (ADR-0011) — rather than the ADR-0010 bigint seed it replaces?
 *
 * The two share a parameter name deliberately: the seed retires with the flag
 * flip, and until then the shape of the value is what says which one a caller
 * meant. A UUID cannot be a v1 hub group id, so there is no ambiguity to
 * resolve.
 */
export function isStorylineView(query: { storyline?: string | undefined }): boolean {
  return query.storyline !== undefined && STORYLINE_UUID.test(query.storyline);
}

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
 * One slot in the timeline: a day's coverage of a story as this topic saw it
 * (§14.3, ADR-0009).
 *
 * Most slots are one article. Where several outlets ran the same story at
 * different URLs — which URL-based dedup deliberately does not collapse, since
 * the wordcloud's breadth signal counts those rows (§10.3) — the slot carries
 * one member as the headline and the other copies as `related`. Where the day
 * produced coverage AROUND the story — retrospectives, successor speculation,
 * fact-checks, clustered by the storyline layer — those arrive as `coverage`:
 * different pieces, same story, and the disclosure renders them as their own
 * section.
 */
/**
 * The storyline a slot belongs to, when it is a REAL one (ADR-0011).
 *
 * Null for a provisional storyline-of-one, which is most slots and renders as
 * the plain article slot it always was — "invisible as a storyline" is the
 * lifecycle's own wording, and a null here is what carries it to the browser
 * without the front end having to know the word "provisional".
 */
export const StorylineRef = z.object({
  /** The label, or null: a promoted storyline whose generation failed renders
   * label-less rather than not at all (ADR-0011, Labels). */
  label: z.string().nullable(),
  /**
   * The storyline's whole date span, first covered day to last. Labels are
   * deliberately non-unique, so when two same-label storylines are on screen
   * together the span is what tells them apart ("Fort Hood Crash · Mar 2026").
   * Sent always; the front end decides when a collision makes it worth showing.
   */
  from: z.iso.datetime(),
  to: z.iso.datetime(),
});
export type StorylineRef = z.infer<typeof StorylineRef>;

/** A surfaced storyline: a ref plus the UUID the storyline view opens by. */
export const SurfacedStoryline = StorylineRef.extend({
  id: z.string().min(1),
  /**
   * Articles in the storyline, over its whole life rather than this search.
   *
   * A SIZE, and the surfacing UI renders it as a bucket rather than a number
   * (S8's verdict): the question a reader asks of a surfaced storyline is "how
   * big is this", not "how many exactly", and a bucket survives the count
   * moving while they look at it. The exact figure still travels, because it
   * costs nothing here and the pill puts it in its `title`.
   */
  size: z.int().min(0),
  /**
   * Quiet for longer than the dormancy window (ADR-0011) — the one bit the pill
   * needs to say so.
   *
   * A dormant storyline is still surfaced: it is a real story that has fallen
   * quiet, and quiet is a thing to tell the reader rather than a reason to hide
   * a match. S8's round found the marker load-bearing — without it a
   * five-month-old story appearing beside today's news reads as a bug. A
   * boolean and not the status string: `provisional` never surfaces at all, so
   * the only distinction left on the wire is running or quiet.
   */
  dormant: z.boolean(),
});
export type SurfacedStoryline = z.infer<typeof SurfacedStoryline>;

export const TimelineEntry = z.object({
  /**
   * The slot's identity and the id half of this page's cursor: a hub group's
   * bigint under the old model, a storyline UUID under STORYLINES_V2. NOT
   * unique per slot in v2 — a storyline appears once per day it has coverage,
   * so a renderer keying on this alone would collide across days.
   */
  storylineId: z.string().min(1),
  /**
   * The storyline's earliest published, NOT the representative's.
   *
   * This is both where the slot sits and the time the UI shows, and the two
   * must agree: positioning a slot at 6 hours ago while showing the
   * representative's own "3 hours ago" reads as a bug in a time-ordered
   * timeline. Render the difference as an "updated" badge instead — the
   * pattern ADR-0002 already uses for an article's earliest sighting.
   */
  published: z.iso.datetime(),
  /** The newest member's published. Equals `published` for a slot of one. */
  updatedAt: z.iso.datetime(),
  /**
   * The headline: any tier-1 source in the slot's LEAD group — its
   * most-syndicated — else that group's earliest member. Chosen per topic, so
   * it is always an article that matched this search.
   */
  article: Article,
  /** Same story, other outlets: the lead group's other members, newest first. */
  related: z.array(Article),
  /** Same storyline, different pieces: every other group's members, newest
   * first. `moreCoverage`, not `coverage` — that word is taken (CONTEXT.md:
   * the fetched time spans), and one word with two meanings is the confusion
   * the language doc exists to prevent. */
  moreCoverage: z.array(Article),
  /**
   * Two words the whole slot shares, offered as a search for the story itself
   * (ADR-0010). Null for a slot with no `moreCoverage` — one article is not a
   * story with a name yet — and null when the coverage shares no two adjacent
   * words the headline also uses.
   *
   * Both words appear in every article the slot shows, which is what makes
   * the search it opens a superset of this slot rather than a guess.
   */
  storylinePhrase: z.string().nullable(),
  /** Non-null exactly when this slot's storyline has been promoted. */
  storyline: StorylineRef.nullable(),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const TimelinePage = z.object({
  topic: TopicSummary,
  /**
   * Storylines this SEARCH surfaced — matched when the query's keywords are a
   * subset of a storyline's profile tokens (ADR-0011, Search and navigation).
   *
   * Surfaced, never filtered: a search is never limited to a storyline, so
   * these sit beside the results rather than narrowing them. Empty under the
   * old model and for the storyline view, which is already about one.
   */
  storylines: z.array(SurfacedStoryline).default([]),
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
