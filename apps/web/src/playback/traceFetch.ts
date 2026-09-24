/**
 * The playback view's wire half (ADR-0029, "The change", items 5 and 7):
 * reading a stored trace back, and RECORDING a new one — making one real API
 * request with the opt-in header and reading what its response headers say
 * became of it.
 *
 * Two routes, two postures, on purpose:
 *
 *  - The READ (`GET /api/v1/traces/:id`) carries no token. The 122-bit id is
 *    the capability, the record behind it is enums and numbers, and a read
 *    that needed the token would put the token in every poll, every new tab a
 *    `#t=` link opens, and the query cache. So `fetchTrace` never sees it.
 *  - The RECORD run carries the token in `x-zammy-trace` and NOWHERE ELSE. Not
 *    in the URL — a URL lands in the CDN's logs, the function log's request
 *    line, the browser's history and any `Referer` — and not in storage: the
 *    token lives in the record panel's component state for the length of one
 *    visit (`RecordPanel.tsx`), and this module only ever holds it for the length
 *    of one `fetch`. `recordTarget` never receives the token at all, which is
 *    what lets its test say "no URL contains it" about every kind at once.
 *
 * A record run reads HEADERS, never the body. A traced response's body is
 * byte-identical to an untraced one (ADR-0029, item 5), so the body says nothing about
 * the trace, and the page plays back what the request touched rather than what
 * it answered. The body is cancelled rather than drained.
 *
 * Deliberately NOT here:
 *  - No retry of a record run. It is a real request: a search nobody asked
 *    recently spends upstream quota, and a retried one spends it twice.
 *  - No token check beyond "can a header carry it". Whether it is RIGHT is the
 *    server's to say, and the server's answer to a wrong token is to trace
 *    nothing and say nothing (ADR-0029, item 2) — which comes back here as
 *    `untraced`.
 *  - No capability probe. The page cannot know tracing is on until a record
 *    run's response says so (ADR-0029's *Consequences* defer the probe), and
 *    so a 404 on a read cannot tell "no such trace" from "no trace route".
 */

import { MAX_KEYWORDS_LENGTH, MAX_VIEW_STORYLINES, STORYLINE_UUID } from "@zammy/shared";
import {
  MAX_TRACE_MS,
  TRACE_ID_HEADER,
  TRACE_ID_PATTERN,
  TRACE_REQUEST_HEADER,
  TRACE_UNSTORED,
  TRACE_VERSION,
  TraceReadResponse,
  traceAuthorization,
  traceReadPath,
  type TraceQueryKey,
  type TraceRoute,
} from "@zammy/shared/request-trace";
import { storylineRefreshPath, throwApiError } from "../api.js";

// ── reading a stored trace ──────────────────────────────────────────────────

/**
 * The trace read answered 404: the id is unknown, expired (it lives
 * `REQUEST_TRACE_TTL_SECONDS`, an hour by default and anywhere from 30 minutes
 * to a day), or its record no longer parses under the server's schema (a future
 * `v`) — or the read route is not there at all, because tracing is off on that
 * API and the route is then Fastify's own 404 (ADR-0029, item 7). The page
 * cannot tell these apart, so what it says must not pretend to. Final, unlike a
 * 503 — the page stops asking rather than retrying, which is why it is a class
 * of its own rather than an `ApiError` with a status.
 *
 * It carries no id. The id is a read capability, and an error object is the
 * kind of thing that ends up in a console or an error report.
 */
export class TraceNotFound extends Error {
  constructor() {
    // The read route's own 404 message (`trace-http.ts`), so both sides say the same thing.
    super("unknown trace");
    this.name = "TraceNotFound";
  }
}

/**
 * One stored trace, parsed rather than cast (the `api.ts` rule): a record from
 * a server a version ahead fails loudly here instead of animating garbage.
 *
 * 404 → `TraceNotFound`; any other non-ok status (400 for a malformed id, 429
 * from the route's own bucket, 503 when the trace store is down) → the
 * `ApiError` every read throws; 200 → `TraceReadResponse`.
 *
 * `cache: "no-store"` although the route already answers `no-store`: this read
 * is also the POLL that brings job runs in, and a poll answered from any cache
 * would watch a trace that never grows.
 */
