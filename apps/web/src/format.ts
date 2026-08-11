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

export function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(date)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Bucket consecutive timeline slots by calendar day. The input is already in
 * timeline order (published DESC — §7), so adjacency is all this needs.
 *
 * The day comes from the slot's own `published` — the group's earliest member
 * (§14.3), which is where the slot sits — never from the headline article's,
 * which can be hours later and would file the slot under the wrong divider.
 */
export function groupByDay(items: TimelineEntry[]): { day: string; items: TimelineEntry[] }[] {
  const groups: { day: string; items: TimelineEntry[] }[] = [];
  for (const item of items) {
    const day = dayLabel(item.published);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}
