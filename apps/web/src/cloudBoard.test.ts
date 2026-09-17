import { describe, expect, it } from "vitest";
import {
  BOARD_MAX,
  BOARD_MIN,
  DRIFT_FASTEST_PX_PER_SECOND,
  DRIFT_SLOWEST_PX_PER_SECOND,
  boardWidth,
  laneDriftSeconds,
} from "./cloudBoard.js";
import { TRENDING_LIMIT_MAX } from "@zammy/shared";

/**
 * The numbers behind the drift (§10.5), all of them invisible until the cloud
 * is full: a strip too short loses its tail to d3-cloud without complaint, a
 * duration that is not proportional to the strip makes a busy cloud whip past
 * while a quiet one crawls, and a speed range that collapses turns the lanes
 * back into one moving picture.
 */
describe("boardWidth (§10.5)", () => {
  it("keeps a quiet cloud on the board it has always had", () => {
    // Twelve storylines spread over a strip sized for sixty is three-quarters
    // of an empty board drifting past the reader.
    expect(boardWidth(12)).toBe(BOARD_MIN);
    expect(boardWidth(0)).toBe(BOARD_MIN);
  });

  it("gives the default cloud more room than the 700px board it outgrew", () => {
    // The point of the change: 60 words do not place on a board drawn for 50.
    expect(boardWidth(60)).toBeGreaterThan(BOARD_MIN);
  });

  it("holds density constant between two counts that both need room", () => {
    expect(boardWidth(60) / boardWidth(30)).toBeCloseTo(2, 5);
  });

  it("bounds the wait even at the limit the API will serve", () => {
    // `?limit=100` is reachable, and the strip is what a reader waits to come
    // back around.
    expect(boardWidth(TRENDING_LIMIT_MAX)).toBeLessThanOrEqual(BOARD_MAX);
  });
});

describe("laneDriftSeconds (§10.5)", () => {
  const strip = 2400;

  it("drifts at one rate whatever the strip's length", () => {
    // The strip's length is data-dependent, so a fixed duration would make a
    // busy cloud whip past and a quiet one crawl.
    expect(laneDriftSeconds(2880, 1) / laneDriftSeconds(1440, 1)).toBeCloseTo(2, 5);
  });

  it("spreads the board across the whole range, ends included", () => {
    expect(laneDriftSeconds(strip, 0)).toBeCloseTo(strip / DRIFT_SLOWEST_PX_PER_SECOND, 5);
    expect(laneDriftSeconds(strip, 1)).toBeCloseTo(strip / DRIFT_FASTEST_PX_PER_SECOND, 5);
  });

  it("gives two lanes different speeds for different picks", () => {
    // The whole point: one rate for every lane is a slide, not a board
    // recomposing itself.
    expect(laneDriftSeconds(strip, 0.2)).toBeGreaterThan(laneDriftSeconds(strip, 0.8));
  });

  it("stays inside the range for a pick off either end", () => {
    const slowest = strip / DRIFT_SLOWEST_PX_PER_SECOND;
    const fastest = strip / DRIFT_FASTEST_PX_PER_SECOND;
    for (const pick of [-1, 0, 0.5, 1, 9]) {
      expect(laneDriftSeconds(strip, pick)).toBeLessThanOrEqual(slowest);
      expect(laneDriftSeconds(strip, pick)).toBeGreaterThanOrEqual(fastest);
    }
  });

  it("never returns a duration a browser would read as zero", () => {
    // Measured content arrives as 0 for one commit — before the words are in
    // the DOM to measure — and `animation-duration: 0s` is a lane sitting
    // still at the end of its own loop.
    for (const degenerate of [0, -1, Number.NaN]) {
      expect(laneDriftSeconds(degenerate, Number.NaN)).toBeGreaterThan(0);
    }
  });
});
