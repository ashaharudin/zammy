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
 *
 * Coverage is `(subject, provider, span)` (ADR-0019), so every case here names
 * a provider. The cases above `the provider dimension` all use one, which is
 * what a single-provider deployment looks like and is why they read the same as
 * they did before the provider existed.
 */

const TOPIC = testFingerprint("c0e0");
const OTHER = testFingerprint("07e0");

/** The only provider that has ever written topic coverage in production. */
const CURRENTS = "currents";

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
    expect(await readCoverage(harness.db, TOPIC, CURRENTS)).toEqual([]);
  });

  it("merges overlapping and adjacent spans on write", async () => {
    await recordCoverage(
      harness.db,
      TOPIC,
      CURRENTS,
      span("2026-08-08T00:00:00Z", "2026-08-08T12:00:00Z"),
    );
    await recordCoverage(
      harness.db,
      TOPIC,
      CURRENTS,
      span("2026-08-08T06:00:00Z", "2026-08-08T18:00:00Z"),
    ); // overlaps
    await recordCoverage(
      harness.db,
      TOPIC,
      CURRENTS,
      span("2026-08-08T18:00:00Z", "2026-08-09T00:00:00Z"),
    ); // adjacent

    expect(iso(await readCoverage(harness.db, TOPIC, CURRENTS))).toEqual([
      "2026-08-08T00:00:00.000Z/2026-08-09T00:00:00.000Z",
    ]);
  });

  it("keeps genuinely disjoint spans separate, ascending", async () => {
    await recordCoverage(
      harness.db,
      TOPIC,
      CURRENTS,
      span("2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z"),
    );

    expect(iso(await readCoverage(harness.db, TOPIC, CURRENTS))).toEqual([
      "2026-08-01T00:00:00.000Z/2026-08-02T00:00:00.000Z",
      "2026-08-08T00:00:00.000Z/2026-08-09T00:00:00.000Z",
    ]);
  });

  it("is idempotent — re-recording a span changes nothing", async () => {
    // A retried queue job re-records its segment; at-least-once delivery makes
    // this a certainty, not an edge case (§9.1).
    const before = await readCoverage(harness.db, TOPIC, CURRENTS);
    await recordCoverage(
      harness.db,
      TOPIC,
      CURRENTS,
      span("2026-08-08T00:00:00Z", "2026-08-09T00:00:00Z"),
    );
    expect(iso(await readCoverage(harness.db, TOPIC, CURRENTS))).toEqual(iso(before));
  });

  it("keeps topics' coverage separate", async () => {
    expect(await readCoverage(harness.db, OTHER, CURRENTS)).toEqual([]);
  });

  /**
   * The provider dimension (migration 0021, ADR-0019): coverage is
   * `(subject, provider, span)`, and both directions are scoped to it.
   *
   * The expensive failure this guards is on the READ. A blind read is exact
   * only while one provider writes; the moment a second one's rows land it
   * unions them, the gap planner subtracts a span the planned provider never
   * walked, and that span is never fetched again — a permanent gap the system
   * believes is filled, with no error, no metric and no retry (ADR-0001).
   */
  describe("the provider dimension", () => {
    it("stamps each span with the provider that recorded it", async () => {
      const { rows } = await sql<{ provider: string }>`
        select distinct provider from topic_coverage
      `.execute(harness.db);
      expect(rows.map((row) => row.provider)).toEqual(["currents"]);
    });

    it("NEVER unions two providers' spans into one answer", async () => {
      // The regression this whole change could have introduced, stated as
      // narrowly as it can be: two providers, two disjoint-and-ADJACENT spans,
      // so a union would coalesce into one wide span and read as a single
      // unbroken stretch of coverage. Each read must see its own provider's
      // day and nothing else.
      //
      // Adjacency is the point. Overlapping spans would make a union merely
      // wrong; adjacent ones make it INVISIBLE — one tidy row that looks
      // exactly like a topic properly walked end to end, which is what the
      // planner would then decline to re-fetch forever.
      await recordCoverage(
        harness.db,
        OTHER,
        "google-news",
        span("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"),
      );
      await recordCoverage(
        harness.db,
        OTHER,
        CURRENTS,
        span("2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z"),
      );

      expect(iso(await readCoverage(harness.db, OTHER, CURRENTS))).toEqual([
        "2026-09-02T00:00:00.000Z/2026-09-03T00:00:00.000Z",
      ]);
      expect(iso(await readCoverage(harness.db, OTHER, "google-news"))).toEqual([
        "2026-09-01T00:00:00.000Z/2026-09-02T00:00:00.000Z",
      ]);
      // And a provider that has never written anything holds no coverage at
      // all, rather than inheriting the others' — which is what makes "this
      // provider still has a gap" expressible.
      expect(await readCoverage(harness.db, OTHER, "gnews")).toEqual([]);

      await sql`delete from topic_coverage where fingerprint = ${hexToBytea(OTHER)}`.execute(
        harness.db,
      );
    });

    it("does not fold a foreign provider's rows into another's on write", async () => {
      // `recordCoverage`'s merge is a delete-and-rewrite. Unscoped, it would
      // take this row into the `range_agg`, coalesce it with the adjacent
      // Currents span, and write the union back stamped 'currents' — coverage
      // manufactured over a span Currents never fetched. Per-provider rows are
      // what make that claim inexpressible (ADR-0019); they only do so if the
      // writes respect them, and this write nearly did not.
      await sql`
        insert into topic_coverage (fingerprint, provider, span)
        values (${hexToBytea(OTHER)}, 'google-news',
                tstzrange('2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', '[)'))
      `.execute(harness.db);

      await recordCoverage(
        harness.db,
        OTHER,
        CURRENTS,
        span("2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z"),
      );

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

      await sql`delete from topic_coverage where fingerprint = ${hexToBytea(OTHER)}`.execute(
        harness.db,
      );
    });

    it("reads rows that predate the column, which migration 0021 defaulted", async () => {
      // Production is live and seeded, so this is about real rows: 0021 added
      // `provider NOT NULL DEFAULT 'currents'` and every row that existed had
      // in fact been fetched by Currents. An INSERT that names no provider is
      // what one of those rows looks like, and it must still be found by the
      // read the planner issues — otherwise a deployment's whole coverage
      // history vanishes at deploy time and every topic re-fetches from cold.
      await sql`
        insert into topic_coverage (fingerprint, span)
        values (${hexToBytea(OTHER)},
                tstzrange('2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', '[)'))
      `.execute(harness.db);

      expect(iso(await readCoverage(harness.db, OTHER, CURRENTS))).toEqual([
        "2026-07-01T00:00:00.000Z/2026-07-02T00:00:00.000Z",
      ]);

      await sql`delete from topic_coverage where fingerprint = ${hexToBytea(OTHER)}`.execute(
        harness.db,
      );
    });
  });
});
