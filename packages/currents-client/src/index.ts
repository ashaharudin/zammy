/**
 * @zammy/currents-client — the only place in the system that knows the upstream's quirks.
 *
 * Phase 0 delivers the contract surface: the error taxonomy, the raw wire shapes,
 * query construction, and the fixture-backed offline store. The live HTTP client
 * — normalization, retries, circuit breaker, header-driven quota governance —
 * lands in Phase 1 (ARCHITECTURE 13).
 */
export * from "./errors.js";
export * from "./raw.js";
export * from "./fixture-store.js";
