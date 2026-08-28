import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { readCoverage, recordCoverage } from "./coverage.js";
import { upsertTopic } from "./ingest.js";
import { migrateToLatest } from "./migrator.js";
import { createTestDatabase, testFingerprint, type TestDatabase } from "./test-support.js";
import { hexToBytea } from "./database.js";

/**
 * topic_coverage (ARCHITECTURE 7.2) — what separates "nothing was published
 * then" from "we never asked". Spans merge on write so the table stays small
 * and the gap subtraction upstairs sees clean disjoint ranges.
 */

const TOPIC = testFingerprint("c0e0");
const OTHER = testFingerprint("07e0");

const span = (from: string, to: string) => ({ from: new Date(from), to: new Date(to) });
const iso = (spans: Array<{ from: Date; to: Date }>) =>
  spans.map((s) => `${s.from.toISOString()}/${s.to.toISOString()}`);

describe("coverage recording", () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
    await upsertTopic(harness.db, { fingerprint: TOPIC, keywords: ["a"] });
    await upsertTopic(harness.db, { fingerprint: OTHER, keywords: ["b"] });
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("starts empty", async () => {
    expect(await readCoverage(harness.db, TOPIC)).toEqual([]);
  });

  it("merges overlapping and adjacent spans on write", async () => {
    await recordCoverage(harness.db, TOPIC, span("2026-08-08T00:00:00Z", "2026-08-08T12:00:00Z"));
    await recordCoverage(harness.db, TOPIC, span("2026-08-08T06:00:00Z", "2026-08-08T18:00:00Z")); // overlaps
    await recordCoverage(harness.db, TOPIC, span("2026-08-08T18:00:00Z", "2026-08-09T00:00:00Z")); // adjacent

    expect(iso(await readCoverage(harness.db, TOPIC))).toEqual([
      "2026-08-08T00:00:00.000Z/2026-08-09T00:00:00.000Z",
    ]);
  });

  it("keeps genuinely disjoint spans separate, ascending", async () => {
    await recordCoverage(harness.db, TOPIC, span("2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z"));

    expect(iso(await readCoverage(harness.db, TOPIC))).toEqual([
      "2026-08-01T00:00:00.000Z/2026-08-02T00:00:00.000Z",
      "2026-08-08T00:00:00.000Z/2026-08-09T00:00:00.000Z",
    ]);
  });

  it("is idempotent — re-recording a span changes nothing", async () => {
    // A retried queue job re-records its segment; at-least-once delivery makes
    // this a certainty, not an edge case (§9.1).
    const before = await readCoverage(harness.db, TOPIC);
    await recordCoverage(harness.db, TOPIC, span("2026-08-08T00:00:00Z", "2026-08-09T00:00:00Z"));
    expect(iso(await readCoverage(harness.db, TOPIC))).toEqual(iso(before));
  });

  it("keeps topics' coverage separate", async () => {
    expect(await readCoverage(harness.db, OTHER)).toEqual([]);
  });

  /**
   * The provider column (migration 0021), and the decision that the reads above
   * do not filter on it. These pin the state the decision rests on rather than
   * new behaviour — every assertion above is unchanged by 0021, which is the
   * evidence that the read path is untouched.
   */
  describe("the provider column", () => {
    it("stamps every span Currents records", async () => {
      // The premise `readCoverage` being provider-blind depends on: Currents is
      // the only caller wired to write topic coverage today, so a blind read is
      // exact. Under ADR-0019 that is a fact about what exists rather than a
      // rule — Google News writes here too from G5 — which is why the module
      // header treats the blind read as sequencing and not as a position.
      const { rows } = await sql<{ provider: string }>`
        select distinct provider from topic_coverage
      `.execute(harness.db);
      expect(rows.map((row) => row.provider)).toEqual(["currents"]);
    });

    it("does not fold a foreign provider's rows into Currents' on write", async () => {
      // `recordCoverage`'s merge is a delete-and-rewrite. Unscoped, it would
      // take this row into the `range_agg`, coalesce it with the adjacent
      // Currents span, and write the union back stamped 'currents' — coverage
      // manufactured over a span Currents never fetched. Per-provider rows are
      // what make that claim inexpressible (ADR-0019); they only do so if the
      // writes respect them, and this write nearly did not.
      //
      // Nothing writes a row like this today; that is why it is inserted by
      // hand. The predicate is here so the write is already correct on the day
      // something does.
      await sql`
        insert into topic_coverage (fingerprint, provider, span)
        values (${hexToBytea(OTHER)}, 'google-news',
                tstzrange('2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', '[)'))
      `.execute(harness.db);

      await recordCoverage(harness.db, OTHER, span("2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z"));

      const { rows } = await sql<{ provider: string; from: Date; to: Date }>`
        select provider, lower(span) as "from", upper(span) as "to"
          from topic_coverage where fingerprint = ${hexToBytea(OTHER)}
         order by provider
      `.execute(harness.db);

      expect(
        rows.map((row) => `${row.provider} ${row.from.toISOString()}/${row.to.toISOString()}`),
      ).toEqual([
        "currents 2026-09-02T00:00:00.000Z/2026-09-03T00:00:00.000Z",
        "google-news 2026-09-01T00:00:00.000Z/2026-09-02T00:00:00.000Z",
      ]);

      // And the read stays blind, which is the documented consequence rather
      // than an oversight: it returns BOTH providers' spans as one list — the
      // single answer ADR-0019 says this question no longer has. Safe only while
      // nothing writes a row like the one above; `coverage.ts` names the four
      // things that change together in G5, when something does.
      expect(iso(await readCoverage(harness.db, OTHER))).toEqual([
        "2026-09-01T00:00:00.000Z/2026-09-02T00:00:00.000Z",
        "2026-09-02T00:00:00.000Z/2026-09-03T00:00:00.000Z",
      ]);

      await sql`delete from topic_coverage where fingerprint = ${hexToBytea(OTHER)}`.execute(
        harness.db,
      );
    });
  });
});
