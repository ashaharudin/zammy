/**
 * A trace turned into a timeline of steps (ADR-0029): who does what, where, and
 * for how long on the animation clock.
 *
 * A trace is a list of touches with real offsets, some of them overlapping and a
 * cold search's worth of them (300+) far too many to watch one by one. This
 * module decides what the robots DO about that, and it decides it once, as data,
 * so every other module — the frame, the step list, the transport, the words —
 * reads the same answer:
 *
 *  - A STOP is consecutive touches drawn as one stay: the five Postgres statements
 *    of an upsert, the four enqueues of a fan-out, five retries of a refused
 *    lock. A web-side word only (CONTEXT.md's vocabulary is trace, touch,
 *    station, job run and playback; this is how the page draws touches).
 *  - The request's own robot (the RUNNER) walks lane 0. A call that overlaps what
 *    the runner is doing at a DIFFERENT station, or one still running when the
 *    response left, is carried by a HELPER drone instead — that is how the label
 *    tail and the parallel reference calls read as concurrency rather than as a
 *    runner teleporting between machines.
 *  - Each job run is a WORKER's walk: pick the crate up at the bay, visit its
 *    stations, stamp the result. Runs that overlapped in real time overlap on
 *    screen; a redelivery five minutes later gets a `later` step instead of five
 *    minutes of nothing.
 *
 * Two paces. READABLE compresses real time logarithmically (`dwellMs`): a 1 ms
 * cache hit and a 712 ms Currents call both get long enough to see, and the
 * Currents call still visibly longer. REAL keeps real durations (with a 60 ms
 * floor so a 0.2 ms touch is not invisible) and drops the walking.
 *
 * The timeline is LAYOUT-INDEPENDENT: it never asks where a station is, so a
 * resize from the wide plan to the tall one changes where robots walk but never
 * what a step means or when it starts. The knots map the request's real clock to
 * the animation clock so helpers and overlapping runs can be placed "when that
 * happened", and so the HUD clock can read real milliseconds.
 *
 * Deliberately not done here: anything about pixels (`frame.ts`, `layout.ts`),
 * anything about words (`stepText.ts`), and any use of wall-clock time — the
 * same response always builds the same timeline, deep-equal (a test pins it).
 */
import {
  Station,
  type Elision,
  type JobKind,
  type PgTable,
  type RedisKeyClass,
  type Touch,
  type TouchOutcome,
  type TraceReadResponse,
} from "@zammy/shared/request-trace";

export type Pace = "readable" | "real";

export type ActorId =
  | "runner"
  | "helper-1"
  | "helper-2"
  | "helper-3"
  | "worker-1"
  | "worker-2"
  | "worker-3";

/** Every actor, in the order ties between steps starting together are broken. */
export const ACTOR_IDS: readonly ActorId[] = [
  "runner",
  "helper-1",
  "helper-2",
  "helper-3",
  "worker-1",
  "worker-2",
  "worker-3",
];

/** Which record a step belongs to: the request, or `response.runs[run]`. */
export type PartRef = { kind: "request" } | { kind: "run"; run: number };

/** Consecutive touches drawn as one stay at one station. */
export interface Stop {
  station: Station;
  /** The Redis key class for a Redis stop (a stop never mixes two); null elsewhere. */
  key: RedisKeyClass | null;
  touches: readonly Touch[];
  count: number;
  /** How many of its touches were in flight at once: 2 for the parallel reference calls. */
  parallel: number;
  /** ms from the PART's own t0 (the request's, or the run's). */
  realAt: number;
  /** Null if any touch is open — no end was observed before the record was sealed. */
  realEnd: number | null;
  /** The most notable outcome among its touches (`OUTCOME_PRECEDENCE`). */
  outcome: TouchOutcome;
  /** Postgres tables named by its touches, first seen first. */
  tables: readonly PgTable[];
}

export type StepKind =
  | "arrive"
  | "stop"
  | "elided"
  | "think"
  | "later"
  | "respond"
  | "run"
  | "run_end"
  | "unobserved";

