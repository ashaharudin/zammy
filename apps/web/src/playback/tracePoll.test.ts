import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver, environmentManager } from "@tanstack/react-query";
import { TraceReadResponse } from "@zammy/shared/request-trace";
import { TraceNotFound } from "./traceFetch.js";
import {
  POLL_SCHEDULE,
  POLL_WINDOW_MS,
  awaitedRefs,
  minutesLeft,
  nextClockChangeMs,
  nextPollDelay,
  pollStatus,
  traceAgeMs,
  traceQueryOptions,
  traceTimeLeftMs,
  type PolledTrace,
} from "./tracePoll.js";

/**
 * The poll that brings a recorded trace's job runs in (ADR-0029, and the cost
 * table under "What it costs").
 *
 * Its regressions are all COST regressions, which is why they need a test: a
 * poll that never stops is invisible on screen and bills a Redis read every few
 * seconds for as long as a tab stays open. So what is pinned is every way the
 * poll stops — every ref finished, nothing linked, the window spent, the first
 * read failing, a later read 404ing — that no clock skew stretches the window,
 * and, against a real TanStack observer driven by the page's own options, that
 * a trace which 404s is asked once and then left alone. And the half a reader
 * sees: the line under the transport stops saying "Waiting" when the window
 * closes, and the expiry badge counts down, both on a clock of their own.
 */

const STARTED = "2026-09-23T18:00:00.000Z";
const T0 = Date.parse(STARTED);
const ORIGIN = {
  instanceSequence: 7,
  redisAtStart: "ready",
  environment: {
    queue: "bullmq",
    currents: "fixture",
    gnews: false,
    googleNews: "fixture",
    summaries: true,
    labeler: false,
  },
} as const;

/** A linked enqueue that went through, unless the case says otherwise. */
const enqueue = (ref: string, overrides: Record<string, unknown> = {}) => ({
  station: "queue",
  at: 790,
  ms: 4.2,
  outcome: "ok",
  job: "segment",
  plane: "search",
  ref,
  linked: true,
  ...overrides,
});

const lookup = { station: "redis", at: 1, ms: 0.3, outcome: "miss", command: "GET", key: "page_cache" };

/** One attempt at the job `ref` names, and whatever it enqueued in turn. */
const run = (ref: string, result: "ok" | "threw", touches: unknown[] = []) => ({
  v: 1,
  ref,
  job: "segment",
  plane: "search",
  source: "bullmq",
  startedAt: "2026-09-23T18:00:01.000Z",
  ms: 420,
  overheadMs: 0,
  result,
  sharedWith: 1,
  origin: ORIGIN,
  touches,
  elided: null,
});

/** A stored search trace, through the shared schema so no case is a shape the server cannot send. */
const traceWith = (touches: unknown[], runs: unknown[] = []): TraceReadResponse =>
  TraceReadResponse.parse({
    trace: {
      v: 1,
      id: "3f2b7c1e-9a4d-4b6e-8c2f-1a2b3c4d5e6f",
      route: "timeline_search",
      method: "GET",
      queryKeys: ["q"],
      status: 200,
      startedAt: STARTED,
      ms: 812.4,
      overheadMs: 1.1,
      origin: ORIGIN,
      meta: null,
      planes: null,
      touches,
      elided: null,
    },
    runs,
    expiresAt: "2026-09-23T19:00:00.000Z",
  });

describe("POLL_SCHEDULE", () => {
  it("backs off monotonically, and its window is thirty minutes", () => {
    for (let i = 1; i < POLL_SCHEDULE.length; i += 1) {
      expect(POLL_SCHEDULE[i]!.untilMs).toBeGreaterThan(POLL_SCHEDULE[i - 1]!.untilMs);
      expect(POLL_SCHEDULE[i]!.everyMs).toBeGreaterThanOrEqual(POLL_SCHEDULE[i - 1]!.everyMs);
    }
    // The drain takes entries at least 900 s old on a ten-minute cadence, so a
    // drained run lands 15–25 minutes after its enqueue. Thirty covers it.
    expect(POLL_SCHEDULE.at(-1)!.untilMs).toBe(30 * 60_000);
  });
});

