/**
 * The playback view's wire half (ADR-0029, "The change", item 7, as amended by ADR-0031):
 * reading a stored trace back by its id, and reading the list of the newest ones the page's
 * dropdown offers.
 *
 * Neither read carries a token — since ADR-0031 there is none — and both answer `no-store`
 * on the server and are fetched `cache: "no-store"` here, because both are polled and a poll
 * answered from a cache would watch a trace (or a list) that never grows.
 *
 * Deliberately NOT here: making a traced request. ADR-0031 took the record panel off the
 * page: with tracing on, every request to a traceable route is traced, so the page lists what
 * was served rather than making requests of its own.
 */

import {
  RECENT_TRACES_PATH,
  RecentTracesResponse,
  TraceReadResponse,
  traceReadPath,
  type TraceSummary,
} from "@zammy/shared/request-trace";
import { throwApiError } from "../api.js";

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
 * It carries no id: an error object is the kind of thing that ends up in a
 * console or an error report, and the record behind an id holds what a reader
 * asked for (ADR-0031).
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

// ── the recent list ─────────────────────────────────────────────────────────

/**
 * The recent list answered 404: the route is not there, which means tracing is off on this
 * API (`REQUEST_TRACE_ENABLED`) — the route exists only while it is on (ADR-0031). Final, like
 * `TraceNotFound`: the page says so rather than retrying.
 */
export class TracingOff extends Error {
  constructor() {
    super("tracing is off");
    this.name = "TracingOff";
  }
}

/**
 * The newest traces still stored, newest first (`GET /api/v1/traces`), parsed rather than
 * cast. 404 → `TracingOff`; any other non-ok status (429 from the route's own bucket, 503
 * when the trace store is down) → the `ApiError` every read throws.
 */
export async function fetchRecentTraces(signal?: AbortSignal): Promise<TraceSummary[]> {
  const response = await fetch(RECENT_TRACES_PATH, { signal, cache: "no-store" });
  if (response.status === 404) throw new TracingOff();
  if (!response.ok) await throwApiError(response);
  return RecentTracesResponse.parse(await response.json()).traces;
}
