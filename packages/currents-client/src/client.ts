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
  /**
   * Name → code, as upstream sends it: names contain typos ("Vietnamise"), so
   * always use the values. `repairedLanguages` spell-checks them for a picker.
   */
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
 * Reference NAMES upstream misspells, and what to draw instead (PROBE-FINDINGS 6).
 *
 * `/available/regions` and `/available/languages` are hand-written name→code maps
 * and five of their names are typed wrong — four of 79 regions, one of 23
 * languages. They reach the reader: a picker draws the NAME, because "CA" says
 * nothing to anybody (`filterChips`), so the command bar has been offering
 * "United State" and "Gahana" as places to read about and "Vietnamise" as a
 * language to read them in.
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
 * rewriting a vocabulary is the only thing keeping these tables small. So is
 * "Saudi-Arabia", which is punctuated oddly rather than spelled wrong.
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
 * One entry, and `de` is deliberately not in it: "German" is the correct name of
 * the LANGUAGE, and only wrong as the name of the country DE. Two maps, two
 * tables, and the same word right in one and wrong in the other is exactly why
 * they are keyed by code rather than matched by string.
 */
export const LANGUAGE_NAME_FIXES: Readonly<Record<string, string>> = {
  vi: "Vietnamese",
};

/** The region map with its names repaired, for user-facing pickers. */
export function repairedRegions(regions: Record<string, string>): Record<string, string> {
  return repairedNames(regions, REGION_NAME_FIXES);
}

/** The language map with its names repaired, for user-facing pickers. */
export function repairedLanguages(languages: Record<string, string>): Record<string, string> {
  return repairedNames(languages, LANGUAGE_NAME_FIXES);
}

/**
 * A name→code map with the misspelled names replaced.
 *
 * Rebuilt rather than edited in place because the map is keyed BY NAME: repairing
 * one means MOVING its entry, and a repaired name that lands on a name already in
 * the map would silently swallow a code. So a repair is skipped when its name is
 * taken — a misspelled region is worse than no region, and one code always keeps
 * one key. No such collision exists in the recorded bodies; the guard is here
 * because upstream is free to fix its own typos without telling us, and the day it
 * ships "Germany" itself is the day this would otherwise drop DE.
 *
 * A `Map` and `Object.hasOwn`, rather than the plain object and `fixes[code]` this
 * started as, because both halves of that reach the prototype and this map arrives
 * from `JSON.parse` on a body we do not control. A key of `__proto__` is an own
 * property coming out of the parser and a silent no-op going into an object
 * literal, so the entry would vanish; a CODE of `toString` would find a function
 * on the fixes table, pass an `!== undefined` guard, and key the output by its
 * source text. Neither is reachable through two-letter region codes — this is the
 * file whose job is absorbing upstream's shapes, and the guards cost nothing.
 */
function repairedNames(
  byName: Record<string, string>,
  fixes: Readonly<Record<string, string>>,
): Record<string, string> {
  const taken = new Set(Object.keys(byName));
  const repaired = new Map<string, string>();
  for (const [name, code] of Object.entries(byName)) {
    const fix = Object.hasOwn(fixes, code) ? fixes[code]! : undefined;
    if (fix !== undefined && !taken.has(fix)) {
      taken.add(fix);
      repaired.set(fix, code);
    } else {
      repaired.set(name, code);
    }
  }
  return Object.fromEntries(repaired);
}
