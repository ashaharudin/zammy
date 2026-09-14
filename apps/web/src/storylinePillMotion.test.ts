import { describe, expect, it } from "vitest";
import type { StorylineSummary } from "@zammy/shared";
import {
  EMPTY_PILL_ROW,
  exitedPills,
  orderStorylinePills,
  PILL_ARC_PX,
  pillMoveKeyframes,
  receivePills,
} from "./storylinePillMotion.js";

function storyline(id: string, size: number): StorylineSummary {
  return {
    id,
    label: id,
    size,
    dormant: false,
    from: "2026-09-01T00:00:00.000Z",
    to: "2026-09-02T00:00:00.000Z",
  };
}

const ids = (row: { slots: readonly { storyline: StorylineSummary }[] }) =>
  row.slots.map((slot) => slot.storyline.id);

describe("orderStorylinePills", () => {
  it("draws the biggest storyline first", () => {
    const ordered = orderStorylinePills([storyline("small", 3), storyline("big", 120), storyline("mid", 40)]);
    expect(ordered.map((s) => s.id)).toEqual(["big", "mid", "small"]);
  });

  it("keeps the API's recency order between storylines of the same size", () => {
    // Stability is the whole tie-break: the API sends most-recently-covered
    // first, so equal-sized pills read newest-first and — the part that shows —
    // do not shuffle between two polls of the same search.
    const sent = [storyline("newest", 20), storyline("older", 20), storyline("oldest", 20)];
    expect(orderStorylinePills(sent).map((s) => s.id)).toEqual(["newest", "older", "oldest"]);
    expect(orderStorylinePills([...sent]).map((s) => s.id)).toEqual(["newest", "older", "oldest"]);
  });

  it("leaves the response alone", () => {
    const sent = [storyline("a", 1), storyline("b", 9)];
    orderStorylinePills(sent);
    expect(sent.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("receivePills", () => {
  it("fades the first row in, biggest first", () => {
    const row = receivePills(EMPTY_PILL_ROW, [storyline("small", 2), storyline("big", 90)]);
    expect(ids(row)).toEqual(["big", "small"]);
    expect(row.slots.every((slot) => slot.entering)).toBe(true);
    expect(row.pending).toBeNull();
  });

  it("returns the same row when the response says nothing new", () => {
    // Load-bearing: the component derives this during render, and a page that
    // re-renders on every progressive fill must not produce a new row each time.
    const sent = [storyline("a", 5)];
    const row = receivePills(EMPTY_PILL_ROW, sent);
    expect(receivePills(row, sent)).toBe(row);
    expect(receivePills(EMPTY_PILL_ROW, [])).toBe(EMPTY_PILL_ROW);
  });

  it("moves and admits in one beat when nothing left", () => {
    const big = storyline("big", 90);
    const small = storyline("small", 2);
    const row = receivePills(EMPTY_PILL_ROW, [big, small]);
    expect(ids(row)).toEqual(["big", "small"]);

    const grown = storyline("small", 200);
    const arrival = storyline("new", 50);
    const next = receivePills(row, [grown, big, arrival]);
    expect(ids(next)).toEqual(["small", "big", "new"]);
    expect(next.pending).toBeNull();
    // "big" is the slot the row already had, carried across the reorder rather
    // than rebuilt — it is the same pill in a new place, and the move is the
    // component's FLIP rather than anything here.
    expect(next.slots[1]).toBe(row.slots[0]);
    expect(next.slots[2]!.entering).toBe(true);
  });

  it("holds the leavers' slots, and the arrivals, until the fade is over", () => {
    const big = storyline("big", 90);
    const row = receivePills(EMPTY_PILL_ROW, [big, storyline("gone", 2)]);
    const arrival = storyline("new", 300);
    const fading = receivePills(row, [big, arrival]);
    // The row does not reorder under a fade, and "new" is not drawn yet.
    expect(ids(fading)).toEqual(["big", "gone"]);
    expect(fading.slots.map((slot) => slot.leaving)).toEqual([false, true]);
    expect(fading.pending?.map((s) => s.id)).toEqual(["new", "big"]);

    const settled = exitedPills(fading);
    expect(ids(settled)).toEqual(["new", "big"]);
    expect(settled.slots[0]!.entering).toBe(true);
    expect(settled.slots[1]).toBe(row.slots[0]);
    expect(settled.pending).toBeNull();
  });

  it("reprieves a pill that matches again inside its own fade", () => {
    // The reader searches again before the fade is over, and one of the pills
    // on the way out belongs to the new search too. It has to stop leaving —
    // otherwise it finishes a fade it is no longer doing and then vanishes.
    const row = receivePills(EMPTY_PILL_ROW, [
      storyline("a", 9),
      storyline("b", 4),
      storyline("c", 3),
    ]);
    const fading = receivePills(row, [storyline("a", 9)]);
    expect(fading.slots.map((slot) => slot.leaving)).toEqual([false, true, true]);

    const back = receivePills(fading, [storyline("a", 9), storyline("b", 4)]);
    expect(back.slots.map((slot) => slot.leaving)).toEqual([false, false, true]);
    // "c" is still on its way out, so the row still has a fade to wait on.
    expect(back.pending?.map((s) => s.id)).toEqual(["a", "b"]);
    expect(ids(exitedPills(back))).toEqual(["a", "b"]);
  });

  it("settles straight away when the last leaver is reprieved", () => {
    const a = storyline("a", 9);
    const b = storyline("b", 4);
    const row = receivePills(EMPTY_PILL_ROW, [a, b]);
    const fading = receivePills(row, [a]);
    const back = receivePills(fading, [a, b]);
    expect(back.slots.map((slot) => slot.leaving)).toEqual([false, false]);
    // Both are pills the row already had: nothing is re-announced, and with
    // nothing left fading there is nothing to wait on either.
    expect(back.slots[0]).toBe(row.slots[0]);
    expect(back.pending).toBeNull();
  });

  it("empties the row through the same fade rather than blanking it", () => {
    const row = receivePills(EMPTY_PILL_ROW, [storyline("a", 9)]);
    const fading = receivePills(row, []);
    expect(ids(fading)).toEqual(["a"]);
    expect(fading.slots[0]!.leaving).toBe(true);
    expect(exitedPills(fading)).toEqual({ slots: [], pending: null });
  });

  it("has nothing to settle when no fade is running", () => {
    const row = receivePills(EMPTY_PILL_ROW, [storyline("a", 9)]);
    expect(exitedPills(row)).toBe(row);
    expect(exitedPills(EMPTY_PILL_ROW)).toBe(EMPTY_PILL_ROW);
  });
});

describe("pillMoveKeyframes", () => {
  /** The y a straight line between the two slots would be at this offset. */
  const straightY = (dy: number, offset: number) => dy * (1 - offset);
  const y = (frame: Keyframe) =>
    Number(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(String(frame.transform))?.[2]);
  const x = (frame: Keyframe) =>
    Number(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(String(frame.transform))?.[1]);

  it("starts where the pill was and ends where it belongs", () => {
    const frames = pillMoveKeyframes(120, 0);
    expect(frames.at(0)).toMatchObject({ offset: 0, transform: "translate(120px, 0px) scale(1)" });
    expect(frames.at(-1)).toMatchObject({ offset: 1, transform: "none" });
  });

  it("bows a pill moving up the order out of the row, and one moving down under it", () => {
    // FLIP deltas: where the pill WAS, relative to where it is now. A positive
    // dx means it used to be further right — it has moved earlier in the row.
    const up = pillMoveKeyframes(200, 0);
    const down = pillMoveKeyframes(-200, 0);
    expect(y(up[2]!)).toBe(-PILL_ARC_PX);
    expect(y(down[2]!)).toBe(PILL_ARC_PX);
  });

  it("reads a wrapped line as the direction, whatever the sideways travel", () => {
    // Up a line and to the right: still a riser, because the line is what the
    // reader sees it leave.
    expect(y(pillMoveKeyframes(-300, 26)[2]!)).toBe(straightY(26, 0.5) - PILL_ARC_PX);
    expect(y(pillMoveKeyframes(300, -26)[2]!)).toBe(straightY(-26, 0.5) + PILL_ARC_PX);
  });

  it("returns to the straight line at both ends, so the bow has no corner", () => {
    const frames = pillMoveKeyframes(160, 26);
    for (const [index, offset] of [0, 0.25, 0.5, 0.75].entries()) {
      // The horizontal travel is the straight line throughout; only the
      // crossways component bows.
      expect(x(frames[index]!)).toBeCloseTo(160 * (1 - offset), 1);
    }
    const bow = (offset: number, frame: Keyframe) => y(frame) - straightY(26, offset);
    expect(bow(0, frames[0]!)).toBe(0);
    expect(bow(0.25, frames[1]!)).toBeCloseTo(-0.75 * PILL_ARC_PX, 5);
    expect(bow(0.5, frames[2]!)).toBeCloseTo(-PILL_ARC_PX, 5);
    expect(bow(0.75, frames[3]!)).toBeCloseTo(-0.75 * PILL_ARC_PX, 5);
  });

  it("carries the riser over the pills it overtakes, and lets the sinker go under", () => {
    // After the commit the riser is already the earlier sibling, so without a
    // lift it would travel BEHIND the pills it is passing.
    expect(pillMoveKeyframes(200, 0).every((frame) => frame.zIndex === "1")).toBe(true);
    expect(pillMoveKeyframes(-200, 0).every((frame) => frame.zIndex === undefined)).toBe(true);
  });

  it("swells the riser and shrinks the sinker, and leaves both at rest", () => {
    const scale = (frame: Keyframe) =>
      Number(/scale\(([\d.]+)\)/.exec(String(frame.transform))?.[1]);
    const up = pillMoveKeyframes(200, 0);
    const down = pillMoveKeyframes(-200, 0);
    expect(scale(up[0]!)).toBe(1);
    expect(scale(up[2]!)).toBeGreaterThan(1);
    expect(scale(down[2]!)).toBeLessThan(1);
    // Neither is left scaled: the last frame is the pill's own style.
    expect(up.at(-1)!.transform).toBe("none");
    expect(down.at(-1)!.transform).toBe("none");
  });
});
