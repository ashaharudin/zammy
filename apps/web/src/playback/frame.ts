/**
 * One frame of the playback, as data (ADR-0029): where every robot stands at
 * animation time t, what it carries and says, which machines are busy, what each
 * Redis bin last answered, where the crates are, and what the HUD reads.
 *
 * `frameAt(timeline, layout, t, motion)` is a pure function of its arguments —
 * no clock, no state carried between frames — so the transport can seek, step
 * backwards and change speed freely, and a test can ask for any instant of any
 * example in either plan. The renderer (`drawList.ts` → `renderer.ts`) turns the
 * result into draw calls; this module never draws.
 *
 * How the robots move:
 *  - The RUNNER stands at the door during `arrive` with its ticket, walks each
 *    stop's first `walk` ms along `walkPath` and dwells at the station, carries a
 *    crate to the hatch for an enqueue, and walks the parcel back to the door in
 *    `respond` (a 429 never got past the turnstile, so it walks back from there).
 *  - A HELPER spawns wherever the runner is at its step's t0 and vanishes at t1 —
 *    unless its call never ended, in which case it stays parked there saying "?".
 *  - A WORKER waits at its home, walks to the bay to pick its crate up, carries it
 *    round its stations, stamps ✓ or ✗ back at the bay, and walks home. A crate
 *    whose run threw goes back on the bay for the redelivery.
 *  - The walk frame advances with DISTANCE walked, not with time, so a long dash
 *    and a short shuffle both look like legs.
 *
 * Under REDUCED motion nothing is ever between two places: every actor stands at
 * its current step's spot, crates snap to the ends of the belt, and no walk frame
 * advances. The information is identical; only the travel is gone.
 *
 * Every string in the result is canvas text, so every one is uppercase and made
 * of the pixel font's characters (`frame.test.ts` checks every example at many
 * instants). The one `?` is intended: a call with no observed end.
 *
 * The frame says what the picture shows, never how to paint it, but it does say
 * everything `drawList.ts` would otherwise have to re-derive from positions:
 * `ActorPose.thinking` (a gear over an actor in a `think` step), `ActorPose.stamp`
 * (the ✓/✗ stamp at the bay), `CratePose.riding` (whether the belt runs) and
 * `FrameState.doorOpen` (the door sprite's frame).
 */
import {
  Station,
  type RedisKeyClass,
  type TouchOutcome,
  type TraceEnvironment,
} from "@zammy/shared/request-trace";
import {
  ACTOR_IDS,
  PACING,
  realClockAt,
  stepAt,
  type ActorId,
  type Step,
  type Timeline,
} from "./choreography.js";
import {
  pathLength,
  pathTurnsSideways,
  pointAlong,
  spotFor,
  walkPath,
  type FloorLayout,
  type Point,
} from "./layout.js";
import { CAPTION_MAX, canvasMs, captionFor, stationPlate } from "./stepText.js";

export type Motion = "full" | "reduced";

/** One robot at one instant. */
export interface ActorPose {
  id: ActorId;
  role: "runner" | "helper" | "worker";
  /** Feet position, whole logical pixels. */
  at: Point;
  facing: -1 | 1;
  walking: boolean;
  /** Phase of the walk cycle (sprite frame = 1 + walkFrame while walking, 0 standing). */
  walkFrame: 0 | 1 | 2 | 3;
  carrying: "ticket" | "parcel" | "crate" | null;
  /** Font-safe, at most 10 glyphs. */
  bubble: string | null;
  tone: Step["tone"];
  /** In a `think` step: the code is working between touches (draw the gear). */
  thinking: boolean;
  /** Stamping its crate at the bay at the end of a run. */
  stamp: "ok" | "fail" | null;
}

/** One machine at one instant. */
export interface StationState {
  /** An actor is dwelling at it (or parked at it with an open call). */
  busy: boolean;
  /** The outcome of the latest stop to reach it; null before any. */
  lamp: TouchOutcome | null;
  /** `stationPlate(station, env)`. */
  plate: string;
  /** "FIXTURE", "BULLMQ", "VQS", "+GNEWS", "OFF", or null. */
  tag: string | null;
  /** Shut: Google News when it is off; Gemini when neither labeler nor summaries can call it. */
  shutter: boolean;
}

