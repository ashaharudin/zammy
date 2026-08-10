import type { Sighting } from "./sighting.js";
import { emptyStats, type NormalizationStats } from "./normalize.js";
import type { SearchParams } from "./raw.js";
import type { QuotaSnapshot } from "./quota.js";
import type { CallOpts, ClientLimits, CurrentsClient } from "./client.js";

/**
 * Paging over one query (ARCHITECTURE 6.3, step 4).
 *
 * This is the client-level primitive only: page through a single window until
 * upstream signals the end, the retrievable cap is hit, or the caller's budget
 * runs out. Deciding *which* windows to ask about — the coverage-gap arithmetic
 * and the adaptive subdivision that gets past the 100-result cap — is the Query
 * Service's job in Phase 3, and it needs exactly one thing from here: an honest
 * answer about whether upstream had more to give.
 *
 * That answer is `stoppedBy`, and getting it wrong is a silent data-loss bug:
 * a full final page means "truncated by the cap", never "finished". Treating it
 * as finished would permanently hide history behind the cap with no error to
 * report it (ARCHITECTURE 11).
 */

export type StopReason =
  /** Upstream returned a short page: a genuine end of results for this window. */
  | "end_of_results"
  /** Hit the tier's retrievable cap with a full page. There IS more; subdivide. */
  | "cap"
  /** The caller's call budget or deadline ran out. Enqueue the remainder. */
  | "call_budget"
  /** A page after the first failed. The gap remains for the next reader. */
  | "error";

export interface PagedResult {
  sightings: Sighting[];
  /** Pages actually fetched. Each is one upstream call and one quota token. */
  pages: number;
  /** Raw sightings returned, before normalization drops. */
  rawCount: number;
  /**
   * Distinct articles across all pages — sightings sharing a dedup key count
   * once. This is the numerator of the
   * unique-articles-per-upstream-call metric (ARCHITECTURE 12). The probe
   * baseline is ~8 unique per 20-sighting call; a fall means duplication is
   * worsening and timelines are thinning.
   */
  uniqueArticles: number;
  stoppedBy: StopReason;
  /** Where a continuation should resume, or null when there is nothing left. */
  nextPageNumber: number | null;
  normalization: NormalizationStats;
  /** The most recent quota observation across the pages fetched. */
  quota: QuotaSnapshot | null;
  adjustments: string[];
  /** Set only when `stoppedBy === "error"`. The first page never swallows an error. */
  error?: unknown;
}

export interface CollectPagesOptions extends CallOpts {
  /**
   * Upstream calls this collection may make. The synchronous fill uses a small
   * number and defers the rest (ARCHITECTURE 6.3 step 5); a background job uses
   * the full page allowance.
   */
  maxCalls?: number;
  /** First page to fetch. 1-indexed, as upstream requires. */
  startPage?: number;
  onPage?: (sightings: Sighting[], pageNumber: number) => void;
}

export async function collectPages(
  client: CurrentsClient,
  params: SearchParams,
  options: CollectPagesOptions = {},
): Promise<PagedResult> {
  const { maxCalls, startPage = 1, onPage, ...callOpts } = options;

  // Read from the client rather than accepting a copy: the two disagreeing is how
  // a pager ends up requesting a page past the cap and re-ingesting the last one.
  const limits: Pick<ClientLimits, "maxPageSize" | "maxRetrievableResults"> =
    client.limits;

  const pageSize = Math.max(
    1,
    Math.min(params.pageSize ?? limits.maxPageSize, limits.maxPageSize),
  );
  const maxPageNumber = Math.max(
    1,
    Math.floor(limits.maxRetrievableResults / pageSize),
  );
  const callBudget = Math.max(1, maxCalls ?? maxPageNumber);

  const sightings: Sighting[] = [];
  const dedupKeys = new Set<string>();
  const normalization = emptyStats();
  const adjustments: string[] = [];
  let quota: QuotaSnapshot | null = null;
  let pages = 0;
  let rawCount = 0;
  let pageNumber = startPage;

  for (;;) {
    let result;
    try {
      result = await client.search({ ...params, pageSize, pageNumber }, callOpts);
    } catch (error) {
      // The first page is the one guaranteed call, and a cold topic has nothing
      // to fall back on — so its failure is the caller's problem to render
      // (ARCHITECTURE 11). A later failure just leaves a coverage gap, which the
      // next reader repairs; returning the pages we did get is strictly better
      // than discarding them.
      if (pages === 0) throw error;
      return {
        sightings,
        pages,
        rawCount,
        uniqueArticles: dedupKeys.size,
        stoppedBy: "error",
        nextPageNumber: pageNumber,
        normalization,
        quota,
        adjustments,
        error,
      };
    }

    pages += 1;
    rawCount += result.rawCount;
    sightings.push(...result.sightings);
    for (const sighting of result.sightings) dedupKeys.add(sighting.dedupKey);
    accumulate(normalization, result.normalization);
    for (const adjustment of result.adjustments) {
      if (!adjustments.includes(adjustment)) adjustments.push(adjustment);
    }
    if (result.quota) quota = result.quota;
    onPage?.(result.sightings, pageNumber);

    if (result.isLastPage) {
      return {
        sightings,
        pages,
        rawCount,
        uniqueArticles: dedupKeys.size,
        stoppedBy: "end_of_results",
        nextPageNumber: null,
        normalization,
        quota,
        adjustments,
      };
    }

    pageNumber += 1;

    // A full page at the cap does NOT mean we are done — it means the cap cut us
    // off and the window needs subdividing (ARCHITECTURE 6.3).
    if (pageNumber > maxPageNumber) {
      return {
        sightings,
        pages,
        rawCount,
        uniqueArticles: dedupKeys.size,
        stoppedBy: "cap",
        nextPageNumber: null,
        normalization,
        quota,
        adjustments,
      };
    }

    if (pages >= callBudget) {
      return {
        sightings,
        pages,
        rawCount,
        uniqueArticles: dedupKeys.size,
        stoppedBy: "call_budget",
        nextPageNumber: pageNumber,
        normalization,
        quota,
        adjustments,
      };
    }
  }
}

function accumulate(target: NormalizationStats, source: NormalizationStats): void {
  target.received += source.received;
  target.kept += source.kept;
  for (const [reason, count] of Object.entries(source.dropped)) {
    target.dropped[reason as keyof NormalizationStats["dropped"]] += count;
  }
}
