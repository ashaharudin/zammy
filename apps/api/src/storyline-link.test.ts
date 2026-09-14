import { describe, expect, it } from "vitest";
import {
  anchorCeiling,
  anchorEligibleTokens,
  barFor,
  candidateRetrieval,
  bridgePairs,
  bridgingQualifiers,
  groupProfile,
  linkEvidence,
  qualifyingStorylines,
  storylineProfile,
  type Corpus,
  type LinkCandidate,
  type LinkRules,
} from "./storyline-link.js";
import { STORYLINE_BAR } from "./storyline-bar.js";

/**
 * The group→storyline decision (ADR-0011). Pure, so these are the tests that
 * pin the RULE; `measure:storylines-v2` is what pins the NUMBERS, and
 * docs/STORYLINE-LINKING.md records what it said.
 */

/**
 * The rules half of the shipped bar. These tests pin the RULE at the values
 * production judges at, so they take them from `STORYLINE_BAR` rather than
 * restating them — a copy here would be a rule pinned at whatever this file
 * happened to say.
 */
const RULES: LinkRules = STORYLINE_BAR.rules;

/** A 16,000-article fortnight, roughly the dev archive's English window. */
function corpus(df: Record<string, number>, size = 16_000): Corpus {
  return { size, df: new Map(Object.entries(df)) };
}

const DAY = 86_400_000;
const NOW = new Date("2026-08-14T12:00:00Z").getTime();

function candidate(over: Partial<LinkCandidate> = {}): LinkCandidate {
  return {
    id: "a",
    profileTokens: [],
    lastCoverageMs: NOW - DAY,
    groupCount: 2,
    ...over,
  };
}

describe("anchorCeiling", () => {
  it("is a share of the corpus — the ADR-0009 absolute-cap failure, not repeated", () => {
    // A story's own name climbs with its coverage. Measured against a day it
    // hit 4.4%; an absolute cap refused it exactly when it mattered most.
    expect(anchorCeiling(16_000, RULES)).toBe(32);
    expect(anchorCeiling(32_000, RULES)).toBe(64);
  });

  it("floors on a thin corpus, where a share is noise", () => {
    // 0.2% of 900 articles is under two — every anchor would be refused in a
    // window that has only just started filling.
    expect(anchorCeiling(900, RULES)).toBe(10);
  });
});

