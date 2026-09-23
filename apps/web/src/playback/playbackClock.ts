/**
 * The playback's transport — play, pause, step, seek, speed — as a reducer
 * (ADR-0029, "The page is an operator's view on `/`"), the two changes from
 * outside it that must keep the reader's place (a pace change, a motion
 * preference turned on mid-play), and the keyboard's mapping onto it.
 *
 * The page holds one `Transport` and feeds it actions: `tick` from the frame
 * loop, everything else from buttons, the scrubber, the step list and the keys.
 * Keeping it a pure reducer over an explicit timeline is what lets every rule
 * below be tested without a renderer, and what makes StrictMode's double
 * invocation harmless.
 *
 * Two modes. ANIMATED advances t continuously (dt × speed). STEPPED — the mode
 * reduced motion starts in — holds each step for `STEP_HOLD_MS` of (sped-up)
 * time and then jumps to the next step's start: the scene changes a step at a
 * time, nothing slides, and Play still means something.
 *
 * Stepping moves by step STARTS, not by index arithmetic: step-forward goes to
 * the first step starting after t, so it always makes progress even while
 * several actors' steps overlap (`stepAt` reads the landing step back).
 *
 * Deliberately not here: persistence (`playbackPreferences.ts`), the frame loop
 * (`loop.ts`), and the live-region announcements, which the page makes on user
 * actions only.
 */
import { stepAt, type Step, type Timeline } from "./choreography.js";

