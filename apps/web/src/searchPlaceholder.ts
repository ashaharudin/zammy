import type { TrendingStoryline } from "@zammy/shared";

const EXAMPLE_COUNT = 3;

/**
 * Shown until the window has enough storylines to speak for itself — loading,
 * an errored /trending, and a cold-start deployment all land here (§9.3).
 */
const STOCK_EXAMPLES = ["ai regulation", "wildfires", "interest rates"];

/**
 * The hero search bar's placeholder text (ARCHITECTURE 10): the storylines
 * leading the cloud, offered as examples of what there is to search for.
 *
 * Taken in the order they arrive, which is the cloud's own ranking — busiest
 * and freshest first (ADR-0014) — so the placeholder names the stories the
 * board is already leading with.
 *
 * It offers each storyline's `query` rather than its LABEL, and that is the
 * whole point of the field: this is ghost text standing in for what the reader
 * would TYPE, so it has to be something worth typing. A label typed verbatim is
 * a conjunctive upstream query that returns nothing (ADR-0014), which made the
 * old version of this function a suggestion to search for an empty timeline.
 * The two stock examples are two-word searches for the same reason.
 *
 * Already lowercase, since `query` is built from folded corpus tokens — where
 * the label needed folding to stand beside the stock examples.
 */
export function searchPlaceholder(storylines: readonly TrendingStoryline[]): string {
  const examples =
    storylines.length >= EXAMPLE_COUNT
      ? storylines.slice(0, EXAMPLE_COUNT).map((storyline) => storyline.query.toLowerCase())
      : STOCK_EXAMPLES;
  return `e.g. ${examples.join(", ")}…`;
}
