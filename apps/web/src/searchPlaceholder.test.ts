import { describe, expect, it } from "vitest";
import type { TrendingStoryline } from "@zammy/shared";
import { searchPlaceholder } from "./searchPlaceholder.js";

/**
 * The hero search bar's placeholder (ARCHITECTURE 10): the examples it offers
 * should be what has actually just happened, not three keywords frozen in the
 * source.
 */

function storyline(label: string, minutesAgo: number): TrendingStoryline {
  return {
    id: `id-${label}`,
    label,
    windowArticles: 3,
    size: 9,
    sourceCount: 2,
    lastUpdated: new Date(Date.UTC(2026, 7, 17, 12, 0, 0) - minutesAgo * 60_000).toISOString(),
  };
}

describe("searchPlaceholder", () => {
  it("offers the three most recently updated storylines as examples", () => {
    const placeholder = searchPlaceholder([
      storyline("Gaza Ceasefire Talks", 5),
      storyline("Federal Reserve Rate Cut", 40),
      storyline("Nvidia Chip Export Ban", 90),
      storyline("Wimbledon Final", 600),
    ]);

    expect(placeholder).toBe(
      "e.g. gaza ceasefire talks, federal reserve rate cut, nvidia chip export ban…",
    );
  });

  it("trusts the order it was handed, because that order IS recency", () => {
    // The API returns most recently updated first (ADR-0013) and the cloud's
    // palette reads the same array index, so re-sorting here could only make
    // the placeholder disagree with the words on the board.
    const placeholder = searchPlaceholder([
      storyline("Wimbledon Final", 600),
      storyline("Gaza Ceasefire Talks", 5),
      storyline("Nvidia Chip Export Ban", 90),
    ]);

    expect(placeholder).toBe("e.g. wimbledon final, gaza ceasefire talks, nvidia chip export ban…");
  });

  it("keeps the stock examples while the window is still thin", () => {
    // Loading, an errored fetch, and a cold-start deployment all arrive here.
    expect(searchPlaceholder([])).toBe("e.g. ai regulation, wildfires, interest rates…");
    expect(
      searchPlaceholder([storyline("Gaza Ceasefire Talks", 5), storyline("Wimbledon Final", 600)]),
    ).toBe("e.g. ai regulation, wildfires, interest rates…");
  });
});
