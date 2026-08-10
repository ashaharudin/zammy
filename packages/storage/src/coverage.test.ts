import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCoverage, recordCoverage } from "./coverage.js";
import { upsertTopic } from "./ingest.js";
import { migrateToLatest } from "./migrator.js";
import { createTestDatabase, testFingerprint, type TestDatabase } from "./test-support.js";

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
});
