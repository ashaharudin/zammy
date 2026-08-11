import type { TrendingTerm } from "@zammy/shared";

const EXAMPLE_COUNT = 3;

/**
 * Shown until the day has enough terms to speak for itself — loading, an
 * errored /trending, and a cold-start day all land here (§9.3).
 */
const STOCK_EXAMPLES = ["ai regulation", "wildfires", "interest rates"];

/**
 * The hero search bar's placeholder text (ARCHITECTURE 10): the day's leading
 * terms, offered as examples of what there is to search for.
 */
export function searchPlaceholder(terms: readonly TrendingTerm[]): string {
  const examples =
    terms.length >= EXAMPLE_COUNT
      ? [...terms]
          .sort((a, b) => b.score - a.score)
          .slice(0, EXAMPLE_COUNT)
          .map((t) => t.term)
      : STOCK_EXAMPLES;
  return `e.g. ${examples.join(", ")}…`;
}
