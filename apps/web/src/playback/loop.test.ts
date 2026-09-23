import { describe, expect, it } from "vitest";
import { MAX_FRAME_DT_MS, startLoop, type LoopDeps } from "./loop.js";

/**
 * The frame loop (ADR-0029), driven by a fake scheduler.
 *
 * What breaks without these rules is invisible in a quick look and obvious to a
 * reader: a loop that is never cancelled keeps a second copy of the animation
 * running under StrictMode, an unclamped dt jumps the playback forward after a
 * stall, and a hidden tab plays the whole trace while nobody watches.
 */

/** A scheduler that runs frames only when the test says so. */
function fakeFrames() {
  let next = 1;
  const pending = new Map<number, (now: number) => void>();
  const cancelled: number[] = [];
  return {
    pending,
    cancelled,
    requestFrame(cb: (now: number) => void) {
      const handle = next++;
      pending.set(handle, cb);
      return handle;
    },
    cancelFrame(handle: number) {
      cancelled.push(handle);
      pending.delete(handle);
    },
    /** Fires every pending frame at `now`. */
    fire(now: number) {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, cb] of due) cb(now);
    },
  };
}

function loop(overrides: Partial<LoopDeps> & { ticks: number[] }) {
  const frames = fakeFrames();
  const stop = startLoop({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    onTick: (dt) => {
      overrides.ticks.push(dt);
      return true;
    },
    ...overrides,
  });
  return { frames, stop };
}

describe("startLoop", () => {
  it("ticks 0 on the first frame, then the time between frames", () => {
    const ticks: number[] = [];
    const { frames } = loop({ ticks });
    frames.fire(1000);
    frames.fire(1016);
    frames.fire(1049);
    expect(ticks).toEqual([0, 16, 33]);
  });

  it("clamps a long gap between frames to MAX_FRAME_DT_MS", () => {
    const ticks: number[] = [];
    const { frames } = loop({ ticks });
    frames.fire(0);
    frames.fire(5000);
    frames.fire(4000); // a clock going backwards never ticks negative
    expect(ticks).toEqual([0, MAX_FRAME_DT_MS, 0]);
  });

  it("ticks 0 while the page is hidden", () => {
    const ticks: number[] = [];
    let visible = true;
    const { frames } = loop({ ticks, isVisible: () => visible });
    frames.fire(0);
    frames.fire(16);
    visible = false;
    frames.fire(32);
    frames.fire(48);
    visible = true;
    frames.fire(64);
    expect(ticks).toEqual([0, 16, 0, 0, 16]);
  });

  it("stops when onTick returns false, asking for no further frame", () => {
    const frames = fakeFrames();
    let calls = 0;
    startLoop({
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
      onTick: () => {
        calls += 1;
        return calls < 3;
      },
    });
    for (let t = 0; t < 10; t += 1) frames.fire(t * 16);
    expect(calls).toBe(3);
    expect(frames.pending.size).toBe(0);
  });

  it("cancels the pending frame on stop, and stop is idempotent", () => {
    const ticks: number[] = [];
    const { frames, stop } = loop({ ticks });
    frames.fire(0);
    const [handle] = [...frames.pending.keys()];
    stop();
    stop();
    expect(frames.cancelled).toEqual([handle]);
    frames.fire(16);
    expect(ticks).toEqual([0]);
  });

  it("holds a stop made from inside onTick", () => {
    const frames = fakeFrames();
    const ticks: number[] = [];
    let stop = () => {};
    stop = startLoop({
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
      onTick: (dt) => {
        ticks.push(dt);
        stop();
        return true;
      },
    });
    frames.fire(0);
    frames.fire(16);
    expect(ticks).toEqual([0]);
    expect(frames.pending.size).toBe(0);
  });
});
