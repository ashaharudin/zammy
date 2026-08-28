import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { deriveAltKey, deriveDedupKey, type Sighting } from "@zammy/news-client";
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
 *
 * **42 URLs, 41 articles** since ADR-0018. The gap is the fallback key catching
 * a duplicate the URL cannot, and it is the SAME pair ADR-0002 measured and
 * declined: "42 unique URLs against 41 unique title+source pairs, so it would
 * merge exactly one pair — no evidence, and a false merge is worse than a
 * visible duplicate". The evidence is now in hand, and it is in this fixture.
 * The pair is one Times of India blog post, "First-World Flames", emitted 15
 * seconds apart under two section paths:
 *
 *     /blogs/gen-zedits/first-world-flames-2
 *     /blogs/toi-edit-page/first-world-flames
 *
 * Same domain, same headline, same opening sentence — a section-path duplicate
 * of exactly the `ansa.it` and `rte.ie` class the production measurement found
 * 411 of. So ADR-0002's caution was right and its conclusion has expired.
 *
 * Both numbers are asserted below, and deliberately: 42 distinct `dedup_key`s
 * still proves canonicalization neither over- nor under-collapses (the original
 * guard, unchanged), and 41 `articles` proves the fallback key caught the one
 * thing the URL could not. A future change that moved 42 would be a
 * canonicalization regression; one that moved 41 would be an alt-key regression.
 * Kept apart, they say which.
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

  it("collapses 100 sightings into 41 articles", async () => {
    // 42 distinct URLs go in; 41 rows come out. The header explains which pair
    // merged and why the evidence for merging it is now good enough.
    expect(new Set(sightings.map((s) => s.dedupKey)).size).toBe(42);

    const result = await ingestSightings(harness.db, {
      plane: "search",
      timeZone: "UTC",
      fingerprint: CLIMATE_TOPIC,
      sightings,
    });

    expect(result).toMatchObject({
      sightingsReceived: 100,
      sightingsInserted: 100,
      articlesCreated: 41,
    });
    // Every created article — and only those — is handed on to grouping
    // (§14.3). An article that already existed has already been offered a
    // group, and regrouping it on every re-sighting would let a group drift.
    expect(result.createdArticles).toHaveLength(41);

    const [sightingRows, articleRows] = await Promise.all([
      harness.db.selectFrom("sightings").select(({ fn }) => fn.countAll().as("n")).executeTakeFirstOrThrow(),
      harness.db.selectFrom("articles").select(({ fn }) => fn.countAll().as("n")).executeTakeFirstOrThrow(),
    ]);
    // Every sighting is still its own row. The alt key collapses ARTICLES; an
    // emission is never discarded, so nothing that arrived is lost.
    expect(Number(sightingRows.n)).toBe(100);
    expect(Number(articleRows.n)).toBe(41);
  });

  it("keeps both URLs' sightings on the one article the alt key folded them onto", async () => {
    // The fold has to be a MERGE, not a preference: the loser's emission must
    // hang off the winning row, or the alt key would be silently dropping
    // sightings instead of collapsing articles.
    const pair = sightings.filter((s) => s.title === "First-World Flames");
    expect(new Set(pair.map((s) => s.dedupKey)).size).toBe(2);
    expect(new Set(pair.map((s) => s.altKey)).size).toBe(1);

    const rows = await harness.db
      .selectFrom("sightings")
      .select("article_id")
      .where(
        "dedup_key",
        "in",
        pair.map((s) => hexToBytea(s.dedupKey)),
      )
      .execute();

    expect(rows).toHaveLength(pair.length);
    expect(new Set(rows.map((row) => row.article_id)).size).toBe(1);
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
      plane: "search",
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
    expect(Number(articleRows.n)).toBe(41);
  });

  it("records topic membership per article, not per sighting", async () => {
    const links = await harness.db
      .selectFrom("topic_articles")
      .select(({ fn }) => fn.countAll().as("n"))
      .where("fingerprint", "=", hexToBytea(CLIMATE_TOPIC))
      .executeTakeFirstOrThrow();

    expect(Number(links.n)).toBe(41);
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
      plane: "search",
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
    expect(Number(articleRows.n)).toBe(41);
  });

  it("ingesting nothing is a no-op", async () => {
    const result = await ingestSightings(harness.db, {
      plane: "search",
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
    altKey: deriveAltKey("example.com", title, published),
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
      plane: "search",
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
      plane: "search",
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
    altKey: deriveAltKey("example.com", "Harbour spill widens", input.published),
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
      plane: "search",
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
      plane: "search",
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
      plane: "search",
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
      plane: "search",
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

  /**
   * The re-derivation is DERIVED, so it must not be able to fail the write it
   * was derived from — the contract `recordStoryDfForArticles` states in its own
   * words ("an ingest triggered by a reader's search must not fail because a
   * derived counter did") and grouping keeps by never throwing.
   *
   * Those two run after this transaction commits, so a plain catch is all they
   * need. This runs INSIDE it, where a plain catch is worse than none: Postgres
   * aborts the transaction on the first failed statement and COMMIT on an
   * aborted transaction is a silent ROLLBACK, so the catch would return a result
   * reporting sightings it had just discarded. Hence the savepoint, and hence
   * this test — the fence is invisible on every path that does not fail.
   */
  it("a re-derivation that throws does not take the ingest with it", async () => {
    const url = "https://example.com/spill-with-a-broken-derivation";
    const { articleId, storylineId } = await seed({
      url,
      published: "2026-08-15T18:00:00.000Z",
      sightingId: "00000000-0000-4000-8000-00000000f04d",
    });

    // The shape of failure to expect here: an error raised by the SERVER
    // mid-transaction, the way a deadlock against the merge path's lock order on
    // these same tables would arrive. Which statement of the re-derivation
    // raises it does not matter.
    await sql`create function zammy_test_boom() returns trigger language plpgsql as $$
      begin raise exception 'day slot re-derivation exploded'; end $$`.execute(harness.db);
    await sql`create trigger zammy_test_boom_trg
      before insert or update or delete on storyline_days
      for each row execute function zammy_test_boom()`.execute(harness.db);

    const warnings: string[] = [];
    try {
      const ingested = await ingestSightings(harness.db, {
        plane: "search",
        fingerprint: TOPIC,
        timeZone: ZONE,
        log: { warn: (_obj, msg) => warnings.push(msg) },
        sightings: [
          emission({
            id: "00000000-0000-4000-8000-00000000f04e",
            url,
            published: "2026-08-15T05:00:00.000Z",
          }),
        ],
      });
      expect(ingested.sightingsInserted).toBe(1);
    } finally {
      await sql`drop trigger zammy_test_boom_trg on storyline_days`.execute(harness.db);
      await sql`drop function zammy_test_boom()`.execute(harness.db);
    }

    // The fold committed. That is the whole point: a paid upstream page and a
    // reader's search must not be lost to a derived value, and unfenced this
    // same raise takes the entire batch down with it.
    const article = await harness.db
      .selectFrom("articles")
      .select(["published", "sighting_count"])
      .where("id", "=", articleId)
      .executeTakeFirstOrThrow();
    expect(article.published.toISOString()).toBe("2026-08-15T05:00:00.000Z");
    expect(article.sighting_count).toBe(2);

    // And the slots are left exactly as stale as they were before any of this
    // existed — 05:00Z on the fifteenth is the FOURTEENTH in Vancouver, so a
    // slot still on the fifteenth is a slot the fence rolled back. That
    // staleness is the degradation the fence trades down to, and the next group
    // merge or a `backfill:storylines --restart` repairs it.
    expect(await days(storylineId)).toEqual([
      { dayKey: "2026-08-15", published: "2026-08-15T18:00:00.000Z", lead: articleId },
    ]);
    expect(warnings).toHaveLength(1);
  });
});

/**
 * The resolution order — **URL key → alt key → insert** (ADR-0018).
 *
 * The ordering is the design, not an implementation detail, and the first test
 * below is the one that proves why. Every case here is a shape the production
 * archive actually holds: a story filed under two section paths, a headline
 * re-styled between emissions, a source that truncates its own titles.
 */
describe("resolving an article by URL key, then by alt key", () => {
  let harness: TestDatabase;
  const TOPIC = testFingerprint("a17ceb00");
  const DOMAIN = "example.com";
  const DAY = "2026-08-27T09:00:00.000Z";

  let uuid = 0;
  const emission = (input: {
    url: string;
    title: string;
    domain?: string;
    published?: string;
  }): Sighting => {
    uuid += 1;
    const domain = input.domain ?? DOMAIN;
    const published = input.published ?? DAY;
    return {
      id: `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`,
      url: input.url,
      provider: "currents",
      providerSightingId: input.url,
      dedupKey: deriveDedupKey(input.url),
      altKey: deriveAltKey(domain, input.title, published),
      title: input.title,
      description: null,
      author: null,
      imageUrl: null,
      language: "en",
      categories: [],
      sourceCategories: [],
      sourceDomain: domain,
      published,
      raw: { id: uuid },
    };
  };

  const ingest = async (...sightings: Sighting[]) =>
    ingestSightings(harness.db, { plane: "search", timeZone: "UTC", fingerprint: TOPIC, sightings });

  const articleCount = async (): Promise<number> => {
    const row = await harness.db
      .selectFrom("articles")
      .select(({ fn }) => fn.countAll().as("n"))
      .executeTakeFirstOrThrow();
    return Number(row.n);
  };

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
    await upsertTopic(harness.db, { fingerprint: TOPIC, keywords: ["ferry"] });
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("takes the URL match when the URL and the alt key point at different rows", async () => {
    // The whole reason the alt key is a FALLBACK. Two articles exist; a new
    // emission arrives under the FIRST one's URL carrying the SECOND one's
    // headline — an outlet editing a headline into something another story on
    // the same day already said. URLs are stable and titles drift, so the URL
    // is what this must believe.
    const first = await ingest(
      emission({ url: "https://example.com/ferry", title: "Ferry service suspended" }),
    );
    const second = await ingest(
      emission({ url: "https://example.com/rail", title: "Rail service suspended" }),
    );
    const ferryId = first.createdArticles[0]!.id;
    const railId = second.createdArticles[0]!.id;
    expect(ferryId).not.toBe(railId);

    const drifted = await ingest(
      emission({ url: "https://example.com/ferry", title: "Rail service suspended" }),
    );
    expect(drifted.articlesCreated).toBe(0);

    // On the ferry row, by its URL — not on the rail row, whose alt key the
    // drifted headline also matches.
    const ferry = await harness.db
      .selectFrom("articles")
      .select(["id", "sighting_count"])
      .where("id", "=", ferryId)
      .executeTakeFirstOrThrow();
    expect(ferry.sighting_count).toBe(2);

    const rail = await harness.db
      .selectFrom("articles")
      .select("sighting_count")
      .where("id", "=", railId)
      .executeTakeFirstOrThrow();
    expect(rail.sighting_count).toBe(1);
  });

  it("folds a never-seen URL onto the article the alt key already names", async () => {
    // The 411 production rows in one sentence: one story, two section paths.
    const before = await articleCount();
    const original = await ingest(
      emission({
        url: "https://example.com/blogs/toi-edit-page/first-world-flames",
        title: "First-World Flames",
      }),
    );
    const articleId = original.createdArticles[0]!.id;

    const second = await ingest(
      emission({
        url: "https://example.com/blogs/gen-zedits/first-world-flames-2",
        title: "First-World Flames",
      }),
    );

    expect(second.articlesCreated).toBe(0);
    expect(second.sightingsInserted).toBe(1);
    expect(await articleCount()).toBe(before + 1);

    const article = await harness.db
      .selectFrom("articles")
      .select(["sighting_count", "url"])
      .where("id", "=", articleId)
      .executeTakeFirstOrThrow();
    expect(article.sighting_count).toBe(2);
    // The later emission is not the earliest, so the display URL is untouched
    // (ADR-0002) — the fold contributes a sighting, not a rewrite.
    expect(article.url).toBe("https://example.com/blogs/toi-edit-page/first-world-flames");
  });

  it("folds across the outlet suffix, since one headline may carry it and one may not", async () => {
    const before = await articleCount();
    await ingest(
      emission({
        url: "https://example.com/harbour-spill",
        title: "Harbour spill widens - Example",
      }),
    );
    const second = await ingest(
      emission({ url: "https://example.com/news/harbour-spill", title: "Harbour spill widens" }),
    );

    expect(second.articlesCreated).toBe(0);
    expect(await articleCount()).toBe(before + 1);
  });

  it("keeps two genuinely different same-day stories from one domain apart", async () => {
    const before = await articleCount();
    await ingest(
      emission({ url: "https://example.com/budget", title: "Budget passes second reading" }),
    );
    await ingest(
      emission({ url: "https://example.com/bridge", title: "Bridge closes for repairs" }),
    );
    expect(await articleCount()).toBe(before + 2);
  });

  it("mints no alt key at all for a title the source truncated, so two rows stand", async () => {
    // hkexnews.hk files distinct disclosures under one truncated title. With no
    // key, both rows take the pre-ADR-0018 path in full: identified by URL, and
    // outside the partial unique index entirely.
    const before = await articleCount();
    const first = await ingest(
      emission({
        url: "https://example.com/disclosure-1",
        title: "[00232.HK] Disclosure of...",
      }),
    );
    const second = await ingest(
      emission({
        url: "https://example.com/disclosure-2",
        title: "[00232.HK] Disclosure of...",
      }),
    );

    expect(second.articlesCreated).toBe(1);
    expect(await articleCount()).toBe(before + 2);

    const rows = await harness.db
      .selectFrom("articles")
      .select(["id", "alt_key"])
      .where("id", "in", [first.createdArticles[0]!.id, second.createdArticles[0]!.id])
      .execute();
    expect(rows.map((row) => row.alt_key)).toEqual([null, null]);
  });

  it("stores the key the sighting carried, so storage and the client cannot disagree", async () => {
    const sighting = emission({
      url: "https://example.com/rate-decision",
      title: "Bank holds rate",
    });
    const created = await ingest(sighting);

    const article = await harness.db
      .selectFrom("articles")
      .select("alt_key")
      .where("id", "=", created.createdArticles[0]!.id)
      .executeTakeFirstOrThrow();
    expect(article.alt_key).toEqual(hexToBytea(sighting.altKey!));
  });

  it("never rewrites the keys when an earlier sighting takes over the display fields", async () => {
    // ADR-0002 hands the display fields to the earliest emission. Identity is
    // NOT a display field: rewriting either key would change an article's
    // identity under a live unique index, and a row that stopped answering to
    // the key it was found by would be found again as a new article by the very
    // next sighting of it.
    const late = emission({
      url: "https://example.com/late-link",
      title: "Cabinet reshuffle announced",
      published: "2026-08-27T18:00:00.000Z",
    });
    const created = await ingest(late);
    const articleId = created.createdArticles[0]!.id;

    // Earlier, and under a different URL — so it resolves by alt key, and then
    // wins the display fields on the way through.
    const early = emission({
      url: "https://example.com/early-link",
      title: "Cabinet reshuffle announced",
      published: "2026-08-27T06:00:00.000Z",
    });
    expect(early.altKey).toBe(late.altKey);
    await ingest(early);

    const article = await harness.db
      .selectFrom("articles")
      .select(["url", "dedup_key", "alt_key"])
      .where("id", "=", articleId)
      .executeTakeFirstOrThrow();

    expect(article.url).toBe("https://example.com/early-link");
    // Minted once, from the sighting that created the row.
    expect(article.dedup_key).toEqual(hexToBytea(late.dedupKey));
    expect(article.alt_key).toEqual(hexToBytea(late.altKey!));
    // And the consequence worth naming: `dedup_key` no longer hashes `url`.
    expect(article.dedup_key).not.toEqual(hexToBytea(early.dedupKey));
  });

  it("keeps one domain's stories out of another's", async () => {
    const before = await articleCount();
    await ingest(
      emission({
        url: "https://other.example/wire-story",
        title: "Wire story everyone ran",
        domain: "other.example",
      }),
    );
    await ingest(
      emission({
        url: "https://third.example/wire-story",
        title: "Wire story everyone ran",
        domain: "third.example",
      }),
    );
    // ADR-0002: one story across several outlets is several articles, on
    // purpose — the cloud's distinct-source gate depends on it.
    expect(await articleCount()).toBe(before + 2);
  });
});

/**
 * The plane, on the row (ADR-0019, migration 0022).
 *
 * Small, and worth its own block because the failure it guards is silent in one
 * direction: `readTrendingStorylines` reads `plane is distinct from
 * 'deepening'`, so a sighting stamped with anything else — or with nothing —
 * feeds the ranking that may have chosen it.
 */
describe("stamping the plane a fetch was made on", () => {
  let harness: TestDatabase;
  const TOPIC = testFingerprint("b1a4e000");
  let uuid = 0;

  const emission = (): Sighting => {
    uuid += 1;
    const url = `https://example.com/plane-${uuid}`;
    return {
      id: `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`,
      url,
      provider: "currents",
      providerSightingId: url,
      dedupKey: deriveDedupKey(url),
      altKey: null,
      title: `Plane fixture ${uuid}`,
      description: null,
      author: null,
      imageUrl: null,
      language: "en",
      categories: [],
      sourceCategories: [],
      sourceDomain: "example.com",
      published: "2026-08-27T09:00:00.000Z",
      raw: { id: uuid },
    };
  };

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
    await upsertTopic(harness.db, { fingerprint: TOPIC, keywords: ["plane"] });
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("writes the caller's plane onto every sighting in the batch", async () => {
    // Uniform across the batch by construction: one call was planned for one
    // reason. The adapter never supplies this — `Sighting` has no plane, and
    // deliberately: the same provider returning the same article answers a
    // reader's search and a cloud-driven deepening fetch.
    const deep = emission();
    await ingestSightings(harness.db, {
      plane: "deepening",
      timeZone: "UTC",
      fingerprint: TOPIC,
      sightings: [deep],
    });

    const row = await harness.db
      .selectFrom("sightings")
      .select("plane")
      .where("id", "=", deep.id)
      .executeTakeFirstOrThrow();
    expect(row.plane).toBe("deepening");
  });

  it("refuses a plane outside the three ADR-0019 names", async () => {
    // `sightings_plane_check`. The predicate upstairs is `is distinct from
    // 'deepening'`, which is TRUE of every misspelling — so a typo does not
    // fail closed, it joins the discovery plane and silently re-opens the
    // endogenous loop. The constraint is what turns that into a failed insert.
    //
    // Raw SQL because the point is the DATABASE\'s guard: `SightingPlane`
    // already makes this unwriteable through the query builder, and a test that
    // only demonstrated the type would be testing tsc.
    const article = await harness.db
      .selectFrom("articles")
      .select("id")
      .executeTakeFirstOrThrow();

    await expect(
      sql`insert into sightings (id, article_id, dedup_key, published, provider, plane, raw)
          values (gen_random_uuid(), ${article.id}, ${hexToBytea(deriveDedupKey("https://example.com/typo"))},
                  now(), 'currents', 'deepning', '{}'::jsonb)`.execute(harness.db),
    ).rejects.toThrow(/sightings_plane_check/);
  });

  it("still admits NULL, because that is what the archive before 0022 carries", async () => {
    // The migration would not invent a value for history, so every pre-0022 row
    // is NULL and the CHECK has to let it stand. `readTrendingStorylines`
    // counts those rows — see its own test — and the whole dev archive is them.
    const article = await harness.db
      .selectFrom("articles")
      .select("id")
      .executeTakeFirstOrThrow();

    await sql`insert into sightings (id, article_id, dedup_key, published, provider, plane, raw)
        values (gen_random_uuid(), ${article.id}, ${hexToBytea(deriveDedupKey("https://example.com/history"))},
                now(), 'currents', null, '{}'::jsonb)`.execute(harness.db);

    const nulls = await harness.db
      .selectFrom("sightings")
      .select(({ fn }) => fn.countAll().as("n"))
      .where("plane", "is", null)
      .executeTakeFirstOrThrow();
    expect(Number(nulls.n)).toBe(1);
  });
});
