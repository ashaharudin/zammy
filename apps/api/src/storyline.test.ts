import { describe, expect, it } from "vitest";
import {
  ANCHOR_DF_FLOOR,
  anchorCeiling,
  clusterStorylines,
  groupProfile,
  linksStoryline,
  storyDayDf,
  storyTokens,
  storylineEvidence,
  type StorylineGroup,
} from "./storyline.js";

/**
 * The storyline decision (ADR-0009), pure half. Every rule here earned its
 * place by failing on live data first — the tests pin the failure shapes, not
 * just the happy path:
 *
 *   roundup descriptions must not speak for a group   (majority profile)
 *   spokes must not extend a storyline's reach        (hub-and-spoke)
 *   a story's own name must anchor on its biggest day (day-relative share)
 */

const RULES = { anchorMaxShare: 0.05, massThreshold: 8 };

describe("storyTokens", () => {
  it("folds title and description through one tokenizer and stemmer", () => {
    const tokens = storyTokens(
      "Press secretary quits",
      "Karoline Leavitt's departures surprise the press corps",
    );
    // `departures` → `departure` (plural fold), `Leavitt's` loses the
    // possessive, stopwords drop, everything lowercases — the same rules
    // grouping lives by, because two layers disagreeing about what a word is
    // would disagree about what a story is.
    expect(tokens).toContain("departure");
    expect(tokens).toContain("leavitt");
    expect(tokens).not.toContain("departures");
    expect(tokens).not.toContain("the");
    // Distinct: "press" appears in both title and description, once here.
    expect(tokens.filter((token) => token === "press")).toHaveLength(1);
  });

  it("stands alone on a null description", () => {
    expect(storyTokens("Ferry service suspended", null)).toEqual(
      expect.arrayContaining(["ferry", "service", "suspended"]),
    );
  });
});

