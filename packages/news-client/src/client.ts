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

/**
 * One contributing provider's account of its OWN walk of the window asked about.
 *
 * Coverage is `(subject, provider, span)` and no provider is privileged
 * (ADR-0019), so "was this window finished?" has one answer per provider and no
 * combined one. This is that answer, reported as a fact rather than resolved
 * into a ranking: a caller writing a coverage row picks the provider it is
 * writing for and reads that provider's entry, and a provider that is absent
 * from the list said nothing this call and may not be recorded as having
 * covered anything.
 */
export interface ProviderCompleteness {
  /** The provider that answered. Matches the `provider` on its own sightings. */
  provider: string;
  /**
   * That provider's clean end-of-results signal for the window asked about —
   * "there is nothing further for ME to fetch here", normally its own raw count
   * coming in under the page size. This is what a coverage row may be written
   * on, and it is per provider because a coverage row is.
   */
  isLastPage: boolean;
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
   * Whether the SHARED PAGING PLAN has another page to ask for — "should this
   * loop call again with `pageNumber + 1`?", nothing more.
   *
   * It is not a coverage claim, and reading it as one is the mistake ADR-0012
   * was written around and ADR-0019 retired: a fan-out sends every provider the
   * same `pageNumber` and `pageSize`, so exactly one of them can own the loop's
   * termination, and that one owning it says nothing about what the others
   * walked. `completeness` is where coverage claims live. ADR-0019's
   * "providers stop sharing a plan" is what eventually retires this field
   * along with the shared plan it terminates.
   */
  isLastPage: boolean;
  /**
   * Each provider that actually answered, and what it said about its own walk.
   *
   * One entry for a single-provider client — itself. One per contributor for
   * the composite, with a provider that errored, sat the call out or ran out of
   * budget simply absent (and named in `adjustments`). Absence is the point:
   * "no entry" is what a provider having no claim over this window looks like,
   * and it cannot be confused with `isLastPage: false`.
   */
  completeness: readonly ProviderCompleteness[];
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

/**
 * The `completeness` of a client that speaks to exactly one provider: itself,
 * and its own answer.
 *
 * A helper rather than an inline literal at each adapter, so a single-provider
 * adapter cannot report a contributor list that disagrees with its own
 * `provider`, and so the shape gains a field in one place rather than seven.
 */
export function soleContributor(
  provider: string,
  isLastPage: boolean,
): readonly ProviderCompleteness[] {
  return [{ provider, isLastPage }];
}