/** A crate on the conveyor or waiting at the bay. */
export interface CratePose {
  ref: string;
  /** Font-safe: the job ref. */
  label: string;
  /** The crate sprite's bottom-centre anchor, whole logical pixels. */
  at: Point;
  /**
   * Carried along the belt right now: inside its trip's [t0, t1) under full
   * motion. False for a crate waiting at the bay, and for every crate under
   * reduced motion, which stands at the hatch end rather than riding. The belt
   * runs while any crate rides (`drawList.ts` beltOps) — said here, because a
   * riding crate snapped to whole pixels passes through the very x a waiting
   * one stands at, so its position cannot tell the two apart.
   */
  riding: boolean;
}

export interface FrameState {
  /** The instant drawn, clamped to [0, duration]. */
  t: number;
  stepIndex: number;
  actors: readonly ActorPose[];
  stations: Readonly<Record<Station, StationState>>;
  bins: Readonly<Partial<Record<RedisKeyClass, TouchOutcome>>>;
  crates: readonly CratePose[];
  /** "COLD START", "REDIS CONNECTING", "+302 S LATER", "×181 FAST-FORWARD", "429". */
  banner: string | null;
  /** "T+312MS", "JOB 2 T+1.4S". */
  clock: string;
  /** The response has left: t ≥ responseAt. */
  responded: boolean;
  /** The runner is passing through the door. */
  doorOpen: boolean;
}

/** Logical px walked per walk-cycle phase. */
export const WALK_STRIDE_PX = 3;
/** How far apart crates waiting at the bay stand along the belt (a crate is 8 wide). */
export const CRATE_PITCH = 9;
const BUBBLE_CAPTION_SHARE = 2 / 3;

const MOVING_KINDS: ReadonlySet<Step["kind"]> = new Set([
  "stop",
  "elided",
  "respond",
  "run",
  "run_end",
  "unobserved",
]);

/**
 * How long a step spends walking on screen. The timing's own `walk` when it has
 * one; at real pace (walk 0) a short arrival phase — at most a third of the step
 * — so actors still travel instead of teleporting, and still arrive long before
 * the dwell's midpoint. Nothing walks under reduced motion.
 */
function walkWindow(step: Step, motion: Motion): number {
  if (motion === "reduced" || !MOVING_KINDS.has(step.kind)) return 0;
  if (step.walk > 0) return step.walk;
  return Math.min(PACING.walkMs, (step.t1 - step.t0) / 3);
}

const dwellStart = (step: Step, motion: Motion) => step.t0 + walkWindow(step, motion);
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const snap = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });

const byActorCache = new WeakMap<Timeline, ReadonlyMap<ActorId, readonly Step[]>>();
function stepsByActor(timeline: Timeline): ReadonlyMap<ActorId, readonly Step[]> {
  let found = byActorCache.get(timeline);
  if (!found) {
    const map = new Map<ActorId, Step[]>(ACTOR_IDS.map((id) => [id, []]));
    for (const step of timeline.steps) map.get(step.actor)!.push(step);
    found = map;
    byActorCache.set(timeline, found);
  }
  return found;
}

function roleOf(id: ActorId): ActorPose["role"] {
  if (id === "runner") return "runner";
  return id.startsWith("helper") ? "helper" : "worker";
}

function homeOf(layout: FloorLayout, id: ActorId): Point {
  const i = Number(id.slice(-1)) - 1;
  return layout.homes[Math.min(2, Math.max(0, i))] as Point;
}

/** Where a step sends its actor; null for steps that stay where the actor is. */
function targetOf(step: Step, layout: FloorLayout): Point | null {
  switch (step.kind) {
    case "arrive":
    case "respond":
      return layout.door;
    case "stop":
      return step.station ? spotFor(layout, step.station, step.key) : null;
    case "elided":
      return step.station ? spotFor(layout, step.station, null) : null;
    case "run":
    case "run_end":
    case "unobserved":
      return layout.bay;
    case "think":
    case "later":
      return null;
  }
}

/** A position part-way along a walk, with its facing and walk phase. */
interface Motionful {
  at: Point;
  facing: -1 | 1;
  walking: boolean;
  walkFrame: 0 | 1 | 2 | 3;
}

