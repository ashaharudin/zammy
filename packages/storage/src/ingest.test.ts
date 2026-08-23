import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveDedupKey, type Sighting } from "@zammy/news-client";
import { hexToBytea } from "./database.js";
import { ingestSightings, upsertTopic } from "./ingest.js";
import { migrateToLatest } from "./migrator.js";
import { createProvisionalStoryline, readStorylineDays } from "./storylines.js";
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
      timeZone: "UTC",
      fingerprint: CLIMATE_TOPIC,
      sightings,
    });

    expect(result).toMatchObject({
      sightingsReceived: 100,
      sightingsInserted: 100,
      articlesCreated: 42,
    });
    // Every created article — and only those — is handed on to grouping
    // (§14.3). An article that already existed has already been offered a
    // group, and regrouping it on every re-sighting would let a group drift.
    expect(result.createdArticles).toHaveLength(42);

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
      timeZone: "UTC",
      fingerprint: CLIMATE_TOPIC,
      sightings,
    });

    expect(result).toEqual({
      sightingsReceived: 100,
      sightingsInserted: 0,
      articlesCreated: 0,
      createdArticles: [],
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
      timeZone: "UTC",
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
      timeZone: "UTC",
      fingerprint: CLIMATE_TOPIC,
      sightings: [],
    });
    expect(result).toEqual({
      sightingsReceived: 0,
      sightingsInserted: 0,
      articlesCreated: 0,
      createdArticles: [],
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
    provider: "currents",
    providerSightingId: URL,
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
      timeZone: "UTC",
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
      timeZone: "UTC",
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

/**
 * The fold moves a storyline's day slots, not just its group's position.
 *
 * `published = LEAST` (ADR-0002) means a sighting arriving later can drag an
 * article EARLIER in time, and both storyline derivations are computed over
 * member ARTICLES — so a fold that moves an article invalidates the day slots
 * of every storyline holding its group. `lowerGroupPosition` maintains the
 * group's own position on the §7.3 keyset axis and nothing else.
 *
 * Deliberately zoned, and deliberately WITHIN one UTC day: both sightings below
 * land on 2026-08-12 in UTC and on different days in Vancouver. A UTC-thinking
 * test sees nothing here, which is exactly how the gap survived.
 */
describe("a fold re-derives the day slots of the storylines holding the article", () => {
  let harness: TestDatabase;
  const TOPIC = testFingerprint("f01dab1e");
  const ZONE = "America/Vancouver";

  const emission = (input: {
    id: string;
    url: string;
    published: string;
  }): Sighting => ({
    id: input.id,
    url: input.url,
    provider: "currents",
    providerSightingId: input.url,
    dedupKey: deriveDedupKey(input.url),
    title: "Harbour spill widens",
    description: "Crews worked through the night",
    author: null,
    imageUrl: null,
    language: "en",
    categories: ["world"],
    sourceCategories: [],
    sourceDomain: "example.com",
    published: input.published,
    raw: { id: input.id, published: input.published },
  });

  const days = async (storylineId: string) =>
    (await readStorylineDays(harness.db, storylineId)).map((day) => ({
      dayKey: day.dayKey,
      published: day.daySlotPublished.toISOString(),
      lead: day.leadArticleId,
    }));

  /**
   * The change marker (migration 0017). Asserted alongside the slots because it
   * is the only witness to whether the guard FIRED: the derivation is
   * idempotent, so a re-derivation that changed nothing and no re-derivation at
   * all leave identical slots behind.
   */
  const dirtyAt = async (storylineId: string): Promise<Date | null> => {
    const row = await harness.db
      .selectFrom("storylines")
      .select("link_dirty_at")
      .where("id", "=", storylineId)
      .executeTakeFirstOrThrow();
    return row.link_dirty_at;
  };

  /** One article, from one sighting, with a storyline over its group of one. */
  const seed = async (input: {
    url: string;
    published: string;
    sightingId: string;
  }): Promise<{ articleId: string; storylineId: string }> => {
    const ingested = await ingestSightings(harness.db, {
      fingerprint: TOPIC,
      timeZone: ZONE,
      sightings: [emission({ id: input.sightingId, url: input.url, published: input.published })],
    });
    const articleId = ingested.createdArticles[0]!.id;
    const storyline = await createProvisionalStoryline(harness.db, {
      groupId: articleId,
      timeZone: ZONE,
    });
    return { articleId, storylineId: storyline.id };
  };

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
    await upsertTopic(harness.db, { fingerprint: TOPIC, keywords: ["spill"] });
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("moves the slot onto the day the fold moved the article to", async () => {
    // 18:00Z on the 12th is 11:00 on the 12th in Vancouver; 05:00Z on the 12th
    // is 22:00 on the ELEVENTH. Folding the later-arriving, earlier-published
    // sighting therefore moves the article across an APP_TIMEZONE midnight —
    // and the storyline has no slot for the day it landed on. Left unrefreshed,
    // the timeline pages over `storyline_days` and that day's coverage is
    // invisible to a reader until a merge or a --restart backfill rebuilds it.
    const url = "https://example.com/spill-across-midnight";
    const { articleId, storylineId } = await seed({
      url,
      published: "2026-08-12T18:00:00.000Z",
      sightingId: "00000000-0000-4000-8000-00000000f01d",
    });

    expect(await days(storylineId)).toEqual([
      { dayKey: "2026-08-12", published: "2026-08-12T18:00:00.000Z", lead: articleId },
    ]);
    expect(await dirtyAt(storylineId)).toBeNull();

    await ingestSightings(harness.db, {
      fingerprint: TOPIC,
      timeZone: ZONE,
      sightings: [
        emission({
          id: "00000000-0000-4000-8000-00000000f01e",
          url,
          published: "2026-08-12T05:00:00.000Z",
        }),
      ],
    });

    const article = await harness.db
      .selectFrom("articles")
      .select(["published", "group_published"])
      .where("id", "=", articleId)
      .executeTakeFirstOrThrow();
    expect(article.published.toISOString()).toBe("2026-08-12T05:00:00.000Z");
    expect(article.group_published?.toISOString()).toBe("2026-08-12T05:00:00.000Z");

    // The whole storyline is re-derived, so the day it LEFT goes too: a slot is
    // a day its member groups have an article on, and after the fold no member
    // article is on the twelfth.
    expect(await days(storylineId)).toEqual([
      { dayKey: "2026-08-11", published: "2026-08-12T05:00:00.000Z", lead: articleId },
    ]);
    // Re-derived, therefore re-offered: the nightly sweep's changed-set filter
    // pages over this marker, and an arc missing from it is an arc the filtered
    // pass never asks about.
    expect(await dirtyAt(storylineId)).not.toBeNull();
  });

  it("lowers the slot's position when the fold stays inside the day", async () => {
    // The same staleness one notch smaller, and the same cause: a slot IS its
    // day's earliest article, so a fold that moves the article earlier without
    // crossing midnight leaves the slot sitting later on the §7.3 keyset axis
    // than the coverage it represents. The reader sees the day in the wrong
    // place rather than not at all.
    const url = "https://example.com/spill-within-the-day";
    const { articleId, storylineId } = await seed({
      url,
      published: "2026-08-13T20:00:00.000Z",
      sightingId: "00000000-0000-4000-8000-00000000f02d",
    });

    await ingestSightings(harness.db, {
      fingerprint: TOPIC,
      timeZone: ZONE,
      sightings: [
        emission({
          id: "00000000-0000-4000-8000-00000000f02e",
          url,
          published: "2026-08-13T16:00:00.000Z",
        }),
      ],
    });

    expect(await days(storylineId)).toEqual([
      { dayKey: "2026-08-13", published: "2026-08-13T16:00:00.000Z", lead: articleId },
    ]);
  });

  it("a fold that moves nothing leaves the slots alone", async () => {
    // The guard's other side: the overwhelmingly common fold is a re-emission
    // no earlier than what is stored, and it must not spend a storyline
    // re-derivation. Asserted on the OUTCOME rather than on the absence of a
    // query — the derivation is idempotent, so only the slot itself can say
    // the late sighting was not mistaken for a move.
    const url = "https://example.com/spill-re-emitted";
    const { articleId, storylineId } = await seed({
      url,
      published: "2026-08-14T09:00:00.000Z",
      sightingId: "00000000-0000-4000-8000-00000000f03d",
    });

    await ingestSightings(harness.db, {
      fingerprint: TOPIC,
      timeZone: ZONE,
      sightings: [
        emission({
          id: "00000000-0000-4000-8000-00000000f03e",
          url,
          published: "2026-08-14T23:00:00.000Z",
        }),
      ],
    });

    expect(await days(storylineId)).toEqual([
      { dayKey: "2026-08-14", published: "2026-08-14T09:00:00.000Z", lead: articleId },
    ]);
    expect(await dirtyAt(storylineId)).toBeNull();
  });
});