describe("anchorEligibleTokens", () => {
  it("keeps tokens at or below the ceiling and drops the common ones", () => {
    // Ceiling is 32 at this corpus size. The boundary is inclusive, because
    // `qualifyingStorylines` rejects on `anchorDf > ceiling`, not `>=`.
    const eligible = anchorEligibleTokens(
      ["rare", "atceiling", "justover", "common"],
      corpus({ rare: 3, atceiling: 32, justover: 33, common: 9_000 }),
      RULES,
    );
    expect(eligible).toEqual(["rare", "atceiling"]);
  });

  it("keeps a token ABSENT from the df map — `linkEvidence` scores it df 1", () => {
    // The load-bearing case, and the one a filter written over the map's
    // entries would get backwards. A token the corpus has not seen is the
    // rarest thing there is, so it always anchors; dropping it here would
    // silently lose links on brand-new vocabulary — the exact tokens a
    // breaking story is named by. Measured 0 absent of 237,944 on the dev
    // corpus, which is why only a test can hold this line.
    expect(anchorEligibleTokens(["unseen"], corpus({ other: 5 }), RULES)).toEqual(["unseen"]);
    expect(linkEvidence(["unseen"], ["unseen"], corpus({ other: 5 })).anchorDf).toBe(1);
  });

  it("is a necessary condition: nothing the full profile qualifies is lost", () => {
    // The property the whole change rests on. A candidate sharing only
    // above-ceiling tokens is rejected by `qualifyingStorylines` anyway, so
    // retrieving on the narrowed array cannot change the verdict — while a
    // candidate reachable ONLY through an eligible token is still reached.
    // 40 common tokens carry mass 27.7 between them — over the floor — so the
    // `no-anchor` candidate below fails on the anchor and NOTHING else. That is
    // the only case where narrowing could lose something, and it does not.
    const common = Array.from({ length: 40 }, (_, i) => `common${i}`);
    const c = corpus({
      anchor: 5,
      ...Object.fromEntries(common.map((t) => [t, 8_000])),
    });
    const profile = ["anchor", ...common];
    const narrowed = anchorEligibleTokens(profile, c, RULES);
    expect(narrowed).toEqual(["anchor"]);
    // Mass over the commons alone clears the floor: the anchor is the only bar.
    expect(linkEvidence(profile, common, c).mass).toBeGreaterThan(RULES.massThreshold);

    const candidates = [
      // Shares the anchor plus mass: qualifies, and the narrowed probe finds it.
      candidate({ id: "qualifies", profileTokens: profile }),
      // Enough mass, no eligible token: rejected by the decision anyway, and the
      // narrowed probe never retrieves it — the same verdict, without the row.
      candidate({ id: "no-anchor", profileTokens: common }),
    ];
    const full = qualifyingStorylines(profile, candidates, c, RULES, NOW);
    const reachable = candidates.filter((x) =>
      x.profileTokens.some((t) => narrowed.includes(t)),
    );
    const narrow = qualifyingStorylines(profile, reachable, c, RULES, NOW);
    expect(full.map((q) => q.candidate.id)).toEqual(["qualifies"]);
    expect(narrow.map((q) => q.candidate.id)).toEqual(full.map((q) => q.candidate.id));
  });

  it("returns empty when nothing can anchor — the group has no qualifier to find", () => {
    // Not degenerate: an empty array is a proof that retrieval is pointless,
    // and `linkGroup` skips the round trip on it. 123 of 12,366 dev-corpus
    // groups in the trailing window are this case.
    const c = corpus({ wide: 9_000, alsowide: 8_000 });
    expect(anchorEligibleTokens(["wide", "alsowide"], c, RULES)).toEqual([]);
    expect(
      qualifyingStorylines(
        ["wide", "alsowide"],
        [candidate({ profileTokens: ["wide", "alsowide"] })],
        c,
        RULES,
        NOW,
      ),
    ).toEqual([]);
  });

  it("uses the NON-dormant ceiling, the loosest bar any candidate faces", () => {
    // `barFor` only ever divides the ceiling, so filtering at the undivided one
    // is a superset of what any candidate — dormant or not — could anchor on.
    // A token eligible here may still be refused by a dormant candidate's
    // tighter bar; that is the decision's business, not retrieval's.
    const c = corpus({ mid: 25 });
    expect(anchorEligibleTokens(["mid"], c, RULES)).toEqual(["mid"]);
    const dormant = candidate({ lastCoverageMs: NOW - 200 * DAY, profileTokens: ["mid"] });
    expect(barFor(dormant, NOW, RULES, c.size).ceiling).toBeLessThan(25);
  });
});

describe("linkEvidence", () => {
  it("weights each shared token by its rarity and takes the rarest as the anchor", () => {
    const evidence = linkEvidence(
      ["fausto", "hawaii", "storm"],
      ["fausto", "hawaii", "storm", "surf"],
      corpus({ fausto: 20, hawaii: 200, storm: 800 }),
    );
    expect(evidence.shared).toBe(3);
    expect(evidence.anchorDf).toBe(20);
    expect(evidence.mass).toBeCloseTo(
      Math.log(16_000 / 20) + Math.log(16_000 / 200) + Math.log(16_000 / 800),
      6,
    );
  });

  it("reports nothing shared as an infinite anchor, not a zero one", () => {
    // Zero would be the RAREST possible df and would anchor anything.
    const evidence = linkEvidence(["ontario"], ["hawaii"], corpus({}));
    expect(evidence).toEqual({ mass: 0, anchorDf: Number.POSITIVE_INFINITY, shared: 0 });
  });

  it("ignores what either side says beyond the overlap", () => {
    // A group joining a three-week-old arc shares a small fraction of its
    // profile by construction — normalizing by the union would punish exactly
    // the links this layer exists to make.
    const df = corpus({ fausto: 20 });
    const narrow = linkEvidence(["fausto"], ["fausto"], df);
    const wide = linkEvidence(
      ["fausto", "a", "b", "c"],
      ["fausto", "x", "y", "z", "w", "v"],
      df,
    );
    expect(wide.mass).toBe(narrow.mass);
  });

  it("counts a token once however often the caller repeats it", () => {
    const df = corpus({ fausto: 20 });
    expect(linkEvidence(["fausto", "fausto"], ["fausto"], df).mass).toBeCloseTo(
      linkEvidence(["fausto"], ["fausto"], df).mass,
      6,
    );
  });
});

