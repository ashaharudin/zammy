import { describe, expect, it } from "vitest";
import { maxPlaceableFont } from "./wordFit.js";

/**
 * The bound has to sit BELOW d3-cloud's real cliff, never above it — being
 * generous here means the word disappears, which is the bug this exists to
 * fix. The reference numbers are the measured drop boundaries on a 700px board
 * with d3-cloud 1.2.9, **at a 0.600em advance**: 20 chars → 54.9px, 22 → 49.9,
 * 26 → 42.9, 30 → 36.9 (ADR-0007).
 *
 * The advance matters, which is why it is stated: a wider face has a lower
 * cliff — Menlo at 0.6021em drops 26 chars from 41.9 — so these constants are
 * the loosest of the faces in the MONO stack. `MONO_ADVANCE` carries the real
 * margin; this test only catches a bound that has stopped being conservative
 * at all.
 */

const BOARD = 700;
const FONT_MIN = 12;
const FONT_MAX = 56;

describe("maxPlaceableFont", () => {
  it("stays under every measured d3-cloud drop boundary", () => {
    for (const [length, boundary] of [
      [20, 54.9],
      [22, 49.9],
      [26, 42.9],
      [30, 36.9],
    ] as const) {
      expect(
        maxPlaceableFont(length, BOARD, FONT_MIN),
        `${length} chars would still be dropped`,
      ).toBeLessThan(boundary);
    }
  });

  it("leaves terms the current cloud actually shows unclamped", () => {
    // "democratic primary" (18) is the longest term the recorded fixtures
    // produce; it must render at full size, or the fix costs more than it buys.
    expect(maxPlaceableFont(18, BOARD, FONT_MIN)).toBeGreaterThan(FONT_MAX);
    expect(maxPlaceableFont(2, BOARD, FONT_MIN)).toBeGreaterThan(FONT_MAX);
  });

  it("keeps a too-long top term visible instead of dropping it", () => {
    // "artificial intelligence" — 23 chars, a df>=2 bigram candidate in the
    // recorded corpus (the propriety gate stops it there, so `ai` is what
    // ships), and invisible at FONT_MAX without this clamp.
    const size = maxPlaceableFont("artificial intelligence".length, BOARD, FONT_MIN);
    expect(size).toBeLessThan(FONT_MAX);
    expect(size).toBeGreaterThan(FONT_MIN);
  });

  it("never clamps below the legible floor", () => {
    expect(maxPlaceableFont(500, BOARD, FONT_MIN)).toBe(FONT_MIN);
  });

  it("is monotonic: a longer word never gets a bigger allowance", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let length = 1; length <= 60; length += 1) {
      const size = maxPlaceableFont(length, BOARD, FONT_MIN);
      expect(size).toBeLessThanOrEqual(previous);
      previous = size;
    }
  });
});
