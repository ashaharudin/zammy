import { describe, expect, it } from "vitest";
import { MAX_TRACE_TOUCHES, RequestTrace, type Touch } from "@zammy/shared/request-trace";
import { createTouchRecorder, type TouchStart } from "./trace-recorder.js";

/**
 * The recorder's arithmetic (ADR-0029, "The change" 4), on a clock the test owns.
 *
 * What these catch: an elision that miscounts what it dropped (the page would
 * draw a gap of the wrong size, or at the wrong index), a sealed record that
 * keeps growing after the response has left (the label tail's touches landing
 * in a trace that was already stored), a recorder method that throws into the
 * request it is observing, and a ref counter that runs past the two digits
 * `JobRef` accepts — any of which turns a stored trace into a refused one.
 */

function fakeClock(start = 1_000): { clock: () => number; tick: (ms: number) => void } {
  let now = start;
  return {
    clock: () => now,
    tick: (ms) => {
      now += ms;
    },
  };
}

const PG: TouchStart = { station: "postgres", operation: "select", tables: ["articles"] };
const GET: TouchStart = { station: "redis", command: "GET", key: "page_cache" };

const RATE_LIMIT: Touch = {
  station: "rate_limit",
  at: 0,
  ms: 1.2,
  outcome: "counted",
  inferred: true,
  limit: 120,
  remaining: 119,
};

