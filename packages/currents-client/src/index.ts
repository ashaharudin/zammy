/**
 * @zammy/currents-client — the only place in the system that knows the Currents
 * API's quirks (ARCHITECTURE 5).
 *
 * What is *shared* with every other provider — the `Sighting` shape, the error
 * taxonomy, URL canonicalization, quota governance, the breaker, the retrying
 * transport, the pager — lives in `@zammy/news-client` and is re-exported here
 * so existing importers keep one import site.
 *
 * What is left is genuinely Currents: the `{status, news[]}` envelope, the
 * `"2026-08-04 20:45:56 +0000"` timestamps, the "None" images, the `url`/`urls`
 * split, the `x-ratelimit-*` headers, the Cloudflare 403, the two API versions,
 * and the v2 latest-news taxonomy.
 *
 * Two implementations satisfy one interface — live HTTP and fixture-backed — so
 * nothing above this package branches on `CURRENTS_MODE`.
 */
export * from "@zammy/news-client";

export * from "./raw.js";
export * from "./normalize.js";
export * from "./quota-headers.js";
export * from "./map-error.js";
export * from "./client.js";
export * from "./http.js";
export * from "./fixture-store.js";
export * from "./fixture-client.js";
export * from "./factory.js";