function travel(
  layout: FloorLayout,
  from: Point,
  to: Point,
  fraction: number,
  facing: -1 | 1,
): Motionful {
  if (same(from, to)) return { at: to, facing, walking: false, walkFrame: 0 };
  const path = walkPath(layout, from, to);
  const f = Math.min(1, Math.max(0, fraction));
  const along = pointAlong(path, f);
  const sideways = pathTurnsSideways(path);
  const walked = f * pathLength(path);
  return {
    at: snap(along.at),
    facing: sideways ? along.facing : facing,
    walking: f > 0 && f < 1,
    walkFrame: (Math.floor(walked / WALK_STRIDE_PX) % 4) as 0 | 1 | 2 | 3,
  };
}

/** The facing an actor ends a walk with. */
function arrivalFacing(layout: FloorLayout, from: Point, to: Point, facing: -1 | 1): -1 | 1 {
  if (same(from, to)) return facing;
  const path = walkPath(layout, from, to);
  return pathTurnsSideways(path) ? pointAlong(path, 1).facing : facing;
}

/** Everything an actor's pose needs, before bubbles and cargo. */
interface Placed {
  present: boolean;
  motion: Motionful;
  step: Step | null;
  /** The actor is past its step's walk and dwelling (or the step does not move). */
  dwelling: boolean;
  /** 0–1 through the dwell. */
  dwellFraction: number;
  parked: boolean;
}

const absent: Placed = {
  present: false,
  motion: { at: { x: 0, y: 0 }, facing: 1, walking: false, walkFrame: 0 },
  step: null,
  dwelling: false,
  dwellFraction: 0,
  parked: false,
};

interface Context {
  timeline: Timeline;
  layout: FloorLayout;
  motion: Motion;
}

/**
 * Where an actor is at t, found by walking its own steps in order from its
 * resting place (the door for the runner, its home for a worker). A helper step
 * that does not follow straight on from the helper's previous one starts wherever
 * the runner is at that instant — that is what "spawns at the runner" means.
 */
function place(ctx: Context, id: ActorId, t: number): Placed {
  const { layout, motion } = ctx;
  const steps = stepsByActor(ctx.timeline).get(id) ?? [];
  const role = roleOf(id);
  const rest = role === "worker" ? homeOf(layout, id) : layout.door;
  let pos: Point = rest;
  let facing: -1 | 1 = 1;
  let prev: Step | null = null;

  for (const step of steps) {
    if (step.t0 > t) break;
    // Where the actor is as this step begins.
    let origin = pos;
    if (role === "helper" && !(prev && prev.t1 === step.t0)) {
      origin = place(ctx, "runner", step.t0).motion.at;
    } else if (role === "worker" && prev && ends(prev)) {
      const home = homeOf(layout, id);
      const back = (step.t0 - prev.t1) / PACING.walkMs;
      const arrived = motion === "reduced" || back >= 1;
      origin = arrived ? home : travel(layout, pos, home, back, facing).at;
      if (motion === "full") facing = back >= 1 ? arrivalFacing(layout, pos, home, facing) : facing;
    }
    const target = targetOf(step, layout) ?? origin;
    if (t < step.t1) {
      const window = walkWindow(step, motion);
      const start = step.t0 + window;
      if (motion === "full" && t < start && !same(origin, target)) {
        return {
          present: true,
          motion: travel(layout, origin, target, (t - step.t0) / window, facing),
          step,
          dwelling: false,
          dwellFraction: 0,
          parked: false,
        };
      }
      return {
        present: true,
        motion: {
          at: target,
          facing: motion === "full" ? arrivalFacing(layout, origin, target, facing) : facing,
          walking: false,
          walkFrame: 0,
        },
        step,
        dwelling: true,
        dwellFraction: step.t1 > start ? (t - start) / (step.t1 - start) : 1,
        parked: false,
      };
    }
    if (motion === "full") facing = arrivalFacing(layout, origin, target, facing);
    pos = target;
    prev = step;
  }

  // Between steps, or after the last one.
  const standing = (at: Point): Motionful => ({ at, facing, walking: false, walkFrame: 0 });
  if (role === "runner") return { ...absent, present: true, motion: standing(pos), step: prev };
  if (role === "helper") {
    const parked = prev?.kind === "stop" && prev.stop?.realEnd === null;
    if (!parked) return absent;
    return { ...absent, present: true, parked: true, step: prev, motion: standing(pos) };
  }
  // A worker: walking home after its run, or at home.
  const home = homeOf(layout, id);
  if (prev && ends(prev) && motion === "full") {
    const back = (t - prev.t1) / PACING.walkMs;
    if (back < 1) {
      return { ...absent, present: true, motion: travel(layout, pos, home, back, facing) };
    }
    facing = arrivalFacing(layout, pos, home, facing);
  }
  return { ...absent, present: true, motion: standing(home) };
}

