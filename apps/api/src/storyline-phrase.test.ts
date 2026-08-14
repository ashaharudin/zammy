import { describe, expect, it } from "vitest";
import { singular } from "./grouping.js";
import { storyTokens } from "./storyline.js";
import { storylinePhrase, type PhraseArticle } from "./storyline-phrase.js";

/**
 * The storyline phrase (ADR-0010). The property that matters is not which
 * phrase wins but what winning GUARANTEES: both words present in every article
 * the slot shows, folded the way `story_tokens` is folded — because that is
 * the gate the seeded attach applies, and a phrase that failed it would open a
 * search missing the very coverage it was named after.
 */

const article = (title: string, description: string | null = null): PhraseArticle => ({
  title,
  description,
});

/** The seeded attach's gate, in the form storage applies it. */
const wouldAttach = (phrase: string, target: PhraseArticle) => {
  const tokens = new Set(storyTokens(target.title, target.description));
  return phrase.split(" ").every((keyword) => tokens.has(singular(keyword)));
};

describe("storylinePhrase", () => {
  it("has nothing to name when the slot is one story", () => {
    expect(storylinePhrase(article("Police chiefs urge minister to act"), [])).toBeNull();
  });

  it("names the story with two words the whole slot carries", () => {
    const headline = article("Police chiefs urge minister to block release");
    const coverage = [
      article("What the police chiefs letter actually asks for"),
      article("Minister responds", "The police chiefs made their case on Tuesday."),
    ];

    const phrase = storylinePhrase(headline, coverage);

    expect(phrase).toBe("police chiefs");
    for (const target of [headline, ...coverage]) {
      expect(wouldAttach(phrase!, target)).toBe(true);
    }
  });

  it("refuses a phrase one piece of the coverage does not carry", () => {
    // "prison release" leads the headline and would win on position alone. It
    // is absent from the retrospective, which is exactly the article the
    // search it opened would then have missed.
    const phrase = storylinePhrase(
      article("Prison release: police chiefs write to minister"),
      [article("The police chiefs who signed the letter")],
    );

    expect(phrase).toBe("police chiefs");
  });

  it("names the story rather than stating it", () => {
    // "letter urges" leads the headline and every article carries both words;
    // it loses anyway, because a predicate is a headline with its middle
    // removed and leads nowhere when clicked (ADR-0006).
    const phrase = storylinePhrase(
      article("Letter urges police chiefs rethink"),
      [article("The letter that urges a police chiefs rethink")],
    );

    expect(phrase).toBe("police chiefs");
  });

  it("folds plurals, so a phrase survives the coverage saying it in the singular", () => {
    const coverage = [article("Profile: the police chief behind the letter")];

    expect(storylinePhrase(article("Police chiefs write to minister"), coverage)).toBe(
      "police chiefs",
    );
  });

  it("prefers the phrase more of the coverage actually says", () => {
    // Every article carries all four words, so "budget committee" qualifies
    // and leads the headline. Only the headline ever puts those two words
    // together, while both other pieces say "funding cut" — which is what the
    // day is calling this story.
    const phrase = storylinePhrase(article("Budget committee funding cut"), [
      article("What the funding cut means", "The cut was approved by a committee under the budget."),
      article("Funding cut clears the committee", "Budget lines shift again."),
    ]);

    expect(phrase).toBe("funding cut");
  });

  it("says nothing when the coverage shares no phrase with the headline", () => {
    expect(
      storylinePhrase(article("Police chiefs write to minister"), [
        article("Unrelated volcano erupts overnight"),
      ]),
    ).toBeNull();
  });

  it("is stable across a replayed read", () => {
    const headline = article("Medicaid funding cut clears committee");
    const coverage = [article("The medicaid funding cut, explained")];

    expect(storylinePhrase(headline, coverage)).toBe(storylinePhrase(headline, coverage));
  });
});
