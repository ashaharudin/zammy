import type { Segment } from "./format.js";

/**
 * Which sections of the rail are collapsed — days, and the parts of day nested
 * inside them (§8.1).
 *
 * Sections are identified by the day's KEY, not the label the reader clicked
 * next to: labels move. A section collapsed as "Today" at 23:59 is called
 * "Yesterday" a minute later, and a label-keyed set would hand that collapsed
 * flag to whichever day inherited the name. Keys are stable, so the set also
 * survives progressive fill — older items appended to a collapsed section
 * arrive collapsed too. A segment's key carries its day, because "Morning"
 * recurs on every day and a bare name would collapse all of them at once.
 *
 * Expanded is the default, and only collapsed sections are recorded, so one
 * that has never been touched needs no entry.
 *
 * The day is the OUTER switch and needs no code to be one: collapsing a day
 * hides its segments without touching their keys, so expanding it again
 * restores whatever they were.
 */
export type CollapsedSections = ReadonlySet<string>;

export const nothingCollapsed: CollapsedSections = new Set();

/**
 * A segment's key, from its day's key (`YYYY-MM-DD`) and its own name. Both
 * halves are fixed-shape and neither can contain `·`, so the join is
 * unambiguous by construction rather than by luck with a localised label.
 */
export function segmentKey(dayKey: string, segment: Segment): string {
  return `${dayKey}·${segment}`;
}

export function isCollapsed(collapsed: CollapsedSections, key: string): boolean {
  return collapsed.has(key);
}

export function toggle(collapsed: CollapsedSections, key: string): CollapsedSections {
  const next = new Set(collapsed);
  if (!next.delete(key)) next.add(key);
  return next;
}
