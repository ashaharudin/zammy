/**
 * @zammy/currents-client — the only place in the system that knows the upstream's
 * quirks (ARCHITECTURE 5).
 *
 * Phase 1 completes the component: normalization at the boundary, a mandatory
 * explicit User-Agent, the typed error taxonomy, header-driven quota governance,
 * retries with a circuit breaker, and paging with honest truncation reporting.
 *
 * Two implementations satisfy one interface — live HTTP and fixture-backed — so
 * nothing above this package branches on `CURRENTS_MODE`.
 */
export * from "./errors.js";
export * from "./raw.js";
export * from "./sighting.js";
export * from "./normalize.js";
export * from "./quota.js";
export * from "./breaker.js";
export * from "./map-error.js";
export * from "./client.js";
export * from "./http.js";
export * from "./fixture-store.js";
export * from "./fixture-client.js";
export * from "./paging.js";
export * from "./factory.js";
