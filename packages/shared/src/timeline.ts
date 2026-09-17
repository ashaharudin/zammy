import { z } from "zod";
import { Article } from "./article.js";

export const MAX_KEYWORDS_LENGTH = 200;
export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;

/** Query parameters accepted by `GET /api/v1/timeline` (ARCHITECTURE 6.1). */
/** A storyline UUID: what names a storyline everywhere (ADR-0011). */
export const STORYLINE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How many storylines one VIEW may hold at once (ADR-0028).
 *
 * A ceiling on the request, not a design target: a search surfaces at most
 * eight (`SURFACED_STORYLINE_LIMIT`), and the gutter can add a few more, so
 * twelve is past anything a reader assembles by clicking. It exists so that a
 * hand-built URL cannot turn the view into a way to page the archive by
 * listing every UUID it knows.
 */
export const MAX_VIEW_STORYLINES = 12;

/**
 * One UUID, or several joined by commas: the shape `?storyline=` accepts.
 *
 * Commas rather than a repeated parameter because the browser's `TopicQuery`
 * and the route both hold the view's subjects as a list already, and one
 * parameter spelling that list is one thing to read back rather than a
 * querystring parser's opinion about repeated keys. The count is not checked
 * here — `TimelineQuery` refines it — so the pattern stays a shape check that
 * callers building a query by hand can reuse.
 */
const STORYLINE_UUID_LIST =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*$/i;

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
  /**
   * There is no `category` here, and its absence is load-bearing (ADR-0020).
   *
   * A reader can no longer choose one, but bookmarks and shared links minted
   * while they could are still out there. This object is not `.strict()`, so
   * Zod STRIPS an unrecognised `?category=technology` rather than failing the
   * parse: the request goes on to be answered as the same search without the
   * filter. Adding the field back — even as something ignored downstream — is
   * how that degradation turns back into a 400, so do not.
   */
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  /** Opaque keyset cursor from a previous response. */
  cursor: z.string().max(512).optional(),
  /**
   * The STORYLINE VIEW's subjects: one UUID, or several joined by commas, and
   * the timeline is filtered to them (ADR-0011, widened by ADR-0028). It
   * carries no keywords — the view's search box is empty — so it is a sibling
   * of `q` rather than a filter, and typing replaces it.
   *
   * Several, because a reader who has one storyline open and clicks another
   * ADDS it: the view then pages both arcs' days on the one keyset, so their
   * slots interleave in time rather than standing as two lists. Read the list
   * with `viewStorylineIds`, which is also where duplicates are folded.
   *
   * It once also accepted a bigint, ADR-0010's seed, which enrolled a
   * day-bounded storyline's articles into the topic. That model is gone
   * (migration 0012) and so is the seed; anything that is not a UUID list is
   * now rejected rather than quietly meaning something else.
   */
  storyline: z
    .string()
    .trim()
    .regex(STORYLINE_UUID_LIST, "must be a storyline UUID, or several joined by commas")
    .refine((list) => list.split(",").length <= MAX_VIEW_STORYLINES, {
      message: `at most ${MAX_VIEW_STORYLINES} storylines in one view`,
    })
    .optional(),
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
 * Is this the STORYLINE VIEW — the timeline filtered to one or more storylines
 * by UUID (ADR-0011, ADR-0028)?
 *
 * The schema now admits nothing else in `storyline`, so this is a presence
 * check with a shape check kept for callers that build a query by hand.
 */
export function isStorylineView(query: { storyline?: string | undefined }): boolean {
  return query.storyline !== undefined && STORYLINE_UUID_LIST.test(query.storyline);
}

/**
 * The view's subjects as a list, in the order the request named them, with
 * repeats folded — `a,b,a` is a view of two, not three.
 *
 * Request order is kept rather than sorted because the browser reads the
 * response's `storylines` back against the list it asked for: the first is the
 * one the pretty path names, and a server that reordered them would move the
 * reader's address bar under them. Empty for anything that is not a view.
 */
export function viewStorylineIds(query: { storyline?: string | undefined }): string[] {
  if (!isStorylineView(query)) return [];
  return [...new Set(query.storyline!.split(","))];
}

