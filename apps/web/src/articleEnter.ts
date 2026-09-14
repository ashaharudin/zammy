/**
 * The cards' entrance (ARCHITECTURE §8.3): an article fades in as it mounts, a
 * beat after the one above it, so a run of articles arrives as a cascade rather
 * than as a slab.
 *
 * The beat lives here and the motion lives in `index.css` (`.article-enter`) —
 * the same split the ingest marks keep, for the same reason `railActivity` is a
 * module: `apps/web` has no renderer in its tests, so a stagger left inline in
 * `TimelinePage` is guarded by nothing. Widening the cap to a number that holds
 * the last card of a busy day back for seconds would pass every test in the
 * package; here it has to get past `articleEnter.test.ts`.
 */

/** The beat between one card and the next. */
export const ENTER_STEP_MS = 45;

/**
 * Where the cascade stops stepping. A run of cards under one heading is
 * unbounded — a busy day carries dozens — and an uncapped stagger would hold the
 * last of them back long after the rail had otherwise settled. Past the cap the
 * remaining cards light together, which on a run that long is only ever true
 * below the fold.
 */
export const ENTER_MAX_STEPS = 7;

/**
 * How long the card at `index` in its run waits before fading in.
 *
 * `index` is the card's place under its own HEADING, not on the rail as a whole:
 * each run cascades from its own start, so a day the reader expands reads the
 * way the first paint of it did, and an older page appended below cascades
 * instead of arriving at the cap all at once.
 */
export function enterDelayMs(index: number): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  return Math.min(Math.floor(index), ENTER_MAX_STEPS) * ENTER_STEP_MS;
}
