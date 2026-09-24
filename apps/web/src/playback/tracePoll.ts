/**
 * How long a recorded trace is polled for its job runs, and what the page can
 * say about it as time passes — as pure functions, plus the one `useQuery`
 * wiring that runs them, so the page and its test share it (ADR-0029, "The page
 * is an operator's view on `/`").
 *
 * A trace is written once, when its request answers; the JOB RUNS of the jobs
 * it enqueued are appended to it afterwards, by whichever consumer runs them —
 * an in-process BullMQ worker within a second, a Vercel Queues delivery within
 * seconds (or a redelivery at about +305 s), the drain 15–25 minutes later
 * (`drain.ts` takes entries at least 900 s old, every 10 minutes). The page
 * polls the read route so the runs walk onto the floor as they land.
 *
 * It asks exactly one question — is anything this trace linked still without
 * a finished run? — and it answers from the query's state alone, with the clock
 * passed in (the `ingestPoll.ts` discipline): TanStack evaluates a
 * function-form `refetchInterval` on every render and every query update, so
 * the answer must be the same however often it is asked, and nothing but the
 * clock and the state may change it.
 *
 * **The window is thirty minutes of the trace's age, and the age is measured
 * twice.** Once by the server's clock (`now − trace.startedAt`), which is what
 * lets a `#t=` link opened forty minutes later poll not at all; and once by the
 * browser's own (`now − firstReadAt`, when THIS page first read the record),
 * which no skew can move. The age is the larger of the two. A trace cannot be
 * younger than the time since it was first read, so a browser clock running
 * behind the server's — which makes the first reading small or negative — can
 * no longer hold the poll at its 3 s cadence for the whole skew, or keep it
 * going for hours: whatever the clocks say, one page polls one trace for at
 * most thirty minutes of its own time, about 55 reads. A browser clock running
 * AHEAD still reads the trace as older than it is and stops early; "Check
 * again" is the way back, and nothing in the record can correct that half.
 * `firstReadAt` rides in the query's data (`traceQueryOptions`), carried from
 * poll to poll, so it is the first read of this id by this page's cache.
 *
 * The cadence backs off as the likely arrivals thin out — every 3 s while a
 * warm worker or a push is landing, then 10 s, then 30 s through the
 * redeliveries, then once a minute for the drain.
 *
 * Deliberately NOT here:
 *  - No polling without a record. With no `data` the poll is off, and that is
 *    load-bearing: TanStack holds `data` undefined only while the first read is
 *    in flight (a poll then would join it) or after it FAILED — a 404 for an
 *    expired or hand-typed id, a 503 from a store that is down. There is no
 *    record there to bound a window by, so it would poll a dead id forever.
 *    The query's own retry and the page's "Try again" own that case.
 *  - No polling after a 404 either, even with a good copy in hand: TanStack
 *    KEEPS `data` when a later read fails, so a trace that expires (or whose API
 *    turned tracing off) mid-poll would otherwise be asked for again at every
 *    interval, each answer another 404.
 *  - No sight of an enqueue the recorder elided. A record past its touch cap
 *    keeps its head and tail and counts the middle; a queue touch counted
 *    there has no ref to wait on, so its run arrives only if some other ref
 *    keeps the poll open. "Check again" is the way back to it.
 */

import { queryOptions } from "@tanstack/react-query";
import type { TraceReadResponse, Touch } from "@zammy/shared/request-trace";
import { fetchTrace, TraceNotFound } from "./traceFetch.js";

/**
 * The cadence, by the trace's age (`traceAgeMs`): `everyMs` applies while the
 * age is at most `untilMs`, and past the last entry polling stops. Ascending in
 * both columns; the last `untilMs` is the whole window.
 */
export const POLL_SCHEDULE = [
  { untilMs: 30_000, everyMs: 3_000 },
  { untilMs: 120_000, everyMs: 10_000 },
  { untilMs: 600_000, everyMs: 30_000 },
  { untilMs: 1_800_000, everyMs: 60_000 },
] as const;