export async function fetchTrace(id: string, signal?: AbortSignal): Promise<TraceReadResponse> {
  const response = await fetch(traceReadPath(id), { signal, cache: "no-store" });
  if (response.status === 404) throw new TraceNotFound();
  if (!response.ok) await throwApiError(response);
  return TraceReadResponse.parse(await response.json());
}

// ── recording a real request ────────────────────────────────────────────────

/**
 * What the record panel can ask for: one per traced route (ADR-0029, item 2), and in the
 * order its `<select>` lists them. `view` and `storylines` are distinct because
 * they are distinct routes — a view is the timeline by UUID, a storylines search
 * is keywords over labels and mints no topic.
 */
export const RECORD_KINDS = [
  "search",
  "view",
  "storylines",
  "open",
  "trending",
  "reference",
] as const;
/** One of `RECORD_KINDS`. */
export type RecordKind = (typeof RECORD_KINDS)[number];

/** One record run as the panel describes it. `input` is read per kind (see `recordTarget`). */
export interface RecordRequest {
  kind: RecordKind;
  /** Keywords (search, storylines), UUIDs (view, open), a language (trending); else unused. */
  input: string;
  /** `REQUEST_TRACE_TOKEN`, pasted. Travels only in the opt-in header. */
  token: string;
  /** Trending only: add a nonce so the CDN cannot answer from its cache. Ignored otherwise. */
  bypassEdge: boolean;
}

/** Where a record run goes, and the facts a browser-only trace would need about it. */
export interface RecordTarget {
  method: "GET" | "POST";
  /** Same-origin and relative, like every `api.ts` read. Never holds the token. */
  url: string;
  route: TraceRoute;
  /** The parameter NAMES the URL carries, as the server would record them. Never their values. */
  queryKeys: TraceQueryKey[];
}

/** 2–8 characters, as `TrendingQuery.language` bounds it, from a letter: "en", "zh-Hant". */
const LANGUAGE_CODE = /^[A-Za-z][A-Za-z0-9-]{1,7}$/;

/**
 * The parameter an edge bypass adds. Not a `TraceQueryKey`: it names nothing, and
 * `TrendingQuery` (not `.strict()`) strips it before the route reads the query.
 */
const EDGE_NONCE_PARAM = "_";

/**
 * The request a record run makes, or why it cannot be made.
 *
 * Built exactly as the reader's own requests are built (`api.ts`), so the trace
 * is of the request a reader makes and not of a lookalike: `URLSearchParams`
 * for every value, `storylineRefreshPath` for the one path segment, and
 * trending's `language` ALWAYS sent — the cloud always sends it, and the URL is
 * the CDN's cache key, so a trending run without it would miss an edge copy the
 * reader's own request would have hit. An empty trending input means "en", the
 * cloud's own default.
 *
 * Validated against the same bounds the server holds (`MAX_KEYWORDS_LENGTH`,
 * `STORYLINE_UUID`, `MAX_VIEW_STORYLINES`), so a typo is refused here rather
 * than traced as a 400 — a real request the operator did not mean to make.
 * A view's ids may be separated by commas or whitespace; exact repeats fold.
 *
 * The nonce is used only for a trending run with `bypassEdge`: trending is the
 * only traced route the CDN caches (`s-maxage=60`), and a nonce anywhere else
 * would change nothing but the URL.
 *
 * Takes no token, by construction.
 */