export const SPEEDS = [0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

/** How long stepped mode dwells on each step, at 1×. */
export const STEP_HOLD_MS = 1400;

/** How far into a step, step-back still means "to its start" rather than "to the one before". */
export const STEP_BACK_GRACE_MS = 250;

export interface Transport {
  status: "playing" | "paused" | "ended";
  /** Animation ms, within [0, duration]. */
  t: number;
  speed: Speed;
  mode: "animated" | "stepped";
  /** Stepped mode: how long the current step has been held. */
  held: number;
}

export type TransportAction =
  | { type: "toggle" }
  | { type: "play" }
  | { type: "pause" }
  | { type: "restart" }
  | { type: "end" }
  | { type: "tick"; dtMs: number }
  | { type: "step"; delta: 1 | -1 }
  | { type: "seek"; stepIndex: number }
  | { type: "speed"; speed: Speed }
  | { type: "faster" }
  | { type: "slower" }
  | { type: "mode"; mode: Transport["mode"] };

/** The transport a page opens with: at the start, playing only when motion is welcome. */
export function initialTransport(options: {
  autoplay: boolean;
  speed: Speed;
  mode: Transport["mode"];
}): Transport {
  return {
    status: options.autoplay ? "playing" : "paused",
    t: 0,
    speed: options.speed,
    mode: options.mode,
    held: 0,
  };
}

/** The t0 of the first step starting after t, or null after the last. */
function nextStart(timeline: Timeline, t: number): number | null {
  for (const step of timeline.steps) if (step.t0 > t) return step.t0;
  return null;
}

/** The t0 of the last step starting before `before`, or 0. */
function previousStart(timeline: Timeline, before: number): number {
  let found = 0;
  for (const step of timeline.steps) {
    if (step.t0 >= before) break;
    found = step.t0;
  }
  return found;
}

const isSpeed = (value: number): value is Speed => (SPEEDS as readonly number[]).includes(value);

/**
 * The transport after one action.
 *
 *  - tick: nothing unless playing. Animated: t += dt × speed, clamped, ending at
 *    the duration. Stepped: held += dt × speed; at STEP_HOLD_MS jump to the next
 *    step's start and hold again; past the last step, end.
 *  - toggle: playing ⇄ paused; from ended, back to the start and playing.
 *  - step pauses. +1: the next step's start, or the end. −1: the current step's
 *    start if more than 250 ms into it, else the previous step's.
 *  - seek pauses on a step's start (index clamped).
 *  - restart: t = 0, and an ended transport becomes paused; end: t = duration, ended.
 *  - speed changes keep t, and stay within SPEEDS.
 */
export function transport(
  state: Transport,
  action: TransportAction,
  timeline: Timeline,
): Transport {
  const duration = timeline.duration;
  switch (action.type) {
    case "tick": {
      if (state.status !== "playing") return state;
      const dt = Math.max(0, Number.isFinite(action.dtMs) ? action.dtMs : 0) * state.speed;
      if (state.mode === "animated") {
        const t = Math.min(duration, state.t + dt);
        return { ...state, t, status: t >= duration ? "ended" : "playing" };
      }
      const held = state.held + dt;
      if (held < STEP_HOLD_MS) return { ...state, held };
      const next = nextStart(timeline, state.t);
      return next === null
        ? { ...state, t: duration, held: 0, status: "ended" }
        : { ...state, t: next, held: 0 };
    }
    case "toggle":
      if (state.status === "playing") return { ...state, status: "paused" };
      if (state.status === "ended") return { ...state, t: 0, held: 0, status: "playing" };
      return { ...state, status: "playing" };
    case "play":
      if (state.status === "ended") return { ...state, t: 0, held: 0, status: "playing" };
      return state.status === "playing" ? state : { ...state, status: "playing" };
    case "pause":
      return state.status === "playing" ? { ...state, status: "paused" } : state;
    case "restart":
      return {
        ...state,
        t: 0,
        held: 0,
        status: state.status === "ended" ? "paused" : state.status,
      };
    case "end":
      return { ...state, t: duration, held: 0, status: "ended" };
    case "step": {
      if (action.delta === 1) {
        const next = nextStart(timeline, state.t);
        return next === null
          ? { ...state, t: duration, held: 0, status: "ended" }
          : { ...state, t: next, held: 0, status: "paused" };
      }
      const current = timeline.steps[stepAt(timeline, state.t)];
      const start = current?.t0 ?? 0;
      const t = state.t - start > STEP_BACK_GRACE_MS ? start : previousStart(timeline, start);
      return { ...state, t, held: 0, status: "paused" };
    }
    case "seek": {
      const last = timeline.steps.length - 1;
      const index = Math.min(last, Math.max(0, Math.round(action.stepIndex)));
      return { ...state, t: timeline.steps[index]?.t0 ?? 0, held: 0, status: "paused" };
    }
    case "speed":
      return isSpeed(action.speed) ? { ...state, speed: action.speed } : state;
    case "faster": {
      const i = SPEEDS.indexOf(state.speed);
      return { ...state, speed: SPEEDS[Math.min(SPEEDS.length - 1, i + 1)]! };
    }
    case "slower": {
      const i = SPEEDS.indexOf(state.speed);
      return { ...state, speed: SPEEDS[Math.max(0, i - 1)]! };
    }
    case "mode":
      return { ...state, mode: action.mode, held: 0 };
  }
}

/**
 * A step's name that no pace can change: which record it belongs to, what kind
 * of step it is, where, when in REAL ms, and for which job. Its position in
 * `Timeline.steps` is not such a name — the steps are sorted by animation start,
 * the paces give the same steps different durations, so the same index names
 * different steps at the two paces (at index 21 of the cold search, Job 3's
 * delivery at readable pace and Job 2's Postgres select at real pace). Nor is
 * the actor: which worker takes a job run depends on who is free on the
 * ANIMATION clock. Everything named here comes from the record's real offsets,
 * which the pace never touches.
 */
function stepName(step: Step): string {
  const part = step.part.kind === "request" ? "request" : `run ${step.part.run}`;
  return [part, step.kind, step.station ?? "", step.key ?? "", step.realAt ?? "", step.jobRef ?? ""]
    .map(String)
    .join("|");
}

/**
 * Every step's pace-free name, with the occurrence count that keeps two steps
 * sharing one (none does in the examples; nothing forbids it) apart. Two such
 * steps share a record, a kind, a station and a real start, so their order is
 * the record's order at either pace.
 */
export function stepNames(timeline: Timeline): string[] {
  const seen = new Map<string, number>();
  return timeline.steps.map((step) => {
    const name = stepName(step);
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return `${name}#${n}`;
  });
}

/**
 * The transport carried onto the SAME trace rebuilt at another pace: on the
 * start of the same step — found by name (`stepNames`), never by index — with
 * the hold reset and the status kept, and an ended playback still at its end.
 *
 * A step the other pace does not have (the choreography builds the same steps
 * at both paces today, so this is a fallback, not a case) keeps the old index,
 * clamped: the page must land somewhere.
 */
export function carryAcrossPace(state: Transport, from: Timeline, to: Timeline): Transport {
  if (state.status === "ended") return { ...state, t: to.duration, held: 0 };
  const index = stepAt(from, state.t);
  const name = stepNames(from)[index];
  const found = name === undefined ? -1 : stepNames(to).indexOf(name);
  const landing = found !== -1 ? found : Math.min(index, to.steps.length - 1);
  return { ...state, t: to.steps[landing]?.t0 ?? 0, held: 0 };
}

/**
 * The transport after the reader's motion preference changes while the page is
 * open — reduced motion steps, full motion glides — and whether that counts as
 * the reader having TAKEN OVER from the static overview.
 *
 * It does when reduced motion comes on while the transport is playing: the
 * overview is the map shown BEFORE Play, and a reader who is watching the
 * playback has in effect already pressed it. Answering no there swapped the
 * stage for the overview while the transport played on beneath it — the step
 * list and scrubber advancing, Pause pressed, and a note telling the reader to
 * press Play.
 */
export function withMotion(
  state: Transport,
  reduced: boolean,
  timeline: Timeline,
): { state: Transport; takesOver: boolean } {
  const mode: Transport["mode"] = reduced ? "stepped" : "animated";
  if (state.mode === mode) return { state, takesOver: false };
  return {
    state: transport(state, { type: "mode", mode }, timeline),
    takesOver: reduced && state.status === "playing",
  };
}

/** What the keyboard handler needs from a `KeyboardEvent`: the key, the modifiers, the target. */
export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: { tagName: string; isContentEditable?: boolean } | null;
}

