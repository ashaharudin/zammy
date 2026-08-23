import { describe, expect, it } from "vitest";
import { replayLinker, replayWithReoffers, type ReplayGroup } from "./storyline-replay.js";
import type { Corpus, LinkRules } from "./storyline-link.js";

/**
 * The replay harness — the instrument, not the decision.
 *
 * `storyline-link.test.ts` pins the RULE and `storyline-linker.test.ts` pins
 * what the service writes. What these pin is the correspondence between the
 * two: that the harness's retrieval is the service's retrieval, that its
 * re-offer models `linkGroup`'s re-offer, and that its merge models
 * `mergeStorylines`. A threshold measured on a harness nobody tested is a
 * threshold pinned against a simulator's bugs, which is how the candidate cap
 * truncated the decision for months (docs/VERCEL-PHASE-0-FINDINGS.md §2.5).
 */

const RULES: LinkRules = {
  anchorMaxShare: 0.002,
  anchorDfFloor: 10,
  massThreshold: 20,
  dormancyDays: 90,
  dormantStrictness: 1.5,
};

const DAY = 86_400_000;
const START = new Date("2026-08-01T00:00:00Z").getTime();

/**
 * A corpus that has seen none of these tokens, so every one scores as df 1 —
 * `linkEvidence`'s "genuinely the rarest thing there is". That makes the
 * arithmetic exact and the fixtures readable: one shared token is worth
 * ln(16,000) = 9.68, so TWO shared tokens (19.36) fall short of the mass floor
 * of 20 and THREE (29.04) clear it. Every fixture below is built on that line.
 */
const CORPUS: Corpus = { size: 16_000, df: new Map() };
const corpusAt = (): Corpus => CORPUS;

/**
 * The retrieval mode these fixtures run under. `narrowRetrieval` is a required
 * argument (PR #128) precisely so it cannot be defaulted apart from the
 * service, and on THIS corpus it is a no-op either way: every token is df 1, so
 * the whole profile is anchor-eligible and both probes retrieve the same set.
 * That is deliberate — the fixtures below test the merge and the re-offer, and a
 * retrieval difference underneath them would be a confound. The modes have their
 * own section at the bottom of this file, on a corpus built to separate them.
 */
const NARROW = true;

let seq = 0;
/** `day` orders publication; the id is padded so ties break in creation order. */
function group(tokens: string[], over: { day?: number; domain?: string } = {}): ReplayGroup {
  seq += 1;
  const day = over.day ?? seq;
  return {
    groupId: `g${String(seq).padStart(3, "0")}`,
    memberTokens: [tokens],
    language: "en",
    publishedMs: START + day * DAY,
    dayKey: `2026-08-${String(day).padStart(2, "0")}`,
    sourceDomain: over.domain ?? `d${seq}.example`,
  };
}

const A = ["alpha", "beta", "gamma", "delta"];
const B = ["kappa", "lambda", "mu", "nu"];
const C = ["rho", "sigma", "tau", "upsilon"];
/** Enough of a family to clear the mass floor, not enough to carry the arc. */
const some = (family: string[]): string[] => family.slice(0, 3);

describe("birth-only replay", () => {
  it("seeds one provisional storyline per group and links none without shared tokens", () => {
    const result = replayLinker([group(A), group(B)], corpusAt, RULES, 2, NARROW);
    expect(result.storylines).toBe(2);
    expect(result.promoted).toBe(0);
    expect(result.attached).toBe(0);
    expect(result.largestStoryline).toBe(1);
  });

  it("absorbs a group's birth storyline into its best qualifier, so it lives in ONE arc", () => {
    const result = replayLinker([group(A), group(A)], corpusAt, RULES, 2, NARROW);
    expect(result.storylines).toBe(1);
    expect(result.attached).toBe(1);
    expect(result.largestStoryline).toBe(2);
  });

  it("never re-offers, so it reports no retroactive attachment at all", () => {
    const result = replayLinker([group(A), group(A), group(A)], corpusAt, RULES, 2, NARROW);
    expect(result.retroAttached).toBe(0);
  });
});