describe("awaitedRefs", () => {
  it("waits on every linked enqueue the request made", () => {
    expect(awaitedRefs(traceWith([lookup, enqueue("1"), enqueue("2")]))).toEqual(["1", "2"]);
  });

  it("stops waiting on a ref once a run of it finished ok", () => {
    const response = traceWith([enqueue("1"), enqueue("2")], [run("2", "ok")]);
    expect(awaitedRefs(response)).toEqual(["1"]);
  });

  it("keeps a ref awaited after a run that threw, until an attempt succeeds", () => {
    // A thrown run is redelivered (or drained) and appends another run under
    // the same ref; the first attempt failing is when waiting matters most.
    expect(awaitedRefs(traceWith([enqueue("1")], [run("1", "threw")]))).toEqual(["1"]);
    expect(
      awaitedRefs(traceWith([enqueue("1")], [run("1", "threw"), run("1", "ok")])),
    ).toEqual([]);
  });

  it("waits on the children a run enqueued, by the refs the server rendered", () => {
    const response = traceWith([enqueue("1")], [run("1", "ok", [enqueue("1.1"), enqueue("1.2")])]);
    expect(awaitedRefs(response)).toEqual(["1.1", "1.2"]);
    const settled = traceWith(
      [enqueue("1")],
      [run("1", "ok", [enqueue("1.1"), enqueue("1.2")]), run("1.1", "ok"), run("1.2", "ok")],
    );
    expect(awaitedRefs(settled)).toEqual([]);
  });

  it("waits on what a thrown run enqueued before it threw, once however often it is retried", () => {
    const attempt = () => run("1", "threw", [enqueue("1.1")]);
    const response = traceWith([enqueue("1")], [attempt(), attempt()]);
    expect(awaitedRefs(response)).toEqual(["1", "1.1"]);
  });

  it("never waits on an enqueue no run can come back from", () => {
    // Unlinked: its run cannot find this trace. Failed: no job was published.
    const response = traceWith([
      enqueue("1", { linked: false }),
      enqueue("2", { outcome: "failed", ms: 250.1 }),
    ]);
    expect(awaitedRefs(response)).toEqual([]);
  });
});


/** A record as the page's query holds it, first read at `firstReadAt` (T0 by default). */
const polled = (response: TraceReadResponse, firstReadAt = T0): PolledTrace => ({
  response,
  firstReadAt,
});
const good = (response: TraceReadResponse, firstReadAt = T0) => ({
  data: polled(response, firstReadAt),
  error: null,
});
const HOUR = 3_600_000;