const TYPING_TARGETS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT"]);
/** Elements that turn Space into a click natively; handling it too would toggle twice. */
const ACTIVATES_ON_SPACE: ReadonlySet<string> = new Set(["BUTTON", "A", "SUMMARY"]);

/** The single-character shortcuts, which `letters: false` turns off (WCAG 2.1.4). */
const LETTER_ACTIONS: ReadonlyMap<string, TransportAction> = new Map<string, TransportAction>([
  ["k", { type: "toggle" }],
  ["K", { type: "toggle" }],
  ["l", { type: "step", delta: 1 }],
  ["L", { type: "step", delta: 1 }],
  ["j", { type: "step", delta: -1 }],
  ["J", { type: "step", delta: -1 }],
  ["]", { type: "faster" }],
  ["+", { type: "faster" }],
  ["=", { type: "faster" }],
  ["[", { type: "slower" }],
  ["-", { type: "slower" }],
]);

/**
 * The transport action a key press means, or null to leave the event alone.
 *
 * Null with Ctrl, Meta or Alt held (browser and OS shortcuts win), and whenever
 * the reader is typing — an input, a textarea, a select, anything contenteditable
 * (the token field and the trace-id form live on this page). Space is null on a
 * button, link or summary, because native activation already clicks it; every
 * other key keeps working with a button focused, so a reader who has just
 * pressed Play can still step with the arrows. Enter is always left alone.
 *
 * The letters and brackets are live page-wide, which WCAG 2.1.4 (Level A)
 * allows only if they can be turned off: a speech-input user's misheard phrase
 * arrives as keystrokes, and each `l` or `]` would step or speed the playback.
 * `letters: false` (the page's "Letter shortcuts" toggle, remembered by
 * `playbackPreferences.ts`) maps none of them. Space, the arrows, Home and End
 * are not character keys, and stay.
 */
export function keyToAction(
  input: KeyInput,
  options: { letters: boolean } = { letters: true },
): TransportAction | null {
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  const tag = (input.target?.tagName ?? "").toUpperCase();
  if (TYPING_TARGETS.has(tag) || input.target?.isContentEditable) return null;
  switch (input.key) {
    case " ":
    case "Spacebar":
      return ACTIVATES_ON_SPACE.has(tag) ? null : { type: "toggle" };
    case "ArrowRight":
      return { type: "step", delta: 1 };
    case "ArrowLeft":
      return { type: "step", delta: -1 };
    case "Home":
      return { type: "restart" };
    case "End":
      return { type: "end" };
    default:
      return options.letters ? (LETTER_ACTIONS.get(input.key) ?? null) : null;
  }
}

/**
 * The key legend under the stage, in the order a reader reaches for them —
 * with the letters only while they work. Speed has no key but a letter, so
 * with the letters off its rows go and the speed buttons are its control.
 */
export function keyLegend(letters: boolean): readonly { keys: string; action: string }[] {
  return letters
    ? [
        { keys: "Space or K", action: "Play or pause" },
        { keys: "→ or L", action: "Next step" },
        { keys: "← or J", action: "Previous step" },
        { keys: "Home", action: "Back to the start" },
        { keys: "End", action: "Jump to the end" },
        { keys: "] or +", action: "Faster" },
        { keys: "[ or −", action: "Slower" },
      ]
    : [
        { keys: "Space", action: "Play or pause" },
        { keys: "→", action: "Next step" },
        { keys: "←", action: "Previous step" },
        { keys: "Home", action: "Back to the start" },
        { keys: "End", action: "Jump to the end" },
      ];
}