describe("qualifyingStorylines", () => {
  const shared = ["fausto", "hawaii", "surf", "swell", "genevieve"];
  // df chosen so the arithmetic is checkable by hand against massThreshold 20:
  // ln(16000/df) is 6.68 / 4.38 / 5.18 / 5.59 / 6.28, summing to 28.1.
  const DF = { fausto: 20, hawaii: 200, surf: 90, swell: 60, genevieve: 30 };

  it("admits a storyline sharing rare vocabulary", () => {
    const qualified = qualifyingStorylines(
      shared,
      [candidate({ id: "storm", profileTokens: shared })],
      corpus(DF),
      RULES,
      NOW,
    );
    expect(qualified.map((q) => q.candidate.id)).toEqual(["storm"]);
  });

  it("refuses one whose only shared tokens are beat vocabulary", () => {
    // "trump" is 13% of the trailing corpus and "president" 9.5% — measured.
    // Sharing them is not evidence of anything, however much of it there is.
    const qualified = qualifyingStorylines(
      ["trump", "president", "washington"],
      [candidate({ profileTokens: ["trump", "president", "washington"] })],
      corpus({ trump: 2089, president: 1525, washington: 492 }),
      RULES,
      NOW,
    );
    expect(qualified).toEqual([]);
  });

  it("refuses a rare anchor with nothing corroborating it", () => {
    // One ambiguous name is not a story: a surname shared by two unrelated
    // pieces would otherwise link them.
    const qualified = qualifyingStorylines(
      ["nordone"],
      [candidate({ profileTokens: ["nordone"] })],
      corpus({ nordone: 5 }),
      RULES,
      NOW,
    );
    expect(qualified[0]).toBeUndefined();
  });

  it("returns EVERY qualifier, best mass first — the others are bridge evidence", () => {
    // Both clear the bar — 28.1 and 21.8 against a floor of 20 — so both are
    // returned, and the one the group is attached to is merely the first.
    const qualified = qualifyingStorylines(
      shared,
      [
        candidate({ id: "thin", profileTokens: ["fausto", "hawaii", "surf", "swell"] }),
        candidate({ id: "full", profileTokens: shared }),
      ],
      corpus(DF),
      RULES,
      NOW,
    );
    expect(qualified.map((q) => q.candidate.id)).toEqual(["full", "thin"]);
  });

  it("breaks mass ties deterministically, so a replay assigns as the run did", () => {
    const df = corpus(DF);
    const older = candidate({ id: "zzz", profileTokens: shared, lastCoverageMs: NOW - 5 * DAY });
    const newer = candidate({ id: "aaa", profileTokens: shared, lastCoverageMs: NOW - DAY });
    expect(
      qualifyingStorylines(shared, [newer, older], df, RULES, NOW).map((q) => q.candidate.id),
    ).toEqual(["zzz", "aaa"]);
  });

  describe("dormancy", () => {
    const df = corpus(DF);
    const dormant = candidate({
      id: "old",
      profileTokens: shared,
      lastCoverageMs: NOW - 200 * DAY,
    });
    /** Five equally rare tokens: mass 33.4, over the dormant floor of 30. */
    const STRONG = ["a", "b", "c", "d", "e"];
    const strongDf = corpus(Object.fromEntries(STRONG.map((t) => [t, 20])));

    it("holds a dormant storyline to a higher bar than a live one", () => {
      const live = barFor(candidate(), NOW, RULES, 16_000);
      const cold = barFor(dormant, NOW, RULES, 16_000);
      expect(live).toEqual({ ceiling: 32, mass: 20, dormant: false });
      expect(cold.dormant).toBe(true);
      expect(cold.ceiling).toBeLessThan(live.ceiling);
      expect(cold.mass).toBeGreaterThan(live.mass);
    });

    it("still admits it on strong evidence — nothing ends a storyline", () => {
      // The trial fourteen months after the crash must still find the crash.
      const cold = candidate({
        profileTokens: STRONG,
        lastCoverageMs: NOW - 400 * DAY,
      });
      const qualified = qualifyingStorylines(STRONG, [cold], strongDf, RULES, NOW);
      expect(qualified).toHaveLength(1);
      expect(qualified[0]!.dormant).toBe(true);
    });

    it("refuses it on evidence a live storyline would have taken", () => {
      // Mass 28.1: over the live floor of 20, under the dormant floor of 30.
      // The same group, the same tokens, and only the storyline's silence
      // between the two verdicts.
      expect(
        qualifyingStorylines(shared, [candidate({ profileTokens: shared })], df, RULES, NOW),
      ).toHaveLength(1);
      expect(qualifyingStorylines(shared, [dormant], df, RULES, NOW)).toHaveLength(0);
    });

    it("measures dormancy from last COVERAGE, not from age", () => {
      // An arc that started a year ago and is still being covered is live.
      const ancientButActive = candidate({
        profileTokens: shared,
        lastCoverageMs: NOW - 2 * DAY,
      });
      expect(barFor(ancientButActive, NOW, RULES, 16_000).dormant).toBe(false);
    });
  });
});

