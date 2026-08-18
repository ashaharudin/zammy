import { describe, expect, it } from "vitest";
import { judgedSetOf, scoreJudged, type JudgedStoryline } from "./storyline-judged.js";

/**
 * Scoring a replay against the hand-judged sets. Pure, so these pin the
 * ARITHMETIC; `measure:storylines-v2` is what pins the numbers, and
 * docs/STORYLINE-LINKING.md records what it said.
 */

const judged = (id: string, groupIds: string[], label = id): JudgedStoryline => ({
  id,
  label,
  groupIds,
});

describe("scoreJudged", () => {
  it("counts a set the replay reassembled exactly as intact and formed", () => {
    const score = scoreJudged([{ groupIds: ["1", "2", "3"] }], [judged("s", ["1", "2", "3"])]);

    expect(score).toMatchObject({
      n: 1,
      formed: 1,
      intact: 1,
      groupsTogether: 3,
      groupsTotal: 3,
    });
  });

  it("counts a set the replay scattered into singletons as neither", () => {
    // Every group in its own storyline is what a REFUSED formation looks like:
    // `built` holds only promoted storylines, so a pile that never formed is
    // simply absent from it.
    const score = scoreJudged([], [judged("s", ["1", "2"])]);

    expect(score).toMatchObject({ n: 1, formed: 0, intact: 0, groupsTogether: 0 });
  });

  it("reports the LARGEST fragment, not the sum, when a set splits", () => {
    // A 5-group arc replayed as 3+2 kept 3 together. Summing the fragments
    // would report 5 and call a split arc intact.
    const score = scoreJudged(
      [{ groupIds: ["1", "2", "3"] }, { groupIds: ["4", "5"] }],
      [judged("s", ["1", "2", "3", "4", "5"])],
    );

    expect(score.verdicts[0]).toMatchObject({ together: 3, size: 5, intact: false, formed: true });
    expect(score.groupsTogether).toBe(3);
  });

  it("does not credit a fragment with groups the judged set never held", () => {
    // The replayed storyline is bigger than the judged one. Only the overlap
    // counts, or a swallow event would score as perfect preservation.
    const score = scoreJudged(
      [{ groupIds: ["1", "2", "99", "98"] }],
      [judged("s", ["1", "2"])],
    );

    expect(score.verdicts[0]).toMatchObject({ together: 2, size: 2, intact: true });
    expect(score.groupsTotal).toBe(2);
  });

  it("skips groups outside the replay window rather than counting them lost", () => {
    // A judged arc reaching back past the window would otherwise make every
    // window length look like a different rule.
    const score = scoreJudged(
      [{ groupIds: ["2", "3"] }],
      [judged("s", ["1", "2", "3"])],
      (groupId) => groupId !== "1",
    );

    expect(score.verdicts[0]).toMatchObject({ size: 2, together: 2, intact: true });
  });

  it("drops a judged set left with fewer than two groups in the window", () => {
    // One group cannot evidence a storyline in either direction.
    const score = scoreJudged([], [judged("s", ["1", "2"])], (groupId) => groupId === "1");

    expect(score).toMatchObject({ n: 0, formed: 0, groupsTotal: 0 });
  });

  it("separates 'formed' from 'intact' — the two directions read different columns", () => {
    // A declined pile is caught by `formed`; a named arc is graded by `intact`.
    // A 4-group set replayed as 2+2 is a pile that formed AND an arc destroyed.
    const score = scoreJudged(
      [{ groupIds: ["1", "2"] }, { groupIds: ["3", "4"] }],
      [judged("s", ["1", "2", "3", "4"])],
    );

    expect(score.formed).toBe(1);
    expect(score.intact).toBe(0);
  });

  it("orders verdicts largest first, then by id, so a report is stable", () => {
    const score = scoreJudged(
      [{ groupIds: ["1", "2", "3"] }, { groupIds: ["4", "5"] }, { groupIds: ["6", "7"] }],
      [judged("b", ["4", "5"]), judged("a", ["6", "7"]), judged("c", ["1", "2", "3"])],
    );

    expect(score.verdicts.map((verdict) => verdict.id)).toEqual(["c", "a", "b"]);
  });

  it("aggregates across sets", () => {
    // `built` holds only promoted storylines, so groups 3 and 4 — whose judged
    // set never formed — appear in it nowhere.
    const score = scoreJudged(
      [{ groupIds: ["1", "2"] }],
      [judged("kept", ["1", "2"]), judged("lost", ["3", "4"])],
    );

    expect(score).toMatchObject({ n: 2, formed: 1, intact: 1, groupsTogether: 2, groupsTotal: 4 });
  });
});

describe("judgedSetOf", () => {
  it("reads a bigram fallback as the model having declined to name it", () => {
    expect(judgedSetOf("bigram")).toBe("declined");
  });

  it("reads any model id as the model having named it", () => {
    // The id varies with the configured model, so this cannot be an allowlist.
    expect(judgedSetOf("gemini-3.1-flash-lite")).toBe("named");
    expect(judgedSetOf("model")).toBe("named");
  });

  it("puts a never-judged storyline in NEITHER set", () => {
    // 776 of the dev archive's two-group storylines are null. Counting them as
    // either side would be inventing data.
    expect(judgedSetOf(null)).toBeNull();
  });
});
