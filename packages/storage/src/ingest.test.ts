import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveDedupKey, type Sighting } from "@zammy/currents-client";
import { hexToBytea } from "./database.js";
import { ingestSightings, upsertTopic } from "./ingest.js";
import { migrateToLatest } from "./migrator.js";
import {
  createTestDatabase,
  loadClimateSightings,
  testFingerprint,
  type TestDatabase,
} from "./test-support.js";

/**
 * The sighting→article collapse (ARCHITECTURE 7.4, ADR-0002), tested against the
 * recorded duplication payload: 100 sightings, 42 unique URLs, one link-roundup
 * page appearing 50 times. Untreated, over half the timeline is one repeated
 * post — this is the regression the fixture exists to guard.
 *
 * Expected counts (100, 42, 50) come from the probe, not from re-deriving them
 * here — PROBE-FINDINGS 4 is the independent source of truth.
 */

const CLIMATE_TOPIC = testFingerprint("c11a1e");
const SECOND_TOPIC = testFingerprint("5ec0d0");

describe("the collapse over the recorded duplication payload", () => {
  let harness: TestDatabase;
  let sightings: Sighting[];
  /** dedup key of the link-roundup page that upstream emitted 50 times. */
  let roundupKey: string;

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
    sightings = loadClimateSightings();

    const byKey = new Map<string, number>();
    for (const sighting of sightings) {
      byKey.set(sighting.dedupKey, (byKey.get(sighting.dedupKey) ?? 0) + 1);
    }
    roundupKey = [...byKey.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];

    await upsertTopic(harness.db, {
      fingerprint: CLIMATE_TOPIC,
      keywords: ["climate"],
      language: "en",
    });
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("collapses 100 sightings into 42 articles", async () => {
    const result = await ingestSightings(harness.db, {
      fingerprint: CLIMATE_TOPIC,
      sightings,
    });

    expect(result).toEqual({
      sightingsReceived: 100,
      sightingsInserted: 100,
      articlesCreated: 42,
    });

    const [sightingRows, articleRows] = await Promise.all([
      harness.db.selectFrom("sightings").select(({ fn }) => fn.countAll().as("n")).executeTakeFirstOrThrow(),
      harness.db.selectFrom("articles").select(({ fn }) => fn.countAll().as("n")).executeTakeFirstOrThrow(),
    ]);
    expect(Number(sightingRows.n)).toBe(100);
    expect(Number(articleRows.n)).toBe(42);
  });

  it("gives the 50×-emitted roundup page a sighting_count of 50", async () => {
    const roundup = await harness.db
      .selectFrom("articles")
      .selectAll()
      .where("dedup_key", "=", hexToBytea(roundupKey))
      .executeTakeFirstOrThrow();

    expect(roundup.sighting_count).toBe(50);
  });

  it("positions the roundup at its EARLIEST sighting and tracks the latest", async () => {
    // A chronology places a story when it appeared; latest_seen feeds the
    // "updated <relative>" badge (ADR-0002). Expected bounds are recomputed
    // from the input with plain Math.min/max — independent of the SQL
    // LEAST/GREATEST arithmetic under test.
    const emissions = sightings.filter((s) => s.dedupKey === roundupKey);
    const times = emissions.map((s) => Date.parse(s.published));

    const roundup = await harness.db
      .selectFrom("articles")
      .selectAll()
      .where("dedup_key", "=", hexToBytea(roundupKey))
      .executeTakeFirstOrThrow();

    expect(roundup.published.getTime()).toBe(Math.min(...times));
    expect(roundup.latest_seen.getTime()).toBe(Math.max(...times));
  });

  it("re-ingesting the same payload changes nothing", async () => {
    // Every fetch must be safely repeatable — this is what lets the worker and
    // a user request race harmlessly (§7.4). Seeing the same upstream UUID
    // twice must not inflate sighting_count.
    const result = await ingestSightings(harness.db, {
      fingerprint: CLIMATE_TOPIC,
      sightings,
    });

    expect(result).toEqual({
      sightingsReceived: 100,
      sightingsInserted: 0,
      articlesCreated: 0,
    });

    const roundup = await harness.db
      .selectFrom("articles")
      .selectAll()
      .where("dedup_key", "=", hexToBytea(roundupKey))
      .executeTakeFirstOrThrow();
    expect(roundup.sighting_count).toBe(50);

    const articleRows = await harness.db
      .selectFrom("articles")
      .select(({ fn }) => fn.countAll().as("n"))
      .executeTakeFirstOrThrow();
    expect(Number(articleRows.n)).toBe(42);
  });

  it("records topic membership per article, not per sighting", async () => {
    const links = await harness.db
      .selectFrom("topic_articles")
      .select(({ fn }) => fn.countAll().as("n"))
      .where("fingerprint", "=", hexToBytea(CLIMATE_TOPIC))
      .executeTakeFirstOrThrow();

    expect(Number(links.n)).toBe(42);
  });

  it("links a second topic to existing articles without duplicating them", async () => {
    // User A pays, user B doesn't — and a different topic surfacing the same
    // stories must share the article rows, not mint new ones (§9.1).
    await upsertTopic(harness.db, {
      fingerprint: SECOND_TOPIC,
      keywords: ["climate", "policy"],
      language: "en",
    });

    const result = await ingestSightings(harness.db, {
      fingerprint: SECOND_TOPIC,
      sightings: sightings.slice(0, 10),
    });
    expect(result.articlesCreated).toBe(0);
    expect(result.sightingsInserted).toBe(0);

    const links = await harness.db
      .selectFrom("topic_articles")
      .select(({ fn }) => fn.countAll().as("n"))
      .where("fingerprint", "=", hexToBytea(SECOND_TOPIC))
      .executeTakeFirstOrThrow();
    expect(Number(links.n)).toBeGreaterThan(0);

    const articleRows = await harness.db
      .selectFrom("articles")
      .select(({ fn }) => fn.countAll().as("n"))
      .executeTakeFirstOrThrow();
    expect(Number(articleRows.n)).toBe(42);
  });

  it("ingesting nothing is a no-op", async () => {
    const result = await ingestSightings(harness.db, {
      fingerprint: CLIMATE_TOPIC,
      sightings: [],
    });
    expect(result).toEqual({
      sightingsReceived: 0,
      sightingsInserted: 0,
      articlesCreated: 0,
    });
  });
});

