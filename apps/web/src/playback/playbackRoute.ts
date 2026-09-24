/**
 * Where the playback view lives in the URL (ADR-0029).
 *
 * The page is `/?trace` — a query parameter on the statically served root, not a
 * path of its own, because production has no SPA fallback: `/replay` is a 404 at
 * the edge, and a rewrite for it would fail the rewrite-destination test in
 * `cron-routes.test.ts`. `/` is served from `index.html` whatever its query, so a
 * parameter needs no `vercel.json` change at all, and its canonical is already `/`.
 *
 *   /?trace              → the default built-in example (`cold-search`)
 *   /?trace=<slug>       → a named example
 *   /?trace#t=<uuid>     → a recorded trace, read from `GET /api/v1/traces/:id`
 *
 * The recorded id travels in the FRAGMENT, never the query: a fragment is not sent
 * with the page's own request, so the id — a read capability for one TTL, an hour
 * by default — stays out of that request's query string, the static file's CDN
 * cache key and its log. It is not secret from the platform: every read the page
 * makes carries it in the read route's PATH, through the edge to the function and
 * its request log.
 *
 * **This module imports nothing**, not even a type, and that is its whole reason
 * for being a module: `App.tsx` reads it at load to decide whether to fetch the
 * lazy playback chunk at all, so it lands in the reader's MAIN chunk. Importing
 * `@zammy/shared/request-trace` for `TRACE_ID_PATTERN` would drag zod's trace
 * schemas in with it, so the pattern is repeated below as a string and a test pins
 * the two equal instead.
 *
 * Deliberately not done here: deciding whether a slug names a real example. The
 * example list lives in the lazy chunk (it is parsed JSON), so an unknown slug is
 * passed through and the page resolves it — falling back to the default with a
 * notice — rather than this module growing a copy of the list.
 */

/** The query parameter whose presence means "show the playback view". */
export const TRACE_PARAM = "trace";

/** The example `/?trace` opens on: the one that shows every station a search can reach. */
export const DEFAULT_EXAMPLE_SLUG = "cold-search";

/**
 * Must equal `TRACE_ID_PATTERN.source` in `@zammy/shared/request-trace` — pinned by
 * `playbackRoute.test.ts`, and not imported, to keep zod out of the main chunk.
 * `crypto.randomUUID()` output: lowercase, version 4, RFC 4122 variant.
 */
export const TRACE_ID_SOURCE =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

/** The shape an example slug may take in the URL. Anything else reads as the default. */
const SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;
const TRACE_ID = new RegExp(TRACE_ID_SOURCE);

/** The key inside the fragment that carries a recorded trace's id: `#t=<uuid>`. */
const FRAGMENT_KEY = "t";

/**
 * What the playback page should show.
 *
 * `notice: "bad_id"` rides on the default example when the URL named a recorded
 * trace by something that is not a trace id — the page says so instead of silently
 * showing an example the reader did not ask for.
 */
export type PlaybackTarget =
  | { kind: "example"; slug: string; notice?: "bad_id" }
  | { kind: "recorded"; id: string };

/** Whether `value` is a trace id exactly as the API mints them (lowercase v4). */
export function isTraceId(value: string): boolean {
  return TRACE_ID.test(value);
}

/**
 * The playback target a location names, or null when it is not the playback view.
 *
 * Null unless the path is exactly `/` and `trace` is present in the query: `/?q=x`
 * is a search, and `/storyline/<uuid>/<slug>?trace` is still a storyline (the
 * storyline route owns every path it matches, and `?trace` on it means nothing).
 *
 * Then, in order:
 *  1. a fragment `#t=<id>` holding a valid trace id → that recorded trace, whatever
 *     the query's slug says (the id is the more specific ask);
 *  2. a fragment `#t=…` holding anything else → the default example, noticed;
 *  3. the `trace` value, when it is slug-shaped → that example;
 *  4. otherwise (`/?trace`, `/?trace=`, `/?trace=Not A Slug`) → the default example.
 *
 * A fragment without a `t` key is ignored rather than treated as a bad id: another
 * script's anchor is not a trace the reader asked for.
 */
export function parsePlaybackLocation(
  pathname: string,
  search: string,
  hash: string,
): PlaybackTarget | null {
  if (pathname !== "/") return null;
  const query = new URLSearchParams(search);
  if (!query.has(TRACE_PARAM)) return null;

  const fragment = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const id = fragment.get(FRAGMENT_KEY);
  if (id !== null) {
    return isTraceId(id)
      ? { kind: "recorded", id }
      : { kind: "example", slug: DEFAULT_EXAMPLE_SLUG, notice: "bad_id" };
  }

  const slug = query.get(TRACE_PARAM) ?? "";
  return { kind: "example", slug: SLUG_PATTERN.test(slug) ? slug : DEFAULT_EXAMPLE_SLUG };
}

/**
 * The URL a target lives at: `/?trace=<slug>` or `/?trace#t=<id>`.
 *
 * A notice is not part of the URL — it describes how the reader arrived, and a
 * copied link should open on the example itself, not on a complaint about the
 * link it replaced. `parsePlaybackLocation(playbackHref(t))` gives `t` back for
 * every target without one.
 */
export function playbackHref(target: PlaybackTarget): string {
  if (target.kind === "recorded") {
    return `/?${TRACE_PARAM}#${FRAGMENT_KEY}=${encodeURIComponent(target.id)}`;
  }
  return `/?${TRACE_PARAM}=${encodeURIComponent(target.slug)}`;
}
