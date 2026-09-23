/**
 * The playback's frame loop, with its scheduler injected (ADR-0029: it autoplays once,
 * never loops, and stops while nobody watches).
 *
 * `startLoop` asks for animation frames and hands each one's elapsed time to
 * `onTick`, until `onTick` says stop or the caller does. It exists as a module
 * so the rules that make an animation loop safe are testable in node with a fake
 * `requestFrame`, in the same way `ingestPoll.ts` takes its fetch and its timer:
 *
 *  - The first frame ticks 0. A loop started after a pause must not replay the
 *    whole pause as one enormous step.
 *  - Every dt is clamped to `MAX_FRAME_DT_MS`. A tab that stalls (a GC, a slow
 *    paint, a debugger) resumes where it was rather than lurching ahead.
 *  - While the page is hidden, frames tick 0. Browsers mostly stop animation
 *    frames for a hidden tab anyway; when one does fire, the playback should not
 *    advance for a reader who is not looking (`isPageVisible`, `browser.ts`).
 *  - `stop()` cancels the pending frame, is idempotent, and holds even when it is
 *    called from inside `onTick` — React's effect cleanup does exactly that when a
 *    tick's state change pauses the page, and StrictMode runs every effect twice.
 *
 * Deliberately not here: what a tick DOES (`playbackClock.ts` decides), and any
 * reading of the wall clock — the timestamps are the scheduler's.
 */

/** The longest step one frame may take, in ms. */
export const MAX_FRAME_DT_MS = 100;

export interface LoopDeps {
  requestFrame(cb: (now: number) => void): number;
  cancelFrame(handle: number): void;
  /** Called once per frame with the clamped elapsed ms; return false to stop. */
  onTick(dtMs: number): boolean;
  isVisible?: () => boolean;
}

/** Starts the loop; returns `stop()`. */
export function startLoop(deps: LoopDeps): () => void {
  let stopped = false;
  let handle: number | null = null;
  let last: number | null = null;

  const frame = (now: number) => {
    handle = null;
    if (stopped) return;
    const visible = deps.isVisible ? deps.isVisible() : true;
    const dt = last === null || !visible || !Number.isFinite(now - last)
      ? 0
      : Math.min(MAX_FRAME_DT_MS, Math.max(0, now - last));
    last = now;
    const more = deps.onTick(dt);
    if (!more) stopped = true;
    if (stopped) return;
    handle = deps.requestFrame(frame);
  };

  handle = deps.requestFrame(frame);
  return () => {
    if (stopped) return;
    stopped = true;
    if (handle !== null) deps.cancelFrame(handle);
    handle = null;
  };
}
