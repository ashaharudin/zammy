/**
 * The LANES the cloud drifts in (ARCHITECTURE 10.5): horizontal bands, each
 * laid out and moved as a unit.
 *
 * **A d3-cloud board has no lanes in it, which is why they are laid out rather
 * than found.** The obvious approach is to take the finished board and group
 * the words whose vertical spans touch — words in different groups can never
 * overlap, whatever their speeds, so those groups would be safe lanes.
 * Measured on the live English cloud (2026-09-16): 43 words, two groups, 38 of
 * them in the first. The spiral fills outward from one centre and the result is
 * a single connected mass, so there is nothing to cut.
 *
 * So the band comes first and the layout second: the words are dealt into
 * bands here, and `TrendingCloud` runs a separate d3-cloud inside each one.
 * Two properties follow, and they are the whole reason for the shape:
 *
 *   - Inside a lane, d3-cloud still guarantees the words do not collide, and a
 *     lane moves rigidly — so that guarantee survives the motion. This is what
 *     per-WORD speeds could not offer at any price.
 *   - Across lanes, the bands are disjoint strips of the board's height, so a
 *     word in one can never reach a word in another however far they slide.
 *
 * Nothing here knows about d3-cloud, pixels or the DOM: it is the dealing and
 * the arithmetic, which are the parts that can be wrong in a way no browser
 * would show you.
 */

/**
 * The most lanes the board is cut into.
 *
 * Bounded by the tallest word, not by taste: `LAYOUT_HEIGHT` is 340 and
 * `FONT_MAX` is 56, and a band has to hold the biggest word that lands in it
 * with room for the spiral to move it around. Four bands is 85px each. Five
 * would be 68, which a 56px word fits only by not being placed anywhere but
 * the middle — and d3-cloud drops what it cannot place.
 */
export const LANE_MAX = 4;

/**
 * Words per lane, at the point the next lane is worth opening. Ten is roughly
 * what a 2000×85 band holds; below it, lanes read as sparse stripes rather than
 * as a cloud. Four lanes of eleven placed 42 of the 50 words the live board
 * offered, against 43 for the same words on one undivided board — banding
 * costs the spiral some of its interlocking, but not its capacity.
 */
const WORDS_PER_LANE = 10;

/**
 * How many lanes `wordCount` words are dealt into, at least one.
 *
 * One lane is the degenerate case and it is a real one — a language with eight
 * storylines gets a single band drifting as a piece, which is the whole board
 * moving as it did before lanes existed. Nothing special-cases it.
 */
export function laneCount(wordCount: number): number {
  if (!Number.isFinite(wordCount)) return 1;
  return Math.min(LANE_MAX, Math.max(1, Math.floor(wordCount / WORDS_PER_LANE)));
}

/**
 * How far the widest and narrowest bands sit either side of the board's own
 * width, as a fraction.
 *
 * Bands of one length make the cloud a set of shutters: every lane comes back
 * around at the same distance, and only the speeds keep them apart. Different
 * lengths mean the pattern of what is beside what almost never repeats — two
 * lanes are back in step only when their lengths and speeds agree at once.
 *
 * A third makes the widest band twice the narrowest, which is plain to see
 * without the narrow ones becoming too short to hold a long label. It is not
 * what decides how many words place: the board is spread around the same total
 * and a wider band takes proportionally more words (see `dealIntoLanes`), so
 * measured on the live cloud, a third and a fifth both placed 38 of 50 — the
 * few words d3-cloud turns away move between the lanes rather than growing in
 * number.
 */
export const LANE_WIDTH_SPREAD = 1 / 3;

/**
 * Each lane's layout width, spread evenly around `board` and shuffled.
 *
 * `picks` are stable numbers in [0, 1), one per lane (see `seededRandom`,
 * keyed per language so the board is the same cloud on every poll).
 *
 * The spread is even and then SHUFFLED rather than drawn at random, and the
 * difference matters: four random draws are quite likely to come out nearly
 * equal, which is the one outcome the spread exists to avoid. Dealing a fixed
 * ladder of widths guarantees the extremes are present, and the shuffle is
 * what stops the widest band from always being the bottom one.
 *
 * The mean is exactly `board`, so cutting the board into bands of differing
 * lengths neither adds nor removes room for words overall.
 */
export function laneWidths(board: number, picks: readonly number[]): number[] {
  return spreadAcross(
    picks.length,
    board * (1 - LANE_WIDTH_SPREAD),
    board * (1 + LANE_WIDTH_SPREAD),
    picks,
  ).map(Math.round);
}

