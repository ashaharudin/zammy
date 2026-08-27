import { NewsInvalidQueryError } from "./errors.js";

/**
 * Search parameters in OUR naming, translated to wire names by each adapter.
 *
 * Provider-agnostic on purpose: this is the vocabulary the Query Service plans
 * in, and it must not acquire a field that only one upstream understands. Where
 * providers disagree on encoding — Currents wants `keywords` space-joined and
 * GNews wants a `q` string with real boolean operators — the disagreement is
 * absorbed in the adapter, which is the whole point of ARCHITECTURE 5.
 */
export interface SearchParams {
  keywords?: string[];
  language?: string;
  country?: string;
  category?: string;
  domain?: string;
  startDate?: Date;
  endDate?: Date;
  /** 1-indexed. Currents rejects 0 with "Min value: 1"; GNews starts at 1 too. */
  pageNumber?: number;
  /** Clamped to the tier maximum (20 on Currents Free, 10 on GNews Free). */
  pageSize?: number;
}

/** Tier limits, enforced locally so upstream 400s stay unreachable. */
export interface ClampLimits {
  maxPageSize: number;
  maxRetrievableResults: number;
  maxLookbackDays: number;
  /** Per-call date-range ceiling. 7 days on Currents, observed live 2026-08-11. */
  maxRangeDays: number;
}

/**
 * How far INSIDE the lookback window the clamp lands, rather than exactly on
 * its edge.
 *
 * The edge is not a safe place to sit, and production proved it: on 2026-08-26
 * (deployment `dpl_GJ9xwKPDw9J7ZQDNpwqpmyMpeHfv`) a start date clamped to
 * exactly `now - 30d` was still answered with 400 `date_range: Max lookback is
 * 30 days`. Three things move a boundary value after we compute it, and all
 * three move it the same way — OLDER, i.e. out of the window:
 *
 *   - **The wire encoding truncates.** Currents wants whole seconds, so the
 *     adapter strips the milliseconds — which for any real timestamp is a
 *     floor, moving it up to 999ms older. A boundary value is already outside
 *     the window before it is sent, on 999 requests in 1000.
 *   - **The request takes time.** Up to 24.6s of it: three attempts at the
 *     transport's 8s timeout, plus full-jitter backoff capped at 200ms and
 *     400ms between them, every attempt re-sending the start date computed
 *     once, here, before the first.
 *   - **Their clock is not our clock.** Any skew in the "upstream is ahead"
 *     direction narrows their window relative to ours by that much.
 *
 * A minute absorbs all three with room to spare, and what it costs is a minute
 * at the oldest edge of a 30-day archive — sixty seconds of month-old news that
 * upstream is about to drop anyway. This is the LAST line of defence, not the
 * first: the planner leaves its own, much larger slack so a segment queued now
 * is still fetchable when a consumer dequeues it minutes later (see
 * `LOOKBACK_PLAN_SLACK_MS` in the API's `coverage-gaps.ts`). The margin here is
 * what keeps the promise below true for every OTHER caller — a top-up, a job
 * enqueued by an older deploy, a re-sliced span read back out of the queue.
 */
export const LOOKBACK_CLAMP_MARGIN_MS = 60_000;

/**
 * Pre-flight clamp, so the tier's limits are enforced locally instead of learned
 * from a 400 (ARCHITECTURE 11: pre-flight validation should make upstream 400s
 * unreachable). Every clamp here corresponds to an error Currents actually
 * returned during the probe, and each one generalizes — every provider sells
 * tiers with a page size, a paging depth, and an archive horizon:
 *
 *   page_size > 20            → "Max page_size for Free tier is 20"
 *   page_number > cap/size    → "Max retrievable results for Free tier is 100"
 *   start_date > 30 days ago  → "Max lookback is 30 days"
 *
 * Adjustments are returned rather than logged-and-forgotten: a window silently
 * pulled forward looks exactly like missing news, so the caller gets to say so.
 */
export function clampSearchParams(
  params: SearchParams,
  limits: ClampLimits,
  now: Date = new Date(),
): { params: SearchParams; adjustments: string[] } {
  const adjustments: string[] = [];
  const clamped: SearchParams = { ...params };

  const requestedPageSize = params.pageSize ?? limits.maxPageSize;
  const pageSize = Math.max(1, Math.min(Math.trunc(requestedPageSize), limits.maxPageSize));
  if (params.pageSize !== undefined && pageSize !== params.pageSize) {
    adjustments.push(`pageSize ${params.pageSize} → ${pageSize} (tier maximum)`);
  }
  clamped.pageSize = pageSize;

  const maxPageNumber = Math.max(1, Math.floor(limits.maxRetrievableResults / pageSize));
  if (params.pageNumber !== undefined) {
    // Asking past the cap must FAIL, not quietly resolve to the last page.
    // Upstream answers such a request with 400 "Max retrievable results for Free
    // tier is 100", and clamping down would be actively worse than that error:
    // page 6 would return page 5's sightings, so a pager would ingest the same
    // twenty sightings forever and count them as new history.
    if (Math.trunc(params.pageNumber) > maxPageNumber) {
      throw new NewsInvalidQueryError(
        `pageNumber ${params.pageNumber} exceeds the retrievable cap: ` +
          `${limits.maxRetrievableResults} results at pageSize ${pageSize} is ` +
          `${maxPageNumber} pages. Subdivide the time window instead — the cap is ` +
          "a wall, not a cursor (ARCHITECTURE 6.3).",
        { page_number: `Max retrievable results is ${limits.maxRetrievableResults}` },
      );
    }
    clamped.pageNumber = Math.max(1, Math.trunc(params.pageNumber));
  }

  if (params.startDate) {
    // Note the `+ margin`: the clamp target is inside the window, not on it.
    // The comparison uses that same target, so a start date sitting a few
    // hundred milliseconds ABOVE the raw boundary — untouched by the old
    // `< boundary` test, then floored below it by the wire encoding — is pulled
    // to safety too. That case was the observed 400.
    const earliest = new Date(
      now.getTime() - limits.maxLookbackDays * 86_400_000 + LOOKBACK_CLAMP_MARGIN_MS,
    );
    if (params.startDate < earliest) {
      adjustments.push(
        `startDate ${params.startDate.toISOString()} → ${earliest.toISOString()} ` +
          `(${limits.maxLookbackDays}-day lookback limit)`,
      );
      clamped.startDate = earliest;
    }
  }

  // A range past the ceiling must FAIL, not quietly narrow (observed live
  // 2026-08-11: 400 "date_range: Max range is 7 days"). The planner records
  // coverage for the span it ASKED for, so a silently narrowed fetch would
  // become coverage over days nobody fetched — data loss with no error
  // anywhere. Slicing wide windows is the planner's job (ARCHITECTURE 6.3).
  if (clamped.startDate && clamped.endDate) {
    const rangeMs = clamped.endDate.getTime() - clamped.startDate.getTime();
    if (rangeMs > limits.maxRangeDays * 86_400_000) {
      throw new NewsInvalidQueryError(
        `date range ${clamped.startDate.toISOString()} → ` +
          `${clamped.endDate.toISOString()} exceeds the ${limits.maxRangeDays}-day ` +
          "per-call ceiling. Slice the window instead — the planner's gap " +
          "segments must each be individually fetchable (ARCHITECTURE 6.3).",
        { date_range: `Max range is ${limits.maxRangeDays} days` },
      );
    }
  }

  return { params: clamped, adjustments };
}
