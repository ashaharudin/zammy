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

const FIXTURE = new URL(
  "../../../fixtures/search-keywordless-category-sample.json",
  import.meta.url,
).pathname;

function loadCorpus(): CorpusArticle[] {
  const data = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
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
    });
  }
  return [...byUrl.values()];
}

const EMPTY_BASELINE = new Map<string, number>();

describe("scoreTerms against the recorded keywordless sample (§10.3)", () => {
  const corpus = loadCorpus();

  // §10.3's three probe-demonstrated failures, asserted on the DAY-ONE
  // configuration — empty baseline — because that is when scoring degrades
  // to raw frequency and only the structural gates stand between the cloud
  // and the garbage top-12 the probe recorded.
  const top50 = scoreTerms(corpus, EMPTY_BASELINE).slice(0, 50);

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

    // The named entities that made the old output credible must remain.
    expect(emitted.has("trump")).toBe(true);
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

describe("scoring mechanisms in isolation", () => {
  const article = (
    title: string,
    domain: string,
    description: string | null = null,
  ): CorpusArticle => ({ title, description, sourceDomain: domain });

  it("bigrams are terms of their own — and generic words survive ONLY inside them", () => {
    const corpus = [
      article("Climate policy shift announced", "a.com"),
      article("New climate policy criticised", "b.com"),
    ];
    const terms = scoreTerms(corpus, EMPTY_BASELINE);
    const bigram = terms.find((t) => t.term === "climate policy");
    expect(bigram).toBeDefined();
    expect(bigram!.isBigram).toBe(true);
    expect(bigram!.dfArticles).toBe(2);

    // "climate" and "policy" are common nouns (seen lowercase in running
    // text): as unigrams they are noise, as a phrase they are a topic.
    const emitted = new Set(terms.map((t) => t.term));
    expect(emitted.has("climate")).toBe(false);
    expect(emitted.has("policy")).toBe(false);
  });

  it("proper nouns qualify by mid-sentence capitalization, not by Title Case", () => {
    const corpus = [
      article("Community Rallies Around Kelowna", "a.com", "The community gathered in Kelowna."),
      article("Community Fund Launched In Kelowna", "b.com", "A fund for the community near Kelowna."),
    ];
    const emitted = new Set(scoreTerms(corpus, EMPTY_BASELINE).map((t) => t.term));

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
    const flat = scoreTerms(corpus, EMPTY_BASELINE);
    const biased = scoreTerms(corpus, new Map([["congress", 5]]));

    const rank = (terms: typeof flat, term: string) =>
      terms.findIndex((t) => t.term === term);
    expect(rank(biased, "kelowna")).toBeLessThan(rank(biased, "congress"));
    expect(
      biased.find((t) => t.term === "congress")!.score,
    ).toBeLessThan(flat.find((t) => t.term === "congress")!.score);
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
    const terms = scoreTerms(flood, EMPTY_BASELINE);
    const equifax = terms.find((t) => t.term === "equifax")!;
    const danube = terms.find((t) => t.term === "danube")!;

    // Six articles say "Equifax" but five are one outlet; four outlets say
    // "Danube". Displayed count stays honest; the SCORE ranks the Danube first.
    expect(equifax.dfArticles).toBe(6);
    expect(danube.score).toBeGreaterThan(equifax.score);
  });
});