/** One step of the timeline: an actor doing one thing for [t0, t1) of animation time. */
export interface Step {
  /** Position in `Timeline.steps`. */
  index: number;
  part: PartRef;
  kind: StepKind;
  actor: ActorId;
  /**
   * The station the step happens at. Null for steps at the door or the bay
   * (`arrive`, `respond`, `run`, `run_end`, `unobserved`) and for `think` and
   * `later`, which happen wherever the actor already is. An `elided` step names
   * the station most of the elided touches were at.
   */
  station: Station | null;
  key: RedisKeyClass | null;
  stop: Stop | null;
  elided: Elision | null;
  /** The run's ref on every step of a run part; a request queue stop's ref if it holds one. */
  jobRef: string | null;
  /** ms from trace.startedAt (runs by wall clock: approximate). */
  realAt: number | null;
  realMs: number | null;
  /**
   * Animation ms; t0 < t1. No two steps share a t0 (`separateTies`), so a step's
   * own start is where `stepAt` names it and only it.
   */
  t0: number;
  t1: number;
  /**
   * The leading ms of [t0, t1) the timing gave to walking there. Zero at real
   * pace, and for steps that do not move. `frame.ts` needs it to know when a walk
   * ends and a dwell begins.
   */
  walk: number;
  tone: "normal" | "attention" | "activity";
}

/** A crate riding the conveyor from the hatch to the bay: one per enqueue. */
export interface CrateTrip {
  ref: string;
  job: JobKind;
  linked: boolean;
  t0: number;
  t1: number;
}

export interface Timeline {
  response: TraceReadResponse;
  pace: Pace;
  /** Sorted by (t0, part order, actor), t0 strictly increasing; `index` = position. */
  steps: readonly Step[];
  /** The last step's or crate's end. */
  duration: number;
  /** The respond step's t0. */
  responseAt: number;
  crates: readonly CrateTrip[];
  /** (real ms, animation ms) pairs for the request part, both non-decreasing. */
  knots: readonly (readonly [realMs: number, animMs: number])[];
}

/**
 * Every duration the choreography uses, in animation ms. One table so a reader
 * tuning the feel of the page changes numbers here and nowhere else.
 */
export const PACING = {
  /** A walk between stations. Fixed, not distance-based: the timeline does not know the plan. */
  walkMs: 420,
  /** A walk between two Redis stops: along the rack, one bin to the next. */
  slotWalkMs: 180,
  /** Standing at the door with the ticket. Also a worker picking a crate up at the bay. */
  arriveMs: 600,
  /** Handing the parcel over at the door. Also a worker stamping its crate. */
  respondMs: 700,
  dwellMinMs: 280,
  dwellMaxMs: 2400,
  /** A call with no observed end. */
  openDwellMs: 1200,
  /** Two touches at one station this close (real ms) are one stop. */
  mergeGapMs: 15,
  /** A real gap this long between touches is drawn as the code thinking. */
  thinkMinRealMs: 20,
  /** A real gap this long is skipped over with a `later` step rather than drawn. */
  laterMinRealMs: 2000,
  laterMs: 1000,
  elidedMs: 900,
  conveyorMs: 900,
  crateStaggerMs: 150,
  /** The shortest a touch lasts at real pace, so a 0.2 ms touch is still seen. */
  realMinDwellMs: 60,
  /**
   * How far a step that would start at the same instant as the one before it is
   * moved on (`separateTies`). Far below one 60 Hz frame (16.7 ms): it exists to
   * make every step seekable, not to be seen.
   */
  tieNudgeMs: 1,
  maxHelpers: 3,
  maxWorkers: 3,
} as const;

/** A stay's length at readable pace: clamp(280 + 420·log10(1 + ms/2), 280, 2400); null → 1200. */
export function dwellMs(realMs: number | null): number {
  if (realMs === null || !Number.isFinite(realMs)) return PACING.openDwellMs;
  const raw = PACING.dwellMinMs + 420 * Math.log10(1 + Math.max(0, realMs) / 2);
  return Math.min(PACING.dwellMaxMs, Math.max(PACING.dwellMinMs, raw));
}

/** How long a gap of in-process work lasts: clamp(160 + 200·log10(1 + gap/2), 160, 900). */
export function thinkMs(gapMs: number): number {
  const raw = 160 + 200 * Math.log10(1 + Math.max(0, gapMs) / 2);
  return Math.min(900, Math.max(160, raw));
}

/**
 * Most notable first. A stop that merged a hit and a miss reads as the miss; five
 * lock attempts of which one was refused read as refused. Every TouchOutcome is
 * here exactly once.
 */
