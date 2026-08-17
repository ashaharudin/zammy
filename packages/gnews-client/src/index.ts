/**
 * @zammy/gnews-client — the only place in the system that knows the GNews v4
 * API's quirks (ARCHITECTURE 5, 5.6).
 *
 * The shared contract lives in `@zammy/news-client`; this package is the second
 * proof that the seam holds. Adding it required no change to §6–§8: the Query
 * Service still plans in `SearchParams`, still receives `Sighting[]`, and still
 * never learns which upstream answered.
 *
 * What is genuinely GNews:
 *
 *   - `X-Api-Key` auth and a `{totalArticles, articles[]}` envelope.
 *   - Real ISO-8601 timestamps, and no `"None"` images.
 *   - No rate-limit headers, and a 403 that means "daily quota spent" rather
 *     than "blocked" — the difference the shared error taxonomy exists for.
 *   - No categories on an article and no category filter on `/search`, so
 *     category-filtered searches are refused locally rather than answered
 *     unfiltered.
 */
export * from "./raw.js";
export * from "./normalize.js";
export * from "./map-error.js";
export * from "./client.js";
export * from "./http.js";
export * from "./fixture-store.js";
export * from "./fixture-client.js";
export * from "./factory.js";