describe("storylineEvidence", () => {
  const corpus = [
    ["leavitt", "white", "house", "press", "secretary"],
    ["leavitt", "replacement", "rumor"],
    ["white", "house", "budget"],
    ["white", "house", "tour"],
    ["press", "freedom", "report"],
  ];
  const df = storyDayDf(corpus);

  it("weights shared tokens by day-rarity and reports the rarest", () => {
    const { mass, anchorDf } = storylineEvidence(corpus[0]!, corpus[1]!, df, corpus.length);
    // Shared: only "leavitt" (df 2 of 5) — rarer than "white" (df 3).
    expect(anchorDf).toBe(2);
    expect(mass).toBeCloseTo(Math.log(5 / 2), 5);
  });

  it("reports Infinity when nothing is shared", () => {
    const { mass, anchorDf } = storylineEvidence(corpus[2]!, ["unrelated"], df, corpus.length);
    expect(mass).toBe(0);
    expect(anchorDf).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("anchorCeiling", () => {
  it("scales with the day", () => {
    // df 64 on a 1,453-article day is 4.4% — a NAME, and the live failure
    // that made the ceiling relative: an absolute cap stopped recognising
    // the Leavitt story on exactly the day it dominated coverage.
    expect(64).toBeLessThanOrEqual(anchorCeiling(1453, RULES));
    // "trump"-shaped vocabulary (~20% of any day) never anchors.
    expect(300).toBeGreaterThan(anchorCeiling(1453, RULES));
  });

  it("keeps a floor so small corpora can link at all", () => {
    expect(anchorCeiling(60, RULES)).toBe(ANCHOR_DF_FLOOR);
  });
});

describe("groupProfile", () => {
  it("is the member's own tokens for a group of one", () => {
    expect(groupProfile([["a", "b"]])).toEqual(["a", "b"]);
  });

  it("silences vocabulary only a minority of members carry", () => {
    // The live failure: AP "The Latest:" live-blog copies inside a group
    // enumerate the whole day's news in their descriptions, and through
    // max-over-members the story acquired BLACKPINK and a blood-robot swarm
    // as coverage. Majority support is the fix.
    const profile = groupProfile([
      ["leavitt", "quits", "blackpink", "thyssenkrupp"], // the live-blog copy
      ["leavitt", "quits", "podium"],
      ["leavitt", "quits", "secretary"],
    ]);
    expect(profile).toContain("leavitt");
    expect(profile).toContain("quits");
    expect(profile).not.toContain("blackpink");
    expect(profile).not.toContain("thyssenkrupp");
  });
});

describe("clusterStorylines", () => {
  /**
   * A day corpus from per-group member tokens, PADDED with unrelated filler
   * articles. The padding is load-bearing: day-relative rarity means a story's
   * own vocabulary is only "rare" against a day that talks about other things
   * too — a six-article corpus makes every token common and the mass collapse
   * to zero, which is correct behaviour and useless for testing topology.
   */
  function day(named: Record<string, string[][]>): {
    groups: StorylineGroup[];
    df: Map<string, number>;
    size: number;
  } {
    const entries: StorylineGroup[] = Object.entries(named).map(
      ([id, memberTokens], index) => ({
        id,
        memberTokens,
        publishedMs: 1_000_000 + index,
      }),
    );
    for (let i = 0; i < 12; i += 1) {
      entries.push({
        id: `90${i}`,
        memberTokens: [[`filler${i}a`, `filler${i}b`, `filler${i}c`]],
        publishedMs: 2_000_000 + i,
      });
    }
    const all = entries.flatMap((group) => group.memberTokens);
    return { groups: entries, df: storyDayDf(all), size: all.length };
  }

  const CORE = ["leavitt", "karoline", "white", "house", "press", "secretary", "quits"];

  it("attaches angle pieces to the biggest group's hub", () => {
    const { groups, df, size } = day({
      "1": [CORE, CORE, CORE], // the syndicated core — biggest, so the hub
      "2": [["leavitt", "karoline", "replacement", "rumor", "press", "secretary"]],
      "3": [["leavitt", "karoline", "husband", "press", "white", "house"]],
      "4": [["ferry", "service", "suspended", "storm"]],
    });

    const assignment = clusterStorylines(groups, df, size, {
      anchorMaxShare: 0.5,
      massThreshold: 3,
    });

    expect(assignment.get("2")).toBe("1");
    expect(assignment.get("3")).toBe("1");
    expect(assignment.get("4")).toBe("4"); // nothing shared: its own storyline
    expect(assignment.get("1")).toBe("1");
  });

  it("never chains through a spoke", () => {
    // B shares a name with hub A; C shares vocabulary with B ONLY. Transitive
    // clustering would fuse all three — the measured mega-storyline failure
    // (1,179 of a day's 1,190 groups in one cluster). One hop means C stands
    // alone: it never cleared the bar against the HUB.
    const { groups, df, size } = day({
      A: [
        ["leavitt", "quits", "podium", "briefing"],
        ["leavitt", "quits", "podium", "exit"],
      ],
      B: [["leavitt", "quits", "roundup", "digest", "newsletter"]],
      C: [["roundup", "digest", "newsletter", "subscribe"]],
    });

    const assignment = clusterStorylines(groups, df, size, {
      anchorMaxShare: 0.5,
      massThreshold: 2,
    });

    expect(assignment.get("B")).toBe("A");
    expect(assignment.get("C")).toBe("C");
  });

  it("is deterministic under input order", () => {
    const { groups, df, size } = day({
      "9": [CORE, CORE],
      "5": [["leavitt", "karoline", "press", "farewell"]],
      "7": [["leavitt", "karoline", "press", "successor"]],
    });
    const rules = { anchorMaxShare: 0.5, massThreshold: 2 };

    const forward = clusterStorylines(groups, df, size, rules);
    const reversed = clusterStorylines([...groups].reverse(), df, size, rules);

    expect([...forward.entries()].sort()).toEqual([...reversed.entries()].sort());
  });

  it("refuses to link on beat vocabulary alone, however much of it is shared", () => {
    // Two White House stories share five tokens — every one carried by BOTH
    // groups' every member, so each is ubiquitous among the non-filler
    // corpus. Ubiquity prices their rarity mass near zero (ln(N/df) with df
    // near N of the beat), and what remains cannot reach even a permissive
    // threshold: shared BEAT vocabulary proves a beat, not a story.
    const common = ["white", "house", "press", "secretary", "briefing"];
    const groups: StorylineGroup[] = [
      { id: "1", memberTokens: [common, common, common, common], publishedMs: 1 },
      { id: "2", memberTokens: [[...common, "budget"], [...common, "vote"]], publishedMs: 2 },
    ];
    const all = groups.flatMap((group) => group.memberTokens);
    const df = storyDayDf(all);

    const assignment = clusterStorylines(groups, df, all.length, {
      anchorMaxShare: 0.5,
      massThreshold: 1,
    });
    expect(assignment.get("2")).toBe("2");
  });

  it("honours linksStoryline for the pairwise question", () => {
    const a = ["leavitt", "quits", "podium"];
    const b = ["leavitt", "successor", "podium"];
    const df = storyDayDf([a, b, ["other", "story"], ["fourth", "estate"]]);
    expect(linksStoryline(a, b, df, 4, { anchorMaxShare: 0.5, massThreshold: 1 })).toBe(true);
    expect(linksStoryline(a, ["fourth", "estate"], df, 4, { anchorMaxShare: 0.5, massThreshold: 1 })).toBe(false);
  });
});