describe("groupProfile / storylineProfile", () => {
  it("is a group of one's own tokens", () => {
    expect(groupProfile([["fausto", "hawaii"]])).toEqual(["fausto", "hawaii"]);
  });

  it("keeps what half the members carry and drops what a minority does", () => {
    // The live-blog rule (ADR-0009): four AP "The Latest:" copies enumerating
    // the whole day's news must not lend their vocabulary to the story.
    expect(
      groupProfile([
        ["fausto", "hawaii", "blackpink"],
        ["fausto", "hawaii"],
        ["fausto", "hawaii"],
        ["fausto", "surf"],
      ]),
    ).toEqual(["fausto", "hawaii"]);
  });

  it("applies the same rule one level up, which is the percolation damper", () => {
    // A growing storyline's consensus vocabulary TIGHTENS: the more groups
    // join, the more a token must be shared to survive in the profile.
    const four = storylineProfile([
      ["fausto", "hawaii"],
      ["fausto", "surf"],
      ["fausto", "swell"],
      ["fausto", "genevieve"],
    ]);
    expect(four).toEqual(["fausto"]);
  });

  it("does not degenerate to a union at two groups (ADR-0026)", () => {
    // The majority is 1 of 2, so this used to return everything either group
    // said and hand the second group's whole vocabulary to the arc's identity.
    // The floor of two makes it the consensus the name promises.
    expect(
      storylineProfile([
        ["fausto", "hawaii"],
        ["fausto", "surf"],
      ]),
    ).toEqual(["fausto"]);
  });

  it("prices the pre-ADR-0026 rule at minGroupSupport 1, which is what the sweep replays", () => {
    expect(
      storylineProfile(
        [
          ["fausto", "hawaii"],
          ["fausto", "surf"],
        ],
        1,
      ),
    ).toEqual(["fausto", "hawaii", "surf"]);
  });

  it("keeps a storyline-of-one whole: the floor cannot exceed the member count", () => {
    // An empty profile is not a stricter storyline, it is one no group can ever
    // retrieve — `profile_tokens` is what candidate retrieval overlaps against.
    expect(storylineProfile([["fausto", "hawaii"]])).toEqual(["fausto", "hawaii"]);
  });

  it("two groups sharing nothing have no profile, so nothing can chain through them", () => {
    // Prod 49002d0e: a stolen ambulance and an energy-policy piece, held
    // together by a bridge whose vocabulary the union handed to the arc.
    expect(storylineProfile([["ambulance", "antigonish"], ["greenhouse", "epa"]])).toEqual([]);
  });

  it("is empty for no members rather than throwing", () => {
    expect(groupProfile([])).toEqual([]);
  });
});

