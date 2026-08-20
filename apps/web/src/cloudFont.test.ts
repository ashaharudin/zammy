import { describe, expect, it } from "vitest";
import type { TrendingStoryline } from "@zammy/shared";
import { FONT_MAX, FONT_MIN, fontSizes } from "./cloudFont.js";

/**
 * The "how much" channel (ARCHITECTURE 10.5). The interesting boards are the
 * ones a browser is least likely to hand you: a single word, and a window where
 * every storyline gained the same count. Both are ordinary now that the input is
 * a small integer count rather than the continuous score it replaced.
 */

const BOARD = 700;
const MID = (FONT_MIN + FONT_MAX) / 2;

function storyline(id: string, windowArticles: number): TrendingStoryline {
  return {
    id,
    label: `Arc ${id}`,
    query: `arc ${id}`,
    windowArticles,
    windowSources: 2,
    size: windowArticles * 3,
    sourceCount: 2,
    lastUpdated: "2026-08-17T12:00:00.000Z",
  };
}

describe("fontSizes", () => {
  it("gives the busiest storyline the top of the range and the quietest the floor", () => {
    const sizes = fontSizes([storyline("a", 1), storyline("b", 9), storyline("c", 36)], BOARD);

    expect(sizes.get("c")).toBeCloseTo(FONT_MAX);
    expect(sizes.get("a")).toBeCloseTo(FONT_MIN);
    expect(sizes.get("b")!).toBeGreaterThan(FONT_MIN);
    expect(sizes.get("b")!).toBeLessThan(FONT_MAX);
  });

  it("compresses the busiest by sqrt rather than scaling linearly", () => {
    // 1, 4, 36 articles: linear would put the middle word a twelfth of the way
    // up the range. sqrt puts it a fifth, which is what keeps the tail legible.
    const sizes = fontSizes([storyline("a", 1), storyline("b", 4), storyline("c", 36)], BOARD);
    const fraction = (sizes.get("b")! - FONT_MIN) / (FONT_MAX - FONT_MIN);

    expect(fraction).toBeCloseTo(0.2);
  });

  it("draws a uniform board at the middle, not at the floor", () => {
    // A thin window, or a young deployment: every qualifying storyline gained
    // the same one article. Equal counts must render equal, and the floor would
    // say "quiet" about a board that is merely uniform.
    const sizes = fontSizes([storyline("a", 1), storyline("b", 1), storyline("c", 1)], BOARD);

    expect([...sizes.values()]).toEqual([MID, MID, MID]);
  });

  it("draws a lone storyline at the middle rather than shrinking it to nothing", () => {
    expect(fontSizes([storyline("a", 12)], BOARD).get("a")).toBe(MID);
  });

  it("clamps a long label to what d3-cloud will actually place", () => {
    const long: TrendingStoryline = {
      ...storyline("long", 36),
      label: "Hormuz Strait Shipping Insurance Crisis",
    };
    const sizes = fontSizes([storyline("a", 1), long], BOARD);

    // Top of the range by count, but 39 characters do not fit a 700px board.
    expect(sizes.get("long")!).toBeLessThan(FONT_MAX);
    expect(sizes.get("long")!).toBeGreaterThan(FONT_MIN);
  });
});
