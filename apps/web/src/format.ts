import type { Article, TimelineEntry } from "@zammy/shared";

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
 * Where that coverage reached a later part of the day it is drawn there
 * instead of under the headline (`RailSlot`).
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
 * is separate enough to stand in a part of the day of its own.
 *
 * A slot that never reached a second part of the day yields exactly one of
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
  segments: { segment: Segment; items: RailSlot[] }[];
}

/**
 * Bucket timeline slots by calendar day, each day holding its parts of day and
 * each part its rail entries (`RailSlot`).
 *
 * The DAY comes from the slot's own `published` — the group's earliest member
 * (§14.3), which is where the slot sits — never from the headline article's,
 * which can be hours later and would file the slot under the wrong divider.
 * The input is already in timeline order (published DESC — §7), so day
 * adjacency is all this needs and a day cannot recur non-adjacently.
 *
 * Segments are NOT read off adjacency, because a slot no longer belongs to
 * exactly one: its coverage can open a segment that a later slot's lead then
 * also lands in, so parts are collected per day and ordered here — newest part
 * first, the direction the whole column runs — with each part's entries sorted
 * by what they hold rather than by which slot contributed them.
 *
 * A day whose coverage all landed in ONE segment gets no segment treatment,
 * and that rule lives in this shape rather than in the renderer: such a day
 * simply has one entry in `segments`.
 */
export function groupByDay(items: TimelineEntry[], now: Date, timeZone: string): DayGroup[] {
  const todayKey = dayKey(now.toISOString(), timeZone);
  const days: { key: string; day: string; parts: Map<Segment, RailSlot[]> }[] = [];
  for (const item of items) {
    const key = dayKey(item.published, timeZone);
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      day = { key, day: labelFor(key, item.published, todayKey, timeZone), parts: new Map() };
      days.push(day);
    }
    for (const { segment, slot } of railSlots(item, key, timeZone)) {
      const part = day.parts.get(segment);
      if (part) part.push(slot);
      else day.parts.set(segment, [slot]);
    }
  }
  return days.map(({ key, day, parts }) => ({
    key,
    day,
    segments: SEGMENTS_DESC.flatMap((segment) => {
      const part = parts.get(segment);
      if (!part) return [];
      // Newest first, the timeline's own order. The slots arrived that way but
      // the cards cut out of them need not: a card heading a later part of the
      // day sits at its own headline, which can be later than the headline of a
      // slot above it.
      return [{ segment, items: [...part].sort((a, b) => at(b) - at(a)) }];
    }),
  }));
}

/** One slot, cut into the parts of its day it actually reaches. */
function railSlots(
  entry: TimelineEntry,
  day: string,
  timeZone: string,
): { segment: Segment; slot: RailSlot }[] {
  const leadSegment = segmentOf(entry.published, timeZone);
  const here: Article[] = [];
  const later = new Map<Segment, Article[]>();
  for (const article of entry.moreCoverage) {
    // Coverage that fell on another of the READER's days stays with the lead.
    // The day a slot sits under is the slot's — the unit the API pages by
    // (§7.3) — so an article moved to a different divider could land in a day
    // this page has not loaded, or below the "load older" frontier. Only the
    // cut INSIDE the slot's own day is the rail's to make. Reachable at all
    // only because the reader's zone need not be `APP_TIMEZONE`, whose day
    // bounds the slot.
    const segment =
      dayKey(article.published, timeZone) === day
        ? segmentOf(article.published, timeZone)
        : leadSegment;
    if (segment === leadSegment) {
      here.push(article);
      continue;
    }
    const part = later.get(segment);
    if (part) part.push(article);
    else later.set(segment, [article]);
  }

  const slots: { segment: Segment; slot: RailSlot }[] = [
    {
      segment: leadSegment,
      slot: {
        ...entry,
        key: slotKey(entry, leadSegment),
        moreCoverage: here,
        // Recomputed rather than taken from the wire, where `updatedAt` is the
        // newest member of the WHOLE slot: a card must not stamp itself updated
        // from coverage now drawn in its own part of the day further up the
        // rail. `published` needs no such treatment — the article that defines
        // it is in this part by construction.
        updatedAt: latestPublished([entry.article, ...entry.related, ...here], entry.published),
      },
    },
  ];
  for (const [segment, articles] of later) {
    // Earliest as the hero, and the rest is the coverage around it. The list
    // arrives newest first (§14.3) and stays that way once the hero is out.
    const hero = earliestIndex(articles);
    slots.push({
      segment,
      slot: {
        ...entry,
        key: slotKey(entry, segment),
        article: articles[hero]!,
        published: articles[hero]!.published,
        updatedAt: latestPublished(articles, articles[hero]!.published),
        // Nothing here is the same story as the hero: every article in a part
        // of the day came from a group of its own, the lead group's copies
        // having stayed with the lead.
        related: [],
        moreCoverage: articles.filter((_, index) => index !== hero),
      },
    });
  }
  return slots;
}

function slotKey(entry: TimelineEntry, segment: Segment): string {
  return `${entry.storylineId}:${entry.published}:${segment}`;
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