/**
 * `GET /api/v1/storylines?q=` — storylines by keyword, and nothing else
 * (ADR-0028, amended). The same match a search runs beside its results
 * (`TimelinePage.storylines`), asked on its own: no topic is minted, nothing is
 * fetched, no page of articles comes back. What the storyline VIEW's search box
 * runs, so a reader inside one arc can find another without leaving.
 */
/**
 * How many storylines a row of pills offers at once: what a search surfaces
 * beside its results, and what the storyline view's row is kept topped up to
 * (ADR-0028, amended). S8 measured the row's cost at eight — see
 * `SURFACED_STORYLINE_LIMIT` in `apps/api`, which is this same number.
 */
export const STORYLINE_OFFER_COUNT = 8;

/** The most one storyline search may ask for: a row's worth plus a view's worth of held arcs. */
export const MAX_STORYLINE_SEARCH_LIMIT = STORYLINE_OFFER_COUNT + MAX_VIEW_STORYLINES + 4;

export const StorylineSearchQuery = z.object({
  q: z.string().trim().min(1).max(MAX_KEYWORDS_LENGTH),
  /**
   * How many to return. The view asks for a row's worth PLUS one per arc it
   * already holds, so that when a pill is taken into the view the next match
   * is already in hand to take its place.
   */
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_STORYLINE_SEARCH_LIMIT)
    .default(STORYLINE_OFFER_COUNT),
});
export type StorylineSearchQuery = z.infer<typeof StorylineSearchQuery>;

export const ServedFrom = z.enum(["cache", "store", "upstream"]);
export type ServedFrom = z.infer<typeof ServedFrom>;

export const DegradedReason = z.enum(["quota", "upstream"]);
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

/**
 * A storyline NAMED to the reader: a ref, plus the UUID the storyline view
 * opens by and the two facts that let a reader choose between two of them.
 *
 * Named for the facts rather than for the reason it is on the page, because a
 * page now carries two lists of these and they arrive for different reasons —
 * `storylines`, matched by this SEARCH (ADR-0011), and `memberships.storylines`,
 * the arcs something on this page is FILED in. The lists are what carry the
 * reason; one literal copy of the shape per reason would be two places for the
 * span, the size and the dormancy marker to drift.
 */
export const StorylineSummary = StorylineRef.extend({
  id: z.string().min(1),
  /**
   * Articles in the storyline, over its whole life rather than this search.
   *
   * A SIZE, and the surfacing UI renders it as a bucket rather than a number
   * (S8's verdict): the question a reader asks of a storyline they have not
   * opened is "how big is this", not "how many exactly", and a bucket survives
   * the count moving while they look at it. The exact figure still travels,
   * because it costs nothing here and the pill puts it in its `title`.
   */
  size: z.int().min(0),
  /**
   * Quiet for longer than the dormancy window (ADR-0011) — the one bit the pill
   * needs to say so.
   *
   * A dormant storyline is still named: it is a real story that has fallen
   * quiet, and quiet is a thing to tell the reader rather than a reason to hide
   * a match. S8's round found the marker load-bearing — without it a
   * five-month-old story appearing beside today's news reads as a bug. A
   * boolean and not the status string: `provisional` is never named at all, so
   * the only distinction left on the wire is running or quiet.
   */
  dormant: z.boolean(),
});
export type StorylineSummary = z.infer<typeof StorylineSummary>;

