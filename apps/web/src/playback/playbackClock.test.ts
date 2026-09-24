import { describe, expect, it } from "vitest";
import { buildTimeline, stepAt, type Step } from "./choreography.js";
import { EXAMPLE_TRACES, exampleBySlug } from "./exampleTraces.js";
import {
  SPEEDS,
  STEP_HOLD_MS,
  carryAcrossPace,
  initialTransport,
  keyLegend,
  keyToAction,
  stepNames,
  transport,
  withMotion,
  type KeyInput,
  type Transport,
  type TransportAction,
} from "./playbackClock.js";

/**
 * The transport (ADR-0029, "The page is an operator's view on `/`") and its
 * keyboard.
 *
 * The regressions this catches are the ones a keyboard or screen-reader user hits
 * first: a Space that toggles twice on a focused button (native click plus our
 * handler), arrows that die the moment a button has focus, a step-forward that
 * cannot get past two overlapping steps, a reduced-motion Play that does nothing,
 * letter shortcuts nobody can turn off (WCAG 2.1.4), a pace change that moves the
 * reader onto a different step, and reduced motion turned on mid-play swapping
 * the stage for a map while the transport plays on.
 */

const timeline = buildTimeline(exampleBySlug("cold-search")!.response, { pace: "readable" });
const at = (overrides: Partial<Transport> = {}): Transport => ({
  ...initialTransport({ autoplay: false, speed: 1, mode: "animated" }),
  ...overrides,
});
const run = (state: Transport, ...actions: TransportAction[]) =>
  actions.reduce((s, a) => transport(s, a, timeline), state);

describe("initialTransport", () => {
  it("starts at zero, playing only when autoplay is allowed", () => {
    expect(initialTransport({ autoplay: true, speed: 2, mode: "animated" })).toEqual({
      status: "playing",
      t: 0,
      speed: 2,
      mode: "animated",
      held: 0,
    });
    expect(initialTransport({ autoplay: false, speed: 1, mode: "stepped" }).status).toBe("paused");
  });
});

describe("transport: ticks", () => {
  it("advances an animated playback by dt × speed", () => {
    expect(run(at({ status: "playing" }), { type: "tick", dtMs: 100 }).t).toBe(100);
    expect(run(at({ status: "playing", speed: 4 }), { type: "tick", dtMs: 100 }).t).toBe(400);
    expect(run(at({ status: "playing", speed: 0.5 }), { type: "tick", dtMs: 100 }).t).toBe(50);
  });

  it("ignores ticks unless playing", () => {
    const paused = at({ t: 500 });
    expect(run(paused, { type: "tick", dtMs: 100 })).toBe(paused);
  });

  it("clamps at the end and ends", () => {
    const nearlyDone = at({ status: "playing", t: timeline.duration - 10 });
    const end = run(nearlyDone, { type: "tick", dtMs: 100 });
    expect(end).toMatchObject({ t: timeline.duration, status: "ended" });
  });

  it("holds each step for STEP_HOLD_MS when stepped, then jumps to the next step's start", () => {
    const start = at({ status: "playing", mode: "stepped" });
    const held = run(start, { type: "tick", dtMs: STEP_HOLD_MS - 1 });
    expect(held).toMatchObject({ t: 0, held: STEP_HOLD_MS - 1 });
    const jumped = run(held, { type: "tick", dtMs: 1 });
    expect(jumped).toMatchObject({ t: timeline.steps[1]!.t0, held: 0, status: "playing" });
  });

  it("speeds the stepped cadence up with the speed", () => {
    const stepped = at({ status: "playing", mode: "stepped", speed: 4 });
    const fast = run(stepped, { type: "tick", dtMs: STEP_HOLD_MS / 4 });
    expect(fast.t).toBe(timeline.steps[1]!.t0);
  });

  it("ends stepped playback after the last step", () => {
    const last = timeline.steps.at(-1)!;
    const onLast = at({ status: "playing", mode: "stepped", t: last.t0 });
    const ended = run(onLast, { type: "tick", dtMs: STEP_HOLD_MS });
    expect(ended).toMatchObject({ t: timeline.duration, status: "ended" });
  });
});