/** The whole poll window: past this age a trace is not polled, whatever it still awaits. */
export const POLL_WINDOW_MS = POLL_SCHEDULE.at(-1)!.untilMs;

/** A recorded trace as the page's query holds it: the record, and when this page first read it. */
export interface PolledTrace {
  response: TraceReadResponse;
  /** Browser epoch ms of this page's first good read of the id, carried across every poll. */
  firstReadAt: number;
}

/**
 * The slice of TanStack's `query.state` the poll decides from. `error` is the
 * LAST read's failure, which TanStack keeps beside the good `data` of an
 * earlier read; a later good read clears it.
 */
export interface PollState {
  data: PolledTrace | undefined;
  error: unknown;
}

/**
 * The refs this trace is still waiting on: every LINKED queue touch — the
 * request's own enqueues, and the children its runs enqueued, already rendered
 * by the server as `<parent>.<n>` — that has no run whose result is `ok`.
 * First-seen order, each ref once.
 *
 * A run that THREW keeps its ref awaited: the job is redelivered (or drained)
 * and the next attempt appends a run of its own under the same ref. A child a
 * thrown run enqueued before it threw is awaited too — its publish happened.
 *
 * Two kinds of enqueue are never awaited, because no run of them can arrive:
 * one with `linked: false` (the link write failed, or a child nested past
 * `MAX_JOB_REF_DEPTH`), whose run cannot find its way back to this trace; and
 * one whose publish `failed`, which put no job on the queue at all.
 */
export function awaitedRefs(response: TraceReadResponse): string[] {
  const finished = new Set(
    response.runs.filter((run) => run.result === "ok").map((run) => run.ref),
  );
  const awaited = new Set<string>();
  const consider = (touches: readonly Touch[]) => {
    for (const touch of touches) {
      if (touch.station !== "queue" || !touch.linked || touch.outcome === "failed") continue;
      if (!finished.has(touch.ref)) awaited.add(touch.ref);
    }
  };
  consider(response.trace.touches);
  for (const run of response.runs) consider(run.touches);
  return [...awaited];
}

/**
 * How old the trace is, as far as this page can tell: the larger of its age by
 * the server's clock and the time since this page first read it (see the
 * header for why both, and why the larger).
 */
export function traceAgeMs(polled: PolledTrace, nowMs: number): number {
  const byServer = nowMs - Date.parse(polled.response.trace.startedAt);
  const byPage = nowMs - polled.firstReadAt;
  return Math.max(byServer, byPage);
}

/**
 * What to hand TanStack's `refetchInterval` for a recorded trace: the delay
 * until the next read, or `false` to stop.
 *
 * `false` with no record (a failed first read, not a slow one), `false` once a
 * read 404'd (the trace is gone; asking again gets the same answer), `false`
 * once nothing is awaited, `false` once the trace is older than the window;
 * otherwise `POLL_SCHEDULE`'s cadence for its age.
 */
export function nextPollDelay(state: PollState, nowMs: number): number | false {
  const { data, error } = state;
  if (data === undefined || error instanceof TraceNotFound) return false;
  if (awaitedRefs(data.response).length === 0) return false;
  const age = traceAgeMs(data, nowMs);
  for (const step of POLL_SCHEDULE) {
    if (age <= step.untilMs) return step.everyMs;
  }
  return false;
}

/**
 * Where the poll stands, for the line the page shows under the transport:
 *
 *  - `none` — no record read yet (or the first read failed; the status plate
 *    says so, and "Try again" is its control).
 *  - `waiting` — polling, with `awaited` refs still to land.
 *  - `stopped` — the window has closed with `awaited` refs still missing. The
 *    page must stop saying "Waiting…" here and offer "Check again": nothing
 *    will read the trace again on its own.
 *  - `settled` — every linked enqueue has an ok run. "Check again" still reads
 *    once more, for a run of an enqueue the recorder elided.
 *  - `expired` — a read after a good one answered 404: there is nothing more to
 *    ask for, so there is no "Check again" either.
 */
export type PollStatus =
  | { kind: "none" }
  | { kind: "waiting"; awaited: number }
  | { kind: "stopped"; awaited: number }
  | { kind: "settled" }
  | { kind: "expired" };

