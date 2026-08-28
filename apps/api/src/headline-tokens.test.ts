import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RawSighting, normalizeSightings } from "@zammy/currents-client";
import {
  contentTokenPairs,
  contentTokens,
  foldDiacritics,
  isVerb,
  properNounEvidence,
  stripSourceAttribution,
} from "./headline-tokens.js";
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

describe("a Latin accent does not split a name from itself (tokenizer version 8)", () => {
  // Measured on the dev archive (2026-08-27): 519 of 32,279 titles carry a
  // Latin mark, and the corpus held `niño` on 96 articles while thirteen live
  // arcs were labelled "El Nino ..." — a name that could not reach its own
  // coverage.
  it("folds the corpus spelling to the one a keyboard produces", () => {
    expect(contentTokens("Super El Niño hits US states")).toEqual(
      contentTokens("Super El Nino hits US states"),
    );
    expect(contentTokens("When will super El Niño hit")).toContain("nino");
  });

  it("folds every mark on one letter, not just the first", () => {
    // Vietnamese stacks two: base + circumflex + acute. A single-mark strip
    // would leave the second behind and the token still would not match.
    expect(foldDiacritics("tiếng")).toBe("tieng");
  });

  it("folds a hyphenated name without shredding it", () => {
    // "Pied-à-Terre" is one token by the identifier rule (§10.2). The fold only
    // ever deletes marks, so it cannot split a token whatever the implementation
    // — this is documentation of the shape rather than a falsifiable guard. The
    // real witness for the fold's boundary is the non-Latin case below.
    expect(foldDiacritics("pied-à-terre")).toBe("pied-a-terre");
  });

  it("touches no non-Latin script, where a mark is not decoration", () => {
    // Devanagari's virama is \p{Mn} and changes what a word SAYS; Hangul
    // decomposes into jamo that are not marks at all, so a fold that forgot to
    // recompose would hand back a different string than it was given.
    expect(foldDiacritics("हिन्दी")).toBe("हिन्दी");
    expect(foldDiacritics("한국")).toBe("한국");
    expect(foldDiacritics("العربية")).toBe("العربية");
  });

  it("is idempotent, so a re-derived row is a stable row", () => {
    // `regroup --tokens-only` re-runs this over rows it may have folded before.
    const once = foldDiacritics("québécois");
    expect(foldDiacritics(once)).toBe(once);
  });
});

describe("the outlet's own name is not vocabulary", () => {
  // Currents ships the title as the outlet wrote its <title> tag. Left in, the
  // attribution is a token like any other and the WORST kind: it is carried by
  // every article from that outlet whatever the article is about. Measured on
  // the dev archive (2026-08-21): `winnipeg`, `globalnew`, `ca` and `manitoba`
  // together are worth mass 19.88 against a linker floor of 20, which is how
  // ten unrelated Manitoba stories became one arc called "Manitoba Beekeepers".

  it("peels the site, then the edition behind it", () => {
    expect(
      stripSourceAttribution(
        "Manitoba beekeepers feeling sting of potential 50 per cent tariff - Winnipeg | Globalnews.ca",
      ),
    ).toBe("Manitoba beekeepers feeling sting of potential 50 per cent tariff");
  });

  it("keeps the outlet's words out of the tokens the layers match on", () => {
    // The composition every title TOKENIZER now uses: `headlineTokens`,
    // `storyTokens`, `properNounEvidence`, `headlineFigures` and the bigram
    // extractor all strip before they read the title. `contentTokens` itself
    // does not, because it is also handed descriptions and
    // `${title} ${description}`, where there is no end to peel from.
    //
    // Not every reader of a title: `buildLabelPrompt` still shows the model the
    // raw title, deliberately. Its wording is a measured artifact, and the
    // grounding vocabulary it is checked against comes from `storyTokens`,
    // which strips — so an outlet name the model echoes fails grounding rather
    // than becoming a label.
    const tokens = contentTokens(
      stripSourceAttribution(
        "Angler reels in training grenade from Red River in Selkirk: RCMP - Winnipeg | Globalnews.ca",
      ),
    );
    for (const attribution of ["winnipeg", "globalnews", "ca"]) {
      expect(tokens, `attribution "${attribution}" survived`).not.toContain(attribution);
    }
    expect(tokens).toContain("grenade");
    expect(tokens).toContain("selkirk");
  });

  it.each([
    ["Bitcoin rise stalls again - Reuters", "Bitcoin rise stalls again"],
    ["Seoul talks resume - The Korea Times", "Seoul talks resume"],
    ["Oil holds above eighty - OilPrice.com", "Oil holds above eighty"],
    ["Lagos port backlog clears - Businessday NG", "Lagos port backlog clears"],
    ["Quarterly results land - Arkansas Democrat Gazette", "Quarterly results land"],
  ])("peels attribution from %s", (title, expected) => {
    expect(stripSourceAttribution(title)).toBe(expected);
  });

  it.each([
    // A verb makes it the headline's own tail, however short.
    "Kabul blast kills twelve - dozens remain missing",
    // So does length.
    "Ferry service resumes - he has a bad record with them",
    // And a stopword anywhere but the front.
    "Harvest ends early - and faster than expected",
    // A leading function word is exempt only when it is an ARTICLE. No outlet
    // is called "Some ..." or "Their ...", so these are tails too.
    "Ottawa tables budget - some quiet relief",
    "Rates hold steady - their fourth such call",
  ])("leaves a headline's own tail alone: %s", (title) => {
    expect(stripSourceAttribution(title)).toBe(title);
  });

  it("peels a short verbless tail that reads like a name", () => {
    // The other side of the same coin, and the cost the module comment quotes:
    // an article plus two content words is the shape of "The Korea Times", so
    // this is indistinguishable by shape alone. Two tokens on one article.
    expect(stripSourceAttribution("Trump wins Ohio - a stunning upset")).toBe("Trump wins Ohio");
  });

  it("never peels a headline down to nothing", () => {
    // Two words is the floor, which is what lets "Bitcoin Rise - Reuters" work
    // at all. Below it there is no headline left to name.
    expect(stripSourceAttribution("Reuters - Fortune")).toBe("Reuters - Fortune");
  });

  it("leaves a title that is nothing but attribution to the stopword list", () => {
    expect(stripSourceAttribution("Globalnews.ca")).toBe("Globalnews.ca");
  });
});

