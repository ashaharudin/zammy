import { createHash } from "node:crypto";

/**
 * Request → canonical query → fingerprint (ARCHITECTURE 6.2).
 *
 * Every request reduces to a canonical form before anything else touches it, so
 * trivially-different requests reuse the same cache entry and the same
 * accumulating topic. Pure: reference data, defaults and the clock all arrive
 * as arguments.
 */

/**
 * Hard cap on keyword terms. Upstream ANDs terms together (PROBE-FINDINGS 5),
 * so beyond a handful every additional term mostly guarantees zero results;
 * eight is generous. Exceeding it is a 400, never a silent truncation — a
 * truncated query would fingerprint as something the user did not type.
 */
const MAX_KEYWORD_TERMS = 8;

/**
 * Cache-key alignment grid for the window (§6.2 step 4).
 *
 * Exported because it is not only a cache-key grid any more: a background
 * refresh whose span reaches `now` has to land on the same grid or its job's
 * content address moves every millisecond and the queue's dedup stops working
 * (`queueStorylineRefresh`). Same grid, one definition — two grids a quarter of
 * an hour apart would be worse than either.
 */
export const WINDOW_SNAP_MS = 15 * 60 * 1000;

export interface TimelineRequestInput {
  /** Raw keyword input. */
  q: string;
  /** Reference code, or the literal "all" to search every language. */
  language?: string | undefined;
  country?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

/**
 * The `/available/*` VALUE sets — codes, never names (PROBE-FINDINGS 6).
 *
 * No categories: a reader cannot choose one any more (ADR-0020), so there is
 * nothing left to validate a category against.
 */
export interface ReferenceCodes {
  languages: ReadonlySet<string>;
  regions: ReadonlySet<string>;
}

export interface CanonicalizeOptions {
  reference: ReferenceCodes;
  /**
   * Applied when the request omits language. Omitting it upstream returns
   * every language mixed together, so "all" is an explicit choice ("all"),
   * never the accident of leaving a field unset (§6.1).
   */
  defaultLanguage: string;
  /** Bounds the default window; the fetch-time clamp happens in planning. */
  lookbackDays: number;
  now: Date;
}

export interface CanonicalQuery {
  /** sha256 hex of the canonical identity — keywords + filters, NO window. */
  fingerprint: string;
  /** Casefolded, NFKC-normalized, deduplicated, sorted. */
  keywords: string[];
  /** null = all languages, chosen explicitly. */
  language: string | null;
  country: string | null;
  /**
   * Always null out of `canonicalize` (ADR-0020): no request can set one.
   *
   * The field stays because a topic MINTED before that decision still carries a
   * category, and `processSegmentJob` rebuilds a query from the stored row —
   * so a queued segment for one of those 29 topics still fetches the thing the
   * topic says it is, rather than quietly widening to an unfiltered search
   * whose results would then be ingested under a category-scoped fingerprint.
   */
  category: string | null;
  /** Snapped outward to the 15-minute grid. A view onto the topic, not identity. */
  window: { from: Date; to: Date };
}

export type CanonicalizeResult =
  | { ok: true; query: CanonicalQuery }
  | { ok: false; errors: Record<string, string> };

export function canonicalize(
  input: TimelineRequestInput,
  options: CanonicalizeOptions,
): CanonicalizeResult {
  const errors: Record<string, string> = {};

  const keywords = canonicalKeywords(input.q);

  if (keywords.length === 0) {
    errors.q = "keywords are required";
  } else if (keywords.length > MAX_KEYWORD_TERMS) {
    errors.q =
      `too many terms (${keywords.length}; max ${MAX_KEYWORD_TERMS}). ` +
      "Terms narrow results — every term must match.";
  }

  let language: string | null;
  if (input.language === undefined) {
    language = options.defaultLanguage;
  } else if (input.language === "all") {
    language = null;
  } else if (options.reference.languages.has(input.language)) {
    language = input.language;
  } else {
    language = null;
    errors.language = `unknown language "${input.language}"`;
  }

  const country = input.country ?? null;
  if (country !== null && !options.reference.regions.has(country)) {
    errors.country = `unknown country "${country}"`;
  }

  // No category is read, and that is the whole of how a bookmarked
  // `?category=technology` degrades (ADR-0020): the parameter is already gone
  // by the time it reaches here — `TimelineQuery` no longer names it, so Zod
  // strips it — and this function has no field to reject it with. The URL
  // answers as the same search without the filter, which is the outcome the
  // decision requires; a 400 would be a worse failure than the filter it
  // replaces.

  // Outward snap: floor the start, ceil the end. The snap may widen the ask,
  // never narrow it — a narrowed window would silently hide articles the user
  // explicitly requested.
  const to = new Date(
    Math.ceil((input.to ?? options.now).getTime() / WINDOW_SNAP_MS) * WINDOW_SNAP_MS,
  );
  const defaultFrom = options.now.getTime() - options.lookbackDays * 86_400_000;
  const from = new Date(
    Math.floor((input.from?.getTime() ?? defaultFrom) / WINDOW_SNAP_MS) * WINDOW_SNAP_MS,
  );
  if (from.getTime() >= to.getTime()) {
    errors.from = "from must be earlier than to";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    query: {
      fingerprint: fingerprintOf({ keywords, language, country, category: null }),
      keywords,
      language,
      country,
      category: null,
      window: { from, to },
    },
  };
}

/**
 * A query string reduced to the term SET a topic is identified by: NFKC, lower
 * case, split on whitespace, de-duplicated, sorted.
 *
 * Exported so the deepening plane can mint the same identity for an arc's label
 * without going through the route's validation — it has no reader's chips to
 * validate and no 400 to return. One definition rather than two, for the reason
 * `fingerprintOf` states one line down: the serialization is shared by every
 * stored topic, and two normalizations that drifted would file the same words
 * under two fingerprints.
 */
export function canonicalKeywords(q: string): string[] {
  return [
    ...new Set(
      q
        .normalize("NFKC")
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length > 0),
    ),
  ].sort();
}

/**
 * The topic identity. The serialization is pinned by a test on purpose: it is
 * shared by every replica and every stored topic, so a key reorder or a new
 * field silently orphans all existing topics. Change it only with a migration
 * story for `topics.fingerprint`.
 *
 * Exported for the §10.1 breadth sample, whose keyword-less per-category
 * fetches are ordinary topics — same identity, same storage, same dedup.
 *
 * **`category` stays in the serialization after ADR-0020 even though nothing
 * can produce a non-null one any more.** It is not a vestige: dropping the key
 * would re-identify the 29 category-scoped topics already stored — their
 * accumulated coverage and 393 article memberships would sit under a
 * fingerprint nothing ever computes again, orphaned and still holding rows.
 * Retiring a reader's CHOICE costs nothing here; retiring the key would cost
 * exactly that, for no gain a reader could see.
 */
export function fingerprintOf(identity: {
  keywords: string[];
  language: string | null;
  country: string | null;
  category: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        category: identity.category,
        country: identity.country,
        keywords: identity.keywords,
        language: identity.language,
      }),
    )
    .digest("hex");
}
