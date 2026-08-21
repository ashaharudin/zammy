import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RawSighting, normalizeSightings } from "@zammy/currents-client";
import { contentTokenPairs, contentTokens, isVerb, properNounEvidence } from "./headline-tokens.js";
import { singular } from "./grouping.js";

/**
 * The headline tokenizer and its two gates, against the RECORDED corpora.
 *
 * These assertions were written through `scoreTerms`, which is gone with the
 * term cloud (ADR-0013). They are kept, re-pointed at the functions that
 * survive it, because the classes they pin are not properties of the cloud —
 * they are properties of headline text, and grouping (§14.3) and the bigram
 * label (ADR-0011's fallback) read them through this same tokenizer. What was
 * dropped is only what was genuinely about ranking: score order, the
 * per-domain cap, the baseline's suppression, and the
 * unigram-subsumed-by-a-bigram rule, none of which have a caller any more.
 *
 * The assertions are failure CLASSES, not an expected token list: the day's
 * news is not reproducible, and pinning exact output would make this a
 * snapshot of one afternoon rather than a check on the mechanisms (§12).
 */

interface CorpusArticle {
  title: string;
  description: string | null;
}

function fixturePath(name: string): string {
  return new URL(`../../../fixtures/${name}`, import.meta.url).pathname;
}

function loadCorpus(fixture: string): CorpusArticle[] {
  const data = JSON.parse(readFileSync(fixturePath(fixture), "utf8")) as {
    calls: Array<{ news: unknown[] }>;
  };
  const raw = data.calls.flatMap((call) => call.news).map((item) => RawSighting.parse(item));
  const { sightings } = normalizeSightings(raw);

  // Collapse to articles by URL, as storage would (80 rows, 80 unique URLs).
  const byUrl = new Map<string, CorpusArticle>();
  for (const s of sightings) {
    byUrl.set(s.url, { title: s.title, description: s.description });
  }
  return [...byUrl.values()];
}

/**
 * Every term the surviving gates admit from a corpus: unigrams, and bigrams
 * over ADJACENT survivors, each carrying a name and no verb.
 *
 * This is the shape `bigram-label.ts` draws its candidates in, written out here
 * so the classes below can be asserted over a whole recorded corpus rather than
 * one storyline's members — which is the only way `angeles ap` is observable at
 * all, since the dateline only clears the old breadth gate across two fixtures.
 */
function admitted(corpus: readonly CorpusArticle[]): Set<string> {
  const isProperNoun = properNounEvidence(corpus);
  const terms = new Set<string>();
  const admit = (words: string[]) => {
    if (!words.some(isProperNoun)) return;
    if (words.some((word, index) => isVerb(word, index, isProperNoun))) return;
    terms.add(words.join(" "));
  };

  for (const article of corpus) {
    const tokens = contentTokens(`${article.title} ${article.description ?? ""}`);
    tokens.forEach((token, index) => {
      admit([token]);
      const next = tokens[index + 1];
      if (next !== undefined) admit([token, next]);
    });
  }
  return terms;
}

describe("tokenization survives identifiers (§10.2)", () => {
  // The probe's own regex shredded CVE-2026-1234 into a `cve-` fragment that
  // then ranked #1. Grouping compares headlines through this tokenizer, so the
  // bug would be inherited verbatim by the thing that decides what one story is.
  const corpus = loadCorpus("search-keywordless-category-sample.json");

  it("emits no numeric or identifier fragment from a corpus full of CVEs", () => {
    for (const article of corpus) {
      for (const token of contentTokens(`${article.title} ${article.description ?? ""}`)) {
        expect(token, `"${token}" looks like an identifier fragment`).not.toMatch(/\d/);
        expect(token, `"${token}" is a cve fragment`).not.toMatch(/^cve-?$/);
      }
    }
  });

  it("drops generic news vocabulary via the stopword list", () => {
    const tokens = new Set(
      corpus.flatMap((a) => contentTokens(`${a.title} ${a.description ?? ""}`)),
    );
    for (const word of ["earlier", "found", "read", "how", "not", "just", "says", "report"]) {
      expect(tokens.has(word), `stopword "${word}" survived`).toBe(false);
    }
  });
});

describe("a typographic apostrophe does not split a contraction (issue #101)", () => {
  it("keeps a curly-quoted contraction whole, matching the ASCII spelling", () => {
    expect(contentTokens("Girlfriend doesn’t get my imessages")).toEqual(
      contentTokens("Girlfriend doesn't get my imessages"),
    );
  });

  it("keeps a curly-quoted name whole (Xi'an)", () => {
    expect(contentTokens("Xi’an protest grows")).toEqual(["xi'an", "protest", "grows"]);
  });
});

