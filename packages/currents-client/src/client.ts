import type { Sighting } from "./sighting.js";
import type { NormalizationStats } from "./normalize.js";
import type { SearchParams } from "./raw.js";
import type { CallPriority, QuotaSnapshot, QuotaView } from "./quota.js";

/**
 * The client's public surface (ARCHITECTURE 5.1).
 *
 * It knows HTTP and the Currents contract; it knows nothing about our cache, our
 * database, or our front end. Two implementations satisfy it — live HTTP and
 * fixture-backed — so no code above this line branches on `CURRENTS_MODE`
 * (ARCHITECTURE 4.1: the moment a code path branches on environment, local
 * development stops predicting production behaviour).
 *
 * `search()` returning `Sighting[]` is also the seam for a second
 * provider later (ARCHITECTURE 5.6).
 */

/** Tier limits, verified against Free (PROBE-FINDINGS 1) and bounded by config. */
export interface ClientLimits {
  maxPageSize: number;
  maxRetrievableResults: number;
  maxLookbackDays: number;
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
  /** `rawCount < pageSize`. Upstream's clean end-of-results signal. */
  isLastPage: boolean;
  /** Page size actually sent, after clamping. Needed to interpret `isLastPage`. */
  pageSize: number;
  normalization: NormalizationStats;
  /**
   * Parsed `x-ratelimit-*`. Null when upstream omitted the headers, or in fixture
   * mode where no call was made — never silently reported as "plenty left".
   */
  quota: QuotaSnapshot | null;
  /**
   * Pre-flight clamps applied to the request, e.g. a start date pulled forward to
   * the 30-day lookback limit. Empty in the normal case. Surfaced rather than
   * hidden, because a silently narrowed window looks like missing news.
   */
  adjustments: string[];
}

/**
 * The `/v2/latest-news` category taxonomy, verbatim from the recorded 400 body
 * (PROBE-FINDINGS 6c, `fixtures/latest-news-v2-sample.json`). Disjoint from
 * `/v1/available/categories` — v1 names like "technology" are v2 400s, so the
 * reference lists must never be used to validate these.
 */
export const V2_CATEGORIES = [
  "general",
  "society",
  "science_technology",
  "politics_government",
  "economy_business_finance",
  "arts_culture_entertainment",
  "lifestyle_leisure",
  "human_interest",
  "sport",
  "crime_law_justice",
  "education",
  "environment",
  "labour",
  "health",
  "automotive",
  "real_estate",
] as const;

export type V2Category = (typeof V2_CATEGORIES)[number];

export interface LatestNewsParams {
  language?: string;
  /** v2 taxonomy values, comma-joined on the wire — repeated params are read
   * first-only upstream (PROBE-FINDINGS 6c). */
  categories?: readonly string[];
  /** The ~20-item page is shared across categories; page if that proves thin. */
  pageNumber?: number;
}

export interface CurrentsClient {
  /**
   * The tier limits this client enforces.
   *
   * Exposed so callers cannot page against a different idea of the cap than the
   * client clamps to. When they disagree, a pager asks for a page past the cap and
   * gets the last page back again — twenty sightings re-ingested as new history.
   */
  readonly limits: ClientLimits;
  search(params: SearchParams, opts?: CallOpts): Promise<SearchResult>;
  /** `/v2/latest-news` — the §10.1 breadth sample's endpoint. */
  latestNews(params?: LatestNewsParams, opts?: CallOpts): Promise<SearchResult>;
  /** Name → code. Names contain typos ("Vietnamise"); always use the values. */
  availableLanguages(opts?: CallOpts): Promise<Record<string, string>>;
  /** Name → code. Names contain typos ("United State", "German"). */
  availableRegions(opts?: CallOpts): Promise<Record<string, string>>;
  availableCategories(opts?: CallOpts): Promise<string[]>;
  /** Current quota knowledge, for `/readyz` and `meta.degraded`. */
  quota(): Promise<QuotaView>;
  close(): Promise<void>;
}

/**
 * Values upstream returns in `/available/categories` that are not categories
 * (PROBE-FINDINGS 6). Filtered out of user-facing pickers only — a stored sighting
 * keeps whatever categories upstream assigned it, because dropping them would
 * make our copy differ from the source for no gain.
 */
export const JUNK_CATEGORIES: readonly string[] = ["crap", "notsure", "redundant"];

export function usefulCategories(categories: readonly string[]): string[] {
  const junk = new Set(JUNK_CATEGORIES);
  return categories.filter((category) => !junk.has(category.toLowerCase()));
}