describe("nextPollDelay", () => {
  const waiting = traceWith([lookup, enqueue("1")]);
  const at = (elapsedMs: number) => nextPollDelay(good(waiting), T0 + elapsedMs);

  it("polls at each step's cadence up to and including its boundary", () => {
    expect(at(0)).toBe(3_000);
    expect(at(30_000)).toBe(3_000);
    expect(at(30_001)).toBe(10_000);
    expect(at(120_000)).toBe(10_000);
    expect(at(120_001)).toBe(30_000);
    expect(at(600_000)).toBe(30_000);
    expect(at(600_001)).toBe(60_000);
    expect(at(1_800_000)).toBe(60_000);
    expect(POLL_WINDOW_MS).toBe(1_800_000);
  });

  it("stops once the trace is more than thirty minutes old, whatever is still awaited", () => {
    expect(at(1_800_001)).toBe(false);
    expect(at(6 * HOUR)).toBe(false);
  });

  it("does not poll a link opened after the window at all", () => {
    // First read forty minutes after the request, clocks agreeing.
    const late = good(waiting, T0 + 40 * 60_000);
    expect(nextPollDelay(late, T0 + 40 * 60_000)).toBe(false);
  });

  it("stops as soon as every ref has an ok run, however early", () => {
    const finished = traceWith([enqueue("1")], [run("1", "ok")]);
    expect(nextPollDelay(good(finished), T0 + 2_000)).toBe(false);
  });

  it("never starts for a trace that linked no enqueue", () => {
    // A cache hit, a rate-limited request, a browser-only edge trace: nothing
    // can be appended to any of them, so there is nothing to wait for.
    expect(nextPollDelay(good(traceWith([lookup])), T0)).toBe(false);
    expect(nextPollDelay(good(traceWith([enqueue("1", { linked: false })])), T0)).toBe(false);
  });

  it("keeps polling while the only run so far threw", () => {
    const thrown = traceWith([enqueue("1")], [run("1", "threw")]);
    expect(nextPollDelay(good(thrown), T0 + 305_000)).toBe(30_000);
  });

  it("does not poll without a record to bound the window by", () => {
    // Undefined data is a read in flight or a read that FAILED; see the
    // observer tests below for why the second must not poll.
    expect(nextPollDelay({ data: undefined, error: null }, T0)).toBe(false);
    expect(nextPollDelay({ data: undefined, error: new TraceNotFound() }, T0)).toBe(false);
  });

  it("stops once a later read 404s, although TanStack keeps the good copy", () => {
    // The trace expired (or tracing was turned off) mid-poll. Asking again
    // gets the same 404, once per interval, for as long as the tab is open.
    const gone = { data: polled(waiting), error: new TraceNotFound() };
    expect(nextPollDelay(gone, T0 + 5_000)).toBe(false);
  });

  it("keeps polling through a failure that is not final", () => {
    // A 503 from a store that blinked: the next poll is how the page recovers.
    const blinked = { data: polled(waiting), error: new Error("503") };
    expect(nextPollDelay(blinked, T0 + 5_000)).toBe(3_000);
  });

  it("gives the same answer however often it is asked at one instant", () => {
    // TanStack asks on every render and every query update, not once per poll.
    const answers = new Set(Array.from({ length: 200 }, () => at(45_000)));
    expect([...answers]).toEqual([10_000]);
  });

  it("measures a browser clock running BEHIND the server's by the page's own time", () => {
    // The browser reads the trace two hours "before" it started. By the server's
    // clock alone every poll for two hours was the 3 s cadence; by the page's
    // own, it backs off and stops thirty minutes after the first read.
    const firstRead = T0 - 2 * HOUR;
    const skewed = good(waiting, firstRead);
    expect(nextPollDelay(skewed, firstRead)).toBe(3_000);
    expect(nextPollDelay(skewed, firstRead + 45_000)).toBe(10_000);
    expect(nextPollDelay(skewed, firstRead + 700_000)).toBe(60_000);
    expect(nextPollDelay(skewed, firstRead + POLL_WINDOW_MS + 1)).toBe(false);
  });

  it("stops early for a browser clock running AHEAD — the half no record can correct", () => {
    const firstRead = T0 + 25 * 60_000;
    expect(nextPollDelay(good(waiting, firstRead), firstRead)).toBe(60_000);
    expect(nextPollDelay(good(waiting, firstRead), firstRead + 5 * 60_000 + 1)).toBe(false);
  });
});

describe("traceAgeMs", () => {
  const waiting = traceWith([enqueue("1")]);

  it("is the larger of the server-clock age and the time since the first read", () => {
    expect(traceAgeMs(polled(waiting, T0 + 1_000), T0 + 11_000)).toBe(11_000);
    expect(traceAgeMs(polled(waiting, T0 - HOUR), T0 - HOUR + 7_000)).toBe(7_000);
  });
});

describe("pollStatus", () => {
  const waiting = traceWith([enqueue("1"), enqueue("2")]);

  it("says nothing before a record has been read", () => {
    expect(pollStatus({ data: undefined, error: null }, T0)).toEqual({ kind: "none" });
    expect(pollStatus({ data: undefined, error: new TraceNotFound() }, T0)).toEqual({
      kind: "none",
    });
  });

  it("is waiting inside the window, and stopped — not waiting — once it closes", () => {
    expect(pollStatus(good(waiting), T0 + 60_000)).toEqual({ kind: "waiting", awaited: 2 });
    expect(pollStatus(good(waiting), T0 + POLL_WINDOW_MS + 1)).toEqual({
      kind: "stopped",
      awaited: 2,
    });
  });

  it("is settled once every linked enqueue has an ok run", () => {
    const done = traceWith([enqueue("1")], [run("1", "ok")]);
    expect(pollStatus(good(done), T0 + 5_000)).toEqual({ kind: "settled" });
  });

  it("is expired once a read after a good one 404s", () => {
    expect(pollStatus({ data: polled(waiting), error: new TraceNotFound() }, T0 + 5_000)).toEqual(
      { kind: "expired" },
    );
  });
});