describe("the re-offer path", () => {
  /**
   * Two disjoint arcs — they share nothing, so neither can qualify for the
   * other — and one group that shares all of both. At birth it joins one; the
   * re-offer is what can pull it into the other, and ADR-0011 allows exactly
   * one such arc however many nights ask.
   */
  const twoArcsAndABridge = (): ReplayGroup[] => [
    group(A, { day: 1 }),
    group(A, { day: 1 }),
    group(B, { day: 2 }),
    group(B, { day: 2 }),
    group([...A, ...B], { day: 3 }),
  ];

  it("pulls an already-homed group into ONE additional arc and no more", () => {
    const result = replayWithReoffers(twoArcsAndABridge(), corpusAt, RULES, 2, NARROW, {
      mode: "posthoc",
      windowDays: 90,
      passes: 6,
    });
    expect(result.retroAttached).toBe(1);
  });

  it("records no bridge for an arc the group already lives in", () => {
    // One bridging group is one observation for the pair, on its birth offer.
    // Every re-offer filters its own homes out of the evidence, so no second
    // observation can appear and K=2 is never reached by one group
    // re-qualifying night after night.
    const result = replayWithReoffers(twoArcsAndABridge(), corpusAt, RULES, 2, NARROW, {
      mode: "posthoc",
      windowDays: 90,
      passes: 6,
    });
    expect(result.merges).toBe(0);
    expect(result.bridgedPairs).toBe(1);
    expect(result.bridgeObservations).toBe(1);
  });

  it("merges once a SECOND independent group bridges the same pair", () => {
    const groups = [
      group(A, { day: 1 }),
      group(A, { day: 1 }),
      group(B, { day: 2 }),
      group(B, { day: 2 }),
      group([...A, ...B], { day: 3 }),
      group([...A, ...B], { day: 4 }),
    ];
    const result = replayWithReoffers(groups, corpusAt, RULES, 2, NARROW, {
      mode: "posthoc",
      windowDays: 90,
      passes: 4,
    });
    expect(result.merges).toBe(1);
    expect(result.storylines).toBe(1);
  });
});

describe("bridgeOffers: first — bridge at birth, still attach late", () => {
  it("keeps the retroactive attachment while recording no re-offer evidence", () => {
    const groups = [
      group(A, { day: 1 }),
      group(A, { day: 1 }),
      group(B, { day: 2 }),
      group(B, { day: 2 }),
      group([...A, ...B], { day: 3 }),
    ];
    const result = replayWithReoffers(groups, corpusAt, RULES, 2, NARROW, {
      mode: "posthoc",
      windowDays: 90,
      passes: 4,
      variant: { bridgeOffers: "first" },
    });
    // The sweep's value survives…
    expect(result.retroAttached).toBe(1);
    // …and the only bridge on record is the one the birth offer wrote.
    expect(result.bridgeObservations).toBe(1);
  });
});

describe("independence", () => {
  /**
   * A–B bridged by two distinct GROUPS that published on the same day from the
   * same wire — "independent" only in the weakest sense the current rule allows.
   */
  const bridgedTwiceByOneDayAndOneWire = (): ReplayGroup[] => [
    group(A, { day: 1 }),
    group(A, { day: 1 }),
    group(B, { day: 2 }),
    group(B, { day: 2 }),
    group([...A, ...B], { day: 3, domain: "wire.example" }),
    group([...A, ...B], { day: 3, domain: "wire.example" }),
  ];

  it("merges on two distinct GROUPS, which is today's rule", () => {
    const result = replayLinker(bridgedTwiceByOneDayAndOneWire(), corpusAt, RULES, 2, NARROW);
    expect(result.merges).toBe(1);
  });

  it("refuses when the two bridges share a day", () => {
    const result = replayLinker(bridgedTwiceByOneDayAndOneWire(), corpusAt, RULES, 2, NARROW, {}, {
      independence: "days",
    });
    expect(result.merges).toBe(0);
  });

  it("refuses when the two bridges share a source domain", () => {
    const result = replayLinker(bridgedTwiceByOneDayAndOneWire(), corpusAt, RULES, 2, NARROW, {}, {
      independence: "domains",
    });
    expect(result.merges).toBe(0);
  });
});

