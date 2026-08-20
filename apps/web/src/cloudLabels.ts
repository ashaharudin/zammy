import type { TrendingStoryline } from "@zammy/shared";
import { relativeTime } from "./format.js";

/**
 * What the cloud says in words rather than in size and colour (ARCHITECTURE
 * 10.5). Pure, and separate from the component for the same reason
 * `storylineLabels.ts` is: these are the strings assistive technology reads,
 * and a wordcloud's two visual channels mean nothing without them.
 */

/**
 * How many hours the response covers, from the window it reports.
 *
 * Read off `windowStart`/`windowEnd` rather than hardcoded, because
 * `TREND_WINDOW_HOURS` is a knob and a section labelled "the last 24 hours"
 * over a 48-hour window is a lie the reader cannot check. Rounded, since the
 * window ends at whatever instant the response was built.
 */
export function windowHours(window: { windowStart: string; windowEnd: string }): number {
  const hours = Math.round(
    (Date.parse(window.windowEnd) - Date.parse(window.windowStart)) / 3_600_000,
  );
  return Number.isFinite(hours) && hours > 0 ? hours : 24;
}

/** "the last 24 hours" — the window, as a phrase both labels below reuse. */
export function windowPhrase(window: { windowStart: string; windowEnd: string }): string {
  const hours = windowHours(window);
  return hours === 1 ? "the last hour" : `the last ${hours} hours`;
}

/**
 * The four facts behind one word: how much of this arc landed in the window,
 * how many newsrooms carried it there, when it last moved, and how big the
 * whole arc is.
 *
 * All four are in the cloud's `title` and the list's text, where they cost no
 * layout — because the two visual channels each carry exactly one of them (size
 * is the window's article count, colour is recency) and neither is legible as a
 * number. Two of them get no channel at all:
 *
 *  - **The outlet count** is the breadth GATE (ADR-0014), so it is the reason
 *    this word is on the board rather than a detail about it: "2 articles from
 *    2 outlets" is what separates a story several newsrooms are covering from
 *    one newsroom filing twice.
 *  - **The arc's total** tells a three-week story from a three-hour one that
 *    happens to be busy.
 */
export function cloudDetail(
  storyline: Pick<
    TrendingStoryline,
    "windowArticles" | "windowSources" | "size" | "lastUpdated"
  >,
  window: { windowStart: string; windowEnd: string },
): string {
  const fresh = `${storyline.windowArticles} article${
    storyline.windowArticles === 1 ? "" : "s"
  } from ${storyline.windowSources} outlet${
    storyline.windowSources === 1 ? "" : "s"
  } in ${windowPhrase(window)}`;
  const updated = `updated ${relativeTime(storyline.lastUpdated)}`;
  // Only worth saying when the arc is bigger than the window's slice of it;
  // "3 articles in the last 24 hours · 3 in all" is a sentence about nothing.
  const arc = storyline.size > storyline.windowArticles ? ` · ${storyline.size} in all` : "";
  return `${fresh}, ${updated}${arc}`;
}
