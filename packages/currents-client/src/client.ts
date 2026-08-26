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
  /**
   * Name → code, as upstream sends it: names contain typos ("United State",
   * "German"). `repairedRegions` spell-checks them for a picker; this returns
   * the wire values.
   */
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

/**
 * Region NAMES upstream misspells, and what to draw instead (PROBE-FINDINGS 6).
 *
 * `/available/regions` is a hand-written name→code map and four of its 79 names
 * are typed wrong. They reach the reader: the command bar's location chip is the
 * name, because "CA" says nothing to anybody (`filterChips`), so the landing page
 * has been offering "United State" and "Gahana" as places to read about.
 *
 * Keyed by CODE, which is the half of the pair that is authoritative and the half
 * this repair must not touch — §2 and this file's own rule is that codes travel
 * and names are shown, so a fix that edited names into codes would be the bug the
 * rule exists to prevent. A code upstream stops sending simply never matches.
 *
 * Only outright misspellings, and only ones the recorded body proves
 * (`fixtures/error-and-reference-bodies.json`). Upstream's short names are left
 * alone even where a longer one exists — "Bosnia" for BA is a name a reader
 * recognizes, not an error — because the line between repairing a typo and
 * rewriting a vocabulary is the only thing keeping this table small.
 *
 * Worth saying what this is NOT: nothing here drops a trailing `s`. "Philippines",
 * "Netherlands" and "United Arab Emirates" arrive from the same map with theirs
 * intact, which is how we know "United State" is a typo rather than a fold — the
 * one fold in the system that shortens words (`singular`) never runs on this data.
 */
export const REGION_NAME_FIXES: Readonly<Record<string, string>> = {
  DE: "Germany",
  GH: "Ghana",
  ID: "Indonesia",
  US: "United States",
};

/**
 * The region map with those names repaired, for user-facing pickers.
 *
 * Rebuilt rather than edited in place because the map is keyed BY NAME: repairing
 * one means MOVING its entry, and a repaired name that lands on a name already in
 * the map would silently swallow a code. So a repair is skipped when its name is
 * taken — a misspelled region is worse than no region, and one code always keeps
 * one key. No such collision exists in the recorded body; the guard is here
 * because upstream is free to fix its own typos without telling us, and the day it
 * ships "Germany" itself is the day this would otherwise drop DE.
 */
export function repairedRegions(regions: Record<string, string>): Record<string, string> {
  const taken = new Set(Object.keys(regions));
  const repaired: Record<string, string> = {};
  for (const [name, code] of Object.entries(regions)) {
    const fix = REGION_NAME_FIXES[code];
    if (fix !== undefined && !taken.has(fix)) {
      taken.add(fix);
      repaired[fix] = code;
    } else {
      repaired[name] = code;
    }
  }
  return repaired;
}