/**
 * `count` values spread evenly from `from` to `to`, then shuffled by `picks`
 * (stable numbers in [0, 1) — see `seededRandom`).
 *
 * A ladder and a shuffle rather than `count` random draws, and the difference
 * is the whole reason this exists: four draws from a range are quite likely to
 * come out near each other, which is the one outcome a spread is for avoiding.
 * Measured when the lane fades were drawn independently — a 6–18% range
 * produced 6.3, 8.7, 12.8 and 13.5%, with nothing at the wide end. A ladder
 * guarantees both extremes are on the board and the shuffle decides only which
 * lane gets which.
 *
 * One value takes the middle of the range: there is nothing for it to differ
 * from, and an end of the range would be an odd thing to hand a board that has
 * only one lane.
 */
export function spreadAcross(
  count: number,
  from: number,
  to: number,
  picks: readonly number[],
): number[] {
  if (!Number.isFinite(count) || count <= 1) return [(from + to) / 2];
  const ladder = Array.from(
    { length: count },
    (_, step) => from + ((to - from) * step) / (count - 1),
  );
  // Fisher-Yates on the picks: deterministic, and every permutation reachable.
  for (let i = count - 1; i > 0; i -= 1) {
    const pick = Number.isFinite(picks[i]) ? Math.min(0.999999, Math.max(0, picks[i]!)) : 0;
    const j = Math.floor(pick * (i + 1));
    [ladder[i], ladder[j]] = [ladder[j]!, ladder[i]!];
  }
  return ladder;
}

/**
 * Deal `items` — already in the API's rank order, busiest and freshest first
 * (ADR-0014) — across bands, one at a time, each going to whichever band is
 * furthest behind its `shares` (its width: see `laneWidths`).
 *
 * One at a time rather than in slices, and that is the difference between a
 * cloud and a chart: the response is ranked, so consecutive slices would put
 * every big word in the top band and leave the bottom one a row of fine print.
 * Dealing them out like cards gives each lane one of the busiest, one of the
 * next, and so on down — every band ends up with the same spread of sizes, and
 * a reader cannot mistake a lane for a ranking.
 *
 * By SHARE rather than in equal piles, because the bands are not the same
 * length. Equal piles in unequal bands would draw the same words further apart
 * in the wide ones and crowd them in the narrow ones — density would read as
 * an accident of which band a word landed in. Proportional dealing keeps every
 * band as full as every other. With equal shares this is exactly round-robin.
 *
 * The order inside a lane is preserved, so the layout that follows is as
 * deterministic as its seed (see `layoutSeed`).
 */
export function dealIntoLanes<T>(items: readonly T[], shares: readonly number[]): T[][] {
  // A share that is zero, negative or NaN would take every word (its ratio
  // never rises) or none at all; a board with no lanes at all would drop them
  // on the floor without raising anything.
  const weights = shares.filter((share) => Number.isFinite(share) && share > 0);
  const count = Math.max(1, weights.length);
  const dealt: T[][] = Array.from({ length: count }, () => []);
  for (const item of items) {
    let leader = 0;
    for (let lane = 1; lane < count; lane += 1) {
      if (dealt[lane]!.length / (weights[lane] ?? 1) < dealt[leader]!.length / (weights[leader] ?? 1))
        leader = lane;
    }
    dealt[leader]!.push(item);
  }
  return dealt;
}

/**
 * How much of the window a lane's words fade across as they arrive and leave,
 * as a fraction of the window's width — narrowest and widest.
 *
 * One fade for the whole board still lines the lanes up: every row began and
 * ended dissolving at the same two x positions, which is a softer version of
 * the guillotine it replaced. A fade per lane per SIDE leaves nothing for the
 * eye to join up — the rows stop being rows.
 *
 * The floor is where a fade stops reading as one: below ~5% of the window a
 * word crosses it in a few frames and is back to being cut. The ceiling is
 * where it starts eating the board — at a fifth of a 760px window, a word
 * spends 150px arriving.
 */
export const EDGE_FADE_MIN = 0.06;
export const EDGE_FADE_MAX = 0.18;

/**
 * One fade per lane, as a percentage of the window's width, spread across
 * `[EDGE_FADE_MIN, EDGE_FADE_MAX]` and shuffled by `picks` — so some lanes
 * begin dissolving a word well before others have started on theirs.
 *
 * Rounded to a tenth of a percent: two edges never differ by a hundredth,
 * which no one can see and which would churn the mask string on every render.
 */
export function edgeFades(lanes: number, picks: readonly number[]): number[] {
  return spreadAcross(lanes, EDGE_FADE_MIN * 100, EDGE_FADE_MAX * 100, picks).map(
    (percent) => Math.round(percent * 10) / 10,
  );
}