export const OUTCOME_PRECEDENCE: readonly TouchOutcome[] = [
  "failed",
  "not_ready",
  "limited",
  "refused",
  "lost",
  "held",
  "fail_open",
  "open",
  "miss",
  "stale",
  "hit",
  "acquired",
  "released",
  "counted",
  "ok",
];

/** Outcomes a reader should look at twice: drawn in the attention colour. */
const ATTENTION: ReadonlySet<TouchOutcome> = new Set([
  "failed",
  "not_ready",
  "limited",
  "refused",
  "lost",
  "held",
  "fail_open",
]);

function notable(a: TouchOutcome, b: TouchOutcome): TouchOutcome {
  return OUTCOME_PRECEDENCE.indexOf(a) <= OUTCOME_PRECEDENCE.indexOf(b) ? a : b;
}

/** Whether a planned lane item is a stop rather than the elision. */
export function isStop(item: Stop | Elision): item is Stop {
  return "touches" in item;
}

// ── planning one part: lanes and stops ──────────────────────────────────────

interface Building {
  station: Station;
  key: RedisKeyClass | null;
  touches: Touch[];
  count: number;
  parallel: number;
  realAt: number;
  realEnd: number | null;
  outcome: TouchOutcome;
  tables: PgTable[];
}

const touchEnd = (t: Touch): number | null => (t.ms === null ? null : t.at + t.ms);
const touchKey = (t: Touch): RedisKeyClass | null => (t.station === "redis" ? t.key : null);
const sameSlot = (s: Building, t: Touch) => s.station === t.station && s.key === touchKey(t);
const inFlight = (s: Building, at: number) => s.realEnd === null || s.realEnd > at;

function open(touch: Touch): Building {
  return {
    station: touch.station,
    key: touchKey(touch),
    touches: [touch],
    count: 1,
    parallel: 1,
    realAt: touch.at,
    realEnd: touchEnd(touch),
    outcome: touch.outcome,
    tables: touch.station === "postgres" ? [...touch.tables] : [],
  };
}

function join(stop: Building, touch: Touch): void {
  const end = touchEnd(touch);
  if (inFlight(stop, touch.at)) stop.parallel += 1;
  stop.touches.push(touch);
  stop.count += 1;
  stop.realEnd = stop.realEnd === null || end === null ? null : Math.max(stop.realEnd, end);
  stop.outcome = notable(stop.outcome, touch.outcome);
  if (touch.station === "postgres") {
    for (const table of touch.tables) if (!stop.tables.includes(table)) stop.tables.push(table);
  }
}

/**
 * Lane assignment and merging for one part. Lane 0 is the runner's (or, for a
 * run, its worker's); lanes 1–3 are helpers and exist only with `helpers: true`,
 * which only the request uses (a run's overlapping touches at different stations
 * become one stop after another on its worker's lane).
 *
 * Touches are visited in array order, which is begin order. With helpers, a touch
 * goes to a helper lane when it has no end, or when it overlaps lane 0's
 * in-flight stop at a different station (or a different Redis key) — the lowest
 * helper free at its start, else the last. A touch overlapping that stop at the
 * same station and key joins it, `parallel` rising. Anything else is lane 0's.
 *
 * Within a lane, a touch joins the previous stop at the same station and key when
 * it starts at most `mergeGapMs` after that stop ended (or while it is still
 * running). Merging never crosses the elision, which sits in lane 0 right after
 * the stop holding touch `elided.after`.
 */
