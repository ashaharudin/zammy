import { describe, expect, it } from "vitest";
import { replayLinker, type ReplayGroup } from "./storyline-replay.js";
import type { Corpus, LinkRules } from "./storyline-link.js";

/**
 * The replay harness, on the two retrieval modes.
 *
 * `measure:storylines-v2` is what pins the NUMBERS (docs/STORYLINE-LINKING.md);
 * what is tested here is the harness's agreement with the service, because their
 * silent divergence is the root of docs/VERCEL-PHASE-0-FINDINGS.md §2.5 — the
 * thresholds were certified against a candidate set production never judged, and
 * nothing in the output said so.
 */

const RULES: LinkRules = {
  anchorMaxShare: 0.002,
  anchorDfFloor: 10,
  massThreshold: 20,
  dormancyDays: 90,
  dormantStrictness: 1.5,
};

/** A 16,000-article fortnight: the anchor ceiling is 32. */
const DF: Record<string, number> = { trump: 2_000 };
const corpusAt = (): Corpus => ({
  size: 16_000,
  df: new Map(Object.entries(DF)),
});

const DAY = "2026-08-11";

/**
 * 210 groups that never link: each carries one token of its own (df 20, absent
 * from the map is not used here — `rare*` is seeded below) plus one COMMON token
 * every group shares. Sharing `trump` alone is mass 2.08 against a floor of 20,
 * so nothing qualifies in either mode — which is the point. The archives come out
 * identical; what differs is how many candidates each mode had to look at.
 */
function crowd(): ReplayGroup[] {
  return Array.from({ length: 210 }, (_, i) => {
    DF[`rare${i}`] = 20;
    return {
      groupId: `g${String(i).padStart(3, "0")}`,
      memberTokens: [["trump", `rare${i}`]],
      language: "en",
      publishedMs: new Date(`${DAY}T09:00:00Z`).getTime() + i * 1_000,
      dayKey: DAY,
    };
  });
}

describe("replayLinker retrieval modes", () => {
  it("builds the same archive either way — narrowing is a no-op on the RESULT", () => {
    // The necessary-condition property, at the harness level: this is what makes
    // the committed grid in docs/STORYLINE-LINKING.md valid for both modes, and
    // what made #117's grid come out byte-identical.
    const groups = crowd();
    const broad = replayLinker(groups, corpusAt, RULES, 2, false);
    const narrowed = replayLinker(groups, corpusAt, RULES, 2, true);

    expect(narrowed.storylines).toBe(broad.storylines);
    expect(narrowed.promoted).toBe(broad.promoted);
    expect(narrowed.attached).toBe(broad.attached);
    expect(narrowed.merges).toBe(broad.merges);
    expect(narrowed.largestStoryline).toBe(broad.largestStoryline);
    expect(narrowed.built).toEqual(broad.built);
  });

  it("REPORTS the row cap it does not apply, per configured mode", () => {
    // The half of the retrieval this harness still does not model, said out loud
    // instead of silently inherited. Broad, the 201st arrival onward overlaps more
    // than 200 live storylines through one common token, so the service would have
    // cut the candidate set these numbers were certified against — 9 groups here,
    // 12,266 of 12,366 on the dev archive. Narrowed, the common token is not
    // anchor-eligible, nothing is retrieved, and the count is 0 exactly as the
    // census over the whole dev window found.
    const groups = crowd();

    expect(replayLinker(groups, corpusAt, RULES, 2, false).cappedGroups).toBe(9);
    expect(replayLinker(groups, corpusAt, RULES, 2, true).cappedGroups).toBe(0);
  });

  it("still links what it should in either mode", () => {
    // A guard on the fixture above rather than on the modes: `crowd` proves
    // nothing if the harness has stopped linking altogether.
    DF.fausto = 20;
    DF.hawaii = 20;
    DF.surf = 20;
    DF.swell = 20;
    DF.genevieve = 20;
    const story = ["fausto", "hawaii", "surf", "swell", "genevieve"];
    const groups: ReplayGroup[] = [0, 1].map((i) => ({
      groupId: `s${i}`,
      memberTokens: [story],
      language: "en",
      publishedMs: new Date(`${DAY}T09:00:00Z`).getTime() + i * 1_000,
      dayKey: DAY,
    }));

    for (const narrowed of [true, false]) {
      const result = replayLinker(groups, corpusAt, RULES, 2, narrowed);
      expect(result.attached).toBe(1);
      expect(result.largestStoryline).toBe(2);
    }
  });
});
