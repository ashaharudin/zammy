/**
 * Coverage-gap math (ARCHITECTURE 6.3 step 3): requested window minus covered
 * ranges, clamped to what upstream can actually answer. Pure — the repository
 * supplies the covered spans, the caller supplies the clock.
 */

/** Half-open interval [from, to), matching the tstzrange rows it is diffed against. */
export interface Span {
  from: Date;
  to: Date;
}

export function subtractCoverage(
  window: Span,
  covered: readonly Span[],
  bounds: { now: Date; lookbackDays: number },
): Span[] {
  // Clamp before diffing. Below the lookback horizon upstream 400s — never
  // spend a call to learn that — and above `now` a fetch would return nothing
  // yet be recorded as covered, hiding articles published minutes later.
  const horizon = bounds.now.getTime() - bounds.lookbackDays * 86_400_000;
  const from = Math.max(window.from.getTime(), horizon);
  const to = Math.min(window.to.getTime(), bounds.now.getTime());
  if (from >= to) return [];

  // Merge coverage into disjoint ascending spans so one subtraction sweep works.
  const merged: Array<{ from: number; to: number }> = [];
  for (const span of [...covered].sort((a, b) => a.from.getTime() - b.from.getTime())) {
    const previous = merged.at(-1);
    if (previous && span.from.getTime() <= previous.to) {
      previous.to = Math.max(previous.to, span.to.getTime());
    } else {
      merged.push({ from: span.from.getTime(), to: span.to.getTime() });
    }
  }

  const gaps: Span[] = [];
  let cursor = from;
  for (const block of merged) {
    if (block.to <= cursor) continue;
    if (block.from >= to) break;
    if (block.from > cursor) {
      gaps.push({ from: new Date(cursor), to: new Date(Math.min(block.from, to)) });
    }
    cursor = Math.max(cursor, block.to);
    if (cursor >= to) break;
  }
  if (cursor < to) gaps.push({ from: new Date(cursor), to: new Date(to) });

  // Newest first: the reader starts at the top of the timeline, so the
  // synchronous fill should spend its deadline there (§6.5).
  return gaps.reverse();
}
