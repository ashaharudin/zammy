import type { Sighting } from "./sighting.js";
import type { NormalizationStats } from "./normalize.js";
import type { SearchParams } from "./search-params.js";
import type { CallPriority, QuotaSnapshot, QuotaView } from "./quota.js";

/**
 * The provider-agnostic client surface (ARCHITECTURE 5.1, 5.6).
 *
 * It knows HTTP and one provider's contract; it knows nothing about our cache,
 * our database, or our front end. Every implementation satisfies it — live HTTP
 * per provider, fixture-backed per provider, and the composite that fans out
 * across them — so no code above this line branches on which upstream answered
 * or on `*_MODE` (ARCHITECTURE 4.1: the moment a code path branches on
 * environment, local development stops predicting production behaviour).
 *
 * `search()` returning `Sighting[]` is the seam ARCHITECTURE 5.6 named, and it
 * is what makes a second provider a new adapter rather than a new data path.
 */

/** Tier limits, verified against Currents Free (PROBE-FINDINGS 1) and bounded by config. */
export interface ClientLimits {
  maxPageSize: number;
  maxRetrievableResults: number;
  maxLookbackDays: number;
  /** Per-call date-range ceiling (7 days on Currents, observed 2026-08-11). */
  maxRangeDays: number;
}

export interface CallOpts {
  /**
   * Caller's own deadline — e.g. the 1200ms synchronous fill budget of
   * ARCHITECTURE 6.3. Composed with the per-request timeout, so whichever fires
   * first wins and an aborted call is never retried.
   */
  signal?: AbortSignal;
  /** Background calls stop at the interactive reserve. Defaults to "interactive". */
  priority?: CallPriority;
  /** Per-request deadline override, in ms. */
  timeoutMs?: number;
}

export interface SearchResult {
  sightings: Sighting[];
  requestedAt: Date;
  /**
   * Raw sighting count from upstream, BEFORE normalization drops.
   *
   * This is the only valid page-boundary signal. Using `sightings.length` would
   * make one malformed sighting read as "last page" and silently truncate a
   * topic's history — a data-loss bug that nothing would report.
   */
  rawCount: number;
  /**
   * Upstream's clean end-of-results signal, normally `rawCount < pageSize`.
   *
   * Read it as "there is nothing further to fetch for this window", because that
   * is what the caller records coverage on. The composite therefore takes it from
   * the coverage-bearing provider alone rather than combining the two — see
   * `CompositeNewsClient`.
   */
  isLastPage: boolean;
  /** Page size actually sent, after clamping. Needed to interpret `isLastPage`. */
  pageSize: number;
  normalization: NormalizationStats;
  /**
   * Parsed quota state. Null when the provider reports none — GNews sends no
   * rate-limit headers at all — or in fixture mode where no call was made. Never
   * silently reported as "plenty left".
   */
  quota: QuotaSnapshot | null;
  /**
   * Pre-flight clamps applied to the request, e.g. a start date pulled forward to
   * the 30-day lookback limit, and — from the composite — any provider that sat
   * a call out. Empty in the normal case. Surfaced rather than hidden, because a
   * silently narrowed window looks like missing news.
   */
  adjustments: string[];
}

export interface NewsClient {
  /** Which upstream this client speaks to. `"composite"` when it fans out. */
  readonly provider: string;
  /**
   * The provider whose fetches back coverage claims (ADR-0012). A single client
   * is its own; the composite answers with its primary's. Callers recording
   * coverage from sightings must consider only sightings carrying this name —
   * a supplement's sightings are breadth, and treating one as the coverage
   * frontier claims spans the coverage-bearing provider never fetched.
   */
  readonly coverageProvider: string;
  /**
   * The tier limits this client enforces.
   *
   * Exposed so callers cannot page against a different idea of the cap than the
   * client clamps to. When they disagree, a pager asks for a page past the cap and
   * gets the last page back again — twenty sightings re-ingested as new history.
   */
  readonly limits: ClientLimits;
  search(params: SearchParams, opts?: CallOpts): Promise<SearchResult>;
  /** Current quota knowledge, for `/readyz` and `meta.degraded`. */
  quota(): Promise<QuotaView>;
  close(): Promise<void>;
}
