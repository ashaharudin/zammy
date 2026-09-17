import { describe, expect, it } from "vitest";
import type { StorylineSummary } from "@zammy/shared";
import {
  EMPTY_PILL_ROW,
  exitedPills,
  orderStorylinePills,
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
  it("starts where the pill was and ends where it belongs", () => {
    const frames = pillMoveKeyframes(120, 0);
    expect(frames.at(0)).toMatchObject({ offset: 0, transform: "translate(120px, 0px)" });
    expect(frames.at(-1)).toMatchObject({ offset: 1, transform: "none" });
  });

  it("slides in a straight line, with no bow, swell or lift", () => {
    // The bubble went (ADR-0028): a row that changes one pill at a time reads a
    // bowed path as the whole row jumping. Two frames and a straight line
    // between them is the whole of the motion now.
    const frames = pillMoveKeyframes(-300, 26);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.transform).toBe("translate(-300px, 26px)");
    expect(frames.every((frame) => frame.zIndex === undefined)).toBe(true);
    expect(frames.every((frame) => !String(frame.transform).includes("scale"))).toBe(true);
  });

  it("rounds sub-pixel deltas rather than writing them into the transform", () => {
    // `-0.004` rounds to negative zero, which stringifies as plain `0`.
    expect(pillMoveKeyframes(12.3456, -0.004)[0]!.transform).toBe("translate(12.35px, 0px)");
  });
});
