/**
 * @zammy/google-news-client — the only place in the system that knows the
 * Google News RSS endpoint's quirks (ARCHITECTURE 5, 5.6).
 *
 * The shared contract lives in `@zammy/news-client`; this is the third adapter
 * to satisfy it, and it satisfies `NewsClient` bare — no widening at all, since
 * the endpoint has exactly one operation. Nothing above this package learns
 * there is a new provider.
 *
 * It is the **deepening plane** of DESIGN-DISCOVERY-AND-DEEPENING: Currents
 * discovers and stays coverage-bearing, this reaches back over arcs Currents
 * already found. That asymmetry is ADR-0012's, and it is stricter here than it
 * was for GNews — this provider is not a peer to be merged, it is a second
 * stage in a pipeline.
 *
 * Everything genuinely Google-News-shaped, in one list:
 *
 *   - **No key, no ceiling, no rate-limit header.** `quota()` reports null
 *     rather than a fabricated snapshot, so the governor is never corrected by
 *     upstream and the budget in config is one we invented (`factory.ts`).
 *   - **RSS, not JSON.** Read through the transport's `parseBody` hook by a
 *     reader written for one known generator (`rss.ts`).
 *   - **`after:`/`before:` instead of date parameters**, resolved by Google in
 *     US Pacific time rather than UTC — measured, and padded for (`raw.ts`).
 *   - **100 items per query and no cursor.** A full 100 means subdivide the
 *     window, never "finished" (`http.ts`).
 *   - **`source_domain` from `<source url>`, not from the URL**, and a null
 *     `description`. The two deliberate departures from the other adapters, both
 *     argued at their site in `normalize.ts`.
 *   - **A 403 is a block, never an auth failure**, because there is no
 *     credential to fail (`map-error.ts`).
 *
 * Two things this adapter deliberately does NOT do, both of which look like
 * omissions until you read why:
 *
 *   - It does not resolve the `CBM…` redirect. Probed: it does not HTTP
 *     redirect, it returns a ~602KB JavaScript interstitial in which the
 *     publisher's name appears zero times. Resolution needs a headless browser
 *     or the reverse-engineered `batchexecute` RPC, per article, at 100
 *     articles a slice. `alt_key` (G1) is the design's answer instead.
 *   - It does not strip the trailing ` - Outlet` from titles, though 100 of 101
 *     carry one and it is the single most damaging thing about this feed. That
 *     strip is shared-tokenizer work and costs a `TOKENIZER_VERSION` bump plus
 *     a repair run: it is G0, not this.
 *
 * **Off by default** (`GOOGLE_NEWS_ENABLED`), and unreachable while it is —
 * `createGoogleNewsClient` refuses to build anything. See `factory.ts` for the
 * two guards that have to land before it can be switched on.
 *
 * **One thing to read before switching it on that is not a technical concern.**
 * The feed's own `<copyright>` element names it as being for "personal,
 * non-commercial use" and says any other use is "expressly prohibited". That is
 * in the payload, not in a terms page — the same shape as CBC's "FOR PERSONAL
 * USE ONLY" (RESEARCH-FREE-NEWS-SOURCES §5), and it is preserved verbatim in
 * both committed fixtures.
 */
export * from "./rss.js";
export * from "./raw.js";
export * from "./normalize.js";
export * from "./map-error.js";
export * from "./client.js";
export * from "./http.js";
export * from "./fixture-store.js";
export * from "./fixture-client.js";
export * from "./factory.js";
