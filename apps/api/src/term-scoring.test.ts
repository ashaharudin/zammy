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

  it("bigrams are terms of their own", () => {
    const corpus = [
      article("Climate policy shift announced", "a.com"),
      article("New climate policy criticised", "b.com"),
    ];
    const terms = scoreTerms(corpus, EMPTY_BASELINE);
    const bigram = terms.find((t) => t.term === "climate policy");
    expect(bigram).toBeDefined();
    expect(bigram!.isBigram).toBe(true);
    expect(bigram!.dfArticles).toBe(2);
  });

  it("the rolling baseline suppresses perennial vocabulary (§10.3)", () => {
    const corpus = [
      article("Wildfire evacuation ordered", "a.com"),
      article("Wildfire spreads north", "b.com"),
      article("Election evacuation debate", "a.com"),
      article("Election results contested wildfire", "b.com"),
    ];
    // "wildfire" and "election" have similar frequency today, but "election"
    // is like this EVERY day — the baseline is what makes today visible.
    const flat = scoreTerms(corpus, EMPTY_BASELINE);
    const biased = scoreTerms(corpus, new Map([["election", 5]]));

    const rank = (terms: typeof flat, term: string) =>
      terms.findIndex((t) => t.term === term);
    expect(rank(biased, "wildfire")).toBeLessThan(rank(biased, "election"));
    expect(
      biased.find((t) => t.term === "election")!.score,
    ).toBeLessThan(flat.find((t) => t.term === "election")!.score);
  });

  it("caps any single domain's contribution to df_articles (§10.3)", () => {
    const flood = [
      article("Breach breach update 1", "loud.com"),
      article("Breach breach update 2", "loud.com"),
      article("Breach breach update 3", "loud.com"),
      article("Breach breach update 4", "loud.com"),
      article("Breach breach update 5", "loud.com"),
      article("Breach also here", "quiet.com"),
      article("Drought hits farms", "a.com"),
      article("Drought worsens", "b.com"),
      article("Drought emergency declared", "c.com"),
      article("Drought aid promised", "d.com"),
    ];
    const terms = scoreTerms(flood, EMPTY_BASELINE);
    const breach = terms.find((t) => t.term === "breach")!;
    const drought = terms.find((t) => t.term === "drought")!;

    // Six articles say "breach" but five are one outlet; four outlets say
    // "drought". Displayed count stays honest; the SCORE ranks drought first.
    expect(breach.dfArticles).toBe(6);
    expect(drought.score).toBeGreaterThan(breach.score);
  });
});
