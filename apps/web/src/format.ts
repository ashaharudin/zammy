import type { Article, TimelineEntry } from "@zammy/shared";
// The collapse key IS the bucket key: a card's part of the rail and the section
// the reader collapses are the same division of it, so they share a definition
// rather than a shape. `dayCollapse` imports only the `Segment` type back, which
// erases, so nothing circular survives to runtime.
import { segmentKey } from "./dayCollapse.js";

/** Date/time presentation shared by the timeline and its meta row. */

export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Below this, later coverage is the same burst rather than a story that
 * developed. Syndication is near-simultaneous by nature — the recorded payload
 * has one story on two outlets a SECOND apart — and stamping "updated 9d ago"
 * on that says something happened when nothing did.
 */
const UPDATE_GAP_MS = 60 * 60 * 1000;

/**
 * Whether a slot's newest member is late enough to be worth an "updated"
 * stamp (§14.3). The contract always carries `updatedAt`; whether it is worth
 * a reader's attention is a presentation question, answered here.
 */
export function hasLaterCoverage(slot: { published: string; updatedAt: string }): boolean {
  return Date.parse(slot.updatedAt) - Date.parse(slot.published) >= UPDATE_GAP_MS;
}

/**
 * A part of the reader's local day. Purely a rail subdivision: segments are a
 * coarser timestamp, never a claim about what happened when — a slot's LEAD
 * sits at its storyline's EARLIEST article that day, so a headline that ran
 * at 07:00 is filed under Morning however long the day's coverage went on.
 * Coverage that ran in another part of the day is drawn there rather than under
 * the headline, and in another of the reader's days under that day (`RailSlot`).
 *
 * Four rather than three, and non-wrapping. Measured on the dev archive, a
 * 00:00–12:00 Morning held 254 of 325 slots against Afternoon's 12: the block
 * that most needs chunking was the one getting chunked least. Wrapping "night"
 * past midnight the way people speak was refused separately — inside a day the
 * rail runs newest-first, so 17:00–05:00 would render as two blocks both
 * called Night, a duplicate label and a collapse-key collision.
 */
export type Segment = "Night" | "Morning" | "Afternoon" | "Evening";

/** Boundaries as local wall-clock hours; each runs to the next one's start. */
const SEGMENTS: readonly { from: number; name: Segment }[] = [
  { from: 0, name: "Night" },
  { from: 6, name: "Morning" },
  { from: 12, name: "Afternoon" },
  { from: 18, name: "Evening" },
];

/** The rail's own order: the newest part of a day first, the way the column runs. */
const SEGMENTS_DESC: readonly Segment[] = [...SEGMENTS].reverse().map((segment) => segment.name);

/**
 * The hour of `iso` in `timeZone`.
 *
 * Reading the hour rather than computing an offset is what keeps DST out of
 * this file: a 23- or 25-hour day simply has a shorter or longer segment, and
 * none of `app-day.ts`'s two-pass midnight correction is needed. The `% 24` is
 * not decoration — Intl reports midnight as "24" under some hourCycle
 * readings, and without it every midnight slot files under Evening.
 */
/**
 * `Intl.DateTimeFormat` is expensive to construct and cheap to reuse, and both
 * of these run once per slot per render — `Rail` re-renders on every collapse
 * click and every ingest poll. Built per zone, of which a session has one.
 */
const hourFormatters = new Map<string, Intl.DateTimeFormat>();
const dayKeyFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(
  cache: Map<string, Intl.DateTimeFormat>,
  timeZone: string,
  build: () => Intl.DateTimeFormat,
): Intl.DateTimeFormat {
  const cached = cache.get(timeZone);
  if (cached) return cached;
  const built = build();
  cache.set(timeZone, built);
  return built;
}

function hourIn(iso: string, timeZone: string): number {
  const parts = formatter(
    hourFormatters,
    timeZone,
    () => new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hour12: false }),
  ).formatToParts(new Date(iso));
  return Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
}

export function segmentOf(iso: string, timeZone: string): Segment {
  const hour = hourIn(iso, timeZone);
  let name = SEGMENTS[0]!.name;
  for (const segment of SEGMENTS) if (hour >= segment.from) name = segment.name;
  return name;
}

/** YYYY-MM-DD of `iso` in `timeZone`. en-CA formats exactly this shape. */
function dayKey(iso: string, timeZone: string): string {
  return formatter(
    dayKeyFormatters,
    timeZone,
    () =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
  ).format(new Date(iso));
}

/**
 * Calendar days between two day keys, parsed as UTC dates purely to subtract
 * them. NOT `now - 24h`: that is an hour out on a DST day, which would call
 * Today "Yesterday" twice a year.
 */