/** Steps after which a worker goes home. */
const ends = (step: Step) => step.kind === "run_end" || step.kind === "unobserved";

function bubbleOf(ctx: Context, placed: Placed): string | null {
  if (placed.parked) return "?";
  const step = placed.step;
  if (!step || !placed.dwelling) return null;
  const trace = ctx.timeline.response.trace;
  switch (step.kind) {
    case "stop":
      if (!step.stop) return null;
      if (placed.dwellFraction < BUBBLE_CAPTION_SHARE) return captionFor(step.stop);
      return canvasMs(step.realMs);
    case "elided":
      return step.elided ? `×${step.elided.count}`.slice(0, CAPTION_MAX) : null;
    case "respond":
      return String(trace.status);
    case "run": {
      const label = `JOB ${step.jobRef ?? ""}`;
      return label.length <= CAPTION_MAX ? label : (step.jobRef ?? "").slice(0, CAPTION_MAX);
    }
    case "run_end": {
      const run = step.part.kind === "run" ? ctx.timeline.response.runs[step.part.run] : undefined;
      if (!run || run.result === "ok") return "✓ DONE";
      const failure = run.failure ? FAILURE_STAMPS[run.failure] : "FAILED";
      const text = `✗ ${failure}`;
      return text.length <= CAPTION_MAX ? text : "✗ FAILED";
    }
    case "unobserved":
      return "NO RUN";
    case "arrive":
    case "think":
    case "later":
      return null;
  }
}

/** Short failure words for the ✗ stamp (the full words are in the step list). */
const FAILURE_STAMPS = {
  quota: "QUOTA",
  circuit_open: "TRIPPED",
  timeout: "TIMEOUT",
  caller_aborted: "ABORTED",
  upstream: "UPSTREAM",
  schema: "SCHEMA",
  auth: "AUTH",
  blocked: "BLOCKED",
  invalid_query: "QUERY",
  answered: "ANSWER",
  unreachable: "NO CONN",
  unknown: "FAILED",
} as const;

/** What an actor holds. Only called for an actor inside a step (or parked). */
function carryingOf(role: ActorPose["role"], placed: Placed): ActorPose["carrying"] {
  const step = placed.step;
  if (!step || role === "helper") return null;
  if (role === "runner") {
    if (step.kind === "respond") return "parcel";
    // The runner brings each enqueue to the hatch itself; the crate appears on the belt at t1.
    if (step.kind === "stop" && step.station === "queue") return "crate";
    return "ticket";
  }
  // A worker holds its crate from the pickup at the bay until it is stamped.
  if (step.part.kind !== "run" || step.kind === "later") return null;
  if (step.kind === "run") return placed.dwelling ? "crate" : null;
  if (step.kind === "run_end") {
    const stamped = placed.dwelling && placed.dwellFraction >= 0.5;
    return stamped ? null : "crate";
  }
  return "crate";
}

function tagOf(station: Station, env: TraceEnvironment | null): string | null {
  if (!env) return null;
  switch (station) {
    case "currents":
      return env.currents === "fixture" ? "FIXTURE" : env.gnews ? "+GNEWS" : null;
    case "queue":
      return env.queue === "bullmq" ? "BULLMQ" : "VQS";
    case "google_news":
      return env.googleNews === "off" ? "OFF" : env.googleNews === "fixture" ? "FIXTURE" : null;
    case "gemini":
      return !env.labeler && !env.summaries ? "OFF" : null;
    default:
      return null;
  }
}

function shutterOf(station: Station, env: TraceEnvironment | null): boolean {
  if (!env) return false;
  if (station === "google_news") return env.googleNews === "off";
  if (station === "gemini") return !env.labeler && !env.summaries;
  return false;
}

/** "+2.4 S LATER", "+302 S LATER", "+17 MIN LATER". */
function laterBanner(realMs: number | null): string {
  const s = Math.max(0, (realMs ?? 0) / 1000);
  if (s < 10) return `+${s.toFixed(1)} S LATER`;
  if (s < 1000) return `+${Math.round(s)} S LATER`;
  return `+${Math.round(s / 60)} MIN LATER`;
}

