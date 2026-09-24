import { describe, expect, it } from "vitest";
import type { Touch, TraceReadResponse } from "@zammy/shared/request-trace";
import {
  OUTCOME_PRECEDENCE,
  PACING,
  buildTimeline,
  dwellMs,
  isStop,
  planPart,
  realClockAt,
  stepAt,
  thinkMs,
  type Step,
  type Stop,
  type Timeline,
} from "./choreography.js";
import { TRACE_FIXTURES, traceFixture } from "./fixtures/traceFixtures.js";
import { STEP_HOLD_MS, initialTransport, transport } from "./playbackClock.js";

/**
 * The choreography (ADR-0029): what the robots do with a trace.
 *
 * This is the one place a trace's MEANING is decided for the page — which touches
 * are one stay, which are concurrent, when a job run starts relative to the
 * request — so a regression here is a page that plays smoothly and tells the
 * reader something false: a label-tail call drawn as the runner's own, a retry
 * that seems to follow its first attempt immediately, a cold search with 230
 * steps. Each test below pins one such claim.
 */

function example(slug: string) {
  const found = traceFixture(slug);
  if (!found) throw new Error(`no example ${slug}`);
  return found.response;
}

const pg = (at: number, ms: number | null = 0.5): Touch => ({
  station: "postgres",
  at,
  ms,
  outcome: ms === null ? "open" : "ok",
  operation: "select",
  tables: ["articles"],
});
type CurrentsCall = "search" | "available_languages" | "available_regions";
const currents = (at: number, ms: number, call: CurrentsCall): Touch => ({
  station: "currents",
  at,
  ms,
  outcome: "ok",
  call,
  priority: "interactive",
});
const enqueue = (at: number, ref: string, linked: boolean): Touch => ({
  station: "queue",
  at,
  ms: 5,
  outcome: "ok",
  job: "segment",
  plane: "search",
  ref,
  linked,
});
const redis = (at: number, key: "page_cache" | "fill_lock" = "page_cache"): Touch => ({
  station: "redis",
  at,
  ms: 0.5,
  outcome: "hit",
  command: "GET",
  key,
});

/** A response around the given request touches, and optional runs. */
function synthetic(
  touches: Touch[],
  ms: number,
  runs: TraceReadResponse["runs"] = [],
): TraceReadResponse {
  const base = example("cache-hit");
  return {
    ...base,
    trace: { ...base.trace, touches, ms, elided: null },
    runs,
  };
}

const TIMELINES: readonly { slug: string; timeline: Timeline }[] = TRACE_FIXTURES.flatMap((e) =>
  (["readable", "real"] as const).map((pace) => ({
    slug: `${e.slug} (${pace})`,
    timeline: buildTimeline(e.response, { pace }),
  })),
);

describe("dwellMs", () => {
  it("follows clamp(280 + 420·log10(1 + ms/2), 280, 2400)", () => {
    expect(dwellMs(0)).toBe(280);
    expect(dwellMs(2)).toBeCloseTo(406, -0.3);
    expect(Math.abs(dwellMs(200) - 1122)).toBeLessThanOrEqual(1);
    expect(Math.abs(dwellMs(8000) - 1793)).toBeLessThanOrEqual(1);
    expect(dwellMs(1e9)).toBe(2400);
  });

  it("gives a call with no observed end the open dwell", () => {
    expect(dwellMs(null)).toBe(PACING.openDwellMs);
  });

  it("never gets shorter as the real call gets longer", () => {
    let last = -Infinity;
    for (let ms = 0; ms <= 20_000; ms += 7) {
      const d = dwellMs(ms);
      expect(d).toBeGreaterThanOrEqual(last);
      last = d;
    }
  });
});

describe("thinkMs", () => {
  it("clamps into [160, 900] and grows with the gap", () => {
    expect(thinkMs(0)).toBe(160);
    expect(thinkMs(1e9)).toBe(900);
    expect(thinkMs(200)).toBeGreaterThan(thinkMs(20));
  });
});

describe("OUTCOME_PRECEDENCE", () => {
  it("ranks every outcome exactly once, the failures first", () => {
    expect(new Set(OUTCOME_PRECEDENCE).size).toBe(15);
    expect(OUTCOME_PRECEDENCE[0]).toBe("failed");
    expect(OUTCOME_PRECEDENCE.at(-1)).toBe("ok");
  });
});

