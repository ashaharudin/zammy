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
  category?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

/** The `/available/*` VALUE sets — codes, never names (PROBE-FINDINGS 6). */
export interface ReferenceCodes {
  languages: ReadonlySet<string>;
  regions: ReadonlySet<string>;
  categories: ReadonlySet<string>;
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

  const keywords = [
    ...new Set(
      input.q
        .normalize("NFKC")
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length > 0),
    ),
  ].sort();

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

  const category = input.category ?? null;
  if (category !== null && !options.reference.categories.has(category)) {
    errors.category = `unknown category "${category}"`;
  }

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
      fingerprint: fingerprintOf({ keywords, language, country, category }),
      keywords,
      language,
      country,
      category,
      window: { from, to },
    },
  };
}

/**
 * The topic identity. The serialization is pinned by a test on purpose: it is
 * shared by every replica and every stored topic, so a key reorder or a new
 * field silently orphans all existing topics. Change it only with a migration
 * story for `topics.fingerprint`.
 *
 * Exported for the §10.1 breadth sample, whose keyword-less per-category
 * fetches are ordinary topics — same identity, same storage, same dedup.
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
