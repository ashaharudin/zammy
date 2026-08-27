import type { TimelineEntry } from "@zammy/shared";

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
 * coarser timestamp, never a claim about what happened when — a slot sits at
 * its storyline's EARLIEST article that day, so a storyline covered 07:00 to
 * 23:00 is one slot filed under Morning.
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

/**
 * The hour of `iso` in `timeZone`.
 *
 * Reading the hour rather than computing an offset is what keeps DST out of
 * this file: a 23- or 25-hour day simply has a shorter or longer segment, and
 * none of `app-day.ts`'s two-pass midnight correction is needed. The `% 24` is
 * not decoration — Intl reports midnight as "24" under some hourCycle
 * readings, and without it every midnight slot files under Evening.
 */
function hourIn(iso: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
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
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
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
  const diff = daysBetween(dayKey(now.toISOString(), timeZone), dayKey(iso, timeZone));
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

export interface DayGroup {
  day: string;
  segments: { segment: Segment; items: TimelineEntry[] }[];
}

/**
 * Bucket consecutive timeline slots by calendar day, each day holding its
 * parts of day. The input is already in timeline order (published DESC — §7),
 * so adjacency is all either level needs, and a segment cannot recur
 * non-adjacently inside one day.
 *
 * The day comes from the slot's own `published` — the group's earliest member
 * (§14.3), which is where the slot sits — never from the headline article's,
 * which can be hours later and would file the slot under the wrong divider.
 *
 * A day whose coverage all landed in ONE segment gets no segment treatment,
 * and that rule lives in this shape rather than in the renderer: such a day
 * simply has one entry in `segments`.
 */
export function groupByDay(items: TimelineEntry[], now: Date, timeZone: string): DayGroup[] {
  const days: DayGroup[] = [];
  for (const item of items) {
    const day = dayLabel(item.published, now, timeZone);
    const segment = segmentOf(item.published, timeZone);
    let lastDay = days[days.length - 1];
    if (!lastDay || lastDay.day !== day) {
      lastDay = { day, segments: [] };
      days.push(lastDay);
    }
    const lastSegment = lastDay.segments[lastDay.segments.length - 1];
    if (lastSegment && lastSegment.segment === segment) lastSegment.items.push(item);
    else lastDay.segments.push({ segment, items: [item] });
  }
  return days;
}
