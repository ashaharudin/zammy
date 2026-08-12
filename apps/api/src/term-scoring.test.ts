import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RawSighting, normalizeSightings } from "@zammy/currents-client";
import { scoreTerms, type CorpusArticle } from "./term-scoring.js";

/**
 * Term scoring (ARCHITECTURE 10.3), tested against the RECORDED 80-article
 * sample — the one naive document-frequency demonstrably fails on. The
 * assertions are failure CLASSES, not an expected term list: the day's news
 * is not reproducible, and pinning exact output would make this a snapshot
 * of one afternoon rather than a check on the mechanisms (§12).
 */

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
    byUrl.set(s.url, {
      title: s.title,
      description: s.description,
      sourceDomain: s.sourceDomain,
      // Sightings carry an ISO string; storage hands the scorer a Date.
      published: new Date(s.published),
    });
  }
  return [...byUrl.values()];
}

/**
 * The window's end for a recorded corpus: its newest article. Ages inside the
 * fixture are then the real ones, which is what the weighting reads (§10.3) —
 * pinning a wall-clock `now` would just decay a recorded day into nothing.
 */
function corpusNow(corpus: readonly CorpusArticle[]): Date {
  return new Date(Math.max(...corpus.map((a) => a.published.getTime())));
}

const EMPTY_BASELINE = new Map<string, number>();

/** The window's end. Fixtures are dated; what matters is age relative to this. */
const NOW = new Date("2026-08-12T12:00:00.000Z");

