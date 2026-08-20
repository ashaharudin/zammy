import { describe, expect, it } from "vitest";
import { contentTokens } from "./headline-tokens.js";
import {
  chooseGroup,
  rankedMatches,
  headlineFigures,
  headlineTokens,
  singular,
  titleSimilarity,
  type GroupCandidate,
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

function candidate(overrides: Partial<GroupCandidate> & { title: string }): GroupCandidate {
  return {
    id: overrides.id ?? "1",
    groupId: overrides.groupId ?? overrides.id ?? "1",
    titleTokens: headlineTokens(overrides.title),
    title: overrides.title,
    published: overrides.published ?? new Date("2026-08-11T10:00:00.000Z"),
  };
}

/** A headline as `chooseGroup` takes it: tokens plus the figures it quotes. */
const headline = (title: string) => ({
  tokens: headlineTokens(title),
  figures: headlineFigures(title),
});

describe("headlineTokens", () => {
  it("drops stopwords and keeps the topical nouns", () => {
    expect(headlineTokens("The prime minister will meet the premier")).toEqual([
      "prime",
      "minister",
      "meet",
      "premier",
    ]);
  });

  it("singularizes, so `chiefs` and `chief` are one word", () => {
    expect(headlineTokens("Police chiefs urge action")).toEqual(
      headlineTokens("Police chief urges action"),
    );
  });

  it("leaves short words and -ss words alone", () => {
    // `gas` must not become `ga`, and `press` must not become `pres`: the
    // floor and the -ss guard are what keep the stemmer from inventing words.
    expect(headlineTokens("Gas press releases")).toEqual(["gas", "press", "release"]);
  });

  it("maps -ies plurals onto their singular", () => {
    expect(headlineTokens("Studies show a shift")).toEqual(headlineTokens("Study shows a shift"));
  });

  it("never mangles a word to reach a tidier stem", () => {
    // The rejected rule (strip `es` after s/x/z/ch/sh) reaches `box` from
    // `boxes` but turns `releases` into `releas`. Dropping the final `s` and
    // nothing more leaves `boxe` — ugly, consistent, and harmless.
    expect(headlineTokens("Prisoner releases announced")).toContain("release");
    expect(headlineTokens("Boxes of ballots")).toEqual(["boxe", "ballot"]);
  });

  it("does not stem the CLOUD's tokens — a term is a surface form", () => {
    // §10.3 and CONTEXT.md: "China" and "Chinese" are two terms and both may
    // appear. Grouping asks a different question, so the stemmer belongs to
    // grouping alone and contentTokens must keep returning what was written.
    expect(contentTokens("Police chiefs urge action")).toContain("chiefs");
  });

  it("drops identifiers whole rather than shredding them into fragments", () => {
    // The §10.2 lesson: a regex that splits CVE-2026-1234 leaves a `cve-`
    // token behind. Grouping shares the cloud's tokenizer so it inherits the
    // fix — the identifier contributes nothing, and no fragment appears.
    const tokens = headlineTokens("Jenkins plugin flaw CVE-2026-1234 patched");
    expect(tokens).not.toContain("cve");
    expect(tokens).not.toContain("cve-");
    // `jenkin`, not `jenkins`: the stemmer treats a proper noun's trailing `s`
    // like any other, which is consistent on both sides of a comparison and so
    // costs nothing here. The cloud, which shows terms to people, does not stem.
    expect(tokens).toContain("jenkin");
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
    const wire = candidate({
      id: "10",
      title: "Bank of Canada holds interest rate at 2.75 per cent",
    });
    const match = chooseGroup(
      headline("Bank of Canada holds its interest rate at 2.75 per cent"),
      [wire],
      RULES,
    );

    expect(match?.groupId).toBe("10");
  });

  it("leaves loosely-related coverage of the same subject in separate groups", () => {
    // Both are wildfire stories from the same day and would sit together under
    // an event-level reading. They are NOT the same story, and a false merge
    // hides one behind a toggle (ADR-0002's principle, restated in §14.3).
    const other = candidate({
      id: "11",
      title: "Wildfires force thousands to flee northern Alberta",
    });
    const match = chooseGroup(
      headline("Alberta wildfire evacuations grow as flames near Fort McMurray"),
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
    const bare = candidate({ id: "12", title: "Trump on Tuesday" });
    expect(headlineTokens("Trump on Tuesday")).toEqual(["trump"]);
    expect(chooseGroup(headline("Trump, the report said"), [bare], RULES)).toBeNull();
  });

  it("takes the closest candidate, not the first one it passes", () => {
    const loose = candidate({
      id: "20",
      title: "Ottawa budget deficit widens as spending climbs sharply",
    });
    const closer = candidate({ id: "21", title: "Ottawa budget deficit widens" });

    const match = chooseGroup(
      headline("Ottawa budget deficit widens again"),
      [loose, closer],
      RULES,
    );

    expect(match?.groupId).toBe("21");
  });

  it("breaks a similarity tie by earliest published, then by lowest id", () => {
    // Determinism matters more than which one wins: the same batch replayed
    // after a retry must produce the same grouping (§7.4 idempotence).
    const later = candidate({
      id: "31",
      title: "Ferry service suspended by storm",
      published: new Date("2026-08-11T12:00:00.000Z"),
    });
    const earlier = candidate({
      id: "32",
      title: "Ferry service suspended by storm",
      published: new Date("2026-08-11T08:00:00.000Z"),
    });
    const earlierHigherId = candidate({
      id: "33",
      title: "Ferry service suspended by storm",
      published: new Date("2026-08-11T08:00:00.000Z"),
    });

    const ferry = headline("Ferry service suspended by storm");
    expect(chooseGroup(ferry, [later, earlier, earlierHigherId], RULES)?.id).toBe("32");
    expect(chooseGroup(ferry, [earlierHigherId, earlier, later], RULES)?.id).toBe("32");
  });

  it("returns the candidate's GROUP, not the candidate", () => {
    // A candidate may be any MEMBER of a group; what a newcomer joins is the
    // group, which is what the timeline pages over.
    const member = candidate({ id: "41", groupId: "40", title: "Storm floods coastal towns" });
    const match = chooseGroup(
      headline("Storm floods coastal towns overnight"),
      [member],
      RULES,
    );

    expect(match?.groupId).toBe("40");
  });

  it("starts a new group when there is nothing to join", () => {
    expect(chooseGroup(headline("A quiet day in Ottawa"), [], RULES)).toBeNull();
  });

  it("cannot group a headline that tokenizes to nothing", () => {
    const stopwordsOnly = candidate({ id: "50", title: "What to know about this" });
    expect(chooseGroup(headline("What to know about this"), [stopwordsOnly], RULES)).toBeNull();
  });

  it("joins through the member it resembles, not the group's first arrival", () => {
    // Live regression (2026-08-11). Group 12523's first arrival was the
    // Independent's "Police leaders call on Burnham…"; the Mirror's piece
    // scores 0.375 against it and MISSED, while duplicating the BBC member in
    // the same group almost word for word. Seed-only comparison judged the
    // wrong article.
    const firstArrival = candidate({
      id: "12523",
      groupId: "12523",
      title: "Police leaders call on Burnham to prevent early release of Pc Harper's killers",
    });
    const bbcMember = candidate({
      id: "12532",
      groupId: "12523",
      title: "Police chiefs call for PM to prevent early release of PC Harper's killers",
    });

    const mirror = headline(
      "Dozens of police chiefs urge PM to prevent PC Harper killers' prison release",
    );

    expect(chooseGroup(mirror, [firstArrival], RULES)).toBeNull(); // what shipped
    expect(chooseGroup(mirror, [firstArrival, bbcMember], RULES)?.groupId).toBe("12523");
  });

  it("joins coverage that differs only in plurals", () => {
    // Live pair (2026-08-11) separated by `chiefs`/`chief` and `killers`/
    // `killer`: 0.43 as surface forms, 0.538 singularized.
    const bbc = candidate({
      id: "70",
      title: "Police chiefs call for PM to prevent early release of PC Harper's killers",
    });
    const dailyMail = headline(
      "Every police chief is urging PM to stop release of PC Harper's killers",
    );

    expect(chooseGroup(dailyMail, [bbc], RULES)?.groupId).toBe("70");
  });

  it("refuses two templated headlines whose figures disagree", () => {
    // Live regression (2026-08-11): ten distinct marketbeat.com insider
    // filings merged into one slot. The tokenizer drops digits (§10.2's `cve-`
    // fix), so the only thing distinguishing these headlines had been thrown
    // away before the comparison — and the figure IS the story here.
    const filing = candidate({
      id: "60",
      title: "Athabasca Oil Corporation Buys 36,800 Shares of Athabasca Oil Corp",
    });
    const other = headline(
      "Athabasca Oil Corporation Buys 43,500 Shares of Athabasca Oil Corp",
    );

    expect(titleSimilarity(other.tokens, filing.titleTokens)).toBe(1); // identical to the tokenizer
    expect(chooseGroup(other, [filing], RULES)).toBeNull();
  });

  it("still groups syndicated copies that quote the SAME figure", () => {
    const wire = candidate({
      id: "61",
      title: "Big Sur wildfire jumps to 2,000 acres as evacuations continue",
    });
    const copy = headline("Big Sur wildfire jumps to 2,000 acres as evacuations continue");

    expect(chooseGroup(copy, [wire], RULES)?.groupId).toBe("61");
  });

  it("lets a figure on one side only pass, since it contradicts nothing", () => {
    // An outlet that puts the acreage in its headline and one that does not are
    // still covering the same fire.
    const withFigure = candidate({
      id: "62",
      title: "Big Sur wildfire jumps to 2,000 acres as evacuations continue",
    });
    const without = headline("Big Sur wildfire jumps as evacuations continue");

    expect(chooseGroup(without, [withFigure], RULES)?.groupId).toBe("62");
  });
});

describe("headlineFigures", () => {
  it("normalizes thousands separators so 36,800 and 36800 are one figure", () => {
    expect(headlineFigures("Insider buys 36,800 shares")).toEqual(new Set(["36800"]));
  });

  it("finds every figure a headline quotes, and none when it quotes none", () => {
    expect(headlineFigures("Insider buys C$419,625.00 in stock, up 90%")).toEqual(
      new Set(["419625.00", "90"]),
    );
    expect(headlineFigures("Police chiefs urge PM to act")).toEqual(new Set());
  });
});

describe("rankedMatches", () => {
  it("returns every match, closest first — not just the winner", () => {
    // The runners-up are what fixes the one-shot limitation: an article that
    // matched two groups joins the better one, and the caller adopts the rest
    // rather than stranding them (§14.3).
    const closer = candidate({ id: "80", groupId: "80", title: "Harbour bridge closed after crash" });
    const looser = candidate({
      id: "81",
      groupId: "81",
      title: "Harbour bridge closed for the evening after a crash downtown",
    });

    const matches = rankedMatches(
      headline("Harbour bridge closed after crash"),
      [looser, closer],
      RULES,
    );

    expect(matches.map((m) => m.id)).toEqual(["80", "81"]);
  });

  it("is empty when nothing clears the bar, so callers cannot adopt noise", () => {
    const unrelated = candidate({ id: "82", title: "Kelp harvest begins in Nova Scotia" });
    expect(rankedMatches(headline("Ferry service suspended by storm"), [unrelated], RULES)).toEqual(
      [],
    );
  });

  it("orders ties the same way the single-winner rule did", () => {
    const later = candidate({
      id: "83",
      title: "Ferry service suspended by storm",
      published: new Date("2026-08-11T12:00:00.000Z"),
    });
    const earlier = candidate({
      id: "84",
      title: "Ferry service suspended by storm",
      published: new Date("2026-08-11T08:00:00.000Z"),
    });

    const matches = rankedMatches(headline("Ferry service suspended by storm"), [later, earlier], RULES);
    expect(matches[0]?.id).toBe("84");
    expect(chooseGroup(headline("Ferry service suspended by storm"), [later, earlier], RULES)?.id).toBe("84");
  });
});
