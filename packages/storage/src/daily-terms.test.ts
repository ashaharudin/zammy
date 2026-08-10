import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readDailyTerms,
  readDayCorpus,
  readTermBaseline,
  refreshTermBaseline,
  replaceDailyTerms,
} from "./daily-terms.js";
import { ingestSightings, upsertTopic } from "./ingest.js";
import { migrateToLatest } from "./migrator.js";
import {
  createTestDatabase,
  loadClimateSightings,
  testFingerprint,
  type TestDatabase,
} from "./test-support.js";

/**
 * daily_terms / term_baseline (ARCHITECTURE 10.4): the cloud's aggregate is
 * recomputed on each sample — a day's rows are REPLACED, not appended — and
 * the baseline is a trailing mean per term, the suppressor that makes the
 * cloud show today rather than news in general (§10.3).
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
  await migrateToLatest(harness.db);
});

afterAll(async () => {
  await harness.drop();
});

const term = (
  t: string,
  score: number,
  overrides: Partial<{ isBigram: boolean; dfArticles: number; dfDomains: number }> = {},
) => ({
  term: t,
  isBigram: overrides.isBigram ?? false,
  dfArticles: overrides.dfArticles ?? 4,
  dfDomains: overrides.dfDomains ?? 2,
  score,
});

describe("replaceDailyTerms / readDailyTerms", () => {
  it("replaces the day's aggregate wholesale and reads it back by score", async () => {
    const day = "2026-08-01";
    await replaceDailyTerms(harness.db, {
      day,
      language: "en",
      terms: [term("stale-term", 9), term("also-stale", 5)],
    });
    await replaceDailyTerms(harness.db, {
      day,
      language: "en",
      terms: [term("wildfire", 8), term("climate policy", 6, { isBigram: true }), term("election", 2)],
    });

    const read = await readDailyTerms(harness.db, { day, language: "en", limit: 2 });

    // The recompute replaced everything: no stale-term ghosts, order by
    // score, limit honoured, bigram flag intact.
    expect(read.map((t) => t.term)).toEqual(["wildfire", "climate policy"]);
    expect(read[1]!.isBigram).toBe(true);
  });

  it("keeps days and languages apart", async () => {
    await replaceDailyTerms(harness.db, {
      day: "2026-08-02",
      language: "en",
      terms: [term("monday", 1)],
    });
    await replaceDailyTerms(harness.db, {
      day: "2026-08-02",
      language: "de",
      terms: [term("montag", 1)],
    });

    const en = await readDailyTerms(harness.db, { day: "2026-08-02", language: "en", limit: 50 });
    expect(en.map((t) => t.term)).toEqual(["monday"]);
    const empty = await readDailyTerms(harness.db, { day: "2026-08-03", language: "en", limit: 50 });
    expect(empty).toEqual([]);
  });
});

describe("term_baseline (§10.3 — the rolling suppressor)", () => {
  it("refreshes to the trailing mean over the window, absent days counting zero", async () => {
    // Own language ("fr") so the other describes' rows cannot leak in — the
    // suite shares one database. "election" runs df=7 on every one of the 7
    // trailing days; "wildfire" spiked once. The baseline must say
    // election≈7, wildfire≈1 — that ratio is exactly what lets a fresh
    // wildfire outrank a perennial election.
    for (let i = 1; i <= 7; i += 1) {
      const day = `2026-07-${String(24 + i).padStart(2, "0")}`; // 25..31
      await replaceDailyTerms(harness.db, {
        day,
        language: "fr",
        terms: [
          term("election", 1, { dfArticles: 7 }),
          ...(i === 4 ? [term("wildfire", 1, { dfArticles: 7 })] : []),
        ],
      });
    }
    await replaceDailyTerms(harness.db, {
      day: "2026-07-28",
      language: "de",
      terms: [term("wahl", 1, { dfArticles: 7 })],
    });

    await refreshTermBaseline(harness.db, {
      language: "fr",
      upToDay: "2026-08-01",
      windowDays: 7,
    });

    const baseline = await readTermBaseline(harness.db, "fr");
    expect(baseline.get("election")).toBeCloseTo(7, 5);
    expect(baseline.get("wildfire")).toBeCloseTo(1, 5);
    expect(baseline.has("wahl")).toBe(false); // other language

    // Rolling forward replaces rather than accumulating.
    await refreshTermBaseline(harness.db, {
      language: "fr",
      upToDay: "2026-08-02",
      windowDays: 7,
    });
    const rolled = await readTermBaseline(harness.db, "fr");
    expect(rolled.get("election")).toBeCloseTo(6, 5); // 07-25 fell out of the window
  });
});

describe("readDayCorpus", () => {
  it("returns the day's distinct articles for a language, ready for the scorer", async () => {
    const fp = testFingerprint("c0d0");
    await upsertTopic(harness.db, { fingerprint: fp, keywords: ["climate"] });
    const sightings = loadClimateSightings();
    await ingestSightings(harness.db, { fingerprint: fp, sightings });

    // The fixture's 100 sightings collapse to 42 articles published 2026-08-01
    // through 2026-08-05 (all "en").
    const corpus = await readDayCorpus(harness.db, {
      language: "en",
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-06T00:00:00.000Z"),
    });
    expect(corpus.length).toBe(42);
    expect(corpus[0]).toHaveProperty("title");
    expect(corpus[0]).toHaveProperty("sourceDomain");

    const none = await readDayCorpus(harness.db, {
      language: "en",
      from: new Date("2026-08-06T00:00:00.000Z"),
      to: new Date("2026-08-07T00:00:00.000Z"),
    });
    expect(none).toEqual([]);
  });
});
