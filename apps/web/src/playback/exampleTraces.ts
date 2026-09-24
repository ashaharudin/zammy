/**
 * The built-in traces the playback page opens on (ADR-0029).
 *
 * Seven hand-written `TraceReadResponse`s, one per path worth watching: a cache
 * hit, a cold search with its job runs (one of them failing and redelivered), a
 * storyline open fanning out to all three planes, a 429, a search out of Currents
 * quota, a cold instance inside the Redis handshake, and a CDN hit that runs no
 * function at all. They exist so the page is never empty — tracing is off by
 * default, and most visitors will never have a token — and so a reader can see
 * each path without spending quota to produce it.
 *
 * **An example is a claim about the code, and it is pinned like one.** The timings
 * are illustrative (every `summary` says so), but the PATH is not: each example's
 * `traceSignature` is pinned in a table that `exampleTraces.test.ts` holds these
 * files to and `apps/api/src/trace-examples.test.ts` holds real recordings of the
 * same requests to, against a real harness. An example that drifts from what the
 * server does fails a test, rather than teaching a reader a path the code no
 * longer takes. Its `mirrors` — where in the code that path is — are held to the
 * code too: each names the text its first line holds, and a test fails once it
 * does not, so a citation cannot quietly slide onto the wrong lines.
 *
 * The JSON is parsed ONCE, at module load, through `TraceReadResponse` itself:
 * drift between these files and the wire contract fails loudly — the chunk throws
 * on import and every test that touches it goes red — instead of reaching the
 * renderer as a half-shaped object. The files live in this chunk only; the main
 * chunk never sees them (`playbackRoute.ts` passes slugs through unchecked for
 * exactly that reason).
 *
 * Deliberately not done here: synthesizing examples from the live environment. An
 * example's `origin.environment` is the production configuration it depicts (the
 * Vercel queue, live Currents and Google News, summaries and the labeler on, GNews
 * off), not the one the page happens to be served from.
 */
import { z } from "zod";
import { TraceReadResponse } from "@zammy/shared/request-trace";
import cacheHit from "./examples/cache-hit.json";
import coldInstance from "./examples/cold-instance.json";
import coldSearch from "./examples/cold-search.json";
import edgeHit from "./examples/edge-hit.json";
import quotaDegraded from "./examples/quota-degraded.json";
import rateLimited from "./examples/rate-limited.json";
import storylineOpen from "./examples/storyline-open.json";

/** Every example, in the order the page offers them; the first is the default. */
export const EXAMPLE_SLUGS = [
  "cold-search",
  "cache-hit",
  "storyline-open",
  "rate-limited",
  "quota-degraded",
  "cold-instance",
  "edge-hit",
] as const;
export type ExampleSlug = (typeof EXAMPLE_SLUGS)[number];

/**
 * One citation of the code an example depicts. `at` is `path:first-last`, from
 * the repo root; `begins` is text line `first` holds, which is what keeps the
 * citation honest: a line number alone drifts silently with every edit above it
 * (this file's first citations did, the day they were written), and
 * `exampleTraces.test.ts` fails once line `first` no longer holds `begins`.
 */
export interface Mirror {
  at: string;
  begins: string;
}

/** One built-in trace, with what the page says about it and where in the code it comes from. */
export interface ExampleTrace {
  slug: ExampleSlug;
  /** A short name for the example picker. */
  title: string;
  /** One or two sentences; always says the timings are illustrative. */
  summary: string;
  /** The code path the example depicts. */
  mirrors: readonly Mirror[];
  response: TraceReadResponse;
}

/** `path:first-last`: a repo-relative path, then a 1-based inclusive line range. */
export const MIRROR_AT = /^([\w./-]+):(\d+)-(\d+)$/;

/**
 * The file shape. Not `.strict()`, like every schema in this repo: an extra key in
 * a file is dropped rather than fatal, and the part that matters — `response` —
 * is the wire contract itself, so it cannot drift silently.
 */
const ExampleFile = z.object({
  slug: z.enum(EXAMPLE_SLUGS),
  title: z.string().min(1),
  summary: z.string().min(1),
  mirrors: z.array(z.object({ at: z.string().regex(MIRROR_AT), begins: z.string().min(1) })).min(1),
  response: TraceReadResponse,
});

const FILES: Readonly<Record<ExampleSlug, unknown>> = {
  "cold-search": coldSearch,
  "cache-hit": cacheHit,
  "storyline-open": storylineOpen,
  "rate-limited": rateLimited,
  "quota-degraded": quotaDegraded,
  "cold-instance": coldInstance,
  "edge-hit": edgeHit,
};

/**
 * The seven examples, parsed, in `EXAMPLE_SLUGS` order.
 *
 * A file whose own `slug` disagrees with the name it is registered under throws
 * too: the slug is what the URL carries (`/?trace=<slug>`), so a copy-pasted file
 * answering to the wrong name would open the wrong trace from a correct link.
 */
export const EXAMPLE_TRACES: readonly ExampleTrace[] = EXAMPLE_SLUGS.map((slug) => {
  const parsed = ExampleFile.parse(FILES[slug]);
  if (parsed.slug !== slug) {
    throw new Error(`examples/${slug}.json declares slug "${parsed.slug}"`);
  }
  return parsed;
});

/** The example a slug names, or undefined (the page falls back to the default, with a notice). */
export function exampleBySlug(slug: string): ExampleTrace | undefined {
  return EXAMPLE_TRACES.find((example) => example.slug === slug);
}
