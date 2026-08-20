import { describe, expect, it } from "vitest";
import type { TrendingStoryline } from "@zammy/shared";
import { searchPlaceholder } from "./searchPlaceholder.js";

/**
 * The hero search bar's placeholder (ARCHITECTURE 10): the examples it offers
 * should be what has actually just happened, not three keywords frozen in the
 * source — and they should be searches that RETURN something, which is what
 * offering `query` instead of `label` is for (ADR-0014).
 */

function storyline(label: string, query: string, minutesAgo: number): TrendingStoryline {
  return {
    id: `id-${label}`,
    label,
    query,
    windowArticles: 3,
    windowSources: 2,
    size: 9,
    sourceCount: 2,
    lastUpdated: new Date(Date.UTC(2026, 7, 17, 12, 0, 0) - minutesAgo * 60_000).toISOString(),
  };
}

describe("searchPlaceholder", () => {
  it("offers the leading storylines' searches, not their labels", () => {
    // The label is what the board draws; the query is what a click runs and
    // therefore what ghost text should suggest typing. A label typed verbatim
    // is a conjunctive upstream query that returns nothing (ADR-0014).
    const placeholder = searchPlaceholder([
      storyline("Gaza Ceasefire Talks", "gaza ceasefire", 5),
      storyline("Federal Reserve Rate Cut", "federal reserve", 40),
      storyline("Nvidia Chip Export Ban", "nvidia chip", 90),
      storyline("Wimbledon Final", "wimbledon", 600),
    ]);

    expect(placeholder).toBe("e.g. gaza ceasefire, federal reserve, nvidia chip…");
  });

  it("trusts the order it was handed, because that order IS the cloud's ranking", () => {
    // The API returns the board's own ranking — busiest and freshest first
    // (ADR-0014) — so re-sorting here could only make the placeholder disagree
    // with which words the reader's eye is being drawn to.
    const placeholder = searchPlaceholder([
      storyline("Wimbledon Final", "wimbledon", 600),
      storyline("Gaza Ceasefire Talks", "gaza ceasefire", 5),
      storyline("Nvidia Chip Export Ban", "nvidia chip", 90),
    ]);

    expect(placeholder).toBe("e.g. wimbledon, gaza ceasefire, nvidia chip…");
  });

  it("keeps the stock examples while the window is still thin", () => {
    // Loading, an errored fetch, and a cold-start deployment all arrive here.
    expect(searchPlaceholder([])).toBe("e.g. ai regulation, wildfires, interest rates…");
    expect(
      searchPlaceholder([
        storyline("Gaza Ceasefire Talks", "gaza ceasefire", 5),
        storyline("Wimbledon Final", "wimbledon", 600),
      ]),
    ).toBe("e.g. ai regulation, wildfires, interest rates…");
  });
});
