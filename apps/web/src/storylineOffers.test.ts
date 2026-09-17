import { describe, expect, it } from "vitest";
import type { StorylineSummary } from "@zammy/shared";
import { growPool, offeredPills } from "./storylineOffers.js";

/**
 * The view's row as a pool of offers (ADR-0028, amended): a taken pill leaves
 * and the next match fills in; a returned one pushes the smallest out.
 */

const arc = (id: string, size: number): StorylineSummary => ({
  id,
  label: id,
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-08-02T00:00:00.000Z",
  size,
  dormant: false,
});

// Eight the search ranked, sizes chosen so rank and size disagree.
const RANKED = [arc("a", 50), arc("b", 20), arc("c", 90), arc("d", 5), arc("e", 30), arc("f", 60), arc("g", 10), arc("h", 40)];
const ids = (list: readonly StorylineSummary[]) => list.map((s) => s.id);

describe("offeredPills", () => {
  it("offers the pool biggest first, a row's worth, when nothing is held", () => {
    expect(ids(offeredPills(RANKED, new Set(), 8))).toEqual(["c", "f", "a", "h", "e", "b", "g", "d"]);
  });

  it("takes a held storyline out of the row, leaving the prompt to name it", () => {
    expect(ids(offeredPills(RANKED, new Set(["c"]), 8))).not.toContain("c");
    expect(offeredPills(RANKED, new Set(["c"]), 8)).toHaveLength(7);
  });

  it("lets the next match fill the gap once the pool has grown by one", () => {
    // The view asked for nine because it holds one; the ninth is what fills in.
    const pool = growPool(RANKED, [...RANKED, arc("i", 15)]);
    expect(ids(offeredPills(pool, new Set(["c"]), 8))).toEqual(["f", "a", "h", "e", "b", "i", "g", "d"]);
  });

  it("drops the pill with the fewest articles when a chip comes back", () => {
    // The chip for "c" is dismissed: the pool still knows nine, the row shows
    // eight, and the smallest — "d", five articles — is the one that goes.
    const pool = growPool(RANKED, [...RANKED, arc("i", 15)]);
    const row = offeredPills(pool, new Set(), 8);
    expect(ids(row)).toContain("c");
    expect(ids(row)).not.toContain("d");
    expect(row).toHaveLength(8);
  });

  it("keeps the server's order between equal sizes, so the same one is dropped each time", () => {
    const tied = [arc("x", 10), arc("y", 10), arc("z", 10)];
    expect(ids(offeredPills(tied, new Set(), 2))).toEqual(["x", "y"]);
  });
});

describe("growPool", () => {
  it("appends only what it has not seen, in arrival order", () => {
    const pool = growPool([arc("a", 1)], [arc("a", 1), arc("b", 2), arc("c", 3)]);
    expect(ids(pool)).toEqual(["a", "b", "c"]);
  });

  it("returns the same array when nothing is new", () => {
    const pool = [arc("a", 1), arc("b", 2)];
    expect(growPool(pool, [arc("b", 2), arc("a", 1)])).toBe(pool);
    expect(growPool(pool, [])).toBe(pool);
  });
});