function clockOf(ctx: Context, step: Step | undefined, t: number): string {
  const { timeline, motion } = ctx;
  const trace = timeline.response.trace;
  const traceClock = (): string => {
    const real = realClockAt(timeline, t);
    const value = real ?? (t < timeline.responseAt ? 0 : trace.ms);
    return `T+${canvasMs(value)}`;
  };
  if (!step || step.part.kind !== "run") return traceClock();
  const run = timeline.response.runs[step.part.run];
  if (!run) return traceClock();
  const runStart = Date.parse(run.startedAt) - Date.parse(trace.startedAt);
  const start = dwellStart(step, motion);
  const f = step.t1 > start ? Math.min(1, Math.max(0, (t - start) / (step.t1 - start))) : 1;
  const at = step.realAt ?? runStart;
  const span = step.realMs ?? 0;
  switch (step.kind) {
    case "later":
      // Before its run starts, a later step fast-forwards the TRACE's clock.
      if (t < step.t1 && step.realAt !== null && step.realAt < runStart) {
        return `T+${canvasMs(at + ((t - step.t0) / (step.t1 - step.t0)) * span)}`;
      }
      return `JOB ${run.ref} T+${canvasMs(at - runStart + f * span)}`;
    case "run":
      return `JOB ${run.ref} T+${canvasMs(0)}`;
    case "run_end":
      return `JOB ${run.ref} T+${canvasMs(run.ms)}`;
    default:
      return `JOB ${run.ref} T+${canvasMs(at - runStart + (t < start ? 0 : f * span))}`;
  }
}

/**
 * The frame at animation time t (clamped to [0, duration]) on a plan.
 *
 * The HUD clock follows the current step (`stepAt`): the request's real clock
 * through its knots, or a job run's own clock ("JOB 2 T+1.4S") while a run's step
 * is current, with a `later` step before a run fast-forwarding the trace clock.
 */