describe("scoreTerms against the recorded keywordless sample (§10.3)", () => {
  const corpus = loadCorpus("search-keywordless-category-sample.json");
  const now = corpusNow(corpus);

  // §10.3's three probe-demonstrated failures, asserted on the DAY-ONE
  // configuration — empty baseline — because that is when scoring degrades
  // to raw frequency and only the structural gates stand between the cloud
  // and the garbage top-12 the probe recorded.
  const top50 = scoreTerms(corpus, EMPTY_BASELINE, { now }).slice(0, 50);

  it("never emits identifier fragments or numeric tokens (the cve- artifact)", () => {
    for (const { term } of top50) {
      expect(term, `"${term}" looks like an identifier fragment`).not.toMatch(/\d/);
      expect(term, `"${term}" is a cve fragment`).not.toMatch(/^cve\b/);
    }
  });

  it("gates on df_domains >= 2, which suppresses the single-source Jenkins burst", () => {
    for (const { term, dfDomains } of top50) {
      expect(dfDomains, `"${term}" has df_domains < 2`).toBeGreaterThanOrEqual(2);
      expect(term, "the Jenkins advisory flood leaked through the gate").not.toContain(
        "jenkins",
      );
    }
  });

  it("drops generic news vocabulary via the stopword list", () => {
    const emitted = new Set(top50.map((t) => t.term));
    for (const word of ["earlier", "found", "read", "how", "not", "just", "says", "report"]) {
      expect(emitted.has(word), `stopword "${word}" survived`).toBe(false);
    }
  });

  it("drops generic non-proper unigrams; proper nouns and phrases carry the cloud", () => {
    // Measured failure (2026-08-11 dev cloud): "community", "finally", "rise"
    // topped the day-one cloud — generic vocabulary the baseline would need a
    // week to suppress. Unigrams now need capitalization evidence; these were
    // all in the old top output of THIS fixture and must be gone.
    const emitted = new Set(top50.map((t) => t.term));
    for (const generic of ["set", "use", "learn", "development", "launch", "code", "using"]) {
      expect(emitted.has(generic), `generic unigram "${generic}" survived`).toBe(false);
    }

    // The named entities that made the old output credible must remain —
    // "trump" as the fuller phrase now that subsumed unigrams are suppressed.
    expect(emitted.has("donald trump")).toBe(true);
    expect(emitted.has("trump")).toBe(false);
    expect(emitted.has("ai")).toBe(true);
  });

  it("still yields a usable cloud: some terms, sized by unique articles", () => {
    expect(top50.length).toBeGreaterThan(5);
    for (const t of top50) {
      expect(t.dfArticles).toBeGreaterThanOrEqual(1);
      expect(t.score).toBeGreaterThan(0);
    }
    // Scores arrive ranked, ready for the size scale.
    const scores = top50.map((t) => t.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});

describe("scoreTerms against the recorded latest-news sample (§10.1)", () => {
  // The breadth sample's own corpus — the one the live cloud is mostly built
  // from, and where the nonsense phrases were reported.
  const latest = loadCorpus("latest-news-v2-sample.json");
  const top50 = scoreTerms(latest, EMPTY_BASELINE, { now: corpusNow(latest) }).slice(0, 50);

  it("emits no phrase of purely common words (the 'gas flows' class)", () => {
    // Measured from this fixture before the propriety gate reached phrases:
    // adjacent survivors of the stopword list, adding up to nothing anyone
    // would search for.
    const emitted = new Set(top50.map((t) => t.term));
    for (const nonsense of [
      "gas flows",
      "flows rise",
      "gas production",
      "power play",
      "shape tmk",
    ]) {
      expect(emitted.has(nonsense), `nonsense phrase "${nonsense}" survived`).toBe(false);
    }

    // The names this sample is genuinely about must still carry the cloud.
    expect(emitted.has("gianni infantino")).toBe(true);
    expect(emitted.has("world cup")).toBe(true);
  });
});

describe("wire-service and desk furniture (ADR-0007)", () => {
  // Both recorded corpora together — `los angeles ap` only exists across the
  // two, and the whole point of this class is that it clears the breadth gate
  // by being reproduced across outlets rather than chosen by them.
  const corpus = [
    ...loadCorpus("latest-news-v2-sample.json"),
    ...loadCorpus("search-keywordless-category-sample.json"),
  ];
  const emitted = new Set(
    scoreTerms(corpus, EMPTY_BASELINE, { now: corpusNow(corpus) }).map((t) => t.term),
  );

  it("drops the words a newsroom writes about the article, not the story", () => {
    // Measured before this list existed: all five of these were in the cloud,
    // and `angeles ap` — the `LOS ANGELES (AP) —` dateline — ranked 12th of 33.
    // Bare `ap` never was, being subsumed by `angeles ap`; it is asserted as a
    // forward guard now that the phrase suppressing it is gone.
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

describe("a name beside a verb is an event, not a topic (§10.3)", () => {
  /** Two domains, so the breadth gate passes and only the gate under test speaks. */
  const emit = (title: string, prose: string): Set<string> =>
    new Set(
      scoreTerms(
        [
          { title, description: prose, sourceDomain: "a.com", published: NOW },
          { title, description: prose, sourceDomain: "b.com", published: NOW },
        ],
        EMPTY_BASELINE,
        { now: NOW },
      ).map((t) => t.term),
    );

  it("drops the verb that follows a name (graham advances)", () => {
    // Measured failure (2026-08-12 live cloud): once one proper word could
    // anchor a phrase, the OTHER half of a headline came with it — "graham
    // advances", "trump slipped", "schaffer reflects". A clause, not a topic.
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
    // never lowercase and appears capitalized mid-sentence, so the §10.3 case
    // evidence stands and the lexicon does not get to overrule it.
    const emitted = emit(
      "Kelowna Honours Sitting Bull",
      "A statue of Sitting Bull was unveiled in Kelowna.",
    );
    expect(emitted.has("sitting bull")).toBe(true);
  });
});

describe("scoring mechanisms in isolation", () => {
  /** Published now, so recency weighting is a no-op and the gate under test is alone. */
  const article = (
    title: string,
    domain: string,
    description: string | null = null,
  ): CorpusArticle => ({ title, description, sourceDomain: domain, published: NOW });

  /** …and the same, `ageHours` old, for the tests that are about age. */
  const aged = (
    title: string,
    domain: string,
    description: string | null,
    ageHours: number,
  ): CorpusArticle => ({
    title,
    description,
    sourceDomain: domain,
    published: new Date(NOW.getTime() - ageHours * 3_600_000),
  });

  it("a phrase needs one name to anchor it; two common words are not a topic", () => {
    const corpus = [
      article("Kelowna policy shift announced", "a.com", "The Kelowna policy drew praise."),
      article("New Kelowna policy criticised", "b.com", "Critics of the Kelowna policy spoke."),
      article("Climate policy shift announced", "a.com", "The climate policy debate continued."),
      article("New climate policy criticised", "b.com", "Critics of the climate policy spoke."),
    ];
    const terms = scoreTerms(corpus, EMPTY_BASELINE, { now: NOW });
    const anchored = terms.find((t) => t.term === "kelowna policy");
    expect(anchored).toBeDefined();
    expect(anchored!.isBigram).toBe(true);
    expect(anchored!.dfArticles).toBe(2);

    // A common word rides along inside a phrase a name anchors — "policy"
    // is noise alone, and "climate policy" is two pieces of noise adjacent.
    const emitted = new Set(terms.map((t) => t.term));
    expect(emitted.has("climate policy")).toBe(false);
    expect(emitted.has("policy")).toBe(false);
    expect(emitted.has("climate")).toBe(false);
  });

  it("drops a phrase of purely common words (slipped away)", () => {
    // Measured failure (2026-08-11 dev cloud): "slipped away", "secretly
    // moved" — verb phrases that mean nothing as topics, admitted because
    // the propriety gate exempted phrases entirely.
    const corpus = [
      article(
        "Suspect Slipped Away After Kelowna Raid",
        "a.com",
        "The suspect slipped away before officers reached Kelowna.",
      ),
      article(
        "Witness Watched Man Slipped Away Near Kelowna",
        "b.com",
        "He slipped away down a lane beside Kelowna.",
      ),
    ];
    const emitted = new Set(scoreTerms(corpus, EMPTY_BASELINE, { now: NOW }).map((t) => t.term));

    expect(emitted.has("slipped away")).toBe(false);
    expect(emitted.has("kelowna")).toBe(true);
  });

  it("cannot reach a place name built on a stopword (new york)", () => {
    // A known limit, pinned so it is not rediscovered as a bug: a stopword
    // BREAKS an n-gram run rather than being skipped, so "new york" is
    // unreachable at any n and "york" stands in for it. Un-stopwording "new"
    // was measured and refused — the propriety gate admits a phrase on ONE
    // name, so "new <name>" would then suppress the name itself (ADR-0007).
    const corpus = [
      article("Blackout Hits New York Again", "a.com", "Crews worked overnight in New York."),
      article("New York Mayor Answers Critics", "b.com", "Officials in New York promised a review."),
    ];
    const emitted = new Set(scoreTerms(corpus, EMPTY_BASELINE, { now: NOW }).map((t) => t.term));

    expect(emitted.has("new york")).toBe(false);
    expect(emitted.has("new")).toBe(false);
    expect(emitted.has("york")).toBe(true);
  });

  it("suppresses a unigram subsumed by a surviving bigram (ben vs ben carroll)", () => {
    const corpus = [
      article("Minister Ben Carroll announces funding", "a.com", "Praise for Ben Carroll followed."),
      article("Statement from Ben Carroll on transport", "b.com", "Critics answered Ben Carroll."),
    ];
    const emitted = new Set(scoreTerms(corpus, EMPTY_BASELINE, { now: NOW }).map((t) => t.term));

    // Both words qualify as proper nouns, but every sighting of "ben" is a
    // sighting of "ben carroll" — the phrase alone represents the topic.
    expect(emitted.has("ben carroll")).toBe(true);
    expect(emitted.has("ben")).toBe(false);
    expect(emitted.has("carroll")).toBe(false);
  });

  it("proper nouns qualify by mid-sentence capitalization, not by Title Case", () => {
    const corpus = [
      article("Community Rallies Around Kelowna", "a.com", "The community gathered in Kelowna."),
      article("Community Fund Launched In Kelowna", "b.com", "A fund for the community near Kelowna."),
    ];
    const emitted = new Set(scoreTerms(corpus, EMPTY_BASELINE, { now: NOW }).map((t) => t.term));

    // Title Case capitalizes "Community", but the descriptions show it
    // lowercase in prose — a common noun. "Kelowna" is never lowercase and
    // appears capitalized mid-sentence: a place.
    expect(emitted.has("kelowna")).toBe(true);
    expect(emitted.has("community")).toBe(false);
  });

  it("the rolling baseline suppresses perennial vocabulary (§10.3)", () => {
    const corpus = [
      article("Evacuations near Kelowna ordered", "a.com"),
      article("Crews battle the Kelowna fires", "b.com"),
      article("Budget vote in Congress delayed", "a.com"),
      article("Shutdown looms as Congress stalls near Kelowna", "b.com"),
    ];
    // "kelowna" and "congress" both qualify as proper nouns, but Congress is
    // in the news EVERY day — the baseline is what makes today visible.
    const flat = scoreTerms(corpus, EMPTY_BASELINE, { now: NOW });
    const biased = scoreTerms(corpus, new Map([["congress", 5]]), { now: NOW });

    const rank = (terms: typeof flat, term: string) =>
      terms.findIndex((t) => t.term === term);
    expect(rank(biased, "kelowna")).toBeLessThan(rank(biased, "congress"));
    expect(
      biased.find((t) => t.term === "congress")!.score,
    ).toBeLessThan(flat.find((t) => t.term === "congress")!.score);
  });

  it("ranks a fresh story above an equally-covered stale one (§10.3)", () => {
    // The rolling window's whole point: two topics identical in every input
    // the frozen-day design could see — same article count, same breadth —
    // separated only by age. One broke an hour ago, one twenty hours ago.
    const corpus = [
      aged("Evacuations near Kelowna ordered", "a.com", "Crews reached Kelowna overnight.", 1),
      aged("Fires close roads by Kelowna", "b.com", "Smoke covered Kelowna by dawn.", 1),
      aged("Verdict delivered in Truro case", "a.com", "The hearing in Truro ended.", 20),
      aged("Appeal expected after Truro ruling", "b.com", "Lawyers left Truro without comment.", 20),
    ];
    const terms = scoreTerms(corpus, EMPTY_BASELINE, { now: NOW });
    const kelowna = terms.find((t) => t.term === "kelowna")!;
    const truro = terms.find((t) => t.term === "truro")!;

    expect(kelowna.score).toBeGreaterThan(truro.score);
    // The weight moves the SIZE, never the number: both are still two
    // articles, and the accessible list must be able to say so.
    expect(kelowna.dfArticles).toBe(2);
    expect(truro.dfArticles).toBe(2);
  });

  it("caps any single domain's contribution to df_articles (§10.3)", () => {
    const flood = [
      article("Advisory on Equifax issue 1", "loud.com"),
      article("Advisory on Equifax issue 2", "loud.com"),
      article("Advisory on Equifax issue 3", "loud.com"),
      article("Advisory on Equifax issue 4", "loud.com"),
      article("Advisory on Equifax issue 5", "loud.com"),
      article("Statement from Equifax today", "quiet.com"),
      article("Flooding along the Danube worsens", "a.com"),
      article("Towns by the Danube evacuate", "b.com"),
      article("Emergency declared on the Danube", "c.com"),
      article("Aid promised along the Danube", "d.com"),
    ];
    const terms = scoreTerms(flood, EMPTY_BASELINE, { now: NOW });
    const equifax = terms.find((t) => t.term === "equifax")!;
    const danube = terms.find((t) => t.term === "danube")!;

    // Six articles say "Equifax" but five are one outlet; four outlets say
    // "Danube". Displayed count stays honest; the SCORE ranks the Danube first.
    expect(equifax.dfArticles).toBe(6);
    expect(danube.score).toBeGreaterThan(equifax.score);
  });
});