describe("the earliest sighting owns the display fields", () => {
  let harness: TestDatabase;
  const TOPIC = testFingerprint("ea111e57");
  const URL = "https://example.com/story";

  const emission = (id: string, published: string, title: string): Sighting => ({
    id,
    url: URL,
    dedupKey: deriveDedupKey(URL),
    title,
    description: `${title} description`,
    author: null,
    imageUrl: null,
    language: "en",
    categories: ["world"],
    sourceCategories: [],
    sourceDomain: "example.com",
    published,
    raw: { id, published },
  });

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
    await upsertTopic(harness.db, { fingerprint: TOPIC, keywords: ["story"] });
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("keeps the earliest emission's headline even when it arrives later", async () => {
    // Upstream returns newest-first, so within one batch the EARLIEST emission
    // of a story arrives LAST. A later re-emission must not rewrite the
    // headline (§7.4) — display fields follow the earliest sighting.
    await ingestSightings(harness.db, {
      fingerprint: TOPIC,
      sightings: [
        emission("00000000-0000-4000-8000-000000000002", "2026-08-04T12:00:00.000Z", "Rewritten headline"),
        emission("00000000-0000-4000-8000-000000000001", "2026-08-04T08:00:00.000Z", "Original headline"),
      ],
    });

    const article = await harness.db
      .selectFrom("articles")
      .selectAll()
      .where("url", "=", URL)
      .executeTakeFirstOrThrow();

    expect(article.title).toBe("Original headline");
    expect(article.description).toBe("Original headline description");
    expect(article.published.toISOString()).toBe("2026-08-04T08:00:00.000Z");
    expect(article.latest_seen.toISOString()).toBe("2026-08-04T12:00:00.000Z");
    expect(article.sighting_count).toBe(2);
  });

  it("an even earlier emission in a later fetch takes over the display fields", async () => {
    await ingestSightings(harness.db, {
      fingerprint: TOPIC,
      sightings: [
        emission("00000000-0000-4000-8000-000000000003", "2026-08-04T06:00:00.000Z", "First headline of all"),
      ],
    });

    const article = await harness.db
      .selectFrom("articles")
      .selectAll()
      .where("url", "=", URL)
      .executeTakeFirstOrThrow();

    expect(article.title).toBe("First headline of all");
    expect(article.published.toISOString()).toBe("2026-08-04T06:00:00.000Z");
    expect(article.latest_seen.toISOString()).toBe("2026-08-04T12:00:00.000Z");
    expect(article.sighting_count).toBe(3);
  });
});

describe("upsertTopic", () => {
  let harness: TestDatabase;
  const TOPIC = testFingerprint("70f1c");

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("creates the topic on first sight and counts hits on every one after", async () => {
    await upsertTopic(harness.db, {
      fingerprint: TOPIC,
      keywords: ["climate", "policy"],
      language: "en",
    });
    await upsertTopic(harness.db, {
      fingerprint: TOPIC,
      keywords: ["climate", "policy"],
      language: "en",
    });

    const topic = await harness.db
      .selectFrom("topics")
      .selectAll()
      .where("fingerprint", "=", hexToBytea(TOPIC))
      .executeTakeFirstOrThrow();

    expect(topic.keywords).toEqual(["climate", "policy"]);
    expect(Number(topic.hit_count)).toBe(2);
    expect(topic.last_hit_at.getTime()).toBeGreaterThanOrEqual(topic.created_at.getTime());
  });
});