describe("transport: play, pause, toggle, restart, end", () => {
  it("toggles playing and paused, and restarts from the end", () => {
    expect(run(at({ status: "playing" }), { type: "toggle" }).status).toBe("paused");
    expect(run(at(), { type: "toggle" }).status).toBe("playing");
    expect(run(at({ status: "ended", t: timeline.duration }), { type: "toggle" })).toMatchObject({
      status: "playing",
      t: 0,
    });
  });

  it("plays and pauses explicitly", () => {
    expect(run(at(), { type: "play" }).status).toBe("playing");
    const again = run(at({ status: "ended", t: 99 }), { type: "play" });
    expect(again).toMatchObject({ status: "playing", t: 0 });
    expect(run(at({ status: "playing" }), { type: "pause" }).status).toBe("paused");
    expect(run(at({ status: "ended" }), { type: "pause" }).status).toBe("ended");
  });

  it("restarts to zero keeping the status, except that an ended playback becomes paused", () => {
    const restarted = run(at({ status: "playing", t: 900 }), { type: "restart" });
    expect(restarted).toMatchObject({ t: 0, status: "playing" });
    expect(run(at({ status: "ended", t: timeline.duration }), { type: "restart" })).toMatchObject({
      t: 0,
      status: "paused",
    });
  });

  it("jumps to the end, ended", () => {
    const end = run(at({ status: "playing" }), { type: "end" });
    expect(end).toMatchObject({ t: timeline.duration, status: "ended" });
  });
});

describe("transport: step and seek", () => {
  it("steps forward to the next step's start, pausing", () => {
    const next = run(at({ status: "playing", t: 1 }), { type: "step", delta: 1 });
    expect(next).toMatchObject({ t: timeline.steps[1]!.t0, status: "paused" });
  });

  it("gets through every step, overlapping ones included, and then ends", () => {
    let state = at();
    const landed = new Set<number>();
    for (let i = 0; i < timeline.steps.length + 5 && state.status !== "ended"; i += 1) {
      state = run(state, { type: "step", delta: 1 });
      landed.add(stepAt(timeline, state.t));
    }
    expect(state.status).toBe("ended");
    // Every step start was visited on the way: `buildTimeline` promises strictly increasing
    // starts (`separateTies`, choreography.ts), so no two steps can share one.
    for (const step of timeline.steps.slice(1)) expect(landed.has(step.index)).toBe(true);
  });

  it("steps back to this step's start mid-dwell, and to the previous one near its start", () => {
    const step = timeline.steps[5]!;
    expect(run(at({ t: step.t0 + 400 }), { type: "step", delta: -1 }).t).toBe(step.t0);
    const back = run(at({ t: step.t0 + 100 }), { type: "step", delta: -1 });
    expect(back.t).toBe(timeline.steps[4]!.t0);
    expect(run(at({ t: 0 }), { type: "step", delta: -1 }).t).toBe(0);
  });

  it("seeks to a step's start, pausing, with the index clamped", () => {
    expect(run(at({ status: "playing" }), { type: "seek", stepIndex: 7 })).toMatchObject({
      t: timeline.steps[7]!.t0,
      status: "paused",
    });
    expect(run(at(), { type: "seek", stepIndex: 9999 }).t).toBe(timeline.steps.at(-1)!.t0);
    expect(run(at(), { type: "seek", stepIndex: -3 }).t).toBe(0);
  });
});

describe("transport: speed and mode", () => {
  it("keeps t across speed changes, and stays within SPEEDS", () => {
    const state = at({ t: 777, speed: 1 });
    expect(run(state, { type: "faster" })).toMatchObject({ t: 777, speed: 2 });
    expect(run(state, { type: "faster" }, { type: "faster" }, { type: "faster" }).speed).toBe(4);
    expect(run(state, { type: "slower" }, { type: "slower" }).speed).toBe(0.5);
    expect(run(state, { type: "speed", speed: 4 })).toMatchObject({ t: 777, speed: 4 });
    expect(run(state, { type: "speed", speed: 3 as never }).speed).toBe(1);
    expect([...SPEEDS]).toEqual([0.5, 1, 2, 4]);
  });

  it("switches mode keeping t and resetting the hold", () => {
    const held = at({ t: 300, held: 500, mode: "stepped" });
    const switched = run(held, { type: "mode", mode: "animated" });
    expect(switched).toMatchObject({ t: 300, held: 0, mode: "animated" });
  });
});

