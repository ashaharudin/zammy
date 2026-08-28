/**
 * @zammy/google-news-client — the only place in the system that knows the
 * Google News RSS endpoint's quirks (ARCHITECTURE 5, 5.6).
 *
 * The shared contract lives in `@zammy/news-client`; this is the third adapter
 * to satisfy it, and it satisfies `NewsClient` bare — no widening at all, since
 * the endpoint has exactly one operation. Nothing above this package learns
 * there is a new provider.
 *
 * What it is *for* is DESIGN-DISCOVERY-AND-DEEPENING's deepening plane —
 * reaching ~18 months back over arcs Currents already found, against Currents'
 * 30 days. What it is *permitted to do* is wider than that, and the difference
 * is ADR-0019's: this provider is expected to serve search and breadth as well,
 * so it is not a supplement and there is no provider ranking for it to sit at
 * the bottom of.
 *
 * ADR-0019 relocates the asymmetry rather than dropping it. Coverage becomes
 * `(subject, provider, span)`, so this client's fetches back only their own
 * spans and can never claim what another provider walked; and what may feed the
 * ranking that chooses what to deepen is decided by a fetch's **reason**, not
 * by which provider answered — `plane <> 'deepening'`, set by the caller that
 * planned the call. Neither property is this adapter's to enforce: it reports
 * honestly about the window it was asked for, and the planner supplies the rest.
 * Note that this replaces the ADR-0012 framing this package was written under.
 *
 * Everything genuinely Google-News-shaped, in one list:
 *
 *   - **No key, no ceiling, no rate-limit header.** `quota()` reports null
 *     rather than a fabricated snapshot, so the governor is never corrected by
 *     upstream and the budget in config is one we invented (`factory.ts`).
 *   - **RSS, not JSON.** Read through the transport's `parseBody` hook by a
 *     reader written for one known generator (`rss.ts`).
 *   - **Every filter is an operator inside `q`.** `after:`/`before:` for the
 *     window — resolved by Google in US Pacific time rather than UTC, measured
 *     and padded for — and `site:` for the domain (`raw.ts`).
 *   - **A category is silently discarded rather than rejected**, so it is
 *     refused locally. Measured: `topic/BUSINESS?q=housing` returns a set
 *     byte-identical to plain `search?q=housing` (`raw.ts`).
 *   - **`hl`/`gl`/`ceid` select an edition, not a subset.** They bias what comes
 *     back; they do not promise it (`raw.ts`).
 *   - **100 items per query and no cursor.** A full 100 means subdivide the
 *     window, never "finished" (`http.ts`).
 *   - **`alt_key` is the only identity it can have.** The `CBM…` link is not
 *     one, so ADR-0018's fallback key is load-bearing here rather than a bonus,
 *     and an item that cannot carry one is DROPPED (`no_identity`) rather than
 *     stored keyed on a redirect. How often the fold actually reaches the
 *     Currents twin is measured rather than assumed: **~35% of outlets and
 *     ~31% of articles do NOT fold**, because Google writes the outlet's
 *     display name and `deriveAltKey` peels it only when it collapses to the
 *     domain stem. The committed fixtures fold 110 of 120, but that corpus is
 *     one finance query and unrepresentative — the four measurements and their
 *     spread are in `fixture-client.test.ts`.
 *   - **`source_domain` from `<source url>`, not from the URL**, and a null
 *     `description`. All four departures from the other adapters are argued at
 *     their site in `normalize.ts`.
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