describe("bridgePairs", () => {
  const q = (id: string) => ({
    candidate: candidate({ id }),
    evidence: { mass: 1, anchorDf: 1, shared: 1 },
    dormant: false,
  });

  it("pairs every qualifier with every other, canonically ordered", () => {
    expect(bridgePairs([q("b"), q("a"), q("c")])).toEqual([
      ["a", "b"],
      ["b", "c"],
      ["a", "c"],
    ]);
  });

  it("has nothing to say about a single qualifier", () => {
    // One storyline is not a bridge; a bridge is a claim about a PAIR.
    expect(bridgePairs([q("a")])).toEqual([]);
  });

  // ---- the bound on the cross-product (STORYLINE_MAX_BRIDGING_QUALIFIERS) ----
  //
  // The knob is the pair COUNT, not the bar: `bridgePairs` is quadratic in the
  // qualifier count, so a wide qualifier set is what walks pairs up to K, and
  // each merge widens a profile for the next arrival. These pin the rule; the
  // numbers are in docs/STORYLINE-LINKING.md.

  it("takes the full cross-product when unbounded, which is the default", () => {
    // `undefined` and an omitted argument must be the same thing, or the
    // shipped default would depend on which call site you read.
    const qualified = [q("a"), q("b"), q("c"), q("d")];
    expect(bridgePairs(qualified, undefined)).toEqual(bridgePairs(qualified));
    expect(bridgePairs(qualified)).toHaveLength(6);
  });

  it("bounds the pair count at the source: top-2 is exactly one pair", () => {
    // The whole argument for this lever over a higher K. Two qualifiers is one
    // pair, so the quadratic term is GONE rather than smaller — 40 qualifiers
    // would otherwise write 780 pairs.
    expect(bridgePairs([q("a"), q("b"), q("c"), q("d")], 2)).toEqual([["a", "b"]]);
    expect(bridgePairs([q("a"), q("b"), q("c"), q("d")], 3)).toEqual([
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
  });

  it("is inert when the bound is at or above the qualifier count", () => {
    // 26% of the live archive's bridging groups exceed 2 qualifiers narrowed
    // and 0.5% broad — so most offers must be untouched, or the bound would be
    // a change to everything rather than to the tail that generates the pairs.
    const qualified = [q("a"), q("b")];
    expect(bridgePairs(qualified, 2)).toEqual(bridgePairs(qualified));
    expect(bridgePairs(qualified, 9)).toEqual(bridgePairs(qualified));
  });

  it("refuses all bridging at 1, and at 0, rather than throwing", () => {
    // One qualifier is no pair, so a bound of 1 turns bridge evidence off
    // entirely. That is a legitimate setting and it must not read as "unset" —
    // which is why 0 rather than an absent value is the flag's off position.
    expect(bridgePairs([q("a"), q("b"), q("c")], 1)).toEqual([]);
    expect(bridgePairs([q("a"), q("b"), q("c")], 0)).toEqual([]);
    // A negative bound is a misconfiguration, not a licence to slice from the
    // end of the array — which is what a bare `slice(0, -1)` would do.
    expect(bridgePairs([q("a"), q("b"), q("c")], -1)).toEqual([]);
  });

  it("takes the PREFIX, so it inherits qualifyingStorylines' tiebreak", () => {
    // The load-bearing property, and the reason nothing here re-sorts: the
    // order is already mass desc, then the OLDER storyline, then the id
    // (`qualifyingStorylines`). A second ordering invented at the bound would
    // be a second decision to keep in step with the attach.
    //
    // Two candidates tied on mass, distinguished only by the tiebreak, plus a
    // third that must fall outside a bound of 2.
    const CORPUS = corpus({ rare: 3, other: 5, extra: 7, more: 9 });
    const GROUP = ["rare", "other", "extra", "more"];
    const older = candidate({
      id: "zzz-older",
      profileTokens: GROUP,
      lastCoverageMs: NOW - 5 * DAY,
    });
    const newer = candidate({
      id: "aaa-newer",
      profileTokens: GROUP,
      lastCoverageMs: NOW - DAY,
    });
    // Clears the mass floor too, just by less — so it is ranked out by the
    // bound rather than refused by the bar.
    const weaker = candidate({ id: "weaker", profileTokens: ["rare", "other", "extra"] });

    const qualified = qualifyingStorylines(GROUP, [newer, weaker, older], CORPUS, RULES, NOW);
    // The tie broke on coverage age, not on the id — `zzz-older` sorts last
    // alphabetically and first here, which is what makes this a real check.
    expect(qualified.map((entry) => entry.candidate.id)).toEqual([
      "zzz-older",
      "aaa-newer",
      "weaker",
    ]);
    // …and the bound keeps that order's first two, canonically ordered as a
    // pair. `weaker` is out because it ranks third, not because of its id.
    expect(bridgePairs(qualified, 2)).toEqual([["aaa-newer", "zzz-older"]]);
  });
});

describe("bridgingQualifiers", () => {
  // Exported so the linker's REPORT of what it bridged comes off the same
  // prefix the write does. A report contradicting the row beside it is the
  // cheapest version of the drift this file's history is about.
  it("is the identity when unbounded", () => {
    const list = [1, 2, 3];
    expect(bridgingQualifiers(list, undefined)).toBe(list);
  });

  it("is the prefix otherwise, clamped at zero", () => {
    expect(bridgingQualifiers([1, 2, 3], 2)).toEqual([1, 2]);
    expect(bridgingQualifiers([1, 2, 3], 0)).toEqual([]);
    expect(bridgingQualifiers([1, 2, 3], -4)).toEqual([]);
    expect(bridgingQualifiers([1, 2, 3], 99)).toEqual([1, 2, 3]);
  });

  it("agrees with bridgePairs about which qualifiers may bridge", () => {
    // The property that keeps the two call sites honest: pairs are exactly the
    // combinations of this list, at every bound.
    const q = (id: string) => ({ candidate: candidate({ id }) });
    const qualified = [q("a"), q("b"), q("c"), q("d"), q("e")];
    for (const bound of [undefined, 0, 1, 2, 3, 5, 9]) {
      const kept = bridgingQualifiers(qualified, bound).length;
      expect(bridgePairs(qualified, bound)).toHaveLength((kept * (kept - 1)) / 2);
    }
  });
});

describe("candidateRetrieval", () => {
  // Ceiling is 32 at this corpus size: `rare` anchors, `common` cannot.
  const CORPUS = corpus({ rare: 3, other: 7, common: 9_000 });
  const PROFILE = ["rare", "other", "common"];

  it("narrowed: the anchor-eligible subset, capped at 4,000", () => {
    expect(candidateRetrieval(PROFILE, CORPUS, RULES, true)).toEqual({
      tokens: ["rare", "other"],
      limit: 4_000,
    });
  });

  it("broad: the whole profile, capped at 200 — pre-2026-08-22 behaviour exactly", () => {
    expect(candidateRetrieval(PROFILE, CORPUS, RULES, false)).toEqual({
      tokens: ["rare", "other", "common"],
      limit: 200,
    });
  });

  it("COUPLES the two halves: no mode gives the whole profile a 4,000 cap", () => {
    // The trap this function exists for. The subset is safe because it is a
    // necessary condition; 4,000 is safe because it was censused against THAT
    // subset (0 of 12,366 window groups exceed it, where 200 binds on 1,131).
    // Whole profile at 4,000 is neither behaviour — it is the broad probe (p50
    // 1,903 rows, max 8,054) with its only bound effectively removed, feeding an
    // O(n^2) bridge cross-product. If a later change can produce that pair, the
    // gate has made things worse than either state it switches between.
    for (const narrowed of [true, false]) {
      const { tokens, limit } = candidateRetrieval(PROFILE, CORPUS, RULES, narrowed);
      const isWholeProfile = tokens.length === PROFILE.length;
      expect(limit === 200).toBe(isWholeProfile);
      expect(limit === 4_000).toBe(!isWholeProfile);
    }
  });

  it("narrows by the same rule as `anchorEligibleTokens`, absent tokens included", () => {
    // Not a second implementation: the whole no-qualifier-lost proof is about
    // that function, and an absent token is eligible because `linkEvidence`
    // scores it df 1. A filter written over the df map's entries would drop
    // brand-new vocabulary here and nowhere else.
    const profile = ["unseen", "rare", "common"];
    expect(candidateRetrieval(profile, CORPUS, RULES, true).tokens).toEqual(
      anchorEligibleTokens(profile, CORPUS, RULES),
    );
    expect(candidateRetrieval(profile, CORPUS, RULES, true).tokens).toContain("unseen");
  });

  it("narrowed, can come back EMPTY — broad never can", () => {
    // Empty means no token this group carries can anchor anything, so there is
    // nothing to retrieve and `linkGroup` skips the round trip. The broad probe
    // has no such shortcut: it always probes with what it was given, which is
    // why the early return in `linkGroup` is a narrowed-mode path only.
    expect(candidateRetrieval(["common"], CORPUS, RULES, true).tokens).toEqual([]);
    expect(candidateRetrieval(["common"], CORPUS, RULES, false).tokens).toEqual(["common"]);
  });
});