describe("wire-service and desk furniture (ADR-0007)", () => {
  // Both recorded corpora together — `los angeles ap` only exists across the
  // two, and the whole point of this class is that it is reproduced across
  // outlets rather than chosen by them, so breadth never disqualified it.
  const emitted = admitted([
    ...loadCorpus("latest-news-v2-sample.json"),
    ...loadCorpus("search-keywordless-category-sample.json"),
  ]);

  it("drops the words a newsroom writes about the article, not the story", () => {
    // Measured before this list existed: all five were in the cloud, and
    // `angeles ap` — the `LOS ANGELES (AP) —` dateline — ranked 12th of 33.
    for (const furniture of ["angeles ap", "ap", "ceo", "daily", "rep", "weekly"]) {
      expect(emitted.has(furniture), `desk furniture "${furniture}" survived`).toBe(false);
    }
  });

  it("keeps the names the corpus is actually about", () => {
    for (const real of ["donald trump", "gianni infantino", "world cup", "los angeles"]) {
      expect(emitted.has(real), `"${real}" was lost to the stopword list`).toBe(true);
    }
  });
});

describe("a name beside a verb states something rather than naming it (ADR-0006)", () => {
  const emit = (title: string, prose: string): Set<string> =>
    admitted([{ title, description: prose }]);

  it("drops the verb that follows a name (graham advances)", () => {
    // Measured failure (2026-08-12 live cloud): once one proper word could
    // anchor a phrase, the OTHER half of a headline came with it — "graham
    // advances", "trump slipped", "schaffer reflects". A clause, not a name.
    const emitted = emit(
      "Kelowna Advances In The Contest",
      "The town advances while rivals stall in Kelowna.",
    );
    expect(emitted.has("kelowna advances")).toBe(false);
    expect(emitted.has("kelowna")).toBe(true);
  });

  it("drops the verb that PRECEDES a name (leaving turkey)", () => {
    // The junk arrives in both orders — "giving rob" and "leaving turkey" sat
    // beside "graham advances" in the same cloud.
    const emitted = emit(
      "Leaving Kelowna Behind, Crews Regroup",
      "Crews are leaving today; they were last seen in Kelowna.",
    );
    expect(emitted.has("leaving kelowna")).toBe(false);
  });

  it("keeps a deverbal NOUN beside a name, whatever suffix it wears", () => {
    // "funding" and "games" wear the same -ing and -s as "leaving" and
    // "advances", so no suffix rule can separate them. The lexicon can: it
    // records which lemmas have nominalized in which inflection.
    const emitted = emit(
      "Kelowna Funding Survives The Kelowna Games",
      "Officials discussed funding, and the games drew crowds in Kelowna.",
    );
    expect(emitted.has("kelowna funding")).toBe(true);
    expect(emitted.has("kelowna games")).toBe(true);
  });

  it("keeps a participle that PRECEDES the name it modifies", () => {
    // In front, "-ed" modifies ("armed forces", "planned parenthood"); only
    // after a name is it a predicate.
    const emitted = emit(
      "Displaced Kelowna Residents Return Home",
      "The displaced families of Kelowna are going home.",
    );
    expect(emitted.has("displaced kelowna")).toBe(true);
  });

  it("lets corpus capitalization outrank the lexicon (Sitting Bull)", () => {
    // "Sitting" is a verb form and also the front half of a name. Here it is
    // never lowercase and appears capitalized mid-sentence, so the case
    // evidence stands and the lexicon does not get to overrule it.
    const emitted = emit(
      "Kelowna Honours Sitting Bull",
      "A statue of Sitting Bull was unveiled in Kelowna.",
    );
    expect(emitted.has("sitting bull")).toBe(true);
  });
});

describe("the propriety gate (ADR-0006)", () => {
  it("qualifies by mid-sentence capitalization, not by Title Case", () => {
    const emitted = admitted([
      { title: "Community Rallies Around Kelowna", description: "The community gathered in Kelowna." },
      { title: "Community Fund Launched In Kelowna", description: "A fund for the community near Kelowna." },
    ]);

    // Title Case capitalizes "Community", but the descriptions show it
    // lowercase in prose — a common noun. "Kelowna" is never lowercase and
    // appears capitalized mid-sentence: a place.
    expect(emitted.has("kelowna")).toBe(true);
    expect(emitted.has("community")).toBe(false);
  });

  it("admits a phrase on ONE name; two common words are not one", () => {
    const emitted = admitted([
      { title: "Kelowna policy shift announced", description: "The Kelowna policy drew praise." },
      { title: "New climate policy criticised", description: "Critics of the climate policy spoke." },
    ]);

    expect(emitted.has("kelowna policy")).toBe(true);
    expect(emitted.has("climate policy")).toBe(false);
    expect(emitted.has("policy")).toBe(false);
  });

  it("cannot reach a place name built on a stopword (new york)", () => {
    // A known limit, pinned so it is not rediscovered as a bug: a stopword
    // BREAKS an n-gram run rather than being skipped, so "new york" is
    // unreachable at any n and "york" stands in for it. Un-stopwording "new"
    // was measured and refused (ADR-0007).
    const emitted = admitted([
      { title: "Blackout Hits New York Again", description: "Crews worked overnight in New York." },
      { title: "New York Mayor Answers Critics", description: "Officials in New York promised a review." },
    ]);

    expect(emitted.has("new york")).toBe(false);
    expect(emitted.has("new")).toBe(false);
    expect(emitted.has("york")).toBe(true);
  });
});

