/**
 * The STRIP the landing cloud is laid out on, and how fast each word crosses
 * it (ARCHITECTURE 10.5).
 *
 * The cloud used to be a fixed 700×340 board scaled down to whatever the
 * viewport gave it: everything the reader could see at once, and everything
 * there was. It now drifts right to left, which turns the board into a strip
 * longer than the window looking at it — so the board's width stops being a
 * layout constant and becomes a function of how many words have to fit on it.
 *
 * The strip drifts in LANES, each at its own speed (`cloudLanes`): the board
 * recomposes itself as the bands slide over one another, and no word ever
 * touches another, because d3-cloud's guarantee holds inside a lane that moves
 * rigidly and the lanes themselves are disjoint strips of the board's height.
 *
 * Pure, and separate from the component for the same reason `cloudFont` and
 * `wordFit` are: a strip too short silently loses words (d3-cloud drops what
 * it cannot place, without a word of complaint — see `wordFit`) and a strip
 * too long drifts a stretch of nothing past the reader. Neither shows up in a
 * unit test of the component, and both are invisible until the board is full.
 */

/**
 * The shortest strip: today's board, and the width `wordFit`'s measurements
 * were taken against. A language with a handful of storylines keeps the cloud
 * it has always had — compact, and quick to come back around — rather than
 * being spread thin over a strip sized for a board that never arrived.
 */
export const BOARD_MIN = 700;

/**
 * The longest, and a bound on the WAIT rather than on the words: the strip is
 * what a reader waits to come back around, and at the rate below this is 80
 * seconds of it. `TRENDING_LIMIT_MAX` is 100 and only an explicit `?limit=`
 * reaches it; past the cap the board gets denser instead of longer, and
 * d3-cloud drops the tail it cannot place — which the accessible list still
 * carries in full.
 */
export const BOARD_MAX = 3200;

/**
 * Strip width per word. Measured against the live English cloud (2026-09-16),
 * counting how many words d3-cloud actually placed:
 *
 *   24px/word → 1200px board → 21 of 50 placed
 *   32px/word → 1920px board → 41 of 60
 *   40px/word → 2400px board → 59 of 60
 *   56px/word → 3360px board → 60 of 60
 *
 * The cliff between 32 and 40 is the point of the measurement: d3-cloud gives
 * up on a word once its spiral leaves the board, so a strip a little too short
 * does not crowd the words — it silently drops a third of them, and the cloud
 * looks fine while doing it. 40 buys all but one, and the last word costs
 * another 960px of strip that the reader would spend 24 seconds crossing.
 */
const BOARD_PER_WORD = 40;

/**
 * How wide a strip `wordCount` words need, clamped into `[BOARD_MIN, BOARD_MAX]`.
 *
 * Proportional rather than fixed so that density is the constant: the strip a
 * full English cloud needs would leave a language with twelve storylines
 * drifting past three-quarters of an empty board.
 */
export function boardWidth(wordCount: number): number {
  return Math.min(BOARD_MAX, Math.max(BOARD_MIN, Math.round(wordCount * BOARD_PER_WORD)));
}

/**
 * The slowest and fastest a lane drifts, in layout px per second.
 *
 * A single rate for the whole board was one moving picture; a range is a few
 * bands sliding over each other, which is what makes the cloud recompose
 * itself instead of repeating.
 *
 * The ratio matters more than either number: 2.4× is enough to watch one lane
 * pull away from the one above it within seconds, and little enough that the
 * slowest still clears the window in about half a minute.
 */
export const DRIFT_SLOWEST_PX_PER_SECOND = 26;
export const DRIFT_FASTEST_PX_PER_SECOND = 62;

/**
 * Seconds for one LANE to cross its own `laneWidth`. `pick` is a stable
 * number in [0, 1) — see `seededRandom`, keyed per lane so that a poll cannot
 * re-roll it — chosen across the range above.
 *
 * **The unit is the lane, and that was measured too.** Per-WORD speeds are the
 * obvious reading of "each one goes its own way", and they cost the layout's
 * one guarantee: d3-cloud promises the words do not collide WHERE IT PUT THEM,
 * and two words at different speeds leave that arrangement immediately. They
 * pass through each other, and the board also thins — the packing is only true
 * at the start, and the words shear apart from there. A lane moves rigidly, so
 * inside it the packing and the guarantee both survive; `cloudLanes` explains
 * why the bands have to be laid out rather than found.
 *
 * Deriving the speed from anything the board MEANS was the other measured
 * dead end. Size is the obvious source, and it empties the middle of the
 * cloud: d3-cloud spirals outward from the centre, so size and position are
 * correlated, and giving the big words their own speed marches the whole
 * centre off the left edge together — twenty seconds in, the top half of the
 * board was gone. An uncorrelated draw claims nothing, which is the honest
 * state for a channel with nothing to say: size answers "how much", colour
 * "how recently" (ADR-0013), and a word's place in the cloud was always
 * arbitrary.
 *
 * A lane crosses its OWN width, measured from what it actually holds, and the
 * two are what keep the loop seamless: the copy standing one lane-width to the
 * right is the same lane at the same offset, so the pair simply swap places at
 * the wrap (`TrendingCloud`). Wrapping every lane at a shared width instead —
 * the widest lane's, or the board the layout ran in — pads the short ones with
 * however much they fell short, and those gaps drift through the window.
 *
 * The rate is in LAYOUT px, before the viewport's own scale — so a phone, which
 * draws the same strip at half the size, takes the same time to pass it. The
 * alternative (constant on-screen px/s) drifts a phone's smaller text at the
 * same absolute speed as a desktop's, which reads as twice as fast.
 *
 * Floored at `BOARD_MIN`, because the width this is given is MEASURED: it is 0
 * for the commit before the words are in the DOM to measure, and a browser
 * reads `animation-duration: 0s` as a lane sitting still at the end of its own
 * loop rather than as one that has not started.
 */
export function laneDriftSeconds(laneWidth: number, pick = 0.5): number {
  const width = Number.isFinite(laneWidth) ? Math.max(laneWidth, BOARD_MIN) : BOARD_MIN;
  const along = Number.isFinite(pick) ? Math.min(1, Math.max(0, pick)) : 0.5;
  const speed =
    DRIFT_SLOWEST_PX_PER_SECOND +
    along * (DRIFT_FASTEST_PX_PER_SECOND - DRIFT_SLOWEST_PX_PER_SECOND);
  return width / speed;
}
