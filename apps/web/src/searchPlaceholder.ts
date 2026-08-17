import type { TrendingStoryline } from "@zammy/shared";

const EXAMPLE_COUNT = 3;

/**
 * Shown until the window has enough storylines to speak for itself — loading,
 * an errored /trending, and a cold-start deployment all land here (§9.3).
 */
const STOCK_EXAMPLES = ["ai regulation", "wildfires", "interest rates"];

/**
 * The hero search bar's placeholder text (ARCHITECTURE 10): the most recently
 * updated storylines, offered as examples of what there is to search for.
 *
 * Taken in the order they arrive, which is recency (ADR-0013) — the same order
 * the cloud's palette reads, so the placeholder names what the reader's eye is
 * already being drawn to. It offers the LABELS because the box is a search box
 * and the cloud's own click runs a label as a search too.
 */
export function searchPlaceholder(storylines: readonly TrendingStoryline[]): string {
  const examples =
    storylines.length >= EXAMPLE_COUNT
      ? storylines.slice(0, EXAMPLE_COUNT).map((storyline) => storyline.label.toLowerCase())
      : STOCK_EXAMPLES;
  return `e.g. ${examples.join(", ")}…`;
}