export function planPart(
  touches: readonly Touch[],
  elided: Elision | null,
  options: { helpers: boolean },
): { lanes: readonly (readonly (Stop | Elision)[])[] } {
  const count = options.helpers ? 1 + PACING.maxHelpers : 1;
  const lanes: (Building | Elision)[][] = Array.from({ length: count }, () => []);
  /** Items below this index in a lane are sealed off by the elision. */
  const floor = new Array<number>(count).fill(0);
  let elisionPlaced = false;
  const placeElision = () => {
    if (!elided || elisionPlaced) return;
    lanes[0]!.push(elided);
    elisionPlaced = true;
    for (let lane = 0; lane < count; lane += 1) floor[lane] = lanes[lane]!.length;
  };
  const lastStop = (lane: number): Building | null => {
    const items = lanes[lane]!;
    const last = items.at(-1);
    return last && "touches" in last && items.length - 1 >= floor[lane]! ? last : null;
  };
  const freeHelper = (at: number): number => {
    for (let lane = 1; lane < count; lane += 1) {
      const last = lanes[lane]!.at(-1);
      if (!last || (!isElision(last) && last.realEnd !== null && last.realEnd <= at)) return lane;
    }
    return count - 1;
  };
  const joins = (lane: number, last: Building, touch: Touch): boolean => {
    if (!sameSlot(last, touch)) return false;
    // An open stop takes more touches only on lane 0 (a run's worker); a helper
    // with an open call is parked there for good, and the next errand is a new one.
    if (last.realEnd === null) return lane === 0;
    // A negative gap is an overlap, which joins too (and raises `parallel`).
    return touch.at - last.realEnd <= PACING.mergeGapMs;
  };
  const add = (lane: number, touch: Touch) => {
    const last = lastStop(lane);
    if (last && joins(lane, last, touch)) join(last, touch);
    else lanes[lane]!.push(open(touch));
  };

  touches.forEach((touch, index) => {
    let lane = 0;
    if (options.helpers) {
      const runnerStop = lastStop(0);
      if (touch.ms === null) lane = freeHelper(touch.at);
      else if (runnerStop && inFlight(runnerStop, touch.at) && !sameSlot(runnerStop, touch)) {
        lane = freeHelper(touch.at);
      }
    }
    add(lane, touch);
    if (elided && index === elided.after) placeElision();
  });
  placeElision();

  return {
    lanes: lanes.map((items) =>
      items.map((item): Stop | Elision =>
        isElision(item)
          ? item
          : { ...item, touches: [...item.touches], tables: [...item.tables] },
      ),
    ),
  };
}

function isElision(item: Building | Elision): item is Elision {
  return !("touches" in item);
}

// ── building the timeline ────────────────────────────────────────────────────

type Draft = Omit<Step, "index"> & { order: number };

const REQUEST: PartRef = { kind: "request" };

/** The station most of an elision's touches were at; ties go to `Station` order. */
function dominantStation(elided: Elision): Station | null {
  let best: Station | null = null;
  let most = 0;
  for (const station of Station.options) {
    const n = elided.stations[station] ?? 0;
    if (n > most) {
      best = station;
      most = n;
    }
  }
  return best;
}

function toneOf(stop: Stop): Step["tone"] {
  if (ATTENTION.has(stop.outcome)) return "attention";
  if (stop.realEnd === null || stop.outcome === "open") return "activity";
  return "normal";
}