describe("keyToAction", () => {
  const key = (
    k: string,
    target: KeyInput["target"] = { tagName: "BODY" },
    mods: Partial<KeyInput> = {},
  ) => keyToAction({ key: k, ctrlKey: false, metaKey: false, altKey: false, target, ...mods });

  it("maps the transport keys", () => {
    expect(key(" ")).toEqual({ type: "toggle" });
    expect(key("Spacebar")).toEqual({ type: "toggle" });
    expect(key("k")).toEqual({ type: "toggle" });
    expect(key("ArrowRight")).toEqual({ type: "step", delta: 1 });
    expect(key("l")).toEqual({ type: "step", delta: 1 });
    expect(key("ArrowLeft")).toEqual({ type: "step", delta: -1 });
    expect(key("j")).toEqual({ type: "step", delta: -1 });
    expect(key("Home")).toEqual({ type: "restart" });
    expect(key("End")).toEqual({ type: "end" });
    for (const k of ["]", "+", "="]) expect(key(k)).toEqual({ type: "faster" });
    for (const k of ["[", "-"]) expect(key(k)).toEqual({ type: "slower" });
  });

  it("leaves Enter and every other key alone", () => {
    expect(key("Enter")).toBeNull();
    expect(key("a")).toBeNull();
    expect(key("Tab")).toBeNull();
  });

  it("leaves shortcuts with Ctrl, Meta or Alt to the browser", () => {
    expect(key("k", undefined, { ctrlKey: true })).toBeNull();
    expect(key("ArrowRight", undefined, { metaKey: true })).toBeNull();
    expect(key(" ", undefined, { altKey: true })).toBeNull();
  });

  it("never steals a key from someone typing", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "input"]) {
      expect(key("k", { tagName })).toBeNull();
      expect(key(" ", { tagName })).toBeNull();
      expect(key("ArrowLeft", { tagName })).toBeNull();
    }
    expect(key("j", { tagName: "DIV", isContentEditable: true })).toBeNull();
  });

  it("leaves Space to a focused button, link or summary, but keeps arrows and letters", () => {
    for (const tagName of ["BUTTON", "A", "SUMMARY"]) {
      expect(key(" ", { tagName })).toBeNull();
      expect(key("ArrowRight", { tagName })).toEqual({ type: "step", delta: 1 });
      expect(key("k", { tagName })).toEqual({ type: "toggle" });
    }
  });

  it("copes with an event that has no target", () => {
    expect(key(" ", null)).toEqual({ type: "toggle" });
  });
});

describe("keyToAction with the letter shortcuts off", () => {
  const key = (k: string, tagName = "BODY") =>
    keyToAction(
      { key: k, ctrlKey: false, metaKey: false, altKey: false, target: { tagName } },
      { letters: false },
    );

  it("maps no character key at all", () => {
    for (const k of ["k", "K", "l", "L", "j", "J", "]", "+", "=", "[", "-"]) {
      expect(key(k)).toBeNull();
      expect(key(k, "BUTTON")).toBeNull();
    }
  });

  it("keeps Space, the arrows, Home and End, which no dictated word can type", () => {
    expect(key(" ")).toEqual({ type: "toggle" });
    expect(key(" ", "BUTTON")).toBeNull();
    expect(key("ArrowRight")).toEqual({ type: "step", delta: 1 });
    expect(key("ArrowLeft")).toEqual({ type: "step", delta: -1 });
    expect(key("Home")).toEqual({ type: "restart" });
    expect(key("End")).toEqual({ type: "end" });
  });

  it("leaves the letters on unless asked", () => {
    const k = { key: "l", ctrlKey: false, metaKey: false, altKey: false, target: null };
    expect(keyToAction(k)).toEqual({ type: "step", delta: 1 });
    expect(keyToAction(k, { letters: true })).toEqual({ type: "step", delta: 1 });
  });
});

describe("keyLegend", () => {
  it("lists every mapped action once", () => {
    const legend = keyLegend(true);
    expect(legend).toHaveLength(7);
    expect(new Set(legend.map((k) => k.action)).size).toBe(7);
  });

  it("names no letter while the letters are off, and only keys that still work", () => {
    const legend = keyLegend(false);
    expect(legend.map((k) => k.keys)).toEqual(["Space", "→", "←", "Home", "End"]);
    const pressed: Record<string, string> = { Space: " ", "→": "ArrowRight", "←": "ArrowLeft" };
    for (const { keys } of legend) {
      const key = pressed[keys] ?? keys;
      const input = { key, ctrlKey: false, metaKey: false, altKey: false, target: null };
      expect(keyToAction(input, { letters: false })).not.toBeNull();
    }
  });
});