describe("a masthead's own capitalization outranks the function word in it (tokenizer version 9)", () => {
  // Version 6's blind spot, closed. Measured on the dev archive (2026-08-28,
  // 32,279 articles): 5,559 titles carry a delimited tail, 101 were refused by
  // the internal-function-word rule alone, and admitting the name-cased ones
  // moves 63 titles — 62 rows' `title_tokens`, 48 rows' `story_tokens`. The
  // biggest single slice is one outlet: 18 Times of India titles donating
  // `india` (and `delhi`, off the "Delhi News" desk line) to every article they
  // carry, which is version 6's "- Winnipeg | Globalnews.ca" with an `of` in
  // the middle.

  it.each([
    // The example the old blind-spot note was written around.
    ["Ottawa unveils plan - the Globe and Mail", "Ottawa unveils plan"],
    // The archive's own, in the shapes it actually holds them.
    [
      "Rain leaves parts of Delhi waterlogged, disrupts traffic | Delhi News - The Times of India",
      "Rain leaves parts of Delhi waterlogged, disrupts traffic",
    ],
    ["The Bombing of Hiroshima | Council on Foreign Relations", "The Bombing of Hiroshima"],
    ["Street Fighter Sneak Peak Corrects the Mistake | Den of Geek", "Street Fighter Sneak Peak Corrects the Mistake"],
    ["Commuting Happens Inside a Giant Strawberry | Moss and Fog", "Commuting Happens Inside a Giant Strawberry"],
    ["GDP first quarterly estimate - Office for National Statistics", "GDP first quarterly estimate"],
  ])("peels the name-cased masthead from %s", (title, expected) => {
    expect(stripSourceAttribution(title)).toBe(expected);
  });

  it("reads the token AS WRITTEN, so a capitalized function word is a name's word", () => {
    // `FUNCTION_WORDS` holds lowercase spellings. "OF" and "The" here are part
    // of the name rather than connectives, and they carry a capital like every
    // other word in it — which is exactly what the test asks of them.
    expect(stripSourceAttribution("How M'sians Can Apply For a Permit - WORLD OF BUZZ")).toBe(
      "How M'sians Can Apply For a Permit",
    );
    expect(stripSourceAttribution("Should Judges Work in Death Penalty Courts? - Law The Podcast")).toBe(
      "Should Judges Work in Death Penalty Courts?",
    );
  });

  it.each([
    // The two the old note said a loose rule would eat. It does not: they are
    // lowercase, and a name is not.
    "Uganda hold on - remain top of the table",
    "Harvest ends early - and faster than expected",
    // Sentence-case tails generally, which is most of what sits after a dash.
    "Trump signs order - mostly from Americans",
    "Gaza talks stall - trap students in Gaza",
    "Ottawa tables budget - Latest and Breaking news",
  ])("leaves a tail that is not name-cased alone: %s", (title) => {
    expect(stripSourceAttribution(title)).toBe(title);
  });

  it("cannot vouch for a segment in a script that has no case", () => {
    // A constructed probe of the boundary rather than an archive shape: the new
    // path only opens for a segment holding an ENGLISH function word, so this
    // is where the two meet. `\p{Lu}` is empty for CJK, so the name-case test
    // refuses and the peel stays where version 8 left it. Refusing is the safe
    // direction — it keeps a token rather than deleting one.
    //
    // A tail with no function word in it at all was already peeled at version 8
    // whatever its script, and still is; that is not this rule's decision.
    expect(stripSourceAttribution("Taipei talks resume - 台灣 of 新聞網")).toBe(
      "Taipei talks resume - 台灣 of 新聞網",
    );
  });

  it.each([
    // A question mark is never an outlet's own name, and Title Case is also how
    // a stock-tip desk writes its headline tail. These four shapes were 9 of
    // the 17 titles the bare capitalization rule got wrong.
    "Dell Technologies Hits New 52-Week High - Time to Buy?",
    "NetEase Shares Gap Up - Still a Buy?",
    "Uber Became a Cash Machine – Opportunity or Trap?",
    "Congress Govt Plans Curbs on Public-Space Activities | BJP Set for Showdown?",
  ])("refuses a name-cased tail that asks a question: %s", (title) => {
    expect(stripSourceAttribution(title)).toBe(title);
  });

  it.each([
    // The cost, pinned so a future loosening of `isNameCased` trips on it
    // rather than quietly widening it. These are the headline's own words and
    // the rule takes them anyway — five titles of 32,279, listed in full in
    // `isNameCased`.
    ["Hamas disarmament plan includes destruction of tunnels — Board of Peace", "Hamas disarmament plan includes destruction of tunnels"],
    ["Force is the only language West understands – Carl Zha to RT", "Force is the only language West understands"],
    ["Help Gov Adeleke prepare for life after losing - Hope Uzodimma to Davido", "Help Gov Adeleke prepare for life after losing"],
    ["CEBL on CBC: Finals - Winnipeg at Brampton", "CEBL on CBC: Finals"],
  ])("peels a Title Case tail that is the headline's own words: %s", (title, expected) => {
    expect(stripSourceAttribution(title)).toBe(expected);
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

describe("properNounEvidence counts members, not occurrences", () => {
  // `minMembers` is what the bigram label's verb gate raises to overrule the
  // lexicon. It has to count MEMBERS: an article that repeats its own Title
  // Case headline inside its description supplies two occurrences of the same
  // word from one source, which is exactly how `Gigabyte Brings` outranked a
  // `brings` the lexicon already held.
  const selfQuoting = [
    {
      title: "Gigabyte Brings Aorus Infinity to Gamescom",
      description:
        "Gigabyte is heading to Gamescom under the Aorus theme. " +
        "Gigabyte Brings Aorus Infinity to Gamescom The series delivers a build.",
    },
    { title: "Arsenal chase another title", description: "Adam explores the chances." },
  ];

  it("promotes a twice-sighted word on one member's word by default", () => {
    const evidence = properNounEvidence(selfQuoting);
    expect(evidence("brings")).toBe(true);
  });

  it("refuses it once a second member is required", () => {
    const evidence = properNounEvidence(selfQuoting);
    expect(evidence("brings", 2)).toBe(false);
    // Not a blanket refusal of the corpus: `gigabyte` is sighted in the same
    // one member and answers the same way, which is the point — the bar is
    // about how many SOURCES agree, not about which word is asked for.
    expect(evidence("gigabyte", 2)).toBe(false);
  });

  it("promotes a word two members write mid-prose", () => {
    const evidence = properNounEvidence([
      { title: "Rose arrives in Memphis", description: "The winner Justin Rose looks sharp." },
      { title: "Champ still pushing", description: "The Englishman Justin Rose defends here." },
    ]);
    expect(evidence("rose", 2)).toBe(true);
    // A third member's word is a real step further, and the one that would
    // cost this golfer his surname.
    expect(evidence("rose", 3)).toBe(false);
  });

  it("still lets one lowercase occurrence disqualify at any bar", () => {
    // The lowercase test is corpus-wide and unchanged: a word seen lowercase
    // ANYWHERE is not a name, however many members capitalize it.
    const evidence = properNounEvidence([
      { title: "Kelowna chiefs urge inquiry", description: "The Chiefs met in Kelowna." },
      { title: "Critics answered", description: "The Chiefs replied from Kelowna." },
    ]);
    expect(evidence("chiefs", 1)).toBe(false);
    expect(evidence("chiefs", 2)).toBe(false);
    expect(evidence("kelowna", 2)).toBe(true);
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