describe("traceTimeLeftMs and minutesLeft", () => {
  const settled = traceWith([lookup]); // expires at T0 + 1 h

  it("counts down to expiresAt when the clocks agree", () => {
    expect(traceTimeLeftMs(polled(settled), T0 + 10 * 60_000)).toBe(50 * 60_000);
    expect(traceTimeLeftMs(polled(settled), T0 + HOUR + 1)).toBe(-1);
  });

  it("never reads more than the ttl left after the first read, whatever the skew", () => {
    // A browser two hours slow: expiresAt − now alone says three hours.
    const firstRead = T0 - 2 * HOUR;
    expect(traceTimeLeftMs(polled(settled, firstRead), firstRead)).toBe(HOUR);
    expect(traceTimeLeftMs(polled(settled, firstRead), firstRead + 20 * 60_000)).toBe(
      40 * 60_000,
    );
  });

  it("shows whole minutes, 1 through the last one, and 0 once the time is up", () => {
    expect(minutesLeft(60 * 60_000)).toBe(60);
    expect(minutesLeft(59 * 60_000 + 1)).toBe(60);
    expect(minutesLeft(1)).toBe(1);
    expect(minutesLeft(0)).toBe(0);
    expect(minutesLeft(-5_000)).toBe(0);
  });
});

describe("nextClockChangeMs", () => {
  // Expiring thirty seconds past the hour, so the window's close and the
  // badge's minute boundaries fall at different instants.
  const expiring = (response: TraceReadResponse): TraceReadResponse => ({
    ...response,
    expiresAt: new Date(T0 + HOUR + 30_000).toISOString(),
  });

  it("wakes the page the moment the poll window closes", () => {
    const waiting = good(expiring(traceWith([enqueue("1")])));
    const now = T0 + POLL_WINDOW_MS - 10_000;
    expect(nextClockChangeMs(waiting, now)).toBe(10_001);
    expect(pollStatus(waiting, now + 10_001).kind).toBe("stopped");
  });

  it("wakes the page when the badge's minute ticks down", () => {
    const settled = good(expiring(traceWith([lookup])));
    // 49 min 45 s left reads "50 min" until 49 min are left.
    const now = T0 + HOUR + 30_000 - (49 * 60_000 + 45_000);
    expect(minutesLeft(traceTimeLeftMs(settled.data, now))).toBe(50);
    expect(nextClockChangeMs(settled, now)).toBe(45_000);
    expect(minutesLeft(traceTimeLeftMs(settled.data, now + 45_000))).toBe(49);
  });

  it("keeps ticking the badge after the window closes, and stops once the time is up", () => {
    const stopped = good(expiring(traceWith([enqueue("1")])));
    expect(nextClockChangeMs(stopped, T0 + POLL_WINDOW_MS + 1)).toBe(29_999);
    expect(nextClockChangeMs(stopped, T0 + HOUR + 30_000)).toBeNull();
  });

  it("has nothing to wake for without a record, or after a 404", () => {
    expect(nextClockChangeMs({ data: undefined, error: null }, T0)).toBeNull();
    const gone = { data: polled(traceWith([enqueue("1")])), error: new TraceNotFound() };
    expect(nextClockChangeMs(gone, T0 + 5_000)).toBeNull();
  });
});

/**
 * The poll as the page wires it — `traceQueryOptions`, the very options
 * `PlaybackPage` hands `useQuery` — over a real `QueryObserver` with fake
 * timers. TanStack's refetch interval is evaluated on every query update, and
 * while a query is in ERROR its `data` is undefined — so a delay with no record
 * is not "not loaded yet" but "what to do after the read failed". Answering a
 * delay there polls a 404 for as long as the tab is open.
 */