/** What a step IS, pace aside: the fields its real offsets fix. */
const identity = (step: Step) => ({
  part: step.part,
  kind: step.kind,
  station: step.station,
  key: step.key,
  realAt: step.realAt,
  realMs: step.realMs,
  jobRef: step.jobRef,
});

describe("carryAcrossPace", () => {
  const paused = (t: number) => at({ t, status: "paused" });

  it("names every step once, and the same steps at both paces", () => {
    for (const example of EXAMPLE_TRACES) {
      const readable = buildTimeline(example.response, { pace: "readable" });
      const real = buildTimeline(example.response, { pace: "real" });
      const names = stepNames(readable);
      expect(new Set(names).size, example.slug).toBe(names.length);
      expect([...stepNames(real)].sort(), example.slug).toEqual([...names].sort());
    }
  });

  it("lands on the same step, not the same index, both ways, in every example", () => {
    let reordered = 0;
    for (const example of EXAMPLE_TRACES) {
      const readable = buildTimeline(example.response, { pace: "readable" });
      const real = buildTimeline(example.response, { pace: "real" });
      for (const [from, to] of [
        [readable, real],
        [real, readable],
      ] as const) {
        from.steps.forEach((step, i) => {
          const carried = carryAcrossPace(paused(step.t0), from, to);
          const landed = to.steps[stepAt(to, carried.t)]!;
          expect(identity(landed), `${example.slug} ${from.pace} step ${i + 1}`).toEqual(
            identity(step),
          );
          expect(carried.t).toBe(landed.t0);
          if (JSON.stringify(identity(to.steps[i]!)) !== JSON.stringify(identity(step))) {
            reordered += 1;
          }
        });
      }
    }
    // The premise: the paces DO order the steps differently, so carrying the
    // index — what the page did — would land somewhere else.
    expect(reordered).toBeGreaterThan(0);
  });

  it("keeps a playing transport playing, resets the hold, and an ended one at its end", () => {
    const readable = buildTimeline(exampleBySlug("cold-search")!.response, { pace: "readable" });
    const real = buildTimeline(exampleBySlug("cold-search")!.response, { pace: "real" });
    const playing = at({ t: readable.steps[10]!.t0 + 5, status: "playing", held: 300 });
    expect(carryAcrossPace(playing, readable, real)).toMatchObject({ status: "playing", held: 0 });
    const ended = at({ t: readable.duration, status: "ended" });
    expect(carryAcrossPace(ended, readable, real)).toMatchObject({
      status: "ended",
      t: real.duration,
    });
  });
});

describe("withMotion", () => {
  it("steps from here on when reduced motion comes on, and glides when it goes off", () => {
    const on = withMotion(at({ t: 300, held: 200, mode: "animated" }), true, timeline);
    expect(on.state).toMatchObject({ t: 300, held: 0, mode: "stepped" });
    const off = withMotion(at({ mode: "stepped" }), false, timeline);
    expect(off).toMatchObject({ state: { mode: "animated" }, takesOver: false });
  });

  it("counts reduced motion arriving mid-play as the reader having taken over", () => {
    // The regression: the stage swapped to the before-Play overview while the
    // transport kept playing under it, Pause pressed and the steps advancing.
    const playing = withMotion(at({ status: "playing" }), true, timeline);
    expect(playing).toMatchObject({ state: { status: "playing" }, takesOver: true });
  });

  it("leaves a paused reader the overview, which Play then steps through", () => {
    expect(withMotion(at({ status: "paused" }), true, timeline).takesOver).toBe(false);
    const ended = at({ status: "ended", t: timeline.duration });
    expect(withMotion(ended, true, timeline).takesOver).toBe(false);
  });

  it("changes nothing when the mode already matches", () => {
    const state = at({ mode: "stepped", status: "playing" });
    expect(withMotion(state, true, timeline)).toEqual({ state, takesOver: false });
  });
});
