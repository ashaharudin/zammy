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

/**
 * How far inside the lookback horizon the PLAN starts, so a segment is still
 * fetchable when whoever fills it actually calls upstream.
 *
 * The planner and the fetcher are not the same moment. A gap computed here is
 * either filled synchronously (a second or two later) or enqueued — and a
 * queued segment is fetched when the consumer dequeues it, which on Vercel
 * Queues is a first delivery at +0s and, if that one fails, redeliveries at
 * +305s and +610s. A plan whose oldest segment starts exactly ON the horizon is
 * therefore valid only for the sync path; by the time the queue gets to it the
 * horizon has moved past it and upstream answers 400 `Max lookback is 30 days`
 * — which is precisely what production did on 2026-08-26 for the oldest segment
 * of every cold search.
 *
 * Fifteen minutes is not a guess, it is the message's whole lifetime:
 * `INGEST_RETENTION_SECONDS` (900s) is when the queue deletes a message, so no
 * delivery can happen more than 900s after the plan that produced it. Slack
 * equal to that bounds every delivery that can still exist, with the +610s
 * final attempt comfortably inside. `coverage-gaps.test.ts` pins the two
 * together, since the relationship is the reason for the number.
 *
 * **What it costs** is the oldest fifteen minutes of a 30-day window, never
 * fetched: the horizon only moves forward, so that sliver ages out of the
 * window before any later read could plan it. Fifteen minutes of month-old news
 * at the exact edge upstream is about to drop it — against a guaranteed 400 and
 * a five-minute delay on every cold search. One horizon for both paths, rather
 * than a second one for queued segments only: coverage is recorded for the span
 * we ASKED for, and two horizons is two chances to record a span nobody fetched.
 */
export const LOOKBACK_PLAN_SLACK_MS = 15 * 60 * 1000;

export function subtractCoverage(
  window: Span,
  covered: readonly Span[],
  bounds: {
    now: Date;
    lookbackDays: number;
    /**
     * Upstream's per-call date-range ceiling (7 days, observed live
     * 2026-08-11 — the probe-era single 30-day call now 400s). Gaps wider
     * than this are sliced so every planned segment is individually
     * fetchable; slicing here rather than clamping in the client keeps
     * coverage honest — a clamped fetch would record spans nobody asked for.
     */
    maxSpanMs?: number;
  },
): Span[] {
  // Clamp before diffing. Below the lookback horizon upstream 400s — never
  // spend a call to learn that — and above `now` a fetch would return nothing
  // yet be recorded as covered, hiding articles published minutes later.
  //
  // The horizon carries `LOOKBACK_PLAN_SLACK_MS`, so it is where the edge will
  // still be once the segment is actually fetched rather than where it is at
  // this instant. Sitting on the live edge produced a 400 on every cold search
  // (see the constant).
  const horizon =
    bounds.now.getTime() - bounds.lookbackDays * 86_400_000 + LOOKBACK_PLAN_SLACK_MS;
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
  const newestFirst = gaps.reverse();
  return bounds.maxSpanMs === undefined
    ? newestFirst
    : newestFirst.flatMap((gap) => sliceSpan(gap, bounds.maxSpanMs!));
}

/**
 * Split a span into ceiling-sized slices, NEWEST FIRST — the reader is at the
 * top of the timeline, so full-size slices hug the recent end and any
 * remainder lands at the oldest edge.
 */
export function sliceSpan(span: Span, maxMs: number): Span[] {
  const slices: Span[] = [];
  let to = span.to.getTime();
  const floor = span.from.getTime();
  while (to > floor) {
    const from = Math.max(floor, to - maxMs);
    slices.push({ from: new Date(from), to: new Date(to) });
    to = from;
  }
  return slices;
}