export function recordTarget(r: RecordRequest, nonce: string): RecordTarget | { error: string } {
  const input = r.input.trim();
  switch (r.kind) {
    case "search":
    case "storylines": {
      if (input === "") return { error: "Type some words to search for." };
      if (input.length > MAX_KEYWORDS_LENGTH) {
        return { error: `A search is at most ${MAX_KEYWORDS_LENGTH} characters.` };
      }
      const params = new URLSearchParams({ q: input });
      return r.kind === "search"
        ? {
            method: "GET",
            url: `/api/v1/timeline?${params}`,
            route: "timeline_search",
            queryKeys: ["q"],
          }
        : {
            method: "GET",
            url: `/api/v1/storylines?${params}`,
            route: "storylines_search",
            queryKeys: ["q"],
          };
    }
    case "view": {
      const ids = [...new Set(input.split(/[\s,]+/).filter((id) => id !== ""))];
      if (ids.length === 0) {
        return { error: "Paste one or more storyline UUIDs, separated by commas." };
      }
      if (!ids.every((id) => STORYLINE_UUID.test(id))) {
        return { error: "Each storyline is a UUID, like 1b671a64-40d5-491e-99b0-da01ff1f3341." };
      }
      if (ids.length > MAX_VIEW_STORYLINES) {
        return { error: `A view holds at most ${MAX_VIEW_STORYLINES} storylines.` };
      }
      const params = new URLSearchParams({ storyline: ids.join(",") });
      return {
        method: "GET",
        url: `/api/v1/timeline?${params}`,
        route: "timeline_view",
        queryKeys: ["storyline"],
      };
    }
    case "open": {
      if (!STORYLINE_UUID.test(input)) {
        return { error: "Paste one storyline UUID, like 1b671a64-40d5-491e-99b0-da01ff1f3341." };
      }
      return {
        method: "POST",
        url: storylineRefreshPath(input),
        route: "storyline_open",
        queryKeys: [],
      };
    }
    case "trending": {
      const language = input === "" ? "en" : input;
      if (!LANGUAGE_CODE.test(language)) return { error: "A language is a code, like en." };
      const params = new URLSearchParams({ language });
      if (r.bypassEdge) params.set(EDGE_NONCE_PARAM, nonce);
      return {
        method: "GET",
        url: `/api/v1/trending?${params}`,
        route: "trending",
        queryKeys: ["language"],
      };
    }
    case "reference":
      return { method: "GET", url: "/api/v1/reference", route: "reference", queryKeys: [] };
  }
}

/**
 * What became of a record run, as its response headers tell it.
 *
 *  - `traced` — the server stored it; `id` is what to read back.
 *  - `unstored` — the server traced it but the write failed (Redis not ready in
 *    time, or the draft failed its own schema); there is nothing to read.
 *  - `browser` — no trace could exist, and the browser draws the one fact it
 *    saw. `cause` says why, and the two are NOT the same story: `cache` is the
 *    CDN answering from its cache (HIT or STALE), when no function ran at all;
 *    `timeout` is a 504 with no id, the platform answering INSTEAD of the API —
 *    most likely a function that ran to its time limit and was stopped before
 *    `onSend` could store a trace, or an edge that could not reach one. A
 *    function may well have run for the whole minute there; nothing may say it
 *    did not.
 *  - `untraced` — a function answered and traced nothing: a wrong token,
 *    tracing off, the per-instance budget spent (ADR-0029, item 2). The server
 *    never says which, on purpose: a wrong token must learn nothing.
 *  - `invalid` — the run was not made (the input or token cannot travel), or
 *    its answer named a trace in a shape this page cannot read.
 */
export type RecordResult =
  | { kind: "traced"; id: string }
  | { kind: "unstored"; status: number }
  | { kind: "browser"; cause: BrowserOnlyCause; response: TraceReadResponse }
  | { kind: "untraced"; status: number }
  | { kind: "invalid"; error: string };

/** What `readRecordResult` reads: the response's headers and status, and the browser's timings. */
export interface RecordResponse {
  headers: { get(name: string): string | null };
  status: number;
  /** The browser's clock when the request was sent. */
  startedAt: Date;
  /** Send to response headers, in ms, by the browser's own clock. */
  browserMs: number;
  route: TraceRoute;
  method: "GET" | "POST";
  queryKeys: TraceQueryKey[];
}

/** Vercel's CDN verdict. Present only behind Vercel; the dev proxy sends none. */
const VERCEL_CACHE_HEADER = "x-vercel-cache";

/**
 * Why a record run could only be drawn from what the browser saw: the CDN's
 * cache answered it (`cache`), or the platform answered a 504 in the API's
 * place (`timeout`). See `RecordResult`.
 */
export type BrowserOnlyCause = "cache" | "timeout";