describe("maxBridgingQualifiers", () => {
  it("bounds the pairs a group may write without changing where it attaches", () => {
    const groups = [
      group(A, { day: 1 }),
      group(A, { day: 1 }),
      group(B, { day: 2 }),
      group(B, { day: 2 }),
      group(C, { day: 3 }),
      group(C, { day: 3 }),
      group([...A, ...B, ...C], { day: 4 }),
    ];
    const wide = replayLinker(groups, corpusAt, RULES, 2, NARROW);
    const bounded = replayLinker(groups, corpusAt, RULES, 2, NARROW, {}, {
      maxBridgingQualifiers: 2,
    });
    // Three qualifiers are three pairs; the best two are one.
    expect(wide.bridgedPairs).toBe(3);
    expect(bounded.bridgedPairs).toBe(1);
    expect(bounded.attached).toBe(wide.attached);
  });
});

describe("cascadeMerges — the storage semantics the harness used to omit", () => {
  /**
   * Three disjoint arcs. A–B is bridged TWICE, so it merges the ordinary way;
   * C holds ONE bridge to A and one to B, so it is below K against either.
   *
   * Storage does not leave it there. `mergeStorylines` re-points the loser's
   * bridges onto the winner, so the instant A–B merges, C holds TWO bridges to
   * the survivor — K, reached with no bridge inserted and nothing to trigger a
   * check but `cascadeMerge`. That is the loop the pinned K was measured
   * without, and the service has its own test for it ("re-checks a pair whose
   * count crosses K LATER in the same cascade").
   *
   * C's bridges are recorded BEFORE the A–B merge on purpose: recorded after,
   * they would land on the survivor as two ordinary observations and merge with
   * no re-pointing involved, which would test nothing.
   */
  const aTwoWayMergeThatStrandsAThirdArc = (): ReplayGroup[] => [
    group(A, { day: 1 }),
    group(A, { day: 1 }),
    group(B, { day: 2 }),
    group(B, { day: 2 }),
    group(C, { day: 3 }),
    group(C, { day: 3 }),
    group([...some(A), ...some(C)], { day: 4 }),
    group([...some(B), ...some(C)], { day: 5 }),
    group([...some(A), ...some(B)], { day: 6 }),
    group([...some(A), ...some(B)], { day: 7 }),
  ];

  it("strands the third arc's evidence at an alias without it", () => {
    const result = replayLinker(aTwoWayMergeThatStrandsAThirdArc(), corpusAt, RULES, 2, NARROW);
    expect(result.merges).toBe(1);
    // A+B merged; C stands alone, its two bridges pointing at ids that no
    // longer resolve to one pair.
    expect(result.storylines).toBe(2);
  });

  it("re-points evidence on merge, so a pair reaches K with no bridge recorded", () => {
    const result = replayLinker(aTwoWayMergeThatStrandsAThirdArc(), corpusAt, RULES, 2, NARROW, {
      cascadeMerges: true,
    });
    expect(result.merges).toBe(2);
    expect(result.storylines).toBe(1);
  });
});

describe("cappedRetrievalLimit — the pre-#117 retrieval, for the drain experiment", () => {
  it("is rejected in interleaved mode, which has no build phase to confine it to", () => {
    expect(() =>
      replayWithReoffers([group(A)], corpusAt, RULES, 2, NARROW, {
        mode: "interleaved",
        windowDays: 14,
        passes: 1,
        fidelity: { cappedRetrievalLimit: 200 },
      }),
    ).toThrow(/posthoc/);
  });

  it("truncates by recency, so a cap of one keeps only the freshest candidate", () => {
    // Two arcs sharing two tokens — 19.36, just under the floor — so neither
    // qualifies for the other. A newcomer sharing three with each qualifies for
    // both and bridges them. Under a cap of 1 only the most recently covered is
    // retrievable, so there is no second qualifier and no pair to write.
    const shared = ["xi", "omicron"];
    const left = [...shared, ...some(A)];
    const right = [...shared, ...some(B)];
    const groups = [
      group(left, { day: 1 }),
      group(left, { day: 1 }),
      group(right, { day: 2 }),
      group(right, { day: 2 }),
      group([...shared, A[0]!, B[0]!], { day: 3 }),
    ];
    const uncapped = replayLinker(groups, corpusAt, RULES, 2, NARROW);
    const capped = replayLinker(groups, corpusAt, RULES, 2, NARROW, { cappedRetrievalLimit: 1 });
    expect(uncapped.bridgedPairs).toBe(1);
    expect(capped.bridgedPairs).toBe(0);
  });
});