export function frameAt(
  timeline: Timeline,
  layout: FloorLayout,
  t: number,
  motion: Motion,
): FrameState {
  const time = Math.min(timeline.duration, Math.max(0, Number.isFinite(t) ? t : 0));
  const ctx: Context = { timeline, layout, motion };
  const trace = timeline.response.trace;
  const env = trace.origin?.environment ?? null;
  const stepIndex = stepAt(timeline, time);
  const current = timeline.steps[stepIndex];

  // ── actors ──
  const placedById = new Map<ActorId, Placed>();
  const actors: ActorPose[] = [];
  for (const id of ACTOR_IDS) {
    const placed = place(ctx, id, time);
    placedById.set(id, placed);
    if (!placed.present) continue;
    const role = roleOf(id);
    const step = placed.step;
    const inStep = step !== null && time >= step.t0 && time < step.t1;
    actors.push({
      id,
      role,
      at: placed.motion.at,
      facing: placed.motion.facing,
      walking: placed.motion.walking,
      walkFrame: placed.motion.walking ? placed.motion.walkFrame : 0,
      // Outside a step an actor holds nothing and says nothing: the runner has
      // handed its parcel over, a worker is walking home empty.
      carrying: inStep ? carryingOf(role, placed) : null,
      bubble: inStep || placed.parked ? bubbleOf(ctx, placed) : null,
      tone: placed.parked ? "activity" : inStep && step ? step.tone : "normal",
      thinking: inStep && step?.kind === "think",
      stamp:
        inStep && step?.kind === "run_end" && placed.dwelling
          ? step.part.kind === "run" && timeline.response.runs[step.part.run]?.result === "threw"
            ? "fail"
            : "ok"
          : null,
    });
  }

  // ── stations, lamps and bins ──
  const busy = new Set<Station>();
  const lamps = new Map<Station, { at: number; outcome: TouchOutcome }>();
  const bins: Partial<Record<RedisKeyClass, TouchOutcome>> = {};
  const binAt = new Map<RedisKeyClass, number>();
  for (const step of timeline.steps) {
    if (step.t0 > time) break;
    if ((step.kind !== "stop" && step.kind !== "elided") || !step.station) continue;
    const start = dwellStart(step, motion);
    if (start > time) continue;
    if (time < step.t1) busy.add(step.station);
    if (step.kind === "stop" && step.stop) {
      const previous = lamps.get(step.station);
      if (!previous || previous.at <= start) {
        lamps.set(step.station, { at: start, outcome: step.stop.outcome });
      }
      if (step.station === "redis" && step.key) {
        const before = binAt.get(step.key);
        if (before === undefined || before <= start) {
          binAt.set(step.key, start);
          bins[step.key] = step.stop.outcome;
        }
      }
    }
  }
  for (const [, placed] of placedById) {
    if (placed.parked && placed.step?.station) {
      busy.add(placed.step.station);
      lamps.set(placed.step.station, { at: time, outcome: "open" });
    }
  }
  const stations = Object.fromEntries(
    Station.options.map((station) => {
      const shutter = shutterOf(station, env);
      return [
        station,
        {
          busy: busy.has(station),
          lamp: shutter ? null : (lamps.get(station)?.outcome ?? null),
          plate: stationPlate(station, env),
          tag: tagOf(station, env),
          shutter,
        } satisfies StationState,
      ];
    }),
  ) as Record<Station, StationState>;

  // ── crates ──
  const crates: CratePose[] = [];
  const [beltStart, beltEnd] = layout.conveyor;
  const waiting: { ref: string; since: number }[] = [];
  for (const trip of timeline.crates) {
    if (trip.t0 > time) continue;
    if (time < trip.t1) {
      const riding = motion === "full";
      const at = riding
        ? snap(pointAlong([beltStart, beltEnd], (time - trip.t0) / (trip.t1 - trip.t0)).at)
        : beltStart;
      crates.push({ ref: trip.ref, label: trip.ref, at, riding });
      continue;
    }
    // At the bay unless a worker has it, or a run of it finished ok.
    let atBay = true;
    let since = trip.t1;
    for (const step of timeline.steps) {
      if (step.part.kind !== "run" || step.jobRef !== trip.ref || step.t0 > time) continue;
      if (step.kind === "run" && dwellStart(step, motion) <= time) atBay = false;
      if (step.kind === "run_end") {
        const stamped = dwellStart(step, motion) + (step.t1 - dwellStart(step, motion)) / 2;
        if (stamped <= time) {
          const threw = timeline.response.runs[step.part.run]?.result === "threw";
          atBay = threw;
          since = stamped;
          if (!threw) break;
        }
      }
    }
    if (atBay) waiting.push({ ref: trip.ref, since });
  }
  waiting
    .sort((a, b) => a.since - b.since)
    .forEach(({ ref }, k) => {
      const x = Math.max(beltStart.x, beltEnd.x - k * CRATE_PITCH);
      crates.push({ ref, label: ref, at: { x, y: beltEnd.y }, riding: false });
    });

  // ── banner ──
  const banners: string[] = [];
  const runner = placedById.get("runner");
  const runnerStep = runner?.step && time < runner.step.t1 ? runner.step : null;
  for (const [, placed] of placedById) {
    const step = placed.step;
    if (!step || time >= step.t1 || time < step.t0) continue;
    if (step.kind === "later") banners.push(laterBanner(step.realMs));
    if (step.kind === "elided" && step.elided) banners.push(`×${step.elided.count} FAST-FORWARD`);
  }
  const atTheLimit = runnerStep?.kind === "respond" || runnerStep?.station === "rate_limit";
  if (trace.status === 429 && atTheLimit) banners.push("429");
  if (runnerStep && trace.origin) {
    const runnerSteps = stepsByActor(timeline).get("runner") ?? [];
    const first = runnerSteps[1];
    const cold = trace.origin.instanceSequence === 1;
    const connecting = trace.origin.redisAtStart === "connecting";
    if (runnerStep.kind === "arrive") {
      if (cold) banners.push("COLD START");
      else if (connecting) banners.push("REDIS CONNECTING");
    } else if (first && runnerStep === first && cold && connecting) {
      banners.push("REDIS CONNECTING");
    }
  }

  return {
    t: time,
    stepIndex,
    actors,
    stations,
    bins,
    crates,
    banner: banners[0] ?? null,
    clock: clockOf(ctx, current, time),
    responded: time >= timeline.responseAt,
    doorOpen:
      runnerStep?.kind === "arrive" ||
      runnerStep?.kind === "respond" ||
      runnerStep?.station === "edge",
  };
}