describe("planPart", () => {
  it("merges three Postgres touches 2 ms apart into one stop", () => {
    const { lanes } = planPart([pg(0), pg(2), pg(4)], null, { helpers: true });
    const stops = lanes[0]!.filter(isStop);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.count).toBe(3);
  });

  it("splits them when a Redis touch comes between", () => {
    const { lanes } = planPart([pg(0), redis(2), pg(4)], null, { helpers: true });
    const stations = lanes[0]!.filter(isStop).map((s) => s.station);
    expect(stations).toEqual(["postgres", "redis", "postgres"]);
  });

  it("keeps two Redis key classes apart even back to back", () => {
    const touches = [redis(0, "page_cache"), redis(0.6, "fill_lock")];
    const { lanes } = planPart(touches, null, { helpers: true });
    expect(lanes[0]!.filter(isStop).map((s) => s.key)).toEqual(["page_cache", "fill_lock"]);
  });

  it("does not merge across a gap wider than mergeGapMs", () => {
    const { lanes } = planPart([pg(0), pg(0.5 + PACING.mergeGapMs + 1)], null, { helpers: true });
    expect(lanes[0]!.filter(isStop)).toHaveLength(2);
  });

  it("puts a touch with no end on a helper, never on the runner", () => {
    const { lanes } = planPart([pg(0), pg(1, null), pg(3)], null, { helpers: true });
    const runnerTouches = lanes[0]!.filter(isStop).flatMap((s) => s.touches);
    expect(runnerTouches.every((t) => t.ms !== null)).toBe(true);
    const helper = lanes[1]!.filter(isStop);
    expect(helper).toHaveLength(1);
    expect(helper[0]!.realEnd).toBeNull();
  });

  it("sends a touch overlapping the runner at another station to the lowest free helper", () => {
    const long = currents(0, 100, "search");
    const { lanes } = planPart([long, pg(10), pg(50)], null, { helpers: true });
    expect(lanes[0]!.filter(isStop).map((s) => s.station)).toEqual(["currents"]);
    // pg(10) ends at 10.5, so the same helper is free again at 50.
    expect(lanes[1]!.filter(isStop).map((s) => s.realAt)).toEqual([10, 50]);
    expect(lanes[2]).toHaveLength(0);
  });

  it("joins an overlapping touch at the same station to the runner's stop, and counts it", () => {
    const a = currents(4, 742, "available_languages");
    const b = currents(4.2, 768, "available_regions");
    const { lanes } = planPart([a, b], null, { helpers: true });
    const [stop] = lanes[0]!.filter(isStop);
    expect(stop).toMatchObject({ count: 2, parallel: 2, realAt: 4 });
    expect(stop!.realEnd).toBeCloseTo(772.2, 5);
  });

  it("keeps a run on one lane, overlapping touches at different stations one after another", () => {
    const { lanes } = planPart([currents(0, 100, "search"), pg(10)], null, { helpers: false });
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.filter(isStop).map((s) => s.station)).toEqual(["currents", "postgres"]);
  });

  it("never merges across the elision, which sits after the stop holding touch `after`", () => {
    const elided = { after: 1, count: 40, stations: { postgres: 40 }, fromAt: 2.5, toAt: 3.5 };
    const { lanes } = planPart([pg(0), pg(1), pg(4)], elided, { helpers: true });
    const items = lanes[0]!;
    const shape = items.map((i) => (isStop(i) ? `stop×${i.count}` : "elided"));
    expect(shape).toEqual(["stop×2", "elided", "stop×1"]);
  });

  it("names the most notable outcome of a merged stop", () => {
    const miss: Touch = { ...redis(1), outcome: "miss" } as Touch;
    const { lanes } = planPart([redis(0), miss], null, { helpers: true });
    expect((lanes[0]![0] as Stop).outcome).toBe("miss");
  });
});

