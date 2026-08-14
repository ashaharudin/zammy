import { describe, expect, it } from "vitest";
import { bigramLabel, type PhraseArticle } from "./bigram-label.js";

/**
 * The bigram label: ADR-0011's deterministic floor under the model.
 *
 * Ported from the read-time storyline phrase's tests when S9 retired it. The
 * containment assertions went with it — a phrase had to appear in every article
 * because clicking it ran a SEARCH, and a label is opened by UUID — but the
 * properties of the extractor underneath are unchanged and are what these
 * cover: it names rather than states, it folds plurals, it prefers what more of
 * the coverage actually says, and it is stable across a replay.
 */

const article = (title: string, description: string | null = null): PhraseArticle => ({
  title,
  description,
});

describe("bigramLabel", () => {
  it("has nothing to name for an empty storyline", () => {
    expect(bigramLabel([])).toBeNull();
  });

  it("names the story with two adjacent words from a headline", () => {
    expect(
      bigramLabel([
        article("Police chiefs urge minister to block release"),
        article("What the police chiefs letter actually asks for"),
      ]),
    ).toBe("Police Chiefs");
  });

  it("names the story rather than stating it", () => {
    // "letter urges" leads the headline and both articles carry both words; it
    // loses anyway, because a predicate is a headline with its middle removed
    // (ADR-0006's verb lexicon), and a label has to be a name.
    expect(
      bigramLabel([
        article("Letter urges police chiefs rethink"),
        article("The letter that urges a police chiefs rethink"),
      ]),
    ).toBe("Police Chiefs");
  });

  it("prefers the phrase more of the coverage actually says", () => {
    // Only the first headline ever puts "budget committee" together, while both
    // other pieces say "funding cut" — which is what the day is calling this.
    expect(
      bigramLabel([
        article("Budget committee funding cut"),
        article(
          "What the funding cut means",
          "The cut was approved by a committee under the budget.",
        ),
        article("Funding cut clears the committee", "Budget lines shift again."),
      ]),
    ).toBe("Funding Cut");
  });

  it("folds plurals, so one article's singular does not split the count", () => {
    expect(
      bigramLabel([
        article("Police chiefs write to minister"),
        article("Profile: the police chief behind the letter"),
      ]),
    ).toBe("Police Chiefs");
  });

  it("Title Cases, because a label is read rather than typed into a search", () => {
    // The one thing that changed when the phrase became a label: it stopped
    // being a query, so it stopped having to survive canonicalization.
    expect(bigramLabel([article("fort hood crash inquiry opens")])).toBe("Fort Hood");
  });

  it("is stable across a replayed read", () => {
    const storyline = [
      article("Medicaid funding cut clears committee"),
      article("The medicaid funding cut, explained"),
    ];
    expect(bigramLabel(storyline)).toBe(bigramLabel(storyline));
  });

  it("no longer requires every article to carry the words", () => {
    // ADR-0010's superset guarantee is deliberately dead (ADR-0011): the label
    // is not a search, so an outlier in the coverage cannot veto the name.
    expect(
      bigramLabel([
        article("Police chiefs write to minister"),
        article("Unrelated volcano erupts overnight"),
      ]),
    ).toBe("Police Chiefs");
  });
});
