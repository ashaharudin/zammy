/**
 * @zammy/news-client — everything about talking to a news provider that is not
 * about talking to a *particular* news provider.
 *
 * ARCHITECTURE 5 puts all upstream quirks in one component. With two upstreams
 * that splits in two: the quirks live in the adapters (`@zammy/currents-client`,
 * `@zammy/gnews-client`) and the contract they satisfy lives here — the
 * `Sighting` shape, the error taxonomy, URL canonicalization and the dedup key,
 * quota governance, the circuit breaker, pre-flight clamping, the retrying HTTP
 * transport, and the pager.
 *
 * This package must never learn a provider's name outside a comment. The moment
 * it does, ARCHITECTURE 5.6's promise — that a new provider is a new adapter and
 * nothing else — stops being true.
 */
export * from "./errors.js";
export * from "./sighting.js";
export * from "./normalize.js";
export * from "./search-params.js";
export * from "./quota.js";
export * from "./breaker.js";
export * from "./client.js";
export * from "./transport.js";
export * from "./paging.js";
