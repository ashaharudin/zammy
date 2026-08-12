/**
 * How big a cloud word may be drawn before d3-cloud silently refuses to place
 * it (ARCHITECTURE 10.5).
 *
 * d3-cloud does not shrink, wrap or warn about a word that does not fit. It
 * measures each word into a collision box, and `place()` rejects any candidate
 * position whose box crosses the board edge; a word that never places is simply
 * absent from the array handed to `.on("end")`. Since font size is assigned by
 * RANK — the top-scoring term always gets `FONT_MAX` — the word most likely to
 * disappear is the one the cloud most wants to show. It stays in the accessible
 * list either way, so the two views disagree with nothing signalling why.
 *
 * Measured against d3-cloud 1.2.9: on an empty 700px board any term past 20
 * characters is unplaceable above ~55px, and `artificial intelligence` (23)
 * vanishes at font 56, while `democratic primary` (18, the longest term the
 * recorded corpora produce) places at any size. Nothing in those corpora is
 * long enough to trigger it today — `artificial intelligence` clears both df
 * gates but is stopped by the propriety gate, so `ai` is what ships. This is a
 * guard against a real library behaviour at the shipped n <= 2, not a fix for
 * a failure anyone has seen (ADR-0007).
 */

/**
 * Monospace advance width per character, as a fraction of the font size.
 * Menlo is 0.6021em and SF Mono 0.6em; 0.62 buys margin for whichever member
 * of the `MONO` stack the browser actually resolves.
 */
const MONO_ADVANCE = 0.62;

/**
 * The widest collision box d3-cloud will place, in px, given the board width.
 *
 * The box is `ceil32(measuredWidth + 1)` — rounded UP to a 32px bucket — so a
 * word can lose up to 31px to rounding alone. Reserving the whole bucket is
 * what makes this a bound rather than an estimate.
 */
const BOX_ROUNDING_PX = 32;

/**
 * The largest font size at which a `length`-character monospace word still
 * fits a `boardWidth`-wide layout.
 *
 * Inverts d3-cloud's own measurement: it sizes the box from `⌊size + 1⌋` px
 * and pads by 1px before rounding, so the constraint is
 * `length × advance × (font + 1) + 1 + rounding <= boardWidth`.
 *
 * Never returns less than `floor`: below that the word is illegible anyway, and
 * a term long enough to need it (~80 characters) cannot come out of a headline
 * tokenizer that splits on whitespace.
 */
export function maxPlaceableFont(
  length: number,
  boardWidth: number,
  floor: number,
): number {
  if (length <= 0) return Number.POSITIVE_INFINITY;
  const usable = boardWidth - BOX_ROUNDING_PX - 1;
  return Math.max(floor, usable / (length * MONO_ADVANCE) - 1);
}
