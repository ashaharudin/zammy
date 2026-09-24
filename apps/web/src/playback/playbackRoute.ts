/**
 * Where the playback view lives in the URL (ADR-0029, as amended by ADR-0031).
 *
 * The page is `/?trace` — a query parameter on the statically served root, not a
 * path of its own, because production has no SPA fallback: `/replay` is a 404 at
 * the edge, and a rewrite for it would fail the rewrite-destination test in
 * `cron-routes.test.ts`. `/` is served from `index.html` whatever its query, so a
 * parameter needs no `vercel.json` change at all, and its canonical is already `/`.
 *
 *   /?trace              → the newest recorded trace, from `GET /api/v1/traces`
 *   /?trace#t=<uuid>     → a recorded trace, read from `GET /api/v1/traces/:id`
 *
 * Any value on `trace` (`/?trace=cache-hit`, a link from when the page had built-in
 * examples) reads as the bare parameter: the examples are gone (ADR-0031).
 *
 * The recorded id travels in the FRAGMENT, never the query: a fragment is not sent
 * with the page's own request, so the id stays out of that request's query
 * string, the static file's CDN cache key and its log. It is no secret — since
 * ADR-0031 the recent list hands the newest ids to anyone — but a page URL is
 * copied and indexed in places an API path is not. It is not secret from the platform: every read the page
 * makes carries it in the read route's PATH, through the edge to the function and
 * its request log.
 *
 * **This module imports nothing**, not even a type, and that is its whole reason
 * for being a module: `App.tsx` reads it at load to decide whether to fetch the
 * lazy playback chunk at all, so it lands in the reader's MAIN chunk. Importing
 * `@zammy/shared/request-trace` for `TRACE_ID_PATTERN` would drag zod's trace
 * schemas in with it, so the pattern is repeated below as a string and a test pins
 * the two equal instead.
 */

/** The query parameter whose presence means "show the playback view". */
export const TRACE_PARAM = "trace";

/**
 * Must equal `TRACE_ID_PATTERN.source` in `@zammy/shared/request-trace` — pinned by
 * `playbackRoute.test.ts`, and not imported, to keep zod out of the main chunk.
 * `crypto.randomUUID()` output: lowercase, version 4, RFC 4122 variant.
 */
export const TRACE_ID_SOURCE =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const TRACE_ID = new RegExp(TRACE_ID_SOURCE);

/** The key inside the fragment that carries a recorded trace's id: `#t=<uuid>`. */
const FRAGMENT_KEY = "t";

/**
 * What the playback page should show: one recorded trace, or `latest` — the newest the
 * recent list offers, once it has been read.
 *
 * `notice: "bad_id"` rides on `latest` when the URL named a recorded trace by
 * something that is not a trace id — the page says so instead of silently showing
 * a trace the reader did not ask for.
 */
export type PlaybackTarget = { kind: "latest"; notice?: "bad_id" } | { kind: "recorded"; id: string };

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
 *  1. a fragment `#t=<id>` holding a valid trace id → that recorded trace;
 *  2. a fragment `#t=…` holding anything else → the newest, noticed;
 *  3. otherwise, whatever `trace`'s value → the newest.
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
      : { kind: "latest", notice: "bad_id" };
  }
  return { kind: "latest" };
}

/**
 * The URL a target lives at: `/?trace` or `/?trace#t=<id>`.
 *
 * A notice is not part of the URL — it describes how the reader arrived, and a
 * copied link should open on the trace itself, not on a complaint about the
 * link it replaced. `parsePlaybackLocation(playbackHref(t))` gives `t` back for
 * every target without one.
 */
export function playbackHref(target: PlaybackTarget): string {
  if (target.kind === "recorded") {
    return `/?${TRACE_PARAM}#${FRAGMENT_KEY}=${encodeURIComponent(target.id)}`;
  }
  return `/?${TRACE_PARAM}`;
}