/**
 * The two RETRIEVAL modes, on a corpus built to tell them apart.
 *
 * Everything above runs on a df-1 corpus where the two probes are identical.
 * These need them to differ, so they get their own fixture: a COMMON token that
 * no narrowed probe will touch, and one rare token per group that both probes
 * will.
 *
 * What is pinned here is the harness's agreement with the service, because
 * their silent divergence is the root of docs/VERCEL-PHASE-0-FINDINGS.md §2.5 —
 * the thresholds were certified against a candidate set production never judged,
 * and nothing in the output said so.
 */
const MODE_DAY = "2026-08-11";
/** A 16,000-article fortnight: the anchor ceiling is 32. */
const MODE_DF: Record<string, number> = { trump: 2_000 };
const modeCorpusAt = (): Corpus => ({
  size: 16_000,
  df: new Map(Object.entries(MODE_DF)),
});

/**
 * 210 groups that never link: each carries one rare token of its own (df 20)
 * plus one COMMON token every group shares. Sharing `trump` alone is mass 2.08
 * against a floor of 20, so nothing qualifies in either mode — which is the
 * point. The archives come out identical; what differs is how many candidates
 * each mode had to look at.
 */
function crowd(): ReplayGroup[] {
  return Array.from({ length: 210 }, (_, i) => {
    MODE_DF[`rare${i}`] = 20;
    return {
      groupId: `c${String(i).padStart(3, "0")}`,
      memberTokens: [["trump", `rare${i}`]],
      language: "en",
      publishedMs: new Date(`${MODE_DAY}T09:00:00Z`).getTime() + i * 1_000,
      dayKey: MODE_DAY,
      sourceDomain: `c${i}.example`,
    };
  });
}

describe("replayLinker retrieval modes", () => {
  it("builds the same archive either way — narrowing is a no-op on the RESULT", () => {
    // The necessary-condition property, at the harness level: this is what makes
    // the committed grid in docs/STORYLINE-LINKING.md valid for both modes, and
    // what made #117's grid come out byte-identical.
    const groups = crowd();
    const broad = replayLinker(groups, modeCorpusAt, RULES, 2, false);
    const narrowed = replayLinker(groups, modeCorpusAt, RULES, 2, true);

    expect(narrowed.storylines).toBe(broad.storylines);
    expect(narrowed.promoted).toBe(broad.promoted);
    expect(narrowed.attached).toBe(broad.attached);
    expect(narrowed.merges).toBe(broad.merges);
    expect(narrowed.largestStoryline).toBe(broad.largestStoryline);
    expect(narrowed.built).toEqual(broad.built);
  });

  it("REPORTS the row cap it does not apply, per configured mode", () => {
    // The half of the retrieval this harness still does not model, said out loud
    // instead of silently inherited. Broad, the 201st arrival onward overlaps
    // more than 200 live storylines through one common token, so the service
    // would have cut the candidate set these numbers were certified against — 9
    // groups here, 12,266 of 12,366 on the dev archive. Narrowed, the common
    // token is not anchor-eligible, nothing is retrieved, and the count is 0
    // exactly as the census over the whole dev window found.
    const groups = crowd();

    expect(replayLinker(groups, modeCorpusAt, RULES, 2, false).cappedGroups).toBe(9);
    expect(replayLinker(groups, modeCorpusAt, RULES, 2, true).cappedGroups).toBe(0);
  });

  it("still links what it should in either mode", () => {
    // A guard on the fixture above rather than on the modes: `crowd` proves
    // nothing if the harness has stopped linking altogether.
    MODE_DF.fausto = 20;
    MODE_DF.hawaii = 20;
    MODE_DF.surf = 20;
    MODE_DF.swell = 20;
    MODE_DF.genevieve = 20;
    const story = ["fausto", "hawaii", "surf", "swell", "genevieve"];
    const groups: ReplayGroup[] = [0, 1].map((i) => ({
      groupId: `m${i}`,
      memberTokens: [story],
      language: "en",
      publishedMs: new Date(`${MODE_DAY}T09:00:00Z`).getTime() + i * 1_000,
      dayKey: MODE_DAY,
      sourceDomain: `m${i}.example`,
    }));

    for (const narrowed of [true, false]) {
      const result = replayLinker(groups, modeCorpusAt, RULES, 2, narrowed);
      expect(result.attached).toBe(1);
      expect(result.largestStoryline).toBe(2);
    }
  });
});