/**
 * Classify a record run's response (ADR-0029, "What is deliberately not seen",
 * the platform 504): a valid id header → traced; `unstored` → unstored; no id
 * and `x-vercel-cache: HIT|STALE` → browser, `cache` (an edge hit or stale
 * serve: no function ran); no id and a 504 → browser, `timeout` (the platform
 * gave up on the request — a function stopped at its `maxDuration`, or an edge
 * that could not reach one — so `onSend` never ran); anything else → untraced.
 *
 * The id is checked FIRST, and that order is safe: a traced response is sent
 * `no-store` (ADR-0029, item 5), so the CDN never holds one, and an id can never
 * arrive on a cached answer that belongs to someone else's request.
 *
 * An id header that is neither a v4 id nor `unstored` reads `invalid`, not
 * `untraced`: the header's presence says the server DID trace the request,
 * and "check your token" would be the wrong thing to tell the operator. The
 * likeliest cause is an API a version away from this page.
 */
export function readRecordResult(input: RecordResponse): RecordResult {
  const id = input.headers.get(TRACE_ID_HEADER)?.trim();
  if (id) {
    if (id === TRACE_UNSTORED) return { kind: "unstored", status: input.status };
    if (TRACE_ID_PATTERN.test(id)) return { kind: "traced", id };
    return {
      kind: "invalid",
      error: "The API traced this request but named the trace in a shape this page cannot read.",
    };
  }
  const cache = input.headers.get(VERCEL_CACHE_HEADER)?.trim().toUpperCase();
  const facts = {
    startedAt: input.startedAt,
    status: input.status,
    ms: input.browserMs,
    route: input.route,
    method: input.method,
    queryKeys: input.queryKeys,
  };
  if (cache === "HIT" || cache === "STALE") {
    return { kind: "browser", cause: "cache", response: browserOnlyTrace({ ...facts, cache }) };
  }
  if (input.status === 504) {
    // The edge did not serve it from cache, whatever `x-vercel-cache` says (MISS
    // behind Vercel, absent behind any other gateway): its one touch is a miss.
    return {
      kind: "browser",
      cause: "timeout",
      response: browserOnlyTrace({ ...facts, cache: "MISS" }),
    };
  }
  return { kind: "untraced", status: input.status };
}

/** What `recordRequest` can be handed instead of the browser's own, so a test can drive it. */
export interface RecordDeps {
  fetch?: typeof fetch;
  /** A monotonic ms clock for `browserMs`; defaults to `performance.now`. */
  now?: () => number;
  /** The wall clock for `startedAt`; defaults to `new Date()`. */
  clock?: () => Date;
  /** The edge-bypass nonce; defaults to 48 random bits. */
  nonce?: () => string;
  /** Aborts the run (the page unmounting mid-request). An abort rejects, like `fetch`. */
  signal?: AbortSignal;
}

/**
 * Printable ASCII, no spaces: what `Bearer <token>` can carry. A header value
 * with a newline or a character past U+00FF makes `fetch` throw rather than
 * send, and the server refuses a token with whitespace at boot anyway
 * (`REQUEST_TRACE_TOKEN` in `packages/config`), so either is a paste gone wrong.
 */
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]+$/;

/**
 * Make one record run: the real request, with `x-zammy-trace: Bearer <token>`,
 * `cache: "no-store"` so the browser's own cache cannot answer it, and the
 * body cancelled unread. Resolves to what the headers say (`readRecordResult`);
 * rejects only when `fetch` does (offline, aborted).
 *
 * `browserMs` runs from send to headers — the part of a request the browser can
 * see. For an edge hit that is the whole of it, and it is the only duration a
 * browser-only trace has.
 *
 * The input is checked before the token, so an operator who has not filled the
 * form in yet is told about the form first. The token is trimmed (a paste
 * brings a newline) and otherwise sent as given.
 */
