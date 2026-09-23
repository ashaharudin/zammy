import { describe, expect, it } from "vitest";
import { RedisKeyClass, Station, type TraceReadResponse } from "@zammy/shared/request-trace";
import {
  PACING,
  buildTimeline,
  stepAt,
  type Pace,
  type Step,
  type Timeline,
} from "./choreography.js";
import { EXAMPLE_TRACES, exampleBySlug } from "./exampleTraces.js";
import { CRATE_PITCH, frameAt, type FrameState, type Motion } from "./frame.js";
import { TALL, WIDE, spotFor, type FloorLayout, type Point } from "./layout.js";

/**
 * The frame (ADR-0029): where everything is at one instant.
 *
 * The regressions this catches are the ones a reader sees and no other test
 * would: a robot standing beside the machine it is supposedly using, one caught
 * between two places under reduced motion, a bubble the pixel font cannot draw
 * (it would read "?", which the stage reserves for a call that never ended), a
 * crate that vanishes from the bay before anyone picked it up.
 *
 * The font's character set is copied from `pixelFont.ts` FONT_CHARS rather than
 * imported, so a caption the font lacks fails here even if someone widens the
 * set there without drawing the glyph.
 */

const FONT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:!?-+/%×✓✗'()#><=_";
const LAYOUTS: readonly FloorLayout[] = [WIDE, TALL];
const PACES: readonly Pace[] = ["readable", "real"];

function response(slug: string): TraceReadResponse {
  const found = exampleBySlug(slug);
  if (!found) throw new Error(`no example ${slug}`);
  return found.response;
}

const walkWindow = (step: Step): number =>
  step.walk > 0 ? step.walk : Math.min(PACING.walkMs, (step.t1 - step.t0) / 3);
const dwellMidpoint = (step: Step): number => {
  const start = step.t0 + walkWindow(step);
  return start + (step.t1 - start) / 2;
};

/** Instants spread over a timeline: every step's start and dwell midpoint, plus a grid. */
function instants(timeline: Timeline): number[] {
  const out = new Set<number>();
  for (const step of timeline.steps) {
    out.add(step.t0);
    out.add(dwellMidpoint(step));
    out.add(step.t1 - 1);
  }
  for (let t = 0; t <= timeline.duration; t += timeline.duration / 40) out.add(t);
  out.add(timeline.duration);
  return [...out];
}

/** Every string a frame asks the canvas to draw, labelled. */
function canvasText(frame: FrameState): { what: string; text: string }[] {
  return [
    ...frame.actors.flatMap((a) =>
      a.bubble === null ? [] : [{ what: `${a.id} bubble`, text: a.bubble }],
    ),
    ...(frame.banner === null ? [] : [{ what: "banner", text: frame.banner }]),
    { what: "clock", text: frame.clock },
    ...Station.options.flatMap((s) => [
      { what: `${s} plate`, text: frame.stations[s].plate },
      ...(frame.stations[s].tag ? [{ what: `${s} tag`, text: frame.stations[s].tag! }] : []),
    ]),
    ...frame.crates.map((c) => ({ what: `crate ${c.ref}`, text: c.label })),
  ];
}

function spots(layout: FloorLayout): Point[] {
  return [
    ...Station.options.filter((s) => s !== "redis").map((s) => spotFor(layout, s, null)),
    ...RedisKeyClass.options.map((k) => layout.bins[k]),
    layout.door,
    layout.bay,
    ...layout.homes,
  ];
}

const has = (points: readonly Point[], p: Point) => points.some((q) => q.x === p.x && q.y === p.y);