export function pollStatus(state: PollState, nowMs: number): PollStatus {
  const { data, error } = state;
  if (data === undefined) return { kind: "none" };
  if (error instanceof TraceNotFound) return { kind: "expired" };
  const awaited = awaitedRefs(data.response).length;
  if (awaited === 0) return { kind: "settled" };
  return nextPollDelay(state, nowMs) === false
    ? { kind: "stopped", awaited }
    : { kind: "waiting", awaited };
}

/**
 * How long the trace has left before the store forgets it, as far as this page
 * can tell: the smaller of `expiresAt − now` (the server's clock against the
 * browser's) and `firstReadAt + ttl − now`, where the ttl is `expiresAt −
 * startedAt` — two readings of ONE clock, so skew-free — and a trace cannot
 * have had more than its whole ttl left when it was first read. Negative once
 * it has (probably) gone. The store's 404 is the authority; this is the badge.
 */
export function traceTimeLeftMs(polled: PolledTrace, nowMs: number): number {
  const { trace, expiresAt } = polled.response;
  const expires = Date.parse(expiresAt);
  const ttl = expires - Date.parse(trace.startedAt);
  return Math.min(expires - nowMs, polled.firstReadAt + ttl - nowMs);
}

/** The badge's whole minutes: 1 through the last minute, 0 once the time is up. */
export function minutesLeft(timeLeftMs: number): number {
  return timeLeftMs > 0 ? Math.ceil(timeLeftMs / 60_000) : 0;
}

/**
 * When the page's time-driven output next changes, in ms from now, or null
 * when nothing more will change by itself: the moment the poll window closes
 * (`waiting` turns `stopped`), and the moment the badge's minute ticks down —
 * whichever comes first. The page sets a timer for it, because nothing else
 * would re-render it: a poll that brings back an identical record keeps the
 * same `data` reference, and after the last poll there is no update at all.
 */
export function nextClockChangeMs(state: PollState, nowMs: number): number | null {
  const { data } = state;
  if (data === undefined || state.error instanceof TraceNotFound) return null;
  const candidates: number[] = [];
  if (pollStatus(state, nowMs).kind === "waiting") {
    candidates.push(POLL_WINDOW_MS - traceAgeMs(data, nowMs) + 1);
  }
  const left = traceTimeLeftMs(data, nowMs);
  if (left > 0) {
    // The next whole-minute boundary below `left`, where `minutesLeft` drops by one.
    const boundary = Math.floor((left - 1) / 60_000) * 60_000;
    candidates.push(left - boundary);
  }
  return candidates.length === 0 ? null : Math.max(1, Math.min(...candidates));
}

/** What `traceQueryOptions` can be handed instead of the browser's own, so a test can drive it. */
export interface TraceQueryDeps {
  read?: (id: string, signal: AbortSignal) => Promise<TraceReadResponse>;
  /** Browser epoch ms; defaults to `Date.now`, read at call time (fake timers see it). */
  now?: () => number;
}

/**
 * The page's query for a recorded trace, `null` for none (the query is then
 * disabled). Polled by `nextPollDelay` over the query's own state; a failed read
 * retried once, and a 404 never (it is final). Every read carries forward the
 * `firstReadAt` of the copy it replaces, so the page's own measure of the
 * trace's age survives every poll.
 */
export function traceQueryOptions(id: string | null, deps: TraceQueryDeps = {}) {
  const read = deps.read ?? fetchTrace;
  const now = () => (deps.now ?? Date.now)();
  return queryOptions({
    queryKey: ["trace", id] as const,
    queryFn: async ({ signal, client, queryKey }): Promise<PolledTrace> => {
      const response = await read(id ?? "", signal);
      const previous = client.getQueryData<PolledTrace>(queryKey);
      return { response, firstReadAt: previous?.firstReadAt ?? now() };
    },
    enabled: id !== null,
    refetchInterval: (query) => nextPollDelay(query.state, now()),
    retry: (failures, error) => !(error instanceof TraceNotFound) && failures < 1,
  });
}
