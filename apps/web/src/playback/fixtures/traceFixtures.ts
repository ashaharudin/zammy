import { z } from "zod";
import { TraceReadResponse } from "@zammy/shared/request-trace";
import cacheHit from "./cache-hit.json";
import coldInstance from "./cold-instance.json";
import coldSearch from "./cold-search.json";
import edgeHit from "./edge-hit.json";
import quotaDegraded from "./quota-degraded.json";
import rateLimited from "./rate-limited.json";
import storylineOpen from "./storyline-open.json";

/**
 * Hand-written traces the playback tests drive the choreography, the frames, the drawing and
 * the words with — TEST FIXTURES ONLY. Nothing the page ships imports this module, so none of
 * it reaches a bundle.
 *
 * They were the page's built-in examples under ADR-0029; ADR-0031 took the examples off the
 * page, which now plays only what the API recorded. One per path worth rendering: a cache hit,
 * a cold search with its job runs (one of them failing and redelivered), a storyline open
 * fanning out to all three planes, a 429, a search out of Currents quota, a cold instance
 * inside the Redis handshake, and a CDN hit that runs no function. Their timings are
 * illustrative.
 *
 * Parsed once, at import, through `TraceReadResponse` itself: drift between these files and the
 * wire contract fails every test that touches them. Each file's extra keys (`title`, `summary`,
 * `mirrors`, from when they were shown to readers) are stripped by the parse.
 */
export const FIXTURE_SLUGS = [
  "cold-search",
  "cache-hit",
  "storyline-open",
  "rate-limited",
  "quota-degraded",
  "cold-instance",
  "edge-hit",
] as const;
export type FixtureSlug = (typeof FIXTURE_SLUGS)[number];

export interface TraceFixture {
  slug: FixtureSlug;
  response: TraceReadResponse;
}

const FixtureFile = z.object({ slug: z.enum(FIXTURE_SLUGS), response: TraceReadResponse });

const FILES: Readonly<Record<FixtureSlug, unknown>> = {
  "cold-search": coldSearch,
  "cache-hit": cacheHit,
  "storyline-open": storylineOpen,
  "rate-limited": rateLimited,
  "quota-degraded": quotaDegraded,
  "cold-instance": coldInstance,
  "edge-hit": edgeHit,
};

/** Every fixture, parsed, in `FIXTURE_SLUGS` order. */
export const TRACE_FIXTURES: readonly TraceFixture[] = FIXTURE_SLUGS.map((slug) => {
  const parsed = FixtureFile.parse(FILES[slug]);
  if (parsed.slug !== slug) throw new Error(`fixtures/${slug}.json declares slug "${parsed.slug}"`);
  return parsed;
});

/** The fixture a slug names, or undefined. */
export function traceFixture(slug: string): TraceFixture | undefined {
  return TRACE_FIXTURES.find((fixture) => fixture.slug === slug);
}
