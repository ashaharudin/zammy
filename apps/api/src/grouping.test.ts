import { describe, expect, it } from "vitest";
import {
  chooseGroup,
  headlineTokens,
  titleSimilarity,
  type GroupSeed,
} from "./grouping.js";

/**
 * The grouping decision (ARCHITECTURE 14.3): does this article belong with an
 * existing group, or does it start its own?
 *
 * Pure by construction — the candidate window (same APP_TIMEZONE day, same
 * language) is SQL's job, and everything judgemental happens here where it can
 * be tested without a database.
 *
 * The threshold is UNMEASURED, exactly as item 7 warned about term variants, so
 * these tests assert FAILURE CLASSES rather than similarity numbers: syndicated
 * near-duplicates group, loosely-related coverage does not, and a single shared
 * word never groups anything. Pinning the arithmetic would make the test a
 * snapshot of one threshold rather than a check on the mechanism.
 */

const RULES = { threshold: 0.5 };

function seed(overrides: Partial<GroupSeed> & { title: string }): GroupSeed {
  return {
    id: overrides.id ?? "1",
    groupId: overrides.groupId ?? overrides.id ?? "1",
    titleTokens: headlineTokens(overrides.title),
    published: overrides.published ?? new Date("2026-08-11T10:00:00.000Z"),
  };
}

describe("headlineTokens", () => {
  it("drops stopwords and keeps the topical nouns", () => {
    expect(headlineTokens("The prime minister will meet the premier")).toEqual([
      "prime",
      "minister",
      "meet",
      "premier",
    ]);
  });

  it("drops identifiers whole rather than shredding them into fragments", () => {
    // The §10.2 lesson: a regex that splits CVE-2026-1234 leaves a `cve-`
    // token behind. Grouping shares the cloud's tokenizer so it inherits the
    // fix — the identifier contributes nothing, and no fragment appears.
    const tokens = headlineTokens("Jenkins plugin flaw CVE-2026-1234 patched");
    expect(tokens).not.toContain("cve");
    expect(tokens).not.toContain("cve-");
    expect(tokens).toContain("jenkins");
  });

  it("is a set: a word repeated in one headline counts once", () => {
    const tokens = headlineTokens("Flood warnings after flood warnings ignored");
    expect(tokens.filter((token) => token === "flood")).toHaveLength(1);
  });
});

describe("titleSimilarity", () => {
  it("is 1 for the same token set and 0 for disjoint ones", () => {
    expect(titleSimilarity(["ottawa", "budget"], ["budget", "ottawa"])).toBe(1);
    expect(titleSimilarity(["ottawa"], ["kyiv"])).toBe(0);
  });

  it("is 0 when either side has no tokens, never NaN", () => {
    // A headline of pure stopwords tokenizes to nothing, and 0/0 must not
    // become a similarity of NaN that comparisons silently treat as false.
    expect(titleSimilarity([], [])).toBe(0);
    expect(titleSimilarity(["budget"], [])).toBe(0);
  });
});

describe("chooseGroup", () => {
  it("groups the same wire story republished under a different headline", () => {
    // The case item 3 exists for: one story, two outlets, two URLs, so
    // URL-based dedup (§7.4) cannot collapse it and should not.
    const wire = seed({
      id: "10",
      title: "Bank of Canada holds interest rate at 2.75 per cent",
    });
    const match = chooseGroup(
      headlineTokens("Bank of Canada holds its interest rate at 2.75 per cent"),
      [wire],
      RULES,
    );

    expect(match?.groupId).toBe("10");
  });

  it("leaves loosely-related coverage of the same subject in separate groups", () => {
    // Both are wildfire stories from the same day and would sit together under
    // an event-level reading. They are NOT the same story, and a false merge
    // hides one behind a toggle (ADR-0002's principle, restated in §14.3).
    const other = seed({
      id: "11",
      title: "Wildfires force thousands to flee northern Alberta",
    });
    const match = chooseGroup(
      headlineTokens("Alberta wildfire evacuations grow as flames near Fort McMurray"),
      [other],
      RULES,
    );

    expect(match).toBeNull();
  });

  it("never groups on a single shared word, however perfect the overlap", () => {
    // Both headlines reduce to the one token `trump`, so their Jaccard is a
    // flawless 1 and the threshold alone would merge them. The shared-token
    // floor is what stops every headline naming one person from collapsing
    // into a single group.
    const bare = seed({ id: "12", title: "Trump on Tuesday" });
    expect(headlineTokens("Trump on Tuesday")).toEqual(["trump"]);
    expect(chooseGroup(headlineTokens("Trump, the report said"), [bare], RULES)).toBeNull();
  });

  it("takes the closest candidate, not the first one it passes", () => {
    const loose = seed({
      id: "20",
      title: "Ottawa budget deficit widens as spending climbs sharply",
    });
    const closer = seed({ id: "21", title: "Ottawa budget deficit widens" });

    const match = chooseGroup(
      headlineTokens("Ottawa budget deficit widens again"),
      [loose, closer],
      RULES,
    );

    expect(match?.groupId).toBe("21");
  });

  it("breaks a similarity tie by earliest published, then by lowest id", () => {
    // Determinism matters more than which one wins: the same batch replayed
    // after a retry must produce the same grouping (§7.4 idempotence).
    const later = seed({
      id: "31",
      title: "Ferry service suspended by storm",
      published: new Date("2026-08-11T12:00:00.000Z"),
    });
    const earlier = seed({
      id: "32",
      title: "Ferry service suspended by storm",
      published: new Date("2026-08-11T08:00:00.000Z"),
    });
    const earlierHigherId = seed({
      id: "33",
      title: "Ferry service suspended by storm",
      published: new Date("2026-08-11T08:00:00.000Z"),
    });

    const tokens = headlineTokens("Ferry service suspended by storm");
    expect(chooseGroup(tokens, [later, earlier, earlierHigherId], RULES)?.id).toBe("32");
    expect(chooseGroup(tokens, [earlierHigherId, earlier, later], RULES)?.id).toBe("32");
  });

  it("returns the candidate's GROUP, not the candidate", () => {
    // Candidates are group seeds, and the seed's id is the group's identity —
    // an article joins the group, and the group is what the timeline pages over.
    const member = seed({ id: "41", groupId: "40", title: "Storm floods coastal towns" });
    const match = chooseGroup(
      headlineTokens("Storm floods coastal towns overnight"),
      [member],
      RULES,
    );

    expect(match?.groupId).toBe("40");
  });

  it("starts a new group when there is nothing to join", () => {
    expect(chooseGroup(headlineTokens("A quiet day in Ottawa"), [], RULES)).toBeNull();
  });

  it("cannot group a headline that tokenizes to nothing", () => {
    const candidate = seed({ id: "50", title: "What to know about this" });
    expect(chooseGroup(headlineTokens("What to know about this"), [candidate], RULES)).toBeNull();
  });
});