describe("the page's trace query", () => {
  const ID = "3f2b7c1e-9a4d-4b6e-8c2f-1a2b3c4d5e6f";

  beforeEach(() => {
    vi.useFakeTimers({ now: T0 + 1_000 });
    // TanStack never runs an interval where there is no `window`; the node
    // test says it is a browser so the interval is the page's.
    environmentManager.setIsServer(() => false);
  });

  afterEach(() => {
    environmentManager.setIsServer(() => true);
    vi.useRealTimers();
  });

  const observe = (read: () => Promise<TraceReadResponse>) => {
    const client = new QueryClient();
    const observer = new QueryObserver(client, traceQueryOptions(ID, { read }));
    const unsubscribe = observer.subscribe(() => {});
    return { observer, stop: () => (unsubscribe(), client.clear()) };
  };

  it("asks for a trace that 404s once, and then leaves it alone", async () => {
    const read = vi.fn(async (): Promise<TraceReadResponse> => {
      throw new TraceNotFound();
    });
    const { observer, stop } = observe(read);

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(observer.getCurrentResult().error).toBeInstanceOf(TraceNotFound);
    expect(read).toHaveBeenCalledTimes(1);
    stop();
  });

  it("polls a trace until its run lands, and not once after", async () => {
    let served = traceWith([enqueue("1")]);
    const read = vi.fn(async () => served);
    const { stop } = observe(read);

    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    // Every 3 s in the first thirty seconds.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(read).toHaveBeenCalledTimes(4);

    served = traceWith([enqueue("1")], [run("1", "ok")]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(read).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(read).toHaveBeenCalledTimes(5);
    stop();
  });

  it("keeps the first read's time across every poll", async () => {
    const read = vi.fn(async () => traceWith([enqueue("1")]));
    const { observer, stop } = observe(read);

    await vi.advanceTimersByTimeAsync(0);
    const first = observer.getCurrentResult().data!.firstReadAt;
    expect(first).toBe(T0 + 1_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(read.mock.calls.length).toBeGreaterThan(10);
    expect(observer.getCurrentResult().data!.firstReadAt).toBe(first);
    stop();
  });

  it("stops at the first 404 after a good read, with the good copy still held", async () => {
    let gone = false;
    const read = vi.fn(async () => {
      if (gone) throw new TraceNotFound();
      return traceWith([enqueue("1")]);
    });
    const { observer, stop } = observe(read);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(read).toHaveBeenCalledTimes(3);
    gone = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(read).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(read).toHaveBeenCalledTimes(4);
    expect(observer.getCurrentResult().data).toBeDefined();
    expect(observer.getCurrentResult().error).toBeInstanceOf(TraceNotFound);
    stop();
  });

  it("reads a trace about 55 times however far behind the browser's clock runs", async () => {
    // The browser is two hours behind the server: the server started the trace
    // at T0 and forgets it at T0 + 1 h, which the browser's clock calls
    // T0 − 1 h. By the server's clock alone this polled at 3 s for two hours
    // and then read 404 after 404 — about 2,450 reads.
    const firstRead = T0 - 2 * HOUR;
    vi.setSystemTime(firstRead);
    const reads: number[] = [];
    let notFound = 0;
    const read = vi.fn(async () => {
      reads.push(Date.now());
      if (Date.now() >= T0 - HOUR) {
        notFound += 1;
        throw new TraceNotFound();
      }
      return traceWith([enqueue("1")]);
    });
    const { stop } = observe(read);

    await vi.advanceTimersByTimeAsync(3 * HOUR);

    expect(reads.length).toBeGreaterThan(45);
    expect(reads.length).toBeLessThanOrEqual(60);
    // The last read is the one scheduled from inside the window, one interval on.
    expect(Math.max(...reads) - firstRead).toBeLessThanOrEqual(POLL_WINDOW_MS + 60_000);
    expect(notFound).toBe(0);
    stop();
  });
});