describe("buildTimeline", () => {
  it("is deterministic: the same response always builds the same timeline", () => {
    for (const e of TRACE_FIXTURES) {
      for (const pace of ["readable", "real"] as const) {
        expect(buildTimeline(e.response, { pace })).toEqual(buildTimeline(e.response, { pace }));
      }
    }
  });

  it("sorts its steps, gives each a positive length, and starts with arrive", () => {
    for (const { slug, timeline } of TIMELINES) {
      const { steps } = timeline;
      expect(steps[0]?.kind, slug).toBe("arrive");
      steps.forEach((step, i) => {
        expect(step.index, slug).toBe(i);
        expect(step.t1, slug).toBeGreaterThan(step.t0);
        // Strictly: no two steps share a start (`separateTies`).
        if (i > 0) expect(step.t0, slug).toBeGreaterThan(steps[i - 1]!.t0);
      });
      const ends = [...steps.map((s) => s.t1), ...timeline.crates.map((c) => c.t1)];
      expect(timeline.duration, slug).toBe(Math.max(...ends));
      expect(timeline.duration, slug).toBeGreaterThanOrEqual(Math.max(...steps.map((s) => s.t1)));
    }
  });

  it("has exactly one respond, and responseAt is its t0", () => {
    for (const { slug, timeline } of TIMELINES) {
      const responds = timeline.steps.filter((s) => s.kind === "respond");
      expect(responds, slug).toHaveLength(1);
      expect(timeline.responseAt, slug).toBe(responds[0]!.t0);
    }
  });

  it("puts every request touch in exactly one stop, or in the elision", () => {
    for (const e of TRACE_FIXTURES) {
      const timeline = buildTimeline(e.response, { pace: "readable" });
      const drawn = timeline.steps
        .filter((s) => s.part.kind === "request" && s.stop)
        .flatMap((s) => s.stop!.touches);
      expect(drawn).toHaveLength(e.response.trace.touches.length);
      for (const touch of e.response.trace.touches) {
        expect(drawn.filter((t) => t === touch), e.slug).toHaveLength(1);
      }
    }
  });

  it("never overlaps two of one actor's steps — the runner's least of all", () => {
    for (const { slug, timeline } of TIMELINES) {
      const byActor = new Map<string, { t0: number; t1: number }[]>();
      for (const s of timeline.steps) byActor.set(s.actor, [...(byActor.get(s.actor) ?? []), s]);
      for (const [actor, steps] of byActor) {
        for (let i = 1; i < steps.length; i += 1) {
          expect(steps[i]!.t0, `${slug} ${actor}`).toBeGreaterThanOrEqual(steps[i - 1]!.t1 - 1e-9);
        }
      }
    }
  });

  it("plays a rate-limited request as exactly arrive, the limiter, respond", () => {
    const timeline = buildTimeline(example("rate-limited"), { pace: "readable" });
    expect(timeline.steps.map((s) => `${s.kind}${s.station ? `:${s.station}` : ""}`)).toEqual([
      "arrive",
      "stop:rate_limit",
      "respond",
    ]);
    expect(timeline.steps[1]!.stop?.outcome).toBe("limited");
    expect(timeline.steps[1]!.tone).toBe("attention");
  });

  it("draws the cold search's four enqueues as one stop, and its label tail on helper-1", () => {
    const timeline = buildTimeline(example("cold-search"), { pace: "readable" });
    const request = timeline.steps.filter((s) => s.part.kind === "request");
    const queue = request.filter((s) => s.station === "queue");
    expect(queue).toHaveLength(1);
    expect(queue[0]!.stop?.count).toBe(4);
    expect(queue[0]!.actor).toBe("runner");
    // The label tail: two Postgres reads and the Gemini call that never ended.
    const helper = request.filter((s) => s.actor.startsWith("helper"));
    expect(helper.every((s) => s.actor === "helper-1")).toBe(true);
    expect(helper.flatMap((s) => s.stop!.touches)).toHaveLength(3);
    expect(helper.at(-1)!.station).toBe("gemini");
    expect(helper.at(-1)!.tone).toBe("activity");
  });

  it("spawns one crate per enqueue, staggered, each riding for conveyorMs", () => {
    const timeline = buildTimeline(example("cold-search"), { pace: "readable" });
    expect(timeline.crates.map((c) => c.ref)).toEqual(["1", "2", "3", "4"]);
    const queue = timeline.steps.find((s) => s.station === "queue")!;
    timeline.crates.forEach((crate, i) => {
      expect(crate.t0).toBe(queue.t1 + i * PACING.crateStaggerMs);
      expect(crate.t1 - crate.t0).toBe(PACING.conveyorMs);
    });
  });

  it("runs the storyline open's three jobs on three workers, side by side", () => {
    const timeline = buildTimeline(example("storyline-open"), { pace: "readable" });
    const runs = [0, 1, 2].map((run) => {
      const steps = timeline.steps.filter((s) => s.part.kind === "run" && s.part.run === run);
      return {
        actor: steps[0]!.actor,
        t0: Math.min(...steps.map((s) => s.t0)),
        t1: Math.max(...steps.map((s) => s.t1)),
      };
    });
    expect(new Set(runs.map((r) => r.actor)).size).toBe(3);
    for (let i = 1; i < runs.length; i += 1) expect(runs[i]!.t0).toBeLessThan(runs[i - 1]!.t1);
  });

  it("precedes the redelivery, 305 s after the first attempt, with a later step", () => {
    const response = example("cold-search");
    const timeline = buildTimeline(response, { pace: "readable" });
    const retry = response.runs.findLastIndex((r) => r.ref === "4");
    const steps = timeline.steps.filter((s) => s.part.kind === "run" && s.part.run === retry);
    expect(steps[0]!.kind).toBe("later");
    expect(steps[1]!.kind).toBe("run");
    expect(steps[0]!.realMs!).toBeGreaterThan(300_000);
  });

  it("starts a run that began mid-request before the response, but not before its crate", () => {
    const limiter: Touch = {
      station: "rate_limit",
      at: 0,
      ms: 1,
      outcome: "counted",
      inferred: true,
      limit: 120,
      remaining: 100,
    };
    const touches: Touch[] = [limiter, enqueue(2, "1", true), pg(100, 400)];
    const base = example("cold-search");
    const run = {
      ...base.runs[0]!,
      startedAt: new Date(Date.parse(base.trace.startedAt) + 50).toISOString(),
      touches: [pg(0, 5)],
      elided: null,
      ms: 10,
    };
    const timeline = buildTimeline(synthetic(touches, 600, [run]), { pace: "readable" });
    const runStep = timeline.steps.find((s) => s.kind === "run")!;
    const crate = timeline.crates.find((c) => c.ref === "1")!;
    expect(runStep.t0).toBeLessThan(timeline.responseAt);
    expect(runStep.t0).toBeGreaterThanOrEqual(crate.t1);
  });

  it("gives a linked enqueue with no run an unobserved step, and an unlinked one none", () => {
    const touches: Touch[] = [enqueue(0, "1", true), enqueue(6, "2", false)];
    const timeline = buildTimeline(synthetic(touches, 20), { pace: "readable" });
    const unobserved = timeline.steps.filter((s) => s.kind === "unobserved");
    expect(unobserved.map((s) => s.jobRef)).toEqual(["1"]);
    expect(unobserved[0]!.t0).toBeGreaterThanOrEqual(Math.max(...timeline.crates.map((c) => c.t1)));
  });

  it("marks a run that threw for attention, start and end", () => {
    const response = example("cold-search");
    const timeline = buildTimeline(response, { pace: "readable" });
    const threw = response.runs.findIndex((r) => r.result === "threw");
    const marks = timeline.steps
      .filter((s) => s.part.kind === "run" && s.part.run === threw)
      .filter((s) => s.kind === "run" || s.kind === "run_end")
      .map((s) => s.tone);
    expect(marks).toEqual(["attention", "attention"]);
  });

  it("keeps the order at real pace and never plays a stop shorter than it really took", () => {
    for (const e of TRACE_FIXTURES) {
      const readable = buildTimeline(e.response, { pace: "readable" });
      const real = buildTimeline(e.response, { pace: "real" });
      const key = (s: Step) => `${s.kind}|${s.actor}|${s.station}|${s.realAt}`;
      expect(new Set(real.steps.map(key))).toEqual(new Set(readable.steps.map(key)));
      const runnerOrder = (t: Timeline) => t.steps.filter((s) => s.actor === "runner").map(key);
      expect(runnerOrder(real)).toEqual(runnerOrder(readable));
      for (const step of real.steps) {
        if (step.kind === "stop" && step.realMs !== null) {
          expect(step.t1 - step.t0 - step.walk, e.slug).toBeGreaterThanOrEqual(step.realMs - 1e-9);
          expect(step.walk).toBe(0);
        }
      }
    }
  });

  it("keeps every example between 3 and 100 steps", () => {
    for (const { slug, timeline } of TIMELINES) {
      expect(timeline.steps.length, slug).toBeGreaterThanOrEqual(3);
      expect(timeline.steps.length, slug).toBeLessThanOrEqual(100);
    }
  });

  it("keeps the knots monotone in both clocks", () => {
    for (const { slug, timeline } of TIMELINES) {
      for (let k = 1; k < timeline.knots.length; k += 1) {
        expect(timeline.knots[k]![0], slug).toBeGreaterThanOrEqual(timeline.knots[k - 1]![0]);
        expect(timeline.knots[k]![1], slug).toBeGreaterThan(timeline.knots[k - 1]![1]);
      }
    }
  });
});