describe("createTouchRecorder", () => {
  it("records offsets relative to its own start, rounded to a tenth of a millisecond", () => {
    const { clock, tick } = fakeClock();
    const recorder = createTouchRecorder({ maxTouches: 240, clock });
    tick(2.34);
    const handle = recorder.begin(GET);
    tick(1.26);
    handle.end("hit");

    const [touch] = recorder.seal().touches;
    expect(touch).toEqual({ ...GET, at: 2.3, ms: 1.3, outcome: "hit" });
    expect(recorder.now()).toBe(3.6);
  });

  it("keeps begin order when touches overlap and end out of order", () => {
    const { clock, tick } = fakeClock();
    const recorder = createTouchRecorder({ maxTouches: 240, clock });
    const first = recorder.begin({ station: "currents", call: "available_languages" });
    tick(1);
    const second = recorder.begin({ station: "currents", call: "available_regions" });
    tick(5);
    second.end("ok");
    tick(5);
    first.end("ok");

    const touches = recorder.seal().touches;
    expect(touches.map((t) => (t.station === "currents" ? t.call : null))).toEqual([
      "available_languages",
      "available_regions",
    ]);
    expect(touches.map((t) => t.ms)).toEqual([11, 5]);
  });

  it("keeps the head and the tail past the cap, and counts exactly what it dropped", () => {
    const { clock, tick } = fakeClock();
    // cap 40 → a head of ceil(0.6 × 40) = 24, a ring of 16.
    const recorder = createTouchRecorder({ maxTouches: 40, clock });
    for (let i = 0; i < 100; i += 1) {
      tick(1);
      recorder.begin(i % 10 === 5 ? GET : PG).end("ok");
    }

    const sealed = recorder.seal();
    expect(sealed.touches).toHaveLength(40);
    // Begun at offsets 1..100: the head is 1..24, the ring the last 16 (85..100).
    expect(sealed.touches[23]?.at).toBe(24);
    expect(sealed.touches[24]?.at).toBe(85);
    expect(sealed.touches.at(-1)?.at).toBe(100);
    // 25..84 went: 60 touches, of which those at i % 10 === 5 (i = 25, 35 … 75)
    // were Redis — offsets 26, 36 … 76, six of them.
    expect(sealed.elided).toEqual({
      after: 23,
      count: 60,
      stations: { postgres: 54, redis: 6 },
      fromAt: 25,
      toAt: 84,
    });
  });

  it("puts a prepend first, keeps it out of the elision, and takes its slot from the ring", () => {
    const { clock, tick } = fakeClock();
    const recorder = createTouchRecorder({ maxTouches: 40, clock });
    for (let i = 0; i < 40; i += 1) {
      tick(1);
      recorder.begin(PG).end("ok");
    }
    // Exactly full: the prepend has to evict the ring's oldest to fit.
    recorder.prepend(RATE_LIMIT);

    const sealed = recorder.seal();
    expect(sealed.touches).toHaveLength(40);
    expect(sealed.touches[0]).toEqual(RATE_LIMIT);
    expect(sealed.elided).toMatchObject({ after: 24, count: 1, fromAt: 25, toAt: 25 });
    // Still a record the schema takes: the prepend never pushes past the cap.
    expect(sealed.touches.length).toBeLessThanOrEqual(MAX_TRACE_TOUCHES);
  });

  it("reads a touch that never ended as open, with no duration", () => {
    const { clock, tick } = fakeClock();
    const recorder = createTouchRecorder({ maxTouches: 240, clock });
    recorder.begin(PG);
    tick(7);

    const sealed = recorder.seal();
    expect(sealed.touches).toEqual([{ ...PG, at: 0, ms: null, outcome: "open" }]);
    expect(sealed.ms).toBe(7);
  });

  it("ignores begin, end and prepend after seal, and never throws", () => {
    const { clock, tick } = fakeClock();
    const recorder = createTouchRecorder({ maxTouches: 240, clock });
    const early = recorder.begin(PG);
    const first = recorder.seal();

    tick(3);
    expect(() => early.end("ok")).not.toThrow();
    expect(() => recorder.begin(GET).end("hit")).not.toThrow();
    expect(() => recorder.prepend(RATE_LIMIT)).not.toThrow();

    // The same record, unchanged — the label tail cannot reach a sealed trace.
    expect(recorder.seal()).toBe(first);
    expect(first.touches).toEqual([{ ...PG, at: 0, ms: null, outcome: "open" }]);
    expect(recorder.sealed).toBe(true);
  });

  it("keeps the first end of a touch and ignores the second", () => {
    const { clock, tick } = fakeClock();
    const recorder = createTouchRecorder({ maxTouches: 240, clock });
    const handle = recorder.begin({ station: "currents", call: "search", priority: "interactive" });
    tick(2);
    handle.end("refused", { failure: "quota" });
    tick(9);
    handle.end("ok");

    expect(recorder.seal().touches).toEqual([
      {
        station: "currents",
        call: "search",
        priority: "interactive",
        failure: "quota",
        at: 0,
        ms: 2,
        outcome: "refused",
      },
    ]);
  });

  it("never lets an end patch rewrite what the recorder measured", () => {
    const { clock, tick } = fakeClock();
    const recorder = createTouchRecorder({ maxTouches: 240, clock });
    const handle = recorder.begin(GET);
    tick(1);
    handle.end("miss", { station: "postgres", at: 99, ms: 99, outcome: "ok" });

    expect(recorder.seal().touches).toEqual([{ ...GET, at: 0, ms: 1, outcome: "miss" }]);
  });

  it("counts job refs 1 to 99 and then stays at 99, saying how many it issued", () => {
    const recorder = createTouchRecorder({ maxTouches: 240 });
    const refs = Array.from({ length: 101 }, () => recorder.nextRef());
    expect(refs.slice(0, 3)).toEqual(["1", "2", "3"]);
    expect(refs[98]).toBe("99");
    expect(refs[99]).toBe("99");
    expect(refs[100]).toBe("99");
    expect(recorder.refsIssued).toBe(101);
  });

  it("sums the tracer's own overhead, ignoring nonsense", () => {
    const recorder = createTouchRecorder({ maxTouches: 240 });
    recorder.addOverhead(1.24);
    recorder.addOverhead(2.5);
    recorder.addOverhead(Number.NaN);
    recorder.addOverhead(-4);
    expect(recorder.seal().overheadMs).toBe(3.7);
  });

  it("never raises the shared ceiling, whatever config asks for", () => {
    const recorder = createTouchRecorder({ maxTouches: 10_000 });
    for (let i = 0; i < 1_000; i += 1) recorder.begin(PG).end("ok");
    const sealed = recorder.seal();
    expect(sealed.touches).toHaveLength(MAX_TRACE_TOUCHES);
    expect(sealed.elided?.count).toBe(600);
  });

  it("produces a record the wire schema accepts, prepend and elision included", () => {
    const { clock, tick } = fakeClock();
    const recorder = createTouchRecorder({ maxTouches: 32, clock });
    for (let i = 0; i < 50; i += 1) {
      tick(0.5);
      recorder.begin(i % 2 === 0 ? PG : GET).end(i % 2 === 0 ? "ok" : "miss");
    }
    recorder.begin(PG);
    recorder.prepend(RATE_LIMIT);
    const sealed = recorder.seal();

    const parsed = RequestTrace.safeParse({
      v: 1,
      id: "00000000-0000-4000-8000-000000000001",
      route: "timeline_search",
      method: "GET",
      queryKeys: ["q"],
      status: 200,
      startedAt: "2026-09-01T12:00:00.000Z",
      ms: sealed.ms,
      overheadMs: sealed.overheadMs,
      origin: null,
      meta: null,
      planes: null,
      touches: sealed.touches,
      elided: sealed.elided,
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("survives a clock that throws", () => {
    let calls = 0;
    const recorder = createTouchRecorder({
      maxTouches: 240,
      clock: () => {
        calls += 1;
        if (calls > 1) throw new Error("clock broke");
        return 0;
      },
    });
    expect(() => recorder.begin(PG).end("ok")).not.toThrow();
    expect(() => recorder.seal()).not.toThrow();
  });
});