export const TimelineEntry = z.object({
  /**
   * The slot's identity and the id half of this page's cursor: a storyline
   * UUID. NOT unique per slot — a storyline appears once per day it has
   * coverage — so a renderer keying on this alone would collide across days.
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
  /**
   * The newest member's published. Equals `published` for a slot of one.
   *
   * The SLOT's, over every member. A renderer that cuts a slot into smaller
   * cards — the rail does, by part of the reader's day — must stamp each card
   * from what that card still holds instead, or a card promises coverage drawn
   * elsewhere on the rail (`apps/web/src/format.ts`, `railSlots`).
   */
  updatedAt: z.iso.datetime(),
  /**
   * The headline: any tier-1 source in the slot's LEAD group — its
   * most-syndicated — else that group's earliest member. Chosen per topic, so
   * it is always an article that matched this search.
   */
  article: Article,
  /**
   * Same story, other outlets: the lead group's other members, newest first.
   * Every one of them carries `article.groupId`, so "these are one piece" is
   * something the reader of this contract can check rather than infer.
   */
  related: z.array(Article),
  /**
   * Same storyline, different pieces: every other group's members, newest
   * first. `moreCoverage`, not `coverage` — that word is taken (CONTEXT.md:
   * the fetched time spans), and one word with two meanings is the confusion
   * the language doc exists to prevent.
   *
   * FLAT and newest-first across groups, with each member naming its group in
   * `groupId`. Flat because this is also the order the disclosure renders in;
   * grouped because a renderer that re-cuts the slot has to keep one piece's
   * copies together, and title equality — the only signal a flat list used to
   * offer — folds two unrelated "Live updates" into one.
   */
  moreCoverage: z.array(Article),
  /** Non-null exactly when this slot's storyline has been promoted. */
  storyline: StorylineRef.nullable(),
  /**
   * What this storyline-day held, in one sentence, and the calendar day that
   * sentence is about: the historical preserve's DAY summary for this slot
   * (ADR-0023, docs/STORYLINE-SUMMARIES.md).
   *
   * On the entry rather than page-level, because an entry IS a storyline-day —
   * the same `(storyline, day)` pair the preserve is keyed by.
   *
   * `dayKey` travels WITH the sentence and is the whole reason this is an
   * object. A consumer cannot derive it: `published` is an instant, and which
   * calendar day it falls in depends on a zone the browser does not know the
   * server used. And a consumer needs it, because the sentence is a claim about
   * a DATE — it says "the 22nd" in its own words often enough — so it has to be
   * drawn under a heading reading the same date. A renderer that cuts the
   * timeline by the reader's own calendar instead (`apps/web/src/format.ts`
   * does) therefore matches this LABEL against its own day labels rather than
   * trying to reconcile two frames: the two calendars disagree about which
   * instants a day holds, and agree exactly about what to call it.
   *
   * Null in three cases a consumer must not try to tell apart: no sentence was
   * written for that day, the model was asked and refused, or this is an
   * ordinary SEARCH rather than the storyline view. The last one is a rule
   * rather than an omission — a search's slot carries only the members that
   * matched the keywords (`readStorylineTimelinePage` step 2), and a sentence
   * written over the storyline's whole day would be describing coverage the
   * reader cannot see on the row it sits on.
   *
   * Defaulted, so a response from an instance that predates this field parses
   * as the silence it is rather than failing the page.
   */
  daySummary: z
    .object({
      /** YYYY-MM-DD, the day the sentence is about. */
      dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      text: z.string().min(1),
    })
    .nullable()
    .default(null),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const TimelinePage = z.object({
  topic: TopicSummary,
  /**
   * Storylines this SEARCH surfaced — matched when every keyword is found in a
   * storyline's own vocabulary: its profile tokens OR its label (ADR-0011,
   * Search and navigation, as amended). Per keyword across the two, so one may
   * come from the profile and the next from the label.
   *
   * Surfaced, never filtered: a search is never limited to a storyline, so
   * these sit beside the results rather than narrowing them.
   *
   * The STORYLINE VIEW fills it with one entry PER ARC BEING VIEWED, in the
   * order the request named them and with aliases resolved to their survivors
   * (ADR-0028) — not search results but the view's own subjects: it is where
   * the command bar reads each chip's label from (`apps/web/src/CommandBar.tsx`),
   * so a reader who arrived by UUID still sees the story's name. A UUID the
   * database has never held is simply absent from it, which is how the browser
   * learns to drop that chip. This comment said "empty for the storyline view"
   * from ADR-0011 until the view started answering its own name, and the claim
   * outlived the code by long enough to be copied into ARCHITECTURE 6.1.
   */
  storylines: z.array(StorylineSummary).default(() => []),
  /**
   * Which storylines each GROUP on this page is filed in — the one fact
   * `TimelineEntry` structurally cannot carry, because membership lives on the
   * group (`storyline_groups`) and an entry names exactly one storyline.
   *
   * PAGE-LEVEL and keyed by group, not repeated per row, and that is not only
   * about bytes. A slot is re-cut in the browser into the parts of the reader's
   * day (`apps/web/src/format.ts`, `railSlots`), and a card cut out of a later
   * part is headed by a DIFFERENT group than the slot's lead — so a membership
   * list hung on the entry would be the lead group's, answering for a headline
   * that is no longer on the card. Keyed by group it survives the cut, because
   * every article already carries `groupId` (page shape 9).
   *
   * Nothing here ranks: the arcs a group is in arrive in no order that means
   * anything, and there is no primary one to put first
   * (`packages/storage/src/storylines.ts` — "'primary storyline' is a concept
   * with no principled definition"). A consumer that wants an order must make
   * one and own it.
   */
  memberships: z
    .object({
      /**
       * Group id → every storyline that group is filed in that this page is
       * willing to NAME: promoted, and not an alias. A group with fewer than two
       * of those is absent, because one arc is the arc of whatever slot the
       * group appears in and a row for it would report no news.
       *
       * Provisional storylines are excluded, because they are invisible as
       * storylines (ADR-0011's Lifecycle) — the same reason `TimelineEntry`
       * sends `storyline: null` for one.
       *
       * WHICH MEANS the arc a slot reads a group under is USUALLY in that
       * group's list, and not always. A slot in a provisional storyline is an
       * ordinary article slot whose own arc is deliberately unnameable, so if
       * its group has also joined two real arcs, this map names those two and
       * not the slot's own. Measured on the dev archive: 2 groups of 28,729,
       * and a transient state — the linker merges a provisional away when its
       * only group finds a home. Rare, but a consumer must not read the list's
       * length as "how many arcs this row is in", and must not assume the arc
       * it is reading under is somewhere in it.
       */
      byGroup: z.record(z.string().min(1), z.array(z.string().min(1))),
      /**
       * Every storyline named in `byGroup`, so a crossing can be rendered and
       * opened without a second request.
       *
       * A DIRECTORY, and deliberately not folded into `storylines` above: that
       * list has a specific documented meaning — the storylines this SEARCH
       * surfaced, matched keyword-by-keyword against a storyline's own
       * vocabulary (ADR-0011) — and widening it into "storylines mentioned
       * anywhere on this page" would put arcs no keyword matched into the
       * pills row.
       */
      storylines: z.array(StorylineSummary),
    })
    // A GETTER, not a literal. Zod shallow-clones a default's top level and no
    // further, so a literal here would hand every memberships-less page the SAME
    // `byGroup` object: one consumer merging into it in place would poison the
    // schema's default for every later parse in the process. Demonstrated on zod
    // 4.4.3 before this line was a function. The same hazard is why `storylines`
    // above takes one too.
    .default(() => ({ byGroup: {}, storylines: [] })),
  /** Slots, not articles: `limit` counts these (§7.3 keyset over groups). */
  items: z.array(TimelineEntry),
  page: z.object({
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
  meta: ResponseMeta,
});
export type TimelinePage = z.infer<typeof TimelinePage>;

/** `GET /api/v1/storylines` response: the matches, busiest-and-freshest first. */
export const StorylineSearchResponse = z.object({
  storylines: z.array(StorylineSummary),
});
export type StorylineSearchResponse = z.infer<typeof StorylineSearchResponse>;

/** True only when the store is exhausted AND nothing further is being ingested. */
export function isTerminalPage(page: TimelinePage): boolean {
  return !page.page.hasMore && page.meta.ingest.state === "complete";
}

/**
 * Every storyline the group `groupId` is filed in, as this page reports it.
 *
 * The one place the `memberships.byGroup` contract's "absent means at most one
 * nameable arc" rule is read. `readUnder` is the arc the row asking is being
 * shown under — the slot's `storylineId` — and a group the map does not name has
 * no second arc worth pointing at, so the row's own arc is the whole answer.
 *
 * That fallback is about what to RENDER, not a claim that the group is in
 * exactly one storyline: it may also sit in a provisional arc, which this
 * contract never names. And when the map DOES name the group, `readUnder` is
 * usually among them but need not be — see `memberships.byGroup`. A caller
 * drawing something per arc has to handle the row it is standing on not being
 * in the list, rather than assume it away.
 *
 * In no meaningful order — see `memberships`. A caller wanting only the
 * crossings filters `readUnder` out and gets an empty list for most rows, which
 * is the point.
 */
export function groupStorylines(
  // The map alone, so a consumer that has merged several pages' maps into one
  // — the browser holds an infinite query's pages at once — can read the rule
  // without first assembling a whole `memberships` object to satisfy a type.
  memberships: Pick<TimelinePage["memberships"], "byGroup">,
  groupId: string,
  readUnder: string,
): string[] {
  return memberships.byGroup[groupId] ?? [readUnder];
}