describe("realClockAt", () => {
  it("inverts the knots at the knot points", () => {
    for (const { slug, timeline } of TIMELINES) {
      for (const [real, anim] of timeline.knots) {
        expect(realClockAt(timeline, anim), slug).toBeCloseTo(real, 6);
      }
    }
  });

  it("interpolates between knots, and is null outside them", () => {
    const timeline = buildTimeline(example("cold-search"), { pace: "readable" });
    const [a, b] = [timeline.knots[0]!, timeline.knots[1]!];
    const mid = realClockAt(timeline, (a[1] + b[1]) / 2)!;
    expect(mid).toBeGreaterThanOrEqual(a[0]);
    expect(mid).toBeLessThanOrEqual(b[0]);
    expect(realClockAt(timeline, a[1] - 1)).toBeNull();
    expect(realClockAt(timeline, timeline.knots.at(-1)![1] + 1)).toBeNull();
  });
});

describe("stepAt", () => {
  const timeline = buildTimeline(example("cold-search"), { pace: "readable" });

  it("lands on a step when asked for its own start, whatever else is still running", () => {
    for (const step of timeline.steps) expect(stepAt(timeline, step.t0)).toBe(step.index);
  });

  it("clamps before the start and after the end", () => {
    expect(stepAt(timeline, -100)).toBe(0);
    expect(stepAt(timeline, timeline.duration + 100)).toBe(timeline.steps.length - 1);
  });

  it("returns a step that covers t whenever one does", () => {
    for (let t = 0; t < timeline.duration; t += 97) {
      const step = timeline.steps[stepAt(timeline, t)]!;
      const covered = timeline.steps.some((s) => s.t0 <= t && t < s.t1);
      if (covered) {
        expect(step.t0).toBeLessThanOrEqual(t);
        expect(t).toBeLessThan(step.t1);
      }
    }
  });

  it("ties two hand-built steps starting together to the lower index", () => {
    const tied: Timeline = {
      ...timeline,
      steps: timeline.steps
        .slice(0, 3)
        .map((s, index) => ({ ...s, index, t0: 0, t1: 100 + index })),
    };
    expect(stepAt(tied, 50)).toBe(0);
  });
});