describe("contentTokenPairs does not fabricate adjacency (issue #100)", () => {
  it("drops a pair a stopword actually separated", () => {
    // `contentTokens` filters "reportedly", "to" and "a" out, so a caller
    // walking THAT array for adjacent pairs would read "agree deal" as a
    // bigram — but "agree" and "deal" never stood next to each other; "to a"
    // sat between them.
    const pairs = contentTokenPairs("Royals reportedly agree to a deal");
    expect(pairs).not.toContainEqual(["agree", "deal"]);
  });

  it("keeps a pair that really is adjacent", () => {
    const pairs = contentTokenPairs("Royals agree deal, Padres celebrate");
    expect(pairs).toContainEqual(["royals", "agree"]);
    expect(pairs).toContainEqual(["agree", "deal"]);
    expect(pairs).toContainEqual(["padres", "celebrate"]);
  });

  it("drops a pair punctuation separated, which the tokenizer throws away", () => {
    // The harder half of the same bug: a stopword at least survives into the
    // token stream, but the comma is DISCARDED, so "deal" lands next to
    // "padres" with nothing left to show that anything stood between them.
    const pairs = contentTokenPairs("Royals agree deal, Padres celebrate");
    expect(pairs).not.toContainEqual(["deal", "padres"]);
  });

  it("drops a pair a spaced hyphen separated, as feed titles write it", () => {
    // A hyphen is kept INSIDE a word so CVE-2026-1234 survives whole (§10.2),
    // so a hyphen standing alone as a source separator has to break the run
    // some other way: it is a chunk that trims to nothing.
    const pairs = contentTokenPairs("Bitcoin rise continues - Kelowna");
    expect(pairs).toContainEqual(["bitcoin", "rise"]);
    expect(pairs).not.toContainEqual(["continues", "kelowna"]);
  });

  it("partitions the token stream without changing it", () => {
    // Runs are a regrouping of `splitTokens`, not a second tokenizer: the
    // possessive still folds, the curly apostrophe still survives (#101), and
    // the hyphenated identifier still comes through whole so it can be
    // dropped whole for containing a digit (§10.2).
    expect(contentTokens("Dillard's patch doesn’t land, Kelowna says")).toEqual([
      "dillard",
      "patch",
      "doesn't",
      "land",
      "kelowna",
    ]);
    expect(contentTokens("The CVE-2026-1234 patch - Kelowna")).toEqual(["patch", "kelowna"]);
  });
});

describe("properNounEvidence needs prose, not Title Case (issue #100)", () => {
  it("promotes nothing from a corpus that is Title Case throughout", () => {
    // Ignoring the segment's FIRST capital is not enough on its own: every
    // later word of a Title Case headline is a mid-segment capital too, so
    // the gate used to read "Quarter", "Eps" and "Estimate" as names and
    // admit the exact vocabulary pairs it exists to refuse.
    const evidence = properNounEvidence([
      { title: "Second Quarter Eps Estimate Revised Again", description: null },
      { title: "Eps Estimate Beats Second Quarter Forecast", description: null },
    ]);

    expect(evidence("eps")).toBe(false);
    expect(evidence("estimate")).toBe(false);
    expect(evidence("quarter")).toBe(false);
  });

  it("still promotes a name once one segment is written as prose", () => {
    // One description in running text is all it takes: "chiefs" shows up
    // lowercase there and "Kelowna" does not, which is the whole test.
    const evidence = properNounEvidence([
      { title: "Kelowna Chiefs Urge Inquiry", description: null },
      { title: "Chiefs Answer Critics", description: "The chiefs met in Kelowna." },
    ]);

    expect(evidence("kelowna")).toBe(true);
    expect(evidence("chiefs")).toBe(false);
  });
});

describe("properNounEvidence's fold", () => {
  const corpus = [
    {
      title: "Talks Resume Over Gaza",
      description:
        "Negotiators said Hamas had accepted the terms in Doha. " +
        "The mediators expect Hamas and Israel to sign this week.",
    },
    {
      title: "Attack in Paris",
      description:
        "Investigators in Paris named a suspect on Tuesday. " +
        "Prosecutors in Paris said the inquiry continues.",
    },
  ];

  it("answers for the surface form by default", () => {
    const evidence = properNounEvidence(corpus);
    expect(evidence("hamas")).toBe(true);
    expect(evidence("paris")).toBe(true);
  });

  it("meets a singularized caller on one spelling", () => {
    // The label merge asks with words `normalizeLabel` has already folded, so
    // it asks for `hama` and `pari`. Unfolded on the corpus side, every name
    // ending in `s` answers false and the grounding guard refuses a whole
    // class of stories as nameless.
    const evidence = properNounEvidence(corpus, singular);
    expect(evidence(singular("hamas"))).toBe(true);
    expect(evidence(singular("paris"))).toBe(true);
    // Still a name test, not a pass: a word written lowercase in the prose
    // fails on either side of the fold.
    expect(evidence(singular("negotiators"))).toBe(false);
  });
});
