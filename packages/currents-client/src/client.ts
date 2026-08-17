import type { CallOpts, NewsClient, SearchResult } from "@zammy/news-client";

/**
 * What Currents can do that every provider cannot (ARCHITECTURE 5.1).
 *
 * The provider-agnostic contract — `search`, `limits`, `quota`, `close` — is
 * `NewsClient` in `@zammy/news-client`, and that is what the Query Service plans
 * against. This interface adds the endpoints only Currents has: the v2
 * latest-news feed behind the §10.1 breadth sample, and the reference lists that
 * populate the search form's language, region and category pickers.
 *
 * Kept as an extension rather than pushed into the shared contract on purpose. A
 * capability one provider lacks does not belong on an interface every provider
 * must satisfy, and a `NewsClient` with four methods that throw is a worse lie
 * than a narrower one that does not.
 */

/**
 * The `/v2/latest-news` category taxonomy, verbatim from the recorded 400 body
 * (PROBE-FINDINGS 6c, `fixtures/latest-news-v2-sample.json`). Disjoint from
 * `/v1/available/categories` — v1 names like "technology" are v2 400s, so the
 * reference lists must never be used to validate these. Disjoint again from
 * GNews's nine top-headline categories, which is why neither taxonomy is
 * promoted to the shared contract.
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

export interface CurrentsClient extends NewsClient {
  /** `/v2/latest-news` — the §10.1 breadth sample's endpoint. */
  latestNews(params?: LatestNewsParams, opts?: CallOpts): Promise<SearchResult>;
  /** Name → code. Names contain typos ("Vietnamise"); always use the values. */
  availableLanguages(opts?: CallOpts): Promise<Record<string, string>>;
  /** Name → code. Names contain typos ("United State", "German"). */
  availableRegions(opts?: CallOpts): Promise<Record<string, string>>;
  availableCategories(opts?: CallOpts): Promise<string[]>;
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
