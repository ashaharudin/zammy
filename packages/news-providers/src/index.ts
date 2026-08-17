/**
 * @zammy/news-providers — the one place that knows how many upstreams there are.
 *
 * The adapters below it each know one provider; the core below them knows none.
 * This package composes them, and it is the only layer allowed to hold both
 * names at once. `apps/api` asks it for a client and gets back something
 * satisfying the same interface a single provider satisfies.
 */
export * from "./composite.js";
export * from "./factory.js";
