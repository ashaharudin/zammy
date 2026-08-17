import type { TrendingStoryline } from "@zammy/shared";
import { maxPlaceableFont } from "./wordFit.js";

/**
 * How big each cloud word is drawn (ARCHITECTURE 10.5) — the "how much" channel.
 *
 * Pure, and separate from the component for the same reason `wordFit` and
 * `cloudLabels` are: the mapping from a count to a font size is the half of the
 * cloud that can be reasoned about without a DOM, and the degenerate boards are
 * the ones a browser is least likely to show you.
 */

export const FONT_MIN = 12;
export const FONT_MAX = 56;

/**
 * Font from sqrt(articles inside the window), ramped across the board into
 * `[FONT_MIN, FONT_MAX]` — sqrt because linear makes the busiest storyline
 * absurd and the tail illegible. The window's count and not the arc's: a
 * storyline running since March would otherwise be the biggest word on the
 * board every day for a month, whatever happened today.
 *
 * **When nothing separates the board, every word takes the middle.** The ramp
 * is relative to the visible extremes, and `windowArticles` is a small integer
 * rather than the continuous score this replaced, so a board where every
 * storyline gained the same count is an ordinary case rather than a pathological
 * one — a thin window, a young deployment, or a single qualifying storyline.
 * Equal counts must render equal, and both other readings of "equal" are lies:
 * the floor calls a uniform board a quiet one, the ceiling calls it a busy one
 * and hands d3-cloud more `FONT_MAX` words than the board can place.
 *
 * The second clamp is by LENGTH, and it is not cosmetic: a word too wide for the
 * board is dropped by d3-cloud without a word of complaint, and labels are two
 * to five WORDS rather than one, so that bound is now routinely met rather than
 * being the guard it was for terms (see `wordFit`).
 */
export function fontSizes(
  storylines: readonly TrendingStoryline[],
  boardWidth: number,
): Map<string, number> {
  const roots = storylines.map((s) => Math.sqrt(Math.max(s.windowArticles, 0)));
  const min = Math.min(...roots);
  const max = Math.max(...roots);
  const span = max - min;
  return new Map(
    storylines.map((storyline, i) => [
      storyline.id,
      Math.min(
        span === 0
          ? (FONT_MIN + FONT_MAX) / 2
          : FONT_MIN + ((roots[i]! - min) / span) * (FONT_MAX - FONT_MIN),
        maxPlaceableFont(storyline.label.length, boardWidth, FONT_MIN),
      ),
    ]),
  );
}