export async function recordRequest(
  r: RecordRequest,
  deps: RecordDeps = {},
): Promise<RecordResult> {
  const target = recordTarget(r, (deps.nonce ?? edgeNonce)());
  if ("error" in target) return { kind: "invalid", error: target.error };
  const token = r.token.trim();
  if (token === "") {
    return {
      kind: "invalid",
      error: "Paste the trace token: REQUEST_TRACE_TOKEN in the API's .env.",
    };
  }
  if (!HEADER_SAFE_TOKEN.test(token)) {
    return {
      kind: "invalid",
      error: "A trace token has no spaces, and only plain ASCII characters.",
    };
  }

  // Held in a local, never called as `deps.fetch(…)`: a browser's own `fetch`
  // called as a method of some other object throws "Illegal invocation".
  const send = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => performance.now());
  const startedAt = (deps.clock ?? (() => new Date()))();
  const sentAt = now();
  const response = await send(target.url, {
    method: target.method,
    headers: { [TRACE_REQUEST_HEADER]: traceAuthorization(token) },
    cache: "no-store",
    signal: deps.signal,
  });
  const browserMs = now() - sentAt;
  // Nothing reads the body (see the header), and an unread body holds the
  // connection's download open until it is collected.
  await response.body?.cancel().catch(() => undefined);

  return readRecordResult({
    headers: response.headers,
    status: response.status,
    startedAt,
    browserMs,
    route: target.route,
    method: target.method,
    queryKeys: target.queryKeys,
  });
}

// ── the browser-only trace ──────────────────────────────────────────────────

/** How long a browser-only trace says it lasts: nominal (it is never stored); the default TTL. */
const BROWSER_TRACE_LIFETIME_MS = 3_600_000;

const EDGE_OUTCOME = { HIT: "hit", STALE: "stale", MISS: "miss" } as const;

/** What the browser knows about a request no function traced. */
export interface BrowserOnlyFacts {
  startedAt: Date;
  status: number;
  /** The browser's own measurement; rounded to 0.1 ms and bounded as the server bounds its own. */
  ms: number;
  route: TraceRoute;
  method: "GET" | "POST";
  queryKeys: TraceQueryKey[];
  cache: "HIT" | "STALE" | "MISS";
}

/**
 * A trace for a request no function recorded, built from what the browser saw:
 * one `edge` touch (the only station the server never records: its hooks run
 * behind the CDN),
 * `origin: null` (no function ran — the schema's own meaning of null), no
 * meta, no planes, no runs, and a fresh random v4 id so it is never confused
 * with, or collides with, a stored one.
 *
 * Returned as the PARSE OUTPUT of `TraceReadResponse`, the same discipline the
 * server keeps with its drafts: the page downstream of this only ever handles
 * records that passed the one schema, whichever side built them. It is never
 * stored and never put in the URL; the page holds it in state.
 */
export function browserOnlyTrace(o: BrowserOnlyFacts): TraceReadResponse {
  const ms = boundedMs(o.ms);
  return TraceReadResponse.parse({
    trace: {
      v: TRACE_VERSION,
      id: randomTraceId(),
      route: o.route,
      method: o.method,
      queryKeys: o.queryKeys,
      status: o.status,
      startedAt: o.startedAt.toISOString(),
      ms,
      overheadMs: 0,
      origin: null,
      meta: null,
      planes: null,
      touches: [{ station: "edge", at: 0, ms, outcome: EDGE_OUTCOME[o.cache] }],
      elided: null,
    },
    runs: [],
    expiresAt: new Date(o.startedAt.getTime() + BROWSER_TRACE_LIFETIME_MS).toISOString(),
  });
}

/** 0.1 ms, within [0, MAX_TRACE_MS]; a non-finite reading is 0 rather than a schema failure. */
function boundedMs(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(MAX_TRACE_MS, Math.max(0, Math.round(ms * 10) / 10));
}

/**
 * A lowercase v4 UUID, the shape `TRACE_ID_PATTERN` accepts.
 *
 * `crypto.randomUUID()` when it exists — and it exists only in a SECURE
 * context (https, or localhost), so a dev stack opened by its LAN address over
 * http has none. `getRandomValues` has no such restriction, and sixteen of its
 * bytes with the version and variant bits set are the same thing.
 */
function randomTraceId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const part = (from: number, to?: number) => hex.slice(from, to);
  return `${part(0, 8)}-${part(8, 12)}-${part(12, 16)}-${part(16, 20)}-${part(20)}`;
}

/** 48 random bits: unique per run, which is all a cache-key nonce has to be. */
function edgeNonce(): string {
  return randomTraceId().replaceAll("-", "").slice(0, 12);
}
