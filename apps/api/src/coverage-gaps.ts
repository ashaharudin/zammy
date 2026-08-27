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
 * Fifteen minutes covers the delivery budget with room. The last attempt on a
 * failing message is `MAX_INGEST_DELIVERIES - 1` redeliveries out: +600s by
 * `OBSERVED_REDELIVERY_LEASE_SECONDS`, or +610s at the redelivery actually
 * measured (305s, five seconds past the lease). The rest absorbs the gap
 * between planning a segment and publishing it — the sync fill runs first, and
 * its floor-of-one call can spend ~25s on transport retries before the deferred
 * jobs are enqueued. `coverage-gaps.test.ts` pins that inequality, and pins the
 * one the fetch-time clamp actually depends on: this slack must stay above
 * `LOOKBACK_CLAMP_MARGIN_MS`, or the client narrows below the span
 * `processSegmentJob` just clamped to and the silent-coverage failure returns.
 *
 * That second pin is necessary rather than sufficient, and the difference is
 * the headroom between the two: `slack - margin` (840s) is how long a job may
 * spend between its clamp and its LAST upstream call before the client starts
 * narrowing again. `vercel.json` caps the consumer and the drain at 300s, so
 * production cannot reach it. The in-process BullMQ consumer has no such cap —
 * a maximally wide legacy job is 25 calls at up to 24.6s each, ~615s, which
 * fits but not by much. Vercel is production (ADR-0015); this is the number to
 * revisit if that stops being true.
 *
 * **This slack is an optimization, NOT the correctness mechanism, and the
 * difference matters.** No fixed number can bound the delay, because two paths
 * reset the clock:
 *
 *   - `DRAIN_MIN_AGE_MS` is `INGEST_RETENTION_SECONDS` exactly, so the drain
 *     route only ever looks at entries ALREADY 900s old — it would consume this
 *     entire slack by construction, on every job it touches.
 *   - `onTruncated` re-enqueues a remainder that keeps the ORIGINAL `from` under
 *     a fresh 900s retention, so a truncation chain walks the same lower edge
 *     forward indefinitely.
 *
 * What makes those safe is that `processSegmentJob` re-clamps against this
 * horizon at FETCH time and fills the clamped span, so coverage is recorded for
 * what was actually fetched. Without that, a slack big enough to survive the
 * clamp in `clampSearchParams` would be worse than the 400 it replaced: the
 * fetch would silently narrow and the planner would record coverage over days
 * nobody fetched — the exact failure the range ceiling below refuses to permit.
 *
 * **What it costs** is the oldest fifteen minutes of a 30-day window, never
 * fetched: the horizon only moves forward, so that sliver ages out of the
 * window before any later read could plan it. Fifteen minutes of month-old news
 * at the exact edge upstream is about to drop it, against a five-minute delay on
 * every cold search.
 */
export const LOOKBACK_PLAN_SLACK_MS = 15 * 60 * 1000;

/**
 * Where the lookback edge will still be once a segment planned now is actually
 * fetched. The single definition of that horizon: the planner subtracts against
 * it, and `processSegmentJob` re-clamps against it with a fresh `now` before
 * spending a call, so the two cannot drift apart.
 */
export function planHorizon(now: Date, lookbackDays: number): Date {
  return new Date(now.getTime() - lookbackDays * 86_400_000 + LOOKBACK_PLAN_SLACK_MS);
}

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
  const horizon = planHorizon(bounds.now, bounds.lookbackDays).getTime();
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