/** Compares job refs numerically, part by part: "2" < "10", "1.2" < "1.10". */
function compareRefs(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The timeline for a response.
 *
 * The request: `arrive`, then each lane-0 stop (or the elision) preceded by a
 * `think` step for a real gap of 20 ms or more and a `later` step for 2 s or
 * more, then `respond`. Helper stops are placed at the animation time their real
 * start maps to through the knots, never before that helper is free.
 *
 * Each run, in (startedAt, ref) order, is anchored: a run that began while the
 * request was still running starts where its real start falls on the request's
 * clock (the in-process BullMQ worker does this); otherwise a run overlapping the
 * previous one in real time starts a think's length after it; otherwise it
 * starts once everything drawn so far is done, after a `later` step for a gap of
 * 2 s or more. No run starts before its crate reaches the bay, and each takes the
 * lowest-numbered free worker (waiting for one when all three are out).
 *
 * Then every linked enqueue with no run gets an `unobserved` step at the bay, and
 * last of all `separateTies` makes every step's start its own.
 */
export function buildTimeline(response: TraceReadResponse, options: { pace: Pace }): Timeline {
  const { trace, runs } = response;
  const real = options.pace === "real";
  const drafts: Draft[] = [];
  const crates: CrateTrip[] = [];
  const knots: [number, number][] = [];
  let order = 0;

  const walkBetween = (prev: Stop | null, next: Stop | null): number => {
    if (real) return 0;
    const alongTheRack = prev?.station === "redis" && next?.station === "redis";
    return alongTheRack ? PACING.slotWalkMs : PACING.walkMs;
  };
  const dwellOf = (stop: Stop): number => {
    const realMs = stop.realEnd === null ? null : stop.realEnd - stop.realAt;
    if (!real) return dwellMs(realMs);
    return realMs === null ? PACING.openDwellMs : Math.max(PACING.realMinDwellMs, realMs);
  };
  const elidedDuration = (e: Elision): number =>
    real ? Math.max(PACING.realMinDwellMs, e.toAt - e.fromAt) : PACING.elidedMs;
  const thinkDuration = (gap: number): number => (real ? gap : thinkMs(gap));
  const push = (draft: Omit<Draft, "order">): Draft => {
    const full = { ...draft, order: order++ };
    drafts.push(full);
    return full;
  };
  const addKnot = (realMs: number, animMs: number) => {
    const last = knots.at(-1);
    const r = last ? Math.max(realMs, last[0]) : realMs;
    const a = last ? Math.max(animMs, last[1]) : animMs;
    if (last && a === last[1]) last[0] = r;
    else knots.push([r, a]);
  };
  const interp = (realMs: number): number => {
    if (knots.length === 0) return 0;
    for (let k = 0; k < knots.length; k += 1) {
      const [r, a] = knots[k]!;
      if (realMs <= r) {
        if (k === 0 || realMs === r) return a;
        const [r0, a0] = knots[k - 1]!;
        return r === r0 ? a0 : a0 + ((realMs - r0) / (r - r0)) * (a - a0);
      }
    }
    return knots.at(-1)![1];
  };
  const drawnSoFar = (): number =>
    Math.max(0, ...drafts.map((d) => d.t1), ...crates.map((c) => c.t1));
  const spawnCrates = (stop: Stop, from: number) => {
    let i = 0;
    for (const touch of stop.touches) {
      if (touch.station !== "queue") continue;
      const t0 = from + i * PACING.crateStaggerMs;
      const t1 = t0 + PACING.conveyorMs;
      crates.push({ ref: touch.ref, job: touch.job, linked: touch.linked, t0, t1 });
      i += 1;
    }
  };
  const singleRef = (stop: Stop): string | null => {
    const queued = stop.touches.filter((t) => t.station === "queue");
    return queued.length === 1 && queued[0]!.station === "queue" ? queued[0]!.ref : null;
  };

  /**
   * A think or later step for a real gap, if it deserves one; returns the new t.
   * `realFrom` is where the gap starts, `offset` converts part ms to trace ms.
   */
  const gapStep = (
    t: number,
    gap: number,
    realFrom: number,
    offset: number,
    actor: ActorId,
    part: PartRef,
    jobRef: string | null,
  ): number => {
    let length = 0;
    let kind: StepKind | null = null;
    if (gap >= PACING.laterMinRealMs) {
      kind = "later";
      length = PACING.laterMs;
    } else if (gap >= PACING.thinkMinRealMs) {
      kind = "think";
      length = thinkDuration(gap);
    }
    if (!kind) return t;
    push({
      part,
      kind,
      actor,
      station: null,
      key: null,
      stop: null,
      elided: null,
      jobRef,
      realAt: offset + realFrom,
      realMs: gap,
      t0: t,
      t1: t + length,
      walk: 0,
      tone: "normal",
    });
    return t + length;
  };

  /**
   * Lays out one part's lane 0 from `t`, returning where it ended. The request
   * records knots as it goes; runs do not (their clock is their own).
   */
  const layLane = (
    items: readonly (Stop | Elision)[],
    start: number,
    context: {
      part: PartRef;
      actor: ActorId;
      offset: number;
      jobRef: string | null;
      knots: boolean;
    },
  ): { t: number; realEnd: number } => {
    let t = start;
    let prevEnd = 0;
    let prev: Stop | null = null;
    for (const item of items) {
      const realAt = isStop(item) ? item.realAt : item.fromAt;
      const { offset, actor, part, jobRef } = context;
      t = gapStep(t, realAt - prevEnd, prevEnd, offset, actor, part, jobRef);
      if (isStop(item)) {
        const walk = walkBetween(prev, item);
        const t1 = t + walk + dwellOf(item);
        push({
          part: context.part,
          kind: "stop",
          actor: context.actor,
          station: item.station,
          key: item.key,
          stop: item,
          elided: null,
          jobRef: context.jobRef ?? singleRef(item),
          realAt: context.offset + item.realAt,
          realMs: item.realEnd === null ? null : item.realEnd - item.realAt,
          t0: t,
          t1,
          walk,
          tone: toneOf(item),
        });
        if (context.knots) {
          addKnot(item.realAt, t + walk);
          if (item.realEnd !== null) addKnot(item.realEnd, t1);
        }
        spawnCrates(item, t1);
        prevEnd = Math.max(prevEnd, item.realEnd ?? item.realAt);
        prev = item;
        t = t1;
      } else {
        const t1 = t + elidedDuration(item);
        push({
          part: context.part,
          kind: "elided",
          actor: context.actor,
          station: dominantStation(item),
          key: null,
          stop: null,
          elided: item,
          jobRef: context.jobRef,
          realAt: context.offset + item.fromAt,
          realMs: item.toAt - item.fromAt,
          t0: t,
          t1,
          walk: 0,
          tone: "normal",
        });
        if (context.knots) {
          addKnot(item.fromAt, t);
          addKnot(item.toAt, t1);
        }
        prevEnd = Math.max(prevEnd, item.toAt);
        prev = null;
        t = t1;
      }
    }
    return { t, realEnd: prevEnd };
  };

  // ── the request ──
  const plan = planPart(trace.touches, trace.elided, { helpers: true });
  push({
    part: REQUEST,
    kind: "arrive",
    actor: "runner",
    station: null,
    key: null,
    stop: null,
    elided: null,
    jobRef: null,
    realAt: 0,
    realMs: null,
    t0: 0,
    t1: PACING.arriveMs,
    walk: 0,
    tone: "normal",
  });
  const runner = layLane(plan.lanes[0] ?? [], PACING.arriveMs, {
    part: REQUEST,
    actor: "runner",
    offset: 0,
    jobRef: null,
    knots: true,
  });

  let t = gapStep(runner.t, trace.ms - runner.realEnd, runner.realEnd, 0, "runner", REQUEST, null);
  const respondWalk = real ? 0 : PACING.walkMs;
  const respond = push({
    part: REQUEST,
    kind: "respond",
    actor: "runner",
    station: null,
    key: null,
    stop: null,
    elided: null,
    jobRef: null,
    realAt: trace.ms,
    realMs: null,
    t0: t,
    t1: t + respondWalk + PACING.respondMs,
    walk: respondWalk,
    tone: trace.status >= 400 ? "attention" : "normal",
  });
  addKnot(trace.ms, respond.t0);

  // Helpers, now that the runner's knots exist.
  plan.lanes.slice(1).forEach((items, i) => {
    const actor = ACTOR_IDS[1 + i]!;
    let free = -Infinity;
    let prev: Stop | null = null;
    for (const item of items) {
      if (!isStop(item)) continue;
      const t0 = Math.max(interp(item.realAt), free);
      const walk = t0 === free ? walkBetween(prev, item) : real ? 0 : PACING.walkMs;
      const t1 = t0 + walk + dwellOf(item);
      push({
        part: REQUEST,
        kind: "stop",
        actor,
        station: item.station,
        key: item.key,
        stop: item,
        elided: null,
        jobRef: singleRef(item),
        realAt: item.realAt,
        realMs: item.realEnd === null ? null : item.realEnd - item.realAt,
        t0,
        t1,
        walk,
        tone: toneOf(item),
      });
      spawnCrates(item, t1);
      free = t1;
      prev = item;
    }
  });

  // ── the job runs ──
  const traceStart = Date.parse(trace.startedAt);
  const runOrder = runs
    .map((run, index) => ({ run, index, realStart: Date.parse(run.startedAt) - traceStart }))
    .sort(
      (a, b) =>
        a.realStart - b.realStart || compareRefs(a.run.ref, b.run.ref) || a.index - b.index,
    );
  const workerFree = new Array<number>(PACING.maxWorkers).fill(-Infinity);
  let previous: { realStart: number; realEnd: number; anchor: number } | null = null;
  let lastRealEnd = trace.ms;
  const partRank = new Map<number, number>();

  runOrder.forEach(({ run, index, realStart }, rank) => {
    partRank.set(index, rank);
    const part: PartRef = { kind: "run", run: index };
    const realEnd = realStart + run.ms;
    const crate = crates.find((c) => c.ref === run.ref);
    let anchor: number;
    let later = false;
    if (realStart < trace.ms) {
      anchor = interp(realStart);
    } else if (previous && realStart < previous.realEnd) {
      anchor = previous.anchor + thinkDuration(realStart - previous.realStart);
    } else {
      anchor = drawnSoFar();
      later = realStart - lastRealEnd >= PACING.laterMinRealMs;
    }
    anchor = Math.max(anchor, crate?.t1 ?? -Infinity);

    let worker = workerFree.findIndex((free) => free <= anchor);
    if (worker === -1) {
      worker = workerFree.indexOf(Math.min(...workerFree));
      anchor = workerFree[worker]!;
    }
    const actor = ACTOR_IDS[1 + PACING.maxHelpers + worker]!;
    const threw = run.result === "threw";

    let t = anchor;
    if (later) {
      push({
        part,
        kind: "later",
        actor,
        station: null,
        key: null,
        stop: null,
        elided: null,
        jobRef: run.ref,
        realAt: lastRealEnd,
        realMs: realStart - lastRealEnd,
        t0: t,
        t1: t + PACING.laterMs,
        walk: 0,
        tone: "normal",
      });
      t += PACING.laterMs;
    }
    const runStart = t;
    const pickupWalk = real ? 0 : PACING.walkMs;
    push({
      part,
      kind: "run",
      actor,
      station: null,
      key: null,
      stop: null,
      elided: null,
      jobRef: run.ref,
      realAt: realStart,
      realMs: run.ms,
      t0: t,
      t1: t + pickupWalk + PACING.arriveMs,
      walk: pickupWalk,
      tone: threw ? "attention" : "normal",
    });
    t += pickupWalk + PACING.arriveMs;

    const lane = planPart(run.touches, run.elided, { helpers: false }).lanes[0] ?? [];
    const laid = layLane(lane, t, {
      part,
      actor,
      offset: realStart,
      jobRef: run.ref,
      knots: false,
    });
    t = gapStep(laid.t, run.ms - laid.realEnd, laid.realEnd, realStart, actor, part, run.ref);
    const stampWalk = real ? 0 : PACING.walkMs;
    const end = push({
      part,
      kind: "run_end",
      actor,
      station: null,
      key: null,
      stop: null,
      elided: null,
      jobRef: run.ref,
      realAt: realEnd,
      realMs: null,
      t0: t,
      t1: t + stampWalk + PACING.respondMs,
      walk: stampWalk,
      tone: threw ? "attention" : "normal",
    });
    workerFree[worker] = end.t1;
    previous = { realStart, realEnd, anchor: runStart };
    lastRealEnd = Math.max(lastRealEnd, realEnd);
  });

  // ── linked enqueues nobody was seen running ──
  const ran = new Set(runs.map((r) => r.ref));
  const unobserved: string[] = [];
  for (const record of [trace, ...runs]) {
    for (const touch of record.touches) {
      if (touch.station !== "queue" || !touch.linked) continue;
      if (!ran.has(touch.ref) && !unobserved.includes(touch.ref)) unobserved.push(touch.ref);
    }
  }
  let tail = drawnSoFar();
  for (const ref of unobserved) {
    push({
      part: REQUEST,
      kind: "unobserved",
      actor: "worker-1",
      station: null,
      key: null,
      stop: null,
      elided: null,
      jobRef: ref,
      realAt: null,
      realMs: null,
      t0: tail,
      t1: tail + PACING.arriveMs,
      walk: 0,
      tone: "normal",
    });
    tail += PACING.arriveMs;
  }

  const rankOf = (p: PartRef) => (p.kind === "request" ? -1 : (partRank.get(p.run) ?? 0));
  drafts.sort(
    (a, b) =>
      a.t0 - b.t0 ||
      rankOf(a.part) - rankOf(b.part) ||
      ACTOR_IDS.indexOf(a.actor) - ACTOR_IDS.indexOf(b.actor) ||
      a.order - b.order,
  );
  separateTies(drafts);
  // `separateTies` can (only through a pile-up of ties) move the respond step on;
  // the request's clock must still reach trace.ms exactly where the parcel leaves,
  // or the HUD would read T+0 for the few ms in between (`frame.ts` clockOf).
  addKnot(trace.ms, respond.t0);
  const steps: Step[] = drafts.map(({ order: _order, ...step }, index) => ({ ...step, index }));

  return {
    response,
    pace: options.pace,
    steps,
    duration: Math.max(0, ...steps.map((s) => s.t1), ...crates.map((c) => c.t1)),
    responseAt: respond.t0,
    crates,
    knots: knots.map(([r, a]) => [r, a] as const),
  };
}

/**
 * Makes every step start strictly later than the one before it in step order,
 * mutating the sorted drafts in place.
 *
 * Why: the transport keeps only an animation time t, and reads the step it is on
 * back through `stepAt`, so a seek to step i lands on t = steps[i].t0, and
 * step-forward and stepped play go to the next distinct start. Two actors' steps
 * CAN start at the very same instant — at real pace the 60 ms floor lines
 * storyline-open's concurrent job runs up, Job 1's Redis SET and Job 3's Postgres
 * select both at 2640 ms — and then the later one in step order could never be
 * current: its list entry marked and announced its neighbour, the scrubber's
 * ArrowRight snapped back, and step-forward jumped over it (ADR-0029's playback
 * is a step at a time; a step nobody can land on is one the reader never gets).
 * With every t0 distinct, `stepAt(timeline, steps[i].t0) === i` for every i, and
 * `playbackClock.ts` needs no index of its own to get there.
 *
 * How: a step starting no later than the one before it starts `tieNudgeMs` after
 * it instead. That keeps the order, and it keeps every step inside itself: each
 * actor's steps never overlap and none is shorter than `thinkMinRealMs` (20 ms, a
 * real-pace think), so at most seven starts (one per actor) fall in any 20 ms, a
 * run of nudges is at most six long, and no step moves more than 6 ms. If the
 * step's own actor had a step ending exactly where it began, that step is
 * stretched to meet it: `frame.ts` reads an actor whose steps do not follow
 * straight on as having left in between — a helper vanishes and respawns at the
 * runner, a worker flashes home — so a 1 ms hole would be a visible glitch, where
 * a 1 ms longer dwell is not. (A crate still leaves at the stop's unstretched
 * end; a crate and a run's anchor are never moved.)
 */
function separateTies(drafts: Draft[]): void {
  const lastOf = new Map<ActorId, Draft>();
  let previous: Draft | null = null;
  for (const draft of drafts) {
    if (previous && draft.t0 <= previous.t0) {
      const t0 = previous.t0 + PACING.tieNudgeMs;
      const before = lastOf.get(draft.actor);
      if (before && before.t1 === draft.t0) before.t1 = t0;
      draft.t0 = t0;
    }
    lastOf.set(draft.actor, draft);
    previous = draft;
  }
}

/**
 * The step to call "current" at animation time t.
 *
 * Of the steps whose [t0, t1) contains t, the one that started LAST — so while a
 * helper runs its errand during the runner's dwell, the errand is current, and
 * once it is done the runner's dwell is current again. In a gap no step covers (a
 * run waiting for its crate), the last step to have started. Clamped to
 * [0, steps.length − 1].
 *
 * Not "the lowest index among ALL covering steps": that would make a worker's
 * long Currents call hide every step another worker takes meanwhile, and would
 * leave the transport's step-forward landing on a step it did not ask for.
 * Steps starting at the same instant would tie to the lower index, but
 * `buildTimeline` never makes one (`separateTies`), so at its own t0 every step
 * of a built timeline is the one named.
 */
export function stepAt(timeline: Timeline, t: number): number {
  const { steps } = timeline;
  if (steps.length === 0) return 0;
  let covering = -1;
  let started = -1;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.t0 > t) break;
    if (started === -1 || step.t0 > steps[started]!.t0) started = i;
    if (t < step.t1 && (covering === -1 || step.t0 > steps[covering]!.t0)) covering = i;
  }
  if (covering !== -1) return covering;
  if (started !== -1) return started;
  return 0;
}

/** The real ms (from trace.startedAt) at animation time t, by the request's knots; else null. */
export function realClockAt(timeline: Timeline, t: number): number | null {
  const { knots } = timeline;
  const first = knots[0];
  const last = knots.at(-1);
  if (!first || !last || t < first[1] || t > last[1]) return null;
  for (let k = 0; k < knots.length; k += 1) {
    const [r, a] = knots[k]!;
    if (t <= a) {
      if (k === 0 || t === a) return r;
      const [r0, a0] = knots[k - 1]!;
      return r0 + ((t - a0) / (a - a0)) * (r - r0);
    }
  }
  return last[0];
}
