/**
 * Which day groups on the rail are collapsed.
 *
 * Days are identified by their rail label (`dayLabel` in format.ts) — the same
 * string the reader clicked next to — so the set survives progressive fill:
 * older items appended to a collapsed day arrive collapsed too.
 *
 * Expanded is the default, and only collapsed days are recorded, so a day that
 * has never been touched needs no entry.
 */
export type CollapsedDays = ReadonlySet<string>;

export const noDaysCollapsed: CollapsedDays = new Set();

export function isCollapsed(collapsed: CollapsedDays, day: string): boolean {
  return collapsed.has(day);
}

export function toggleDay(collapsed: CollapsedDays, day: string): CollapsedDays {
  const next = new Set(collapsed);
  if (!next.delete(day)) next.add(day);
  return next;
}