describe("separateTies: every step is one the reader can land on", () => {
  const paused = () => initialTransport({ autoplay: false, speed: 1, mode: "animated" });

  /**
   * The regression: the transport keeps only t and reads its step back through
   * `stepAt`, so two steps sharing a start made the later one unreachable —
   * storyline-open at real pace had three such pairs (Job 1's and Job 3's stops,
   * lined up by the 60 ms floor), and its list entries, the scrubber and
   * step-forward all landed on the neighbour instead.
   */
  it("names each step at its own start, for every example at both paces", () => {
    for (const { slug, timeline } of TIMELINES) {
      for (const step of timeline.steps) {
        expect(stepAt(timeline, step.t0), `${slug} step ${step.index}`).toBe(step.index);
      }
    }
  });

  it("lands a seek on the step asked for, and a step forward on the next", () => {
    for (const { slug, timeline } of TIMELINES) {
      const { steps } = timeline;
      steps.forEach((_step, i) => {
        const seeked = transport(paused(), { type: "seek", stepIndex: i }, timeline);
        expect(stepAt(timeline, seeked.t), `${slug} seek ${i}`).toBe(i);
        if (i + 1 === steps.length) return;
        const next = transport(seeked, { type: "step", delta: 1 }, timeline);
        expect(stepAt(timeline, next.t), `${slug} step forward from ${i}`).toBe(i + 1);
      });
    }
  });

  it("holds every step in turn in stepped play, skipping none", () => {
    for (const { slug, timeline } of TIMELINES) {
      let state = initialTransport({ autoplay: true, speed: 1, mode: "stepped" });
      const shown = [stepAt(timeline, state.t)];
      while (state.status !== "ended" && shown.length <= timeline.steps.length) {
        state = transport(state, { type: "tick", dtMs: STEP_HOLD_MS }, timeline);
        if (state.status !== "ended") shown.push(stepAt(timeline, state.t));
      }
      expect(shown, slug).toEqual(timeline.steps.map((s) => s.index));
    }
  });

  /** Two job runs that began at the same wall-clock instant, a minute after the request. */
  function twins(): TraceReadResponse {
    const base = example("cold-search");
    const startedAt = new Date(Date.parse(base.trace.startedAt) + 60_000).toISOString();
    const run = (ref: string) => ({
      ...base.runs[0]!,
      ref,
      startedAt,
      touches: [pg(0, 5), pg(40, 5)],
      elided: null,
      ms: 60,
    });
    return synthetic([pg(0, 5)], 20, [run("1"), run("2")]);
  }

  /**
   * Two calls still open when the response left, started a hair before it: the
   * runner's think maps real 50–100 ms onto its readable length, so both helpers
   * spawn half a millisecond before respond, together.
   */
  function pileUp(): TraceReadResponse {
    const at = 100 - (0.5 * 50) / thinkMs(50);
    return synthetic([pg(0, 50), pg(at, null), pg(at, null)], 100);
  }

  it("moves the later of two steps starting together on by tieNudgeMs", () => {
    // At real pace a run overlapping the previous one starts a think's length
    // after it, and a think of a 0 ms gap is 0 ms: the twins start together, and
    // every step of the second would share its start with the first's (the first
    // alone is preceded by the minute's `later` step).
    const timeline = buildTimeline(twins(), { pace: "real" });
    const starts = (run: number) =>
      timeline.steps
        .filter((s) => s.part.kind === "run" && s.part.run === run && s.kind !== "later")
        .map((s) => s.t0);
    const [first, second] = [starts(0), starts(1)];
    expect(second).toHaveLength(first.length);
    second.forEach((t0, i) => expect(t0 - first[i]!).toBe(PACING.tieNudgeMs));
    for (const step of timeline.steps) expect(stepAt(timeline, step.t0)).toBe(step.index);
  });

  it("keeps the clock reaching trace.ms as the parcel leaves, however far respond moves", () => {
    // The second helper is moved on past respond's start, and so respond is moved
    // too — and the respond knot with it, or the HUD's clock would run out of
    // knots a millisecond before the parcel leaves and read T+0 (`frame.ts` clockOf).
    const timeline = buildTimeline(pileUp(), { pace: "readable" });
    const respond = timeline.steps.find((s) => s.kind === "respond")!;
    const helpers = timeline.steps.filter((s) => s.actor.startsWith("helper"));
    expect(helpers.map((s) => s.actor)).toEqual(["helper-1", "helper-2"]);
    // Respond sorts before a helper at the same instant, so it moved only because
    // the second helper was moved past it.
    expect(helpers[1]!.t0).toBeLessThan(respond.t0);
    expect(respond.t0 - helpers[0]!.t0).toBeCloseTo(2 * PACING.tieNudgeMs, 9);
    expect(timeline.responseAt).toBe(respond.t0);
    expect(realClockAt(timeline, respond.t0)).toBe(100);
    for (const step of timeline.steps) expect(stepAt(timeline, step.t0)).toBe(step.index);
  });

  it("stretches the actor's step before a moved one, so no actor has a hole", () => {
    // `frame.ts` reads a hole between an actor's steps as the actor having left:
    // a helper respawns at the runner, a worker flashes home. So wherever an
    // actor's steps followed straight on before, they still do — every run from
    // pickup to stamp, and the runner from the door back to the door.
    const cases = [
      ...TIMELINES,
      { slug: "twins (real)", timeline: buildTimeline(twins(), { pace: "real" }) },
      { slug: "pile-up (readable)", timeline: buildTimeline(pileUp(), { pace: "readable" }) },
    ];
    for (const { slug, timeline } of cases) {
      const lanes = new Map<string, Step[]>();
      for (const s of timeline.steps) {
        const lane = s.part.kind === "run" ? `run ${s.part.run}` : s.actor;
        if (s.part.kind === "run" || s.actor === "runner") {
          lanes.set(lane, [...(lanes.get(lane) ?? []), s]);
        }
      }
      for (const [lane, steps] of lanes) {
        for (let i = 1; i < steps.length; i += 1) {
          expect(steps[i]!.t0, `${slug} ${lane} step ${i}`).toBe(steps[i - 1]!.t1);
        }
      }
    }
  });
});