describe("frameAt", () => {
  it("stands every stop's actor on the station's spot mid-dwell, on both plans", () => {
    for (const e of EXAMPLE_TRACES) {
      for (const pace of PACES) {
        const timeline = buildTimeline(e.response, { pace });
        for (const layout of LAYOUTS) {
          for (const step of timeline.steps) {
            if (step.kind !== "stop" || !step.station) continue;
            const frame = frameAt(timeline, layout, dwellMidpoint(step), "full");
            const actor = frame.actors.find((a) => a.id === step.actor);
            expect(actor?.at, `${e.slug} ${pace} ${layout.name} step ${step.index}`).toEqual(
              spotFor(layout, step.station, step.key),
            );
            expect(actor?.walking).toBe(false);
          }
        }
      }
    }
  });

  it("clamps before the start to the first frame, and past the end to the final one", () => {
    for (const e of EXAMPLE_TRACES) {
      const timeline = buildTimeline(e.response, { pace: "readable" });
      for (const layout of LAYOUTS) {
        for (const motion of ["full", "reduced"] as const) {
          const first = frameAt(timeline, layout, 0, motion);
          expect(frameAt(timeline, layout, -500, motion)).toEqual(first);
          expect(frameAt(timeline, layout, timeline.duration + 5000, motion)).toEqual(
            frameAt(timeline, layout, timeline.duration, motion),
          );
        }
      }
    }
  });

  it("puts nothing between two places under reduced motion", () => {
    for (const e of EXAMPLE_TRACES) {
      for (const pace of PACES) {
        const timeline = buildTimeline(e.response, { pace });
        for (const layout of LAYOUTS) {
          const allowed = spots(layout);
          const belt = layout.conveyor;
          for (const t of instants(timeline)) {
            const frame = frameAt(timeline, layout, t, "reduced");
            for (const actor of frame.actors) {
              const label = `${e.slug} ${layout.name} ${actor.id} at ${t}`;
              expect(has(allowed, actor.at), label).toBe(true);
              expect(actor.walking).toBe(false);
              expect(actor.walkFrame).toBe(0);
            }
            for (const crate of frame.crates) {
              // The belt's two ends, or a waiting slot at the bay end.
              const { x, y } = crate.at;
              const onBelt = y === belt[1].y && x >= belt[0].x && x <= belt[1].x;
              const inSlot = x === belt[0].x || (belt[1].x - x) % CRATE_PITCH === 0;
              expect(onBelt && inSlot).toBe(true);
              expect(crate.riding).toBe(false);
            }
          }
        }
      }
    }
  });

  it("draws only what the pixel font can, with no '?' but an open call's", () => {
    for (const e of EXAMPLE_TRACES) {
      for (const pace of PACES) {
        const timeline = buildTimeline(e.response, { pace });
        for (const layout of LAYOUTS) {
          for (const motion of ["full", "reduced"] as Motion[]) {
            for (const t of instants(timeline)) {
              const frame = frameAt(timeline, layout, t, motion);
              for (const { what, text } of canvasText(frame)) {
                const label = `${e.slug} ${pace} ${motion} t=${t.toFixed(0)} ${what} "${text}"`;
                expect([...text].every((c) => FONT_CHARS.includes(c)), label).toBe(true);
                if (text.includes("?")) expect(text, label).toBe("?");
              }
              for (const actor of frame.actors) {
                if (actor.bubble !== null) expect(actor.bubble.length).toBeLessThanOrEqual(10);
              }
            }
          }
        }
      }
    }
  });

  it("puts the '?' on exactly the helper whose call never ended, and keeps it parked", () => {
    const timeline = buildTimeline(response("cold-search"), { pace: "readable" });
    const open = timeline.steps.find((s) => s.station === "gemini")!;
    const later = frameAt(timeline, WIDE, open.t1 + 5000, "full");
    const helper = later.actors.find((a) => a.id === open.actor);
    expect(helper?.bubble).toBe("?");
    expect(helper?.at).toEqual(spotFor(WIDE, "gemini", null));
    expect(later.stations.gemini.busy).toBe(true);
    expect(later.stations.gemini.lamp).toBe("open");
  });

  it("spawns a helper at the runner, and lets it vanish once its call has ended", () => {
    // The runner waits on Currents while a Postgres read runs alongside it.
    const base = response("cache-hit");
    const concurrent: TraceReadResponse = {
      ...base,
      trace: {
        ...base.trace,
        ms: 200,
        touches: [
          {
            station: "currents",
            at: 0,
            ms: 150,
            outcome: "ok",
            call: "search",
            priority: "interactive",
          },
          {
            station: "postgres",
            at: 20,
            ms: 5,
            outcome: "ok",
            operation: "select",
            tables: ["articles"],
          },
        ],
      },
    };
    const timeline = buildTimeline(concurrent, { pace: "readable" });
    const errand = timeline.steps.find((s) => s.actor === "helper-1")!;
    const actor = (t: number, id: string) =>
      frameAt(timeline, WIDE, t, "full").actors.find((a) => a.id === id);
    const runner = (t: number) => actor(t, "runner")!;
    const helper = (t: number) => actor(t, "helper-1");
    expect(helper(errand.t0 - 1)).toBeUndefined();
    expect(helper(errand.t0)?.at).toEqual(runner(errand.t0).at);
    expect(helper(dwellMidpoint(errand))?.at).toEqual(spotFor(WIDE, "postgres", null));
    expect(helper(errand.t1 + 1)).toBeUndefined();
    // A trace with nothing concurrent has no helper at any instant.
    const quiet = buildTimeline(response("cache-hit"), { pace: "readable" });
    for (const t of instants(quiet)) {
      expect(frameAt(quiet, WIDE, t, "full").actors.filter((a) => a.role === "helper")).toEqual([]);
    }
  });

  it("closes Google News behind a shutter when the environment turns it off", () => {
    const base = response("storyline-open");
    const off: TraceReadResponse = {
      ...base,
      trace: {
        ...base.trace,
        origin: {
          ...base.trace.origin!,
          environment: { ...base.trace.origin!.environment, googleNews: "off" },
        },
      },
    };
    const frame = frameAt(buildTimeline(off, { pace: "readable" }), WIDE, 0, "full");
    expect(frame.stations.google_news).toMatchObject({ shutter: true, tag: "OFF", lamp: null });
    expect(frame.stations.gemini.shutter).toBe(false);
    const live = frameAt(buildTimeline(base, { pace: "readable" }), WIDE, 0, "full");
    expect(live.stations.google_news.shutter).toBe(false);
  });

  it("shuts Gemini when neither the labeler nor the summaries can call it", () => {
    const base = response("cache-hit");
    const env = { ...base.trace.origin!.environment, labeler: false, summaries: false };
    const origin = { ...base.trace.origin!, environment: env };
    const off = { ...base, trace: { ...base.trace, origin } };
    const frame = frameAt(buildTimeline(off, { pace: "readable" }), TALL, 0, "full");
    expect(frame.stations.gemini.shutter).toBe(true);
  });

  it("opens the cold instance on a COLD START banner, then says Redis is still connecting", () => {
    const timeline = buildTimeline(response("cold-instance"), { pace: "readable" });
    const arrive = timeline.steps[0]!;
    expect(frameAt(timeline, WIDE, arrive.t0, "full").banner).toBe("COLD START");
    const midway = (arrive.t0 + arrive.t1) / 2;
    expect(frameAt(timeline, WIDE, midway, "reduced").banner).toBe("COLD START");
    const first = timeline.steps.find((s) => s.actor === "runner" && s.kind === "stop")!;
    expect(frameAt(timeline, WIDE, dwellMidpoint(first), "full").banner).toBe("REDIS CONNECTING");
    // A warm instance shows no banner on arrival.
    const warm = buildTimeline(response("cache-hit"), { pace: "readable" });
    expect(frameAt(warm, WIDE, 0, "full").banner).toBeNull();
  });

  it("fast-forwards an elision and a redelivery with banners that say so", () => {
    const timeline = buildTimeline(response("cold-search"), { pace: "readable" });
    const elided = timeline.steps.find((s) => s.kind === "elided" && s.part.kind === "request")!;
    expect(frameAt(timeline, WIDE, dwellMidpoint(elided), "full").banner).toBe("×181 FAST-FORWARD");
    const later = timeline.steps.find((s) => s.kind === "later")!;
    expect(frameAt(timeline, WIDE, (later.t0 + later.t1) / 2, "full").banner).toBe("+302 S LATER");
  });

  it("flags a 429 at the turnstile and walks the runner back out with it", () => {
    const timeline = buildTimeline(response("rate-limited"), { pace: "readable" });
    const [, limiter, respond] = timeline.steps;
    const atTurnstile = frameAt(timeline, WIDE, dwellMidpoint(limiter!), "full");
    expect(atTurnstile.banner).toBe("429");
    expect(atTurnstile.stations.rate_limit).toMatchObject({ busy: true, lamp: "limited" });
    expect(atTurnstile.actors[0]?.bubble).toBe("429");
    const leaving = frameAt(timeline, WIDE, respond!.t0 + respond!.walk / 2, "full");
    expect(leaving.actors[0]).toMatchObject({ walking: true, carrying: "parcel" });
    expect(frameAt(timeline, WIDE, timeline.duration, "full").actors[0]?.at).toEqual(WIDE.door);
  });

  it("gives the runner its ticket, a crate at the hatch, and the parcel on the way out", () => {
    const timeline = buildTimeline(response("cold-search"), { pace: "readable" });
    const runnerAt = (t: number) =>
      frameAt(timeline, WIDE, t, "full").actors.find((a) => a.id === "runner")!;
    expect(runnerAt(0)).toMatchObject({ carrying: "ticket", at: WIDE.door });
    const hatch = timeline.steps.find((s) => s.station === "queue")!;
    expect(runnerAt(dwellMidpoint(hatch)).carrying).toBe("crate");
    const respond = timeline.steps.find((s) => s.kind === "respond")!;
    expect(runnerAt(dwellMidpoint(respond))).toMatchObject({ carrying: "parcel", bubble: "200" });
    expect(frameAt(timeline, WIDE, respond.t0, "full").responded).toBe(true);
    expect(frameAt(timeline, WIDE, respond.t0 - 1, "full").responded).toBe(false);
  });

  it("advances the walk frame with the distance walked, and rests it while standing", () => {
    const timeline = buildTimeline(response("cold-search"), { pace: "readable" });
    const walk = timeline.steps.find((s) => s.kind === "stop" && s.station === "postgres")!;
    const phases = new Set<number>();
    for (let t = walk.t0 + 1; t < walk.t0 + walk.walk; t += 10) {
      const runner = frameAt(timeline, WIDE, t, "full").actors[0]!;
      expect(runner.walking).toBe(true);
      phases.add(runner.walkFrame);
    }
    expect(phases.size).toBe(4);
    const standing = frameAt(timeline, WIDE, dwellMidpoint(walk), "full").actors[0]!;
    expect(standing).toMatchObject({ walking: false, walkFrame: 0 });
  });

  it("has workers pick their crates up at the bay, carry them, and stamp the result", () => {
    const r = response("cold-search");
    const timeline = buildTimeline(r, { pace: "readable" });
    const pickup = timeline.steps.find((s) => s.kind === "run")!;
    const before = frameAt(timeline, WIDE, pickup.t0, "full");
    expect(before.crates.some((c) => c.ref === pickup.jobRef)).toBe(true);
    const holding = frameAt(timeline, WIDE, dwellMidpoint(pickup), "full");
    const worker = holding.actors.find((a) => a.id === pickup.actor);
    expect(worker).toMatchObject({ carrying: "crate", at: WIDE.bay });
    expect(holding.crates.some((c) => c.ref === pickup.jobRef)).toBe(false);

    const threw = r.runs.findIndex((run) => run.result === "threw");
    const end = timeline.steps.find(
      (s) => s.kind === "run_end" && s.part.kind === "run" && s.part.run === threw,
    )!;
    const stamping = frameAt(timeline, WIDE, dwellMidpoint(end) + 1, "full");
    const stamper = stamping.actors.find((a) => a.id === end.actor);
    expect(stamper).toMatchObject({ stamp: "fail", bubble: "✗ UPSTREAM" });
    // A crate whose run threw goes back on the bay for the redelivery.
    const waiting = frameAt(timeline, WIDE, end.t1 + 1, "full");
    expect(waiting.crates.some((c) => c.ref === "4")).toBe(true);
    expect(frameAt(timeline, WIDE, timeline.duration, "full").crates).toEqual([]);
  });

  it("says a crate rides exactly while its trip is under way, never under reduced motion", () => {
    // `drawList.ts` runs the belt off this flag: a riding crate snapped to whole
    // pixels passes through the very x a waiting crate stands at (a CRATE_PITCH
    // step from the bay), so no reading of its position can stand in for it.
    for (const slug of ["cold-search", "storyline-open"]) {
      const timeline = buildTimeline(response(slug), { pace: "readable" });
      const inTrip = (ref: string, t: number) =>
        timeline.crates.some((c) => c.ref === ref && c.t0 <= t && t < c.t1);
      for (const layout of LAYOUTS) {
        let rode = 0;
        for (let t = 0; t <= timeline.duration; t += 5) {
          for (const crate of frameAt(timeline, layout, t, "full").crates) {
            expect(crate.riding, `${slug} ${layout.name} crate ${crate.ref} at ${t}`).toBe(
              inTrip(crate.ref, t),
            );
            if (crate.riding) rode += 1;
          }
          for (const crate of frameAt(timeline, layout, t, "reduced").crates) {
            expect(crate.riding).toBe(false);
          }
        }
        expect(rode, `${slug} ${layout.name}`).toBeGreaterThan(0);
      }
    }
  });

  it("walks a worker home after its run and leaves the other workers resting there", () => {
    const timeline = buildTimeline(response("cache-hit"), { pace: "readable" });
    const frame = frameAt(timeline, TALL, 0, "full");
    const workers = frame.actors.filter((a) => a.role === "worker");
    expect(workers.map((w) => w.at)).toEqual([...TALL.homes]);
    const cold = buildTimeline(response("cold-search"), { pace: "readable" });
    // A worker with nothing queued after its run (worker-1 goes straight on to the
    // redelivery, so pick one that does not).
    const end = cold.steps.find(
      (s) =>
        s.kind === "run_end" &&
        !cold.steps.some(
          (n) => n.actor === s.actor && n.t0 >= s.t1 && n.t0 < s.t1 + PACING.walkMs + 1,
        ),
    )!;
    const worker = (t: number) =>
      frameAt(cold, WIDE, t, "full").actors.find((a) => a.id === end.actor);
    const halfway = worker(end.t1 + PACING.walkMs / 2);
    expect(halfway).toMatchObject({ walking: true, carrying: null, bubble: null });
    const home = worker(end.t1 + PACING.walkMs + 1);
    expect(WIDE.homes).toContainEqual(home?.at);
  });

  it("keeps a lamp and a bin for what each station last answered", () => {
    const timeline = buildTimeline(response("quota-degraded"), { pace: "readable" });
    const refused = timeline.steps.find((s) => s.station === "currents")!;
    expect(frameAt(timeline, WIDE, refused.t0, "full").stations.currents.lamp).toBeNull();
    const after = frameAt(timeline, WIDE, refused.t1 + 1, "full");
    expect(after.stations.currents).toMatchObject({ lamp: "refused", busy: false });
    expect(after.bins).toMatchObject({
      page_cache: "miss",
      reference: "hit",
      fill_lock: "acquired",
    });
    const released = frameAt(timeline, WIDE, timeline.duration, "full");
    expect(released.bins.fill_lock).toBe("released");
  });

  it("reads the request's clock, then each job's own", () => {
    const timeline = buildTimeline(response("cold-search"), { pace: "readable" });
    expect(frameAt(timeline, WIDE, 0, "full").clock).toBe("T+0.0MS");
    const currents = timeline.steps.find(
      (s) => s.station === "currents" && s.part.kind === "request",
    )!;
    expect(frameAt(timeline, WIDE, currents.t1, "full").clock).toBe("T+727MS");
    const run = timeline.steps.find((s) => s.kind === "run")!;
    expect(frameAt(timeline, WIDE, run.t0, "full").clock).toBe(`JOB ${run.jobRef} T+0.0MS`);
    const respond = timeline.steps.find((s) => s.kind === "respond")!;
    expect(frameAt(timeline, WIDE, respond.t1 - 1, "full").clock).toBe("T+1.2S");
  });

  it("reports the step the transport would call current", () => {
    const timeline = buildTimeline(response("storyline-open"), { pace: "readable" });
    for (const t of instants(timeline)) {
      expect(frameAt(timeline, WIDE, t, "full").stepIndex).toBe(stepAt(timeline, t));
    }
  });

  it("opens the door while the runner comes in and goes out", () => {
    const timeline = buildTimeline(response("cache-hit"), { pace: "readable" });
    const respond = timeline.steps.find((s) => s.kind === "respond")!;
    const middle = timeline.steps.find((s) => s.station === "redis")!;
    expect(frameAt(timeline, WIDE, 0, "full").doorOpen).toBe(true);
    expect(frameAt(timeline, WIDE, dwellMidpoint(middle), "full").doorOpen).toBe(false);
    expect(frameAt(timeline, WIDE, respond.t0 + 1, "full").doorOpen).toBe(true);
  });

  it("uses whole pixels for every actor and crate", () => {
    for (const e of EXAMPLE_TRACES) {
      const timeline = buildTimeline(e.response, { pace: "readable" });
      for (const t of instants(timeline)) {
        const frame = frameAt(timeline, TALL, t, "full");
        for (const p of [...frame.actors.map((a) => a.at), ...frame.crates.map((c) => c.at)]) {
          expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
        }
      }
    }
  });
});
