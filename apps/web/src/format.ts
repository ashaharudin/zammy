import type { Article, TimelineEntry } from "@zammy/shared";
// The representative rule, whole: which article heads a card, and how the rest
// of that card's members split behind it. The rail is its second caller — the
// API's `toEntry` is the first — and calling the same function is what makes
// "the lead card and the 18:00 card follow one rule" an assertion. Not in
// `@zammy/shared`, which ADR-0004 reserves for the wire contract (ADR-0024): the tier list
// it carries is an editorial stance, not a shape the API sends.
import { chooseHeading, LATER_PART_RULE } from "@zammy/representative";
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
 * Which headline is not answered here. It is clause 4 of one rule whose other
 * three clauses the service applies, and it is answered where they are:
 * `@zammy/representative`, under `LATER_PART_RULE`. That constant says `"part"`
 * — the EARLIEST article the part holds, which is the rule a storyline day
 * already follows (its earliest as the hero) applied one level down. `"lead"`
 * is available and unchosen: the wire names each article's group
 * (`Article.groupId`), so a part could choose within its lead group by source
 * authority the way §14.3 chooses within a slot's. Changing which headline a
 * reader sees is its own change with its own review, so the restructure that
 * moved the clause deliberately did not make it. The part the storyline's day
 * BEGINS in keeps the service's choice either way.
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
 * Which of them are copies is `groupId`, not a guess at it.
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
 * The GROUP is the fold: `groupId` says which articles are one piece, which is
 * the same fact §14.3 read to choose the slot's lead, now carried through
 * rather than respent. It used to be reconstructed from exact title equality,
 * a strictly weaker signal — a title reducing to fewer than two content tokens
 * ("The Latest", "Live updates") can never group at all, so two genuinely
 * different pieces shared one and the rail drew them as a single card. Under
 * group identity they are two cards, which is what they are.
 *
 * The flat wire order is what fills the lists, untouched. `moreCoverage`
 * arrives newest-first ACROSS groups and that is the order the disclosure
 * renders in, so the fold decides where an article goes and never in what
 * order it sits once there.
 */
function railSlots(
  entry: TimelineEntry,
  timeZone: string,
): { day: string; segment: Segment; slot: RailSlot }[] {
  const leadDay = dayKey(entry.published, timeZone);
  const leadSegment = segmentOf(entry.published, timeZone);
  const lead = segmentKey(leadDay, leadSegment);

  // Where each PIECE goes: the lead's bucket, or a bucket of its own. Buckets
  // are keyed by day AND part, because a slot can reach the same part of two
  // days — an `APP_TIMEZONE` day is 24 hours wherever it starts.
  //
  // There is no third destination any more. A copy of the representative's own
  // story cannot BE here: the service builds `moreCoverage` from the non-lead
  // groups (`apps/api/src/timeline-read.ts`, `toEntry`), so everything in it is
  // a different piece by the same reckoning that chose the representative. The
  // branch that used to divert one by its title was catching the title fold's
  // own false merges.
  const byGroup = new Map<string, Article[]>();
  for (const article of entry.moreCoverage) {
    const copies = byGroup.get(article.groupId);
    if (copies) copies.push(article);
    else byGroup.set(article.groupId, [article]);
  }
  const destination = new Map<string, string>();
  const buckets = new Map<string, { day: string; segment: Segment; articles: Article[] }>();
  for (const [groupId, copies] of byGroup) {
    const anchor = earliestCopy(copies);
    const day = dayKey(anchor.published, timeZone);
    const segment = segmentOf(anchor.published, timeZone);
    const bucket = segmentKey(day, segment);
    destination.set(groupId, bucket);
    if (bucket !== lead && !buckets.has(bucket)) buckets.set(bucket, { day, segment, articles: [] });
  }

  // Filled in the order the wire sent, so every list stays newest first (§14.3)
  // rather than headline-major.
  const here: Article[] = [];
  for (const article of entry.moreCoverage) {
    const bucket = destination.get(article.groupId)!;
    if (bucket === lead) here.push(article);
    else buckets.get(bucket)!.articles.push(article);
  }

  const slots = [
    // The lead keeps its POSITION — `entry.published`, §7.3's keyset axis — and
    // the rail's order has to be the one the API paged by. It is also that
    // day's earliest across the whole storyline while members are per-topic
    // (`readStorylineTimelinePage`), so on a keyword search it can predate
    // every article this reader can see, and the part of the day it files the
    // lead under is then a part holding nothing else. That predates this cut
    // and is §14.3's own trade; what the cut must not do is move a slot's
    // coverage away and leave the position's card claiming rows it no longer
    // has.
    card(entry, {
      day: leadDay,
      segment: leadSegment,
      headline: entry.article,
      published: entry.published,
      related: entry.related,
      moreCoverage: here,
    }),
  ];
  for (const { day, segment, articles } of buckets.values()) {
    // Clause 4 of the representative rule, applied by the module that owns the
    // other three (`@zammy/representative`) rather than restated here. Under
    // `LATER_PART_RULE` — `"part"`, what ships — the earliest article the part
    // holds heads the card, its own copies beside it as the same story, and the
    // rest is the coverage around it. Under `"lead"` the part would be headed
    // the way §14.3 heads a slot. Which of the two is a PRODUCT question with
    // its own review; the constant is where it gets answered, and the API's
    // `toEntry` reaches this same function for the lead card.
    const { representative, related, coverage } = chooseHeading(articles, {
      within: LATER_PART_RULE,
    });
    slots.push(
      card(entry, {
        day,
        segment,
        headline: representative,
        published: representative.published,
        related,
        moreCoverage: coverage,
      }),
    );
  }
  return slots;
}

/**
 * One card of a cut slot: a `RailSlot` and where on the rail it goes.
 *
 * A function rather than two object literals because of `updatedAt`, which is
 * the one field neither the entry nor the caller can supply. It is NOT the
 * wire's, which is the newest member of the WHOLE slot: a card must not stamp
 * itself updated from coverage now drawn elsewhere on the rail. So it is read
 * off what this card actually holds, floored at the card's own position — one
 * definition, applied to the lead and to every part of the day promoted out of
 * it alike, where two literals were two chances to disagree.
 */
function card(
  entry: TimelineEntry,
  // Named, not positional: `related` and `moreCoverage` are two `Article[]`
  // that render under different headings, and swapping them at a call site
  // would file every follow-up as a copy without failing a type.
  at: {
    day: string;
    segment: Segment;
    headline: Article;
    published: string;
    related: Article[];
    moreCoverage: Article[];
  },
): { day: string; segment: Segment; slot: RailSlot } {
  return {
    day: at.day,
    segment: at.segment,
    slot: {
      ...entry,
      key: slotKey(entry, at.day, at.segment, at.headline),
      article: at.headline,
      published: at.published,
      related: at.related,
      moreCoverage: at.moreCoverage,
      updatedAt: latestPublished(
        [at.headline, ...at.related, ...at.moreCoverage],
        at.published,
      ),
    },
  };
}

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
 * The earliest of `articles`. Ties go to the first, which is the newest-first
 * list's own answer. Never called on an empty list.
 *
 * This is the FOLD's placement rule, not the representative rule: it answers
 * "where did this piece run", which decides the part of the day a whole group
 * lands in. Which article then heads that part is `@zammy/representative`'s
 * question and no longer asked here — the two used to share this helper, which
 * is how one rule's last clause came to live in the browser.
 */
function earliestCopy(articles: Article[]): Article {
  let earliest = articles[0]!;
  for (const article of articles) {
    if (Date.parse(article.published) < Date.parse(earliest.published)) earliest = article;
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
