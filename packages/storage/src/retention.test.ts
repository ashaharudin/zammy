import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hexToBytea } from "./database.js";
import { ingestSightings, upsertTopic } from "./ingest.js";
import { migrateToLatest } from "./migrator.js";
import { retentionReport } from "./retention.js";
import {
  createTestDatabase,
  loadClimateSightings,
  testFingerprint,
  type TestDatabase,
} from "./test-support.js";

/**
 * Retention (ARCHITECTURE 7.5): a nightly job REPORTS articles (and their
 * sightings) past RETENTION_DAYS that belong to no recently-hit topic, plus
 * idle topics. It never deletes — beyond the 30-day upstream lookback our
 * store is the only copy, and a wrong prune is unrecoverable (ADR-0001).
 */

const NOW = new Date("2026-08-10T03:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const ACTIVE = testFingerprint("aaaa");
const IDLE = testFingerprint("bbbb");

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
  const { db } = harness;
  await migrateToLatest(db);

  // Real recorded sightings; the repeated link-roundup URL gives an article
  // with more than one sighting, so the sighting count is a real count.
  const sightings = loadClimateSightings();
  const byUrl = new Map<string, typeof sightings>();
  for (const s of sightings) {
    byUrl.set(s.url, [...(byUrl.get(s.url) ?? []), s]);
  }
  const urls = [...byUrl.entries()];
  const repeated = urls.find(([, group]) => group.length >= 2)!;
  const singles = urls.filter(([, group]) => group.length === 1);

  const shared = singles[0]![1]![0]!; // in BOTH topics → protected by the active one
  const oldIdle = repeated[1].slice(0, 2); // only in the idle topic, ancient → candidate
  const youngIdle = singles[1]![1]![0]!; // only in the idle topic, recent → kept

  await upsertTopic(db, { fingerprint: ACTIVE, keywords: ["climate"] });
  await upsertTopic(db, { fingerprint: IDLE, keywords: ["climate", "policy"] });

  await ingestSightings(db, { timeZone: "UTC", fingerprint: ACTIVE, sightings: [shared] });
  await ingestSightings(db, {
    timeZone: "UTC",
    fingerprint: IDLE,
    sightings: [shared, ...oldIdle, youngIdle],
  });

  // Shape the ages: everything ancient except the young article.
  await db
    .updateTable("articles")
    .set({ published: new Date(NOW.getTime() - 100 * DAY) })
    .execute();
  await db
    .updateTable("articles")
    .set({ published: new Date(NOW.getTime() - 10 * DAY) })
    .where("url", "=", youngIdle.url)
    .execute();
  await db
    .updateTable("topics")
    .set({ last_hit_at: new Date(NOW.getTime() - 40 * DAY) })
    .where("fingerprint", "=", hexToBytea(IDLE))
    .execute();
});

afterAll(async () => {
  await harness.drop();
});

describe("retentionReport", () => {
  it("reports old articles in idle topics only, with their sightings, and the idle topics", async () => {
    const report = await retentionReport(harness.db, {
      retentionDays: 90,
      topicIdleDays: 30,
      now: NOW,
    });

    // The shared article is 100 days old but the ACTIVE topic still hits it;
    // the young article is in the idle topic but inside the window. Only the
    // ancient idle-only article — with BOTH its sightings — is reportable.
    expect(report.articleCandidates).toBe(1);
    expect(report.sightingCandidates).toBe(2);
    expect(report.idleTopics).toEqual([IDLE]);
  });

  it("reports nothing when every topic is recently hit", async () => {
    const report = await retentionReport(harness.db, {
      retentionDays: 90,
      topicIdleDays: 60, // wide enough that the 40-day-idle topic counts as hit
      now: NOW,
    });

    expect(report.articleCandidates).toBe(0);
    expect(report.sightingCandidates).toBe(0);
    expect(report.idleTopics).toEqual([]);
  });
});