function daysBetween(later: string, earlier: string): number {
  const utc = (key: string) => {
    const [year, month, day] = key.split("-").map(Number);
    return Date.UTC(year!, month! - 1, day!);
  };
  return Math.round((utc(later) - utc(earlier)) / 86_400_000);
}

/**
 * The reader's calendar day for an instant. Exported for one caller: the rail
 * memoises its whole grouping, and this is what tells that memo the difference
 * between a re-render and a day rolling over under it — "Today" becomes
 * "Yesterday" at local midnight and every label has to move with it.
 */
export function readerDayKey(instant: Date, timeZone: string): string {
  return dayKey(instant.toISOString(), timeZone);
}

export function dayLabel(iso: string, now: Date, timeZone: string): string {
  return labelFor(dayKey(iso, timeZone), iso, dayKey(now.toISOString(), timeZone), timeZone);
}

/** `dayLabel` with today's key already in hand — it is constant per render. */
function labelFor(key: string, iso: string, todayKey: string, timeZone: string): string {
  const diff = daysBetween(todayKey, key);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return new Date(iso).toLocaleDateString(undefined, {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

/**
 * `labelFor`'s date branch alone, for segment headings — which carry no
 * weekday and stay silent on Today/Yesterday, where the day heading above
 * them already says so.
 */
function dateSuffixFor(key: string, iso: string, todayKey: string, timeZone: string): string | null {
  if (daysBetween(todayKey, key) <= 1) return null;
  return new Date(iso).toLocaleDateString(undefined, { timeZone, month: "short", day: "numeric" });
}

export function timeLabel(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * One entry as the RAIL draws it: a timeline slot, or a part of one.
 *
 * A timeline slot is one storyline's coverage of one day (§14.3), and it used
 * to be one card. But a day's coverage lands hours apart, and filing all of it
 * under the storyline's earliest article puts an afternoon follow-up beneath a
 * MORNING heading, in a disclosure hanging off a headline that ran before it.
 * So a slot is cut into the parts of the day it actually reaches, and each part
 * is a slot in its own right: a headline card with the rest of that part's
 * coverage behind its own disclosure.
 *
 * Which headline: the EARLIEST article the part holds. That is the rule a
 * storyline day already follows — its earliest as the hero — applied one level
 * down, and it is the only rule available here, since the wire carries
 * `moreCoverage` as a flat list with the group structure §14.3 chooses a
 * representative within already spent. The part the storyline's day BEGINS in
 * keeps the service's own choice.
 *
 * Promoting a row is safe on the one count §14.3 cares about: a slot's members
 * are already scoped to the topic that asked (`readStorylineTimelinePage` step
 * 2 — only its POSITION is global), so every article the wire sends is one that
 * matched this search, and none of them can arrive as a headline the reader's
 * keywords never found.
 *
 * Same-story copies never move. They are the same piece on another wire,
 * near-simultaneous by nature (`UPDATE_GAP_MS`), so cutting them off the
 * headline would scatter one story down the rail to say nothing. Only
 * `moreCoverage` — the storyline's OTHER groups, which are different pieces —
 * is separate enough to stand in a part of the day of its own. It arrives
 * flattened, though, so a promoted headline can have copies of its own among
 * the rows beside it; those become the new card's `related`, not its coverage.
 *
 * A slot's coverage is filed by the article's OWN day as well as its own part
 * of the day. A storyline's day is bounded in `APP_TIMEZONE`, which is never
 * the reader's, so for a reader west of it half a slot's coverage routinely
 * belongs to the next of their days — and a card can therefore open a day the
 * page has no slot in. Never a day BELOW the last one, though: an article is
 * never earlier than the slot it belongs to, so coverage only ever moves a card
 * up the rail.
 *
 * A slot whose coverage stayed in one part of one day yields exactly one of
 * these, every field the same as the entry it came from, so the common case is
 * the card it always was.
 */
export type RailSlot = TimelineEntry & {
  /**
   * React identity, unique per (slot, part of day). Not `storylineId` alone:
   * under ADR-0011 a storyline takes one slot per day, so its id repeats down
   * the rail — and two of its slots can even share a READER's day, whose
   * boundaries are not `APP_TIMEZONE`'s.
   */
  key: string;
};

export interface DayGroup {
  /**
   * The day's identity: its YYYY-MM-DD key in the reader's zone. What collapse
   * state and React key on, because the LABEL moves — a section the reader
   * collapsed as "Today" is called "Yesterday" a minute after local midnight,
   * and keying on it would hand that collapsed flag to a different day.
   *
   * It is also what makes a segment's key uncollidable: two fixed-shape
   * fields, where a localised label could in principle carry the separator.
   */
  key: string;
  /** What the divider reads: "Today", "Yesterday", or a formatted date. */
  day: string;
  /**
   * The abbreviated date a segment heading appends beyond Today/Yesterday
   * ("MORNING, Aug 21") — null on those two, where the day heading above the
   * segments already carries the answer and repeating it on every segment
   * would be noise.
   */
  dateSuffix: string | null;
  segments: { segment: Segment; items: RailSlot[] }[];
}

/**
 * Bucket a page of timeline slots into the rail: days, their parts of day, and
 * the cards each part holds (`RailSlot`).
 *
 * A slot's LEAD is filed by the slot's own `published` — the position §7.3
 * pages by — never by its headline article's, which can be hours later and
 * would file it under the wrong divider. Its wider coverage is filed by each
 * article's OWN time, day and part alike, and that is the whole point: a
 * storyline's day is bounded in `APP_TIMEZONE`, which is never the reader's, so
 * for a reader west of it half a slot's coverage routinely belongs to the next
 * of their days. Leaving it with the lead put morning rows inside a card filed
 * under the previous evening — the same misfiling one level up.
 *
 * Nothing is read off adjacency any more, at either level. A slot no longer
 * belongs to exactly one part of one day, so days and parts are collected and
 * then ordered — newest first, the direction the whole column runs — with each
 * part's cards sorted by their own earliest article rather than by which slot
 * contributed them. Since every card's day and part are derived from its own
 * time, and parts do not wrap midnight, the rail comes out in strict published
 * order all the same.
 *
 * Coverage can only ever move a card UP the rail: an article is never earlier
 * than the slot it belongs to, so no card can appear below the "load older"
 * frontier. It can appear above cards already on screen, which §8.1 records.
 *
 * A day whose coverage all landed in ONE part gets no part treatment, and that
 * rule lives in this shape rather than in the renderer: such a day simply has
 * one entry in `segments`.
 */
export function groupByDay(items: TimelineEntry[], now: Date, timeZone: string): DayGroup[] {
  const todayKey = dayKey(now.toISOString(), timeZone);
  // `at` is any instant inside the day, kept only to format its label — every
  // card in the group shares the day, so the first one to arrive will do.
  const days = new Map<string, { at: string; parts: Map<Segment, RailSlot[]> }>();
  for (const item of items) {
    for (const { day, segment, slot } of railSlots(item, timeZone)) {
      let group = days.get(day);
      if (!group) {
        group = { at: slot.published, parts: new Map() };
        days.set(day, group);
      }
      const part = group.parts.get(segment);
      if (part) part.push(slot);
      else group.parts.set(segment, [slot]);
    }
  }
  return (
    [...days]
      // `YYYY-MM-DD` sorts lexicographically exactly as it sorts in time.
      .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
      .map(([key, group]) => ({
        key,
        day: labelFor(key, group.at, todayKey, timeZone),
        dateSuffix: dateSuffixFor(key, group.at, todayKey, timeZone),
        segments: SEGMENTS_DESC.flatMap((segment) => {
          const part = group.parts.get(segment);
          return part ? [{ segment, items: [...part].sort((a, b) => at(b) - at(a)) }] : [];
        }),
      }))
  );
}

/**
 * One slot, cut into the days and parts of day its coverage actually reaches.
 *
 * A HEADLINE is what gets placed, not an article. `moreCoverage` is every
 * non-lead group's members flattened, so one piece that four outlets ran
 * arrives as four articles minutes or hours apart; placing each on its own
 * would draw the same headline twice on the rail — once per part of the day a
 * copy happened to land in — which is the scattering "same-story copies never
 * move" exists to prevent. So copies are folded first, and a headline goes
 * wherever its EARLIEST copy ran, the rest of them with it.
 *
 * Exact title is the fold, the signal `collapseCopies` already folds rows by:
 * near-identical wire variants stay separate, which is honest about what the
 * outlets printed. It is a weaker signal than the group ids, which are spent
 * upstream — a title reducing to fewer than two content tokens ("The Latest",
 * "Live updates") can never group at all, so two genuinely different pieces can
 * share one — but two cards under one headline are indistinguishable to a
 * reader whatever produced them, so folding is right either way.
 */
function railSlots(
  entry: TimelineEntry,
  timeZone: string,
): { day: string; segment: Segment; slot: RailSlot }[] {
  const leadDay = dayKey(entry.published, timeZone);
  const leadSegment = segmentOf(entry.published, timeZone);
  const lead = segmentKey(leadDay, leadSegment);

  // Where each HEADLINE goes: the lead card's own copies, the lead's bucket, or
  // a bucket of its own. Buckets are keyed by day AND part, because a slot can
  // reach the same part of two days — an `APP_TIMEZONE` day is 24 hours
  // wherever it starts.
  const byTitle = new Map<string, Article[]>();
  for (const article of entry.moreCoverage) {
    const copies = byTitle.get(article.title);
    if (copies) copies.push(article);
    else byTitle.set(article.title, [article]);
  }
  const destination = new Map<string, string>();
  const buckets = new Map<string, { day: string; segment: Segment; articles: Article[] }>();
  for (const [title, copies] of byTitle) {
    // A copy of the representative's OWN story, however far from it the wire
    // put it: the lead card's "same story", never a second headline card.
    if (title === entry.article.title) {
      destination.set(title, SAME_STORY);
      continue;
    }
    const anchor = copies[earliestIndex(copies)]!;
    const day = dayKey(anchor.published, timeZone);
    const segment = segmentOf(anchor.published, timeZone);
    const bucket = segmentKey(day, segment);
    destination.set(title, bucket);
    if (bucket !== lead && !buckets.has(bucket)) buckets.set(bucket, { day, segment, articles: [] });
  }

  // Filled in the order the wire sent, so every list stays newest first (§14.3)
  // rather than headline-major.
  const here: Article[] = [];
  const sameStory: Article[] = [];
  for (const article of entry.moreCoverage) {
    const bucket = destination.get(article.title)!;
    if (bucket === SAME_STORY) sameStory.push(article);
    else if (bucket === lead) here.push(article);
    else buckets.get(bucket)!.articles.push(article);
  }

  const related = [...entry.related, ...sameStory];
  const slots: { day: string; segment: Segment; slot: RailSlot }[] = [
    {
      day: leadDay,
      segment: leadSegment,
      slot: {
        ...entry,
        key: slotKey(entry, leadDay, leadSegment, entry.article),
        related,
        moreCoverage: here,
        // Recomputed rather than taken from the wire, where `updatedAt` is the
        // newest member of the WHOLE slot: a card must not stamp itself updated
        // from coverage now drawn elsewhere on the rail.
        //
        // `published` is left alone — it is the slot's POSITION (§7.3's keyset
        // axis), and the rail's order has to be the one the API paged by. It is
        // also that day's earliest across the whole storyline while members are
        // per-topic (`readStorylineTimelinePage`), so on a keyword search it can
        // predate every article this reader can see, and the part of the day it
        // files the lead under is then a part holding nothing else. That
        // predates this cut and is §14.3's own trade; what the cut must not do
        // is move a slot's coverage away and leave the position's card claiming
        // rows it no longer has.
        updatedAt: latestPublished([entry.article, ...related, ...here], entry.published),
      },
    },
  ];
  for (const { day, segment, articles } of buckets.values()) {
    // The earliest headline heads the card, its own copies beside it as the
    // same story — a heading that says what they are, where "more coverage"
    // would promise different pieces. The rest is the coverage around it.
    const headline = articles[earliestIndex(articles)]!;
    const copies: Article[] = [];
    const coverage: Article[] = [];
    for (const article of articles) {
      if (article === headline) continue;
      (article.title === headline.title ? copies : coverage).push(article);
    }
    slots.push({
      day,
      segment,
      slot: {
        ...entry,
        key: slotKey(entry, day, segment, headline),
        article: headline,
        published: headline.published,
        updatedAt: latestPublished(articles, headline.published),
        related: copies,
        moreCoverage: coverage,
      },
    });
  }
  return slots;
}

/** Not a bucket: a headline that belongs to the lead card's own same story. */
const SAME_STORY = "same story";

/**
 * A card's React identity. The headline is part of it: an article arriving for
 * a bucket already on screen can take the headline off the card there (§8.1's
 * note on the gate), and a card whose headline changed is a different card —
 * inheriting the old one's open disclosure would leave the reader's expanded
 * rows hanging under someone else's story.
 */
function slotKey(
  entry: TimelineEntry,
  day: string,
  segment: Segment,
  headline: Article,
): string {
  return `${entry.storylineId}:${entry.published}:${segmentKey(day, segment)}:${headline.id}`;
}

/** Sort key. Parsed, not compared as strings: `.000Z` and `Z` both spell one instant. */
function at(slot: RailSlot): number {
  return Date.parse(slot.published);
}

/**
 * Where the earliest of `articles` sits — an index, not the article, because
 * the caller has to lift that one entry out of the list and copies of one
 * article can share a timestamp. Ties go to the first, which is the newest-
 * first list's own answer. Never called on an empty list.
 */
function earliestIndex(articles: Article[]): number {
  let earliest = 0;
  for (const [index, article] of articles.entries()) {
    if (Date.parse(article.published) < Date.parse(articles[earliest]!.published)) earliest = index;
  }
  return earliest;
}

/** The latest of `articles` and `floor`, the slot time an entry cannot precede. */
function latestPublished(articles: Article[], floor: string): string {
  let latest = floor;
  for (const article of articles) {
    if (Date.parse(article.published) > Date.parse(latest)) latest = article.published;
  }
  return latest;
}
