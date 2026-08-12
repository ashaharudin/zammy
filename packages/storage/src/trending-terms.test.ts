import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  hourBucket,
  pruneTermSnapshots,
  readTermBaseline,
  readTrendingTerms,
  readWindowCorpus,
  recordTermSnapshot,
  refreshTermBaseline,
  replaceTrendingTerms,
} from "./trending-terms.js";
import { ingestSightings, upsertTopic } from "./ingest.js";
import { migrateToLatest } from "./migrator.js";
import {
  createTestDatabase,
  loadClimateSightings,
  testFingerprint,
  type TestDatabase,
} from "./test-support.js";

/**
 * trending_terms / term_snapshots / term_baseline (ARCHITECTURE 10.4): the
 * cloud rolls over a weighted 24-hour window (ADR-0008), so there is ONE live
 * row set per language — replaced wholesale on each recompute — and an hourly
 * snapshot history that is the baseline's only input.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
  await migrateToLatest(harness.db);
});

afterAll(async () => {
  await harness.drop();
});

const WINDOW = {
  windowStart: new Date("2026-08-12T12:00:00.000Z"),
  windowEnd: new Date("2026-08-13T12:00:00.000Z"),
};

const term = (
  t: string,
  score: number,
  overrides: Partial<{
    isBigram: boolean;
    dfArticles: number;
    dfDomains: number;
    weightedDf: number;
  }> = {},
) => ({
  term: t,
  isBigram: overrides.isBigram ?? false,
  dfArticles: overrides.dfArticles ?? 4,
  dfDomains: overrides.dfDomains ?? 2,
  weightedDf: overrides.weightedDf ?? 2.5,
  score,
});

describe("trending_terms — the live cloud (§10.4)", () => {
  it("replaces the language's cloud wholesale and reads it back by score", async () => {
    await replaceTrendingTerms(harness.db, {
      language: "en",
      ...WINDOW,
      terms: [term("stale-term", 9), term("also-stale", 5)],
    });
    await replaceTrendingTerms(harness.db, {
      language: "en",
      ...WINDOW,
      terms: [
        term("wildfire", 8),
        term("climate policy", 6, { isBigram: true }),
        term("election", 2),
      ],
    });

    const read = await readTrendingTerms(harness.db, { language: "en", limit: 2 });

    // The recompute replaced everything: no ghosts from the window before it,
    // order by score, limit honoured, bigram flag intact. There is no day key
    // to partition by — the previous cloud IS what gets replaced (ADR-0008).
    expect(read.map((t) => t.term)).toEqual(["wildfire", "climate policy"]);
    expect(read[1]!.isBigram).toBe(true);
  });

  it("keeps languages apart", async () => {
    await replaceTrendingTerms(harness.db, {
      language: "de",
      ...WINDOW,
      terms: [term("montag", 1)],
    });
    await replaceTrendingTerms(harness.db, {
      language: "en",
      ...WINDOW,
      terms: [term("monday", 1)],
    });

    const de = await readTrendingTerms(harness.db, { language: "de", limit: 50 });
    expect(de.map((t) => t.term)).toEqual(["montag"]);
    const none = await readTrendingTerms(harness.db, { language: "pt", limit: 50 });
    expect(none).toEqual([]);
  });
});

describe("readWindowCorpus (§10.1 corpus source 1)", () => {
  it("returns the window's distinct articles with their publish times", async () => {
    const fp = testFingerprint("c0d0");
    await upsertTopic(harness.db, { fingerprint: fp, keywords: ["climate"] });
    await ingestSightings(harness.db, { fingerprint: fp, sightings: loadClimateSightings() });

    // The fixture's 100 sightings collapse to 42 articles published 2026-08-01
    // through 2026-08-05 (all "en").
    const corpus = await readWindowCorpus(harness.db, {
      language: "en",
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-06T00:00:00.000Z"),
    });
    expect(corpus.length).toBe(42);
    // `published` is what the recency weight reads — the corpus read is the
    // only place it can come from (§10.3).
    for (const article of corpus) {
      expect(article.published).toBeInstanceOf(Date);
      expect(article.published.getTime()).toBeGreaterThanOrEqual(
        new Date("2026-08-01T00:00:00.000Z").getTime(),
      );
    }

    // A window that has rolled past them keeps nothing: the articles are still
    // stored and still in timelines, they are simply outside the cloud now.
    const rolledPast = await readWindowCorpus(harness.db, {
      language: "en",
      from: new Date("2026-08-06T00:00:00.000Z"),
      to: new Date("2026-08-07T00:00:00.000Z"),
    });
    expect(rolledPast).toEqual([]);
  });
});

describe("term_baseline over the snapshot history (§10.3, ADR-0008)", () => {
  const NOW = new Date("2026-08-12T12:00:00.000Z");
  const snapshot = (iso: string, terms: Array<[string, number]>, language = "fr") =>
    recordTermSnapshot(harness.db, {
      language,
      bucketHour: hourBucket(new Date(iso)),
      terms: terms.map(([t, dfArticles]) => ({ term: t, dfArticles })),
    });

  it("means over recorded snapshots only, excluding the live window", async () => {
    // Own language ("fr") so the other describes' rows cannot leak in — the
    // suite shares one database. Five snapshots inside the baseline range
    // [now-8d, now-24h): "election" runs df=7 in every one, "wildfire" spiked
    // in exactly one. That ratio is what lets a fresh wildfire outrank a
    // perennial election.
    await snapshot("2026-08-05T03:20:00Z", [["election", 7]]);
    await snapshot("2026-08-06T09:00:00Z", [["election", 7]]);
    await snapshot("2026-08-07T15:00:00Z", [["election", 7], ["wildfire", 7]]);
    await snapshot("2026-08-08T21:00:00Z", [["election", 7]]);
    await snapshot("2026-08-09T06:00:00Z", [["election", 7]]);

    // Excluded three ways: inside the live 24h window, older than the range,
    // and another language.
    await snapshot("2026-08-12T02:00:00Z", [["wildfire", 100]]);
    await snapshot("2026-08-01T00:00:00Z", [["election", 100]]);
    await snapshot("2026-08-07T15:00:00Z", [["wahl", 7]], "de");

    await refreshTermBaseline(harness.db, {
      language: "fr",
      now: NOW,
      windowHours: 24,
      baselineWindowDays: 7,
    });

    const baseline = await readTermBaseline(harness.db, "fr");
    // Divisor is snapshots RECORDED (5), not hours elapsed (168): an hour
    // nobody visited is not an observation of anything.
    expect(baseline.get("election")).toBeCloseTo(7, 5);
    expect(baseline.get("wildfire")).toBeCloseTo(7 / 5, 5);
    expect(baseline.has("wahl")).toBe(false);
  });

  it("keeps one observation per hour, however often the sampler runs", async () => {
    // Two recomputes inside one hour — routine when a reader arrives just
    // after a sample lands. The later wins; the hour does not get two votes.
    await snapshot("2026-08-06T04:05:00Z", [["ferry", 5]], "pt");
    await snapshot("2026-08-06T04:55:00Z", [["ferry", 9]], "pt");
    await snapshot("2026-08-07T04:00:00Z", [["ferry", 9]], "pt");

    await refreshTermBaseline(harness.db, {
      language: "pt",
      now: NOW,
      windowHours: 24,
      baselineWindowDays: 7,
    });

    // Two hours recorded, df 9 in each — not three observations, and not 14.
    expect((await readTermBaseline(harness.db, "pt")).get("ferry")).toBeCloseTo(9, 5);
  });

  it("prunes snapshots past the baseline's reach (§7.5)", async () => {
    await snapshot("2026-07-20T08:00:00Z", [["obsolete", 3]], "nl");
    await snapshot("2026-08-06T08:00:00Z", [["current", 3]], "nl");

    const deleted = await pruneTermSnapshots(harness.db, {
      before: new Date("2026-08-01T00:00:00.000Z"),
    });
    expect(deleted).toBe(1);

    await refreshTermBaseline(harness.db, {
      language: "nl",
      now: NOW,
      windowHours: 24,
      baselineWindowDays: 7,
    });
    const baseline = await readTermBaseline(harness.db, "nl");
    expect(baseline.has("obsolete")).toBe(false);
    expect(baseline.get("current")).toBeCloseTo(3, 5);
  });
});
