import type { StorylineSummary } from "@zammy/shared";
import { orderStorylinePills } from "./storylinePillMotion.js";

/**
 * The storyline view's row of pills as a POOL of offers (ADR-0028, amended).
 *
 * The row offers storylines the reader has not taken. Taking one moves it to
 * the prompt as a chip and out of the row, and the next match from the same
 * search takes its place, so the row stays a row's worth. Dismissing a chip
 * returns its storyline to the row, which is then one over, and the pill with
 * the fewest articles makes room — the row is ordered biggest first
 * (`orderStorylinePills`), so that is its last pill.
 *
 * Two pure pieces, because both rules are the kind that are easy to get subtly
 * wrong and impossible to see going wrong in a screenshot: which candidates the
 * view has ever been offered (`growPool`), and which of them it shows now
 * (`offeredPills`).
 */

/**
 * Everything the search has answered so far for one question, in the order
 * first seen — the server's ranking for the first answer, later arrivals
 * appended. Kept rather than replaced because the row asks for more as the
 * reader takes pills (a row's worth plus one per held arc), and a chip
 * dismissed later shrinks that ask again: without the pool, the ninth match
 * would vanish the moment the ask went back to eight, and the row would lose
 * a pill by rank instead of by size.
 *
 * Returns the SAME array when nothing is new, so a render that memoises on it
 * does no work for an answer it already had.
 */
export function growPool(
  pool: readonly StorylineSummary[],
  incoming: readonly StorylineSummary[],
): readonly StorylineSummary[] {
  const known = new Set(pool.map((storyline) => storyline.id));
  const fresh = incoming.filter((storyline) => !known.has(storyline.id));
  return fresh.length === 0 ? pool : [...pool, ...fresh];
}

/**
 * The pills to draw: the pool without the arcs the view holds, biggest first,
 * and no more than `count` — the smallest are the ones that do not fit.
 *
 * Ties in size keep pool order, which is the server's ranking, so two
 * equal-sized arcs are offered fresher first and the same one is dropped each
 * time.
 */
export function offeredPills(
  pool: readonly StorylineSummary[],
  held: ReadonlySet<string>,
  count: number,
): StorylineSummary[] {
  return orderStorylinePills(pool.filter((storyline) => !held.has(storyline.id))).slice(0, count);
}
