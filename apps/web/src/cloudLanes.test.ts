import { describe, expect, it } from "vitest";
import {
  EDGE_FADE_MAX,
  EDGE_FADE_MIN,
  LANE_MAX,
  dealIntoLanes,
  edgeFades,
  laneCount,
  laneWidths,
  spreadAcross,
} from "./cloudLanes.js";
import { FONT_MAX } from "./cloudFont.js";

/**
 * The lanes are the unit of motion (§10.5), so what is checked here is what a
 * lane has to be for the motion to be safe: enough height to hold the biggest
 * word d3-cloud will try to place in it, and a spread of sizes in every band
 * rather than the ranking the response arrives in.
 */
const LAYOUT_HEIGHT = 340;

describe("laneCount (§10.5)", () => {
  it("leaves a quiet cloud as one band", () => {
    // One lane is the whole board drifting as a piece — the degenerate case,
    // and a real one for a language with eight storylines.
    expect(laneCount(8)).toBe(1);
    expect(laneCount(0)).toBe(1);
  });

  it("opens lanes as the board fills", () => {
    expect(laneCount(25)).toBeGreaterThan(laneCount(15));
  });

  it("never cuts a band too short for the tallest word", () => {
    // d3-cloud drops what it cannot place, in silence (see wordFit), and a
    // band shorter than FONT_MAX is how that would start happening.
    for (const count of [0, 10, 43, 60, 100, 1000]) {
      expect(LAYOUT_HEIGHT / laneCount(count)).toBeGreaterThan(FONT_MAX);
    }
    expect(LAYOUT_HEIGHT / LANE_MAX).toBeGreaterThan(FONT_MAX);
  });
});

describe("laneWidths (§10.5)", () => {
  const still = Array.from({ length: 4 }, () => 0); // no shuffle, so the ladder is readable

  it("spreads the bands around the board rather than drawing them alike", () => {
    const widths = laneWidths(2000, still);
    expect(Math.max(...widths) / Math.min(...widths)).toBeGreaterThan(1.5);
  });

  it("neither adds nor removes room overall", () => {
    // The width is a lane's capacity, so a mean off the board would quietly
    // change how many words the cloud can hold.
    const widths = laneWidths(2000, still);
    expect(widths.reduce((sum, width) => sum + width, 0) / widths.length).toBeCloseTo(2000, 0);
  });

  it("shuffles, so the widest band is not always the same one", () => {
    const first = laneWidths(2000, [0, 0, 0, 0]);
    const other = laneWidths(2000, [0, 0.9, 0.9, 0.9]);
    expect(other).not.toEqual(first);
    expect(other.toSorted()).toEqual(first.toSorted());
  });

  it("leaves a single band the whole board", () => {
    expect(laneWidths(2000, [0.4])).toEqual([2000]);
  });

  it("survives a pick at either end, or no pick at all", () => {
    for (const picks of [[0, 0, 0, 0], [1, 1, 1, 1], [Number.NaN, -1, 2, Number.NaN]]) {
      const widths = laneWidths(2000, picks);
      expect(widths).toHaveLength(4);
      for (const width of widths) expect(width).toBeGreaterThan(0);
    }
  });
});

describe("edgeFades (§10.5)", () => {
  const still = [0, 0, 0, 0]; // no shuffle, so the ladder is readable

  it("has some lanes fade sooner than others, both ends of the range included", () => {
    // One fade for every lane lines the rows back up: each begins dissolving
    // at the same x, which is a softer version of the guillotine it replaced.
    const fades = edgeFades(4, still);
    expect(Math.min(...fades)).toBeCloseTo(EDGE_FADE_MIN * 100, 5);
    expect(Math.max(...fades)).toBeCloseTo(EDGE_FADE_MAX * 100, 5);
  });

  it("stays inside the range it was given, whatever the picks", () => {
    // Too narrow and a word is back to being cut; too wide and the fade eats
    // the board.
    for (const picks of [[0, 0, 0, 0], [1, 1, 1, 1], [Number.NaN, 2, -1, 0.5]]) {
      for (const fade of edgeFades(4, picks)) {
        expect(fade).toBeGreaterThanOrEqual(EDGE_FADE_MIN * 100);
        expect(fade).toBeLessThanOrEqual(EDGE_FADE_MAX * 100);
      }
    }
  });

  it("gives a single lane the middle of the range", () => {
    expect(edgeFades(1, [0.9])).toEqual([((EDGE_FADE_MIN + EDGE_FADE_MAX) / 2) * 100]);
  });

  it("rounds to a tenth, so the mask string does not churn", () => {
    for (const fade of edgeFades(3, [0.3, 0.7, 0.1])) {
      expect(fade * 10).toBeCloseTo(Math.round(fade * 10), 9);
    }
  });
});

describe("spreadAcross (§10.5)", () => {
  it("reaches both ends and keeps the count", () => {
    const spread = spreadAcross(4, 10, 40, [0, 0, 0, 0]);
    expect(spread).toHaveLength(4);
    expect(spread.toSorted((a, b) => a - b)).toEqual([10, 20, 30, 40]);
  });

  it("shuffles which step lands where, without changing the steps", () => {
    const first = spreadAcross(4, 10, 40, [0, 0, 0, 0]);
    const other = spreadAcross(4, 10, 40, [0, 0.9, 0.9, 0.9]);
    expect(other).not.toEqual(first);
    expect(other.toSorted((a, b) => a - b)).toEqual(first.toSorted((a, b) => a - b));
  });

  it("gives one value the middle rather than an end", () => {
    expect(spreadAcross(1, 10, 40, [0.9])).toEqual([25]);
    expect(spreadAcross(0, 10, 40, [])).toEqual([25]);
  });
});

describe("dealIntoLanes (§10.5)", () => {
  const ranked = Array.from({ length: 12 }, (_, i) => i); // 0 is the busiest

  it("deals one at a time, so no band is the top of the ranking", () => {
    // In slices, lane 0 would be [0..3] — every busiest storyline in one band
    // and a row of fine print at the bottom. Dealt, each lane gets one of the
    // busiest and one of the quietest.
    expect(dealIntoLanes(ranked, [1, 1, 1, 1])).toEqual([
      [0, 4, 8],
      [1, 5, 9],
      [2, 6, 10],
      [3, 7, 11],
    ]);
  });

  it("fills a wide band proportionally fuller than a narrow one", () => {
    // Equal piles in unequal bands would draw the same words further apart in
    // the wide ones: density would read as an accident of where a word landed.
    const [wide, narrow] = dealIntoLanes(ranked, [3, 1]);
    expect(wide!.length / narrow!.length).toBeCloseTo(3, 0);
  });

  it("keeps every word, and only once", () => {
    const dealt = dealIntoLanes(ranked, [1.3, 0.7, 1.1, 0.9]).flat();
    expect(dealt.toSorted((a, b) => a - b)).toEqual(ranked);
  });

  it("returns one lane's worth when there is one lane", () => {
    expect(dealIntoLanes(ranked, [1])).toEqual([ranked]);
  });

  it("never returns zero lanes to lay a board out in", () => {
    for (const shares of [[], [0], [-3], [Number.NaN]]) {
      expect(dealIntoLanes(ranked, shares)).toHaveLength(1);
      expect(dealIntoLanes(ranked, shares).flat()).toEqual(ranked);
    }
  });

  it("tolerates more lanes than words rather than dropping any", () => {
    const dealt = dealIntoLanes([1, 2], [1, 1, 1, 1]);
    expect(dealt.flat()).toEqual([1, 2]);
    expect(dealt.filter((lane) => lane.length > 0)).toHaveLength(2);
  });
});
