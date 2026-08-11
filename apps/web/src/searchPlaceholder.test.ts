import { describe, expect, it } from "vitest";
import type { TrendingTerm } from "@zammy/shared";
import { searchPlaceholder } from "./searchPlaceholder.js";

/**
 * The hero search bar's placeholder (ARCHITECTURE 10): the examples it offers
 * should be the day's actual news, not three keywords frozen in the source.
 */

function term(name: string, score: number): TrendingTerm {
  return { term: name, isBigram: false, uniqueArticles: 3, sourceCount: 2, score };
}

describe("searchPlaceholder", () => {
  it("offers the day's top three terms as examples", () => {
    const placeholder = searchPlaceholder([
      term("Gaza", 9),
      term("Federal Reserve", 8),
      term("Nvidia", 7),
      term("Wimbledon", 6),
    ]);

    expect(placeholder).toBe("e.g. Gaza, Federal Reserve, Nvidia…");
  });

  it("ranks by score rather than trusting the order it was handed", () => {
    // TrendingCloud re-sorts for the same reason (rankColors): the cloud's own
    // order is a rendering detail, not a ranking.
    const placeholder = searchPlaceholder([
      term("Wimbledon", 6),
      term("Nvidia", 7),
      term("Gaza", 9),
      term("Federal Reserve", 8),
    ]);

    expect(placeholder).toBe("e.g. Gaza, Federal Reserve, Nvidia…");
  });

  it("keeps the stock examples while the day's cloud is still thin", () => {
    // Loading, an errored fetch, and a cold-start day all arrive here.
    expect(searchPlaceholder([])).toBe("e.g. ai regulation, wildfires, interest rates…");
    expect(searchPlaceholder([term("Gaza", 9), term("Nvidia", 7)])).toBe(
      "e.g. ai regulation, wildfires, interest rates…",
    );
  });
});
