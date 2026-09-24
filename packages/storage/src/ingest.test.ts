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

/**
 * **THREE databases for this file, not one per describe block.**
 *
 * Every block below asserts something a real Postgres uniquely does — the
 * `ON CONFLICT` arithmetic over the recorded payload, a savepoint, a CHECK
 * constraint, what a column actually holds after an UPDATE — so none of them
 * moved out. What moved out are the fold's two decisions, which are truth tables
 * and are now asserted exhaustively and without a database in `fold.test.ts`,
 * against the SQL they replace in `fold-differential.test.ts`. What is left here
 * is the end-to-end path, and eight throwaway databases running eight full
 * migrations was eight prices for one thing.
 *
 * The three are separated by what would otherwise interfere, not by topic:
 *
 *  - `collapseDb` — the recorded duplication payload, which asserts ABSOLUTE
 *    row counts (41 articles, 100 sightings) and so cannot share a database with
 *    anything that mints an article. `upsertTopic` shares it because it writes
 *    one `topics` row and nothing else.
 *  - `storylineDb` — the day-slot re-derivation, which installs a trigger on
 *    `storyline_days` mid-test and asserts over every storyline the database
 *    holds.
 *  - `writesDb` — everything else: what the fold WRITES. Blocks sharing it owe
 *    each other three disjoint spaces, and the cost of getting one wrong is a
 *    confusing failure rather than a silent pass: **sighting ids** (each block
 *    takes a hundred, offset below), **URLs** (hence `dedup_key`) and
 *    **(domain, folded title, UTC day)** (hence `alt_key`, whose partial index
 *    is unique). Absolute `count(*)` assertions do not belong in these blocks;
 *    every one of them counts relative to a `before`, or off its own result.
 */
let collapseDb: TestDatabase;
let writesDb: TestDatabase;
let storylineDb: TestDatabase;

/** A throwaway database at the latest migration. */
async function migrated(): Promise<TestDatabase> {
  const harness = await createTestDatabase();
  await migrateToLatest(harness.db);
  return harness;
}

beforeAll(async () => {
  // In parallel: three migrations serialized is most of what this file spends
  // before its first assertion.
  [collapseDb, writesDb, storylineDb] = await Promise.all([
    migrated(),
    migrated(),
    migrated(),
  ]);
});

afterAll(async () => {
  await Promise.all([collapseDb.drop(), writesDb.drop(), storylineDb.drop()]);
});

describe("the collapse over the recorded duplication payload", () => {
  let harness: TestDatabase;
  let sightings: Sighting[];
  /** dedup key of the link-roundup page that upstream emitted 50 times. */
  let roundupKey: string;

  beforeAll(async () => {
    harness = collapseDb;
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
    harness = writesDb;
    await upsertTopic(harness.db, { fingerprint: TOPIC, keywords: ["story"] });
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
        emission("00000000-0000-4000-8000-000000000102", "2026-08-04T12:00:00.000Z", "Rewritten headline"),
        emission("00000000-0000-4000-8000-000000000101", "2026-08-04T08:00:00.000Z", "Original headline"),
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
        emission("00000000-0000-4000-8000-000000000103", "2026-08-04T06:00:00.000Z", "First headline of all"),
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
    harness = collapseDb;
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
    harness = storylineDb;
    await upsertTopic(harness.db, { fingerprint: TOPIC, keywords: ["spill"] });
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
 *
 * **These are the end-to-end cases, not the truth table.** The ordering itself
 * is `chooseArticle`, and every reachable candidate set is asserted against it
 * in `fold.test.ts` with no database — 20 archive shapes × 4 probe widths — and
 * against the SQL it came out of in `fold-differential.test.ts`. What these
 * tests add is that the verdict is actually APPLIED: the sighting lands on the
 * row, the keys that are stored are the ones the client derived, and the ones
 * that must not move do not.
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
      id: `00000000-0000-4000-8000-${String(200 + uuid).padStart(12, "0")}`,
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
    harness = writesDb;
    await upsertTopic(harness.db, { fingerprint: TOPIC, keywords: ["ferry"] });
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
 * A bare date resolves against its neighbours, and only a bare date does
 * (ADR-0022).
 *
 * The defect: a provider that sends a DATE puts it on a clock of its own, the
 * archive holds a real time on the newsroom's clock, and the two disagree about
 * which calendar day the story belongs to — measured over 150 twin pairs on the
 * dev archive, 12 a day early and 11 a day late. The fold cannot reconcile that
 * because it is not a fixed offset, so the LOOKUP widens instead and the fold
 * stays exactly where it is. These assertions are as much about what does NOT
 * move as about what does.
 *
 * The precedence among the three keys — own day over a neighbour, and both
 * neighbours a refusal — is `chooseArticle`, asserted exhaustively and without a
 * database in `fold.test.ts`, **including the DEGRADED probe these tests cannot
 * reach**: `altKeyProbe` falls back to the single stored key when its
 * consistency check fails, so a bare-dated sighting does not always arrive with
 * three keys. What is asserted here is the half that needs Postgres: which key
 * gets STORED, and that folding does not chain.
 */
describe("a bare-dated sighting resolves against the adjacent days", () => {
  let harness: TestDatabase;
  const TOPIC = testFingerprint("d0e0f0a1");
  const DOMAIN = "pbs.example";

  let uuid = 0;
  const emission = (input: {
    url: string;
    title: string;
    published: string;
    dateOnly?: boolean;
    domain?: string;
  }): Sighting => {
    uuid += 1;
    const domain = input.domain ?? DOMAIN;
    return {
      id: `00000000-0000-4000-8000-${String(600 + uuid).padStart(12, "0")}`,
      url: input.url,
      provider: input.dateOnly ? "google-news" : "currents",
      providerSightingId: input.url,
      dedupKey: deriveDedupKey(input.url),
      altKey: deriveAltKey(domain, input.title, input.published),
      title: input.title,
      description: null,
      author: null,
      imageUrl: null,
      language: "en",
      categories: [],
      sourceCategories: [],
      sourceDomain: domain,
      published: input.published,
      ...(input.dateOnly ? { publishedIsDateOnly: true } : {}),
      raw: { id: uuid },
    };
  };

  const ingest = async (...sightings: Sighting[]) =>
    ingestSightings(harness.db, {
      plane: "search",
      timeZone: "UTC",
      fingerprint: TOPIC,
      sightings,
    });

  beforeAll(async () => {
    harness = writesDb;
    await upsertTopic(harness.db, { fingerprint: TOPIC, keywords: ["press"] });
  });

  it("folds onto an article the archive filed on the NEXT day", async () => {
    // The worked case from plan §G6, with the domain renamed: pbs.org filed
    // "Karoline Leavitt is leaving her role as Trump's White House press
    // secretary" at 2026-08-13T00:32:39Z and Google reported the same headline
    // as a bare 2026-08-12. Byte-identical titles, two rows, and no fold on
    // earth that works on the TITLE could have joined them.
    const held = emission({
      url: "https://pbs.example/leavitt",
      title: "Karoline Leavitt is leaving her role as press secretary",
      published: "2026-08-13T00:32:39.000Z",
    });
    const created = await ingest(held);
    const articleId = created.createdArticles[0]!.id;

    const bare = emission({
      url: "https://news.google.example/rss/articles/CBMiswFB",
      title: "Karoline Leavitt is leaving her role as press secretary",
      published: "2026-08-12T07:00:00.000Z",
      dateOnly: true,
    });
    expect(bare.altKey).not.toBe(held.altKey);

    const result = await ingest(bare);
    expect(result.articlesCreated).toBe(0);

    const rows = await harness.db
      .selectFrom("sightings")
      .select("article_id")
      .where("id", "in", [held.id, bare.id])
      .execute();
    expect(new Set(rows.map((row) => row.article_id))).toEqual(new Set([articleId]));
  });

  it("folds onto an article the archive filed on the PREVIOUS day", async () => {
    // The other direction, and it is not symmetric decoration: the archive's
    // twin sits a day EARLIER as often as it sits a day later — 12 against 11
    // over the measured pairs — so a probe in one direction would close half
    // the defect and read as if it had closed all of it.
    const held = emission({
      url: "https://pbs.example/hormuz",
      title: "Why Trump wants Iran to pay compensation",
      published: "2026-08-10T19:53:41.000Z",
    });
    const created = await ingest(held);

    const result = await ingest(
      emission({
        url: "https://news.google.example/rss/articles/CBMiaHR0",
        title: "Why Trump wants Iran to pay compensation",
        published: "2026-08-11T07:00:00.000Z",
        dateOnly: true,
      }),
    );
    expect(result.articlesCreated).toBe(0);
    expect(created.createdArticles).toHaveLength(1);
  });

  it("mints the article under its OWN day, never a neighbour's", async () => {
    // The whole claim that this is not a fold change. A bare-dated sighting
    // that folds writes no key at all; one that mints writes the key
    // `deriveAltKey` gave it, and a re-derivation — a migration, a repair —
    // reproduces it from the stored columns exactly as before.
    const bare = emission({
      url: "https://news.google.example/rss/articles/CBMiNEsY",
      title: "Wildfire evacuation order lifted",
      published: "2026-08-19T07:00:00.000Z",
      dateOnly: true,
    });
    const created = await ingest(bare);

    const article = await harness.db
      .selectFrom("articles")
      .select("alt_key")
      .where("id", "=", created.createdArticles[0]!.id)
      .executeTakeFirstOrThrow();
    expect(article.alt_key).toEqual(hexToBytea(bare.altKey!));
    expect(article.alt_key).toEqual(
      hexToBytea(
        deriveAltKey(DOMAIN, "Wildfire evacuation order lifted", "2026-08-19T07:00:00.000Z")!,
      ),
    );
  });

  it("leaves the day bucket alone for a sighting that carries a real time", async () => {
    // The regression this trades against. A day bucket is what stops a domain's
    // recurring headline from collapsing a month of instalments into one
    // article, and it is relaxed for bare dates ONLY. 22 of the dev archive's
    // 31,752 distinct (domain, folded title) pairs recur on adjacent days and
    // four of those are a daily desk column.
    const first = await ingest(
      emission({
        url: "https://pbs.example/brief-monday",
        title: "AP News in Brief at 12:04 a.m. EDT",
        published: "2026-08-05T04:04:35.000Z",
      }),
    );
    const second = await ingest(
      emission({
        url: "https://pbs.example/brief-tuesday",
        title: "AP News in Brief at 12:04 a.m. EDT",
        published: "2026-08-06T04:05:17.000Z",
      }),
    );
    expect(first.articlesCreated).toBe(1);
    expect(second.articlesCreated).toBe(1);
  });

  it("prefers the article on the sighting's OWN day when a neighbour also matches", async () => {
    // Never observed — the widened set matched articles on more than one day in
    // 0 of the 1,749 bare-date sightings measured — which is precisely why the
    // precedence is written down instead of left to whichever row the planner
    // returns first.
    const title = "Overnight ferry service resumes";
    const neighbour = emission({
      url: "https://pbs.example/ferry-neighbour",
      title,
      published: "2026-08-21T23:30:00.000Z",
    });
    const ownDay = emission({
      url: "https://pbs.example/ferry-own-day",
      title,
      published: "2026-08-22T18:00:00.000Z",
    });
    await ingest(neighbour);
    const target = await ingest(ownDay);
    const ownDayId = target.createdArticles[0]!.id;

    const bare = emission({
      url: "https://news.google.example/rss/articles/CBMiRmZlcnJ5",
      title,
      published: "2026-08-22T07:00:00.000Z",
      dateOnly: true,
    });
    expect(await ingest(bare)).toMatchObject({ articlesCreated: 0 });

    const row = await harness.db
      .selectFrom("sightings")
      .select("article_id")
      .where("id", "=", bare.id)
      .executeTakeFirstOrThrow();
    expect(row.article_id).toBe(ownDayId);
  });

  it("refuses the fallback when both neighbours match and the own day does not", async () => {
    // The recurring-column signature, and the one shape the widening must NOT
    // resolve: this domain filed the same folded headline on Monday and on
    // Wednesday, and Tuesday's instalment arrives with a bare date. Picking
    // either neighbour would file Tuesday's sighting against Monday's row and
    // Tuesday's article would never be minted at all — losing an article, which
    // ADR-0018 settles as the worse error against showing a duplicate.
    const title = "AP News in Brief at 12:04 a.m. EDT";
    await ingest(
      emission({ url: "https://pbs.example/brief-mon", title, published: "2026-08-24T04:04:35.000Z" }),
    );
    await ingest(
      emission({ url: "https://pbs.example/brief-wed", title, published: "2026-08-26T04:04:35.000Z" }),
    );

    const tuesday = emission({
      url: "https://news.google.example/rss/articles/CBMiVHVlcw",
      title,
      published: "2026-08-25T07:00:00.000Z",
      dateOnly: true,
    });
    const result = await ingest(tuesday);

    // Minted, under its own day, exactly as it would have been before the
    // widening existed.
    expect(result.articlesCreated).toBe(1);
    const article = await harness.db
      .selectFrom("articles")
      .select("alt_key")
      .where("id", "=", result.createdArticles[0]!.id)
      .executeTakeFirstOrThrow();
    expect(article.alt_key).toEqual(hexToBytea(tuesday.altKey!));
  });

  it("folds a bare date onto a bare-dated article, but only in one arrival order", async () => {
    // A KNOWN RESIDUE, asserted so it cannot be mistaken for an oversight
    // (ADR-0022's asymmetry consequence). The probe is carried by the ARRIVING
    // sighting and matched against STORED keys, so folding does not chain: a row
    // minted under D-1 is invisible to a sighting on D+1, whose own neighbours
    // are D and D+2. Three emissions of one story therefore collapse to one
    // article or to two depending only on which arrived first.
    const outward = ["2026-09-01", "2026-09-02", "2026-09-03"];
    const inward = ["2026-09-12", "2026-09-11", "2026-09-13"];
    const run = async (title: string, days: string[]): Promise<number> => {
      let created = 0;
      for (const day of days) {
        const result = await ingest(
          emission({
            url: `https://news.google.example/rss/${title}-${day}`,
            title,
            published: `${day}T07:00:00.000Z`,
            dateOnly: true,
          }),
        );
        created += result.articlesCreated;
      }
      return created;
    };

    // Oldest first: D-1 mints, D folds onto it, D+1 cannot see it and mints.
    expect(await run("Ferry timetable published", outward)).toBe(2);
    // Middle first: both neighbours fold onto the row keyed on their own day.
    expect(await run("Harbour timetable published", inward)).toBe(1);
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
      id: `00000000-0000-4000-8000-${String(400 + uuid).padStart(12, "0")}`,
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
    harness = writesDb;
    await upsertTopic(harness.db, { fingerprint: TOPIC, keywords: ["plane"] });
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

/**
 * The orphan sweep: an article this batch created whose every sighting turned
 * out to be a duplicate upstream UUID holds zero sightings, which the Article
 * contract (sightingCount >= 1) forbids, and is deleted before commit.
 *
 * Not hypothetical: production deleted 50 of them between 2026-08-26 and
 * 2026-09-24. And the sweep's REACH is asserted as carefully as its effect,
 * because the table-wide version it replaced cost 1.28s per call on average
 * (a seq scan of `articles` with no index on `sighting_count`) to find rows
 * only this batch could have made.
 */
describe("sweeping an article left with no sightings", () => {
  let harness: TestDatabase;
  const TOPIC = testFingerprint("0f9a4000");

  const emission = (input: { id: number; url: string }): Sighting => ({
    id: `00000000-0000-4000-8000-${String(700 + input.id).padStart(12, "0")}`,
    url: input.url,
    provider: "currents",
    providerSightingId: input.url,
    dedupKey: deriveDedupKey(input.url),
    altKey: null,
    title: `Orphan fixture ${input.id}`,
    description: null,
    author: null,
    imageUrl: null,
    language: "en",
    categories: [],
    sourceCategories: [],
    sourceDomain: "example.com",
    published: "2026-08-28T09:00:00.000Z",
    raw: { id: input.id },
  });

  const articleAt = (url: string) =>
    harness.db
      .selectFrom("articles")
      .select(["id", "sighting_count"])
      .where("dedup_key", "=", hexToBytea(deriveDedupKey(url)))
      .executeTakeFirst();

  beforeAll(async () => {
    harness = writesDb;
    await upsertTopic(harness.db, { fingerprint: TOPIC, keywords: ["orphan"] });
  });

  it("deletes the article a duplicate UUID under a new URL would have minted", async () => {
    // The one shape known to reach it: upstream re-sends a UUID it already
    // sent, under a URL nobody has seen. The URL mints an article, the UUID
    // conflicts, and the fold that would have counted the sighting never runs.
    await ingestSightings(harness.db, {
      plane: "search",
      timeZone: "UTC",
      fingerprint: TOPIC,
      sightings: [emission({ id: 1, url: "https://example.com/orphan-first" })],
    });

    const result = await ingestSightings(harness.db, {
      plane: "search",
      timeZone: "UTC",
      fingerprint: TOPIC,
      sightings: [emission({ id: 1, url: "https://example.com/orphan-reused-uuid" })],
    });

    expect(result).toEqual({
      sightingsReceived: 1,
      sightingsInserted: 0,
      articlesCreated: 0,
      createdArticles: [],
    });
    expect(await articleAt("https://example.com/orphan-reused-uuid")).toBeUndefined();
    expect((await articleAt("https://example.com/orphan-first"))?.sighting_count).toBe(1);
  });

  it("reaches only the articles this batch created", async () => {
    // A zero-count row the batch did not make. Nothing in the app can commit
    // one — every transaction sweeps its own first — so it is planted here
    // directly, as the one row that tells a scoped sweep from a table-wide one.
    // Table-wide, this batch deletes it AND subtracts it from
    // `articlesCreated`, reporting 0 for a batch that created one.
    const planted = await harness.db
      .insertInto("articles")
      .values({
        dedup_key: hexToBytea(deriveDedupKey("https://example.com/orphan-planted")),
        url: "https://example.com/orphan-planted",
        title: "Planted with no sightings",
        description: null,
        author: null,
        image_url: null,
        language: "en",
        categories: [],
        source_category: [],
        source_domain: "example.com",
        published: new Date("2026-08-28T09:00:00.000Z"),
        latest_seen: new Date("2026-08-28T09:00:00.000Z"),
        sighting_count: 0,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    try {
      const result = await ingestSightings(harness.db, {
        plane: "search",
        timeZone: "UTC",
        fingerprint: TOPIC,
        sightings: [emission({ id: 2, url: "https://example.com/orphan-bystander" })],
      });

      expect(result.articlesCreated).toBe(1);
      expect(result.createdArticles).toHaveLength(1);
      expect((await articleAt("https://example.com/orphan-planted"))?.id).toBe(planted.id);
    } finally {
      await harness.db.deleteFrom("articles").where("id", "=", planted.id).execute();
    }
  });
});

/**
 * The two claims an adapter may make about its own fields, and what the fold
 * does with them (ADR-0021; plan §G6 for the measurements).
 *
 * Both guard a failure that is silent and reader-visible at once: an absorbed
 * sighting quietly replacing a working outlet link with an aggregator redirect,
 * or dragging a properly-timed article back onto a day boundary. Measured on the
 * dev archive before the guard existed, 116 of 169 absorbed articles lost their
 * URL and the same 116 had `published` moved earlier — 106 of them onto a
 * 07:00Z day boundary rather than onto a real time.
 *
 * The `undefined` cases matter as much as the `true` ones and are asserted
 * beside them: every adapter but Google News sends neither flag, and ADR-0002's
 * handover has to go on working exactly as it did for them.
 *
 * **The 2×2 itself is `fieldAuthority`** — asserted without a database in
 * `fold.test.ts`, and crossed with an earlier/later/equal stamp against every
 * column the statement writes in `fold-differential.test.ts`. These five tests
 * are the reader-visible consequences of it, on real rows: a summary and a hero
 * image that survive, a sighting stored and counted while moving nothing, and a
 * bare date that is permanent once minted.
 */
describe("a sighting that warns the fold about its own fields", () => {
  let harness: TestDatabase;
  const TOPIC = testFingerprint("c3f70000");
  let uuid = 0;

  const emission = (input: {
    url: string;
    title: string;
    published: string;
    provider?: string;
    isAggregatorCopy?: boolean;
    publishedIsDateOnly?: boolean;
  }): Sighting => {
    uuid += 1;
    return {
      id: `00000000-0000-4000-8000-${String(500 + uuid).padStart(12, "0")}`,
      url: input.url,
      provider: input.provider ?? "currents",
      providerSightingId: input.url,
      dedupKey: deriveDedupKey(input.url),
      // Null throughout: this block is about the DISPLAY handover, and a shared
      // alt key would fold these rows for a reason that is not the one under
      // test. Each pair below is folded by an explicitly shared `dedupKey`.
      altKey: null,
      title: input.title,
      description: null,
      author: null,
      imageUrl: null,
      language: "en",
      categories: [],
      sourceCategories: [],
      sourceDomain: "example.com",
      published: input.published,
      ...(input.isAggregatorCopy === undefined
        ? {}
        : { isAggregatorCopy: input.isAggregatorCopy }),
      ...(input.publishedIsDateOnly === undefined
        ? {}
        : { publishedIsDateOnly: input.publishedIsDateOnly }),
      raw: { id: uuid },
    };
  };

  /** Two emissions of one story: the same `dedupKey`, so the second folds. */
  const foldOnto = async (first: Sighting, second: Sighting): Promise<void> => {
    await ingestSightings(harness.db, {
      plane: "search",
      timeZone: "UTC",
      fingerprint: TOPIC,
      sightings: [first],
    });
    await ingestSightings(harness.db, {
      plane: "deepening",
      timeZone: "UTC",
      fingerprint: TOPIC,
      sightings: [{ ...second, dedupKey: first.dedupKey }],
    });
  };

  const article = async (dedupKey: string) =>
    harness.db
      .selectFrom("articles")
      .select(["url", "title", "published", "sighting_count", "provider"])
      .where("dedup_key", "=", Buffer.from(dedupKey, "hex"))
      .executeTakeFirstOrThrow();

  beforeAll(async () => {
    harness = writesDb;
    await upsertTopic(harness.db, { fingerprint: TOPIC, keywords: ["stamp"] });
  });

  it("hands the display fields to an earlier emission when neither flag is set", async () => {
    // The control, and the reason it is first: everything below is a REFUSAL,
    // and a refusal proves nothing unless the thing being refused would
    // otherwise happen. This is ADR-0002 unchanged.
    const late = emission({
      url: "https://example.com/control-late",
      title: "Control, late emission",
      published: "2026-08-13T12:09:10.000Z",
    });
    const early = emission({
      url: "https://example.com/control-early",
      title: "Control, early emission",
      published: "2026-08-13T07:00:00.000Z",
    });
    await foldOnto(late, early);

    const row = await article(late.dedupKey);
    expect(row.url).toBe("https://example.com/control-early");
    expect(row.title).toBe("Control, early emission");
    expect(row.published.toISOString()).toBe("2026-08-13T07:00:00.000Z");
    expect(row.sighting_count).toBe(2);
  });

  it("keeps the newsroom's record when an aggregator's copy arrives earlier", async () => {
    // The earlier-emission claim here is TRUE and the timestamp is honest, and
    // the display handover is refused anyway — a `CBM…` redirect and an
    // aggregator's rendering are not the better record even when they really did
    // come first. Measured: 9 of the 12 URL losses in the leading-edge run were
    // exactly this case, where a bare-date test would have found nothing wrong.
    const late = emission({
      url: "https://outlet.example.com/real-story",
      title: "Opaque, late emission",
      published: "2026-08-13T12:09:10.000Z",
    });
    const early = emission({
      url: "https://news.google.com/rss/articles/CBMiOPAQUE?oc=5",
      title: "Opaque, early emission - Outlet Name",
      published: "2026-08-13T09:30:00.000Z",
      provider: "google-news",
      isAggregatorCopy: true,
    });
    await foldOnto(late, early);

    const row = await article(late.dedupKey);
    expect(row.url).toBe("https://outlet.example.com/real-story");
    expect(row.title).toBe("Opaque, late emission");
    // The timestamp fold and `provider` DO still move, which is what keeps this
    // an exception to ADR-0002 rather than a repeal of it: this sighting really
    // did see the article, and really did see it earlier. What it may not do is
    // describe it.
    expect(row.published.toISOString()).toBe("2026-08-13T09:30:00.000Z");
    expect(row.provider).toBe("google-news");
  });

  it("lets a date-only sighting move nothing at all, while still counting it", async () => {
    // The §G6 fix. `least(published, ...)` would drag 12:09 back to the 07:00
    // day boundary, and that would then make the arriving sighting the earliest
    // emission and take the title and url with it — which is how a plane that
    // feeds no ranking still moved the cloud, since the trend window and the
    // recency decay both read `published`.
    const timed = emission({
      url: "https://outlet.example.com/timed-story",
      title: "Dated, the properly timed emission",
      published: "2026-08-13T12:09:10.000Z",
    });
    const dated = emission({
      url: "https://news.google.com/rss/articles/CBMiDATED?oc=5",
      title: "Dated, the day-boundary emission",
      published: "2026-08-13T07:00:00.000Z",
      provider: "google-news",
      isAggregatorCopy: true,
      publishedIsDateOnly: true,
    });
    await foldOnto(timed, dated);

    const row = await article(timed.dedupKey);
    expect(row.published.toISOString()).toBe("2026-08-13T12:09:10.000Z");
    expect(row.url).toBe("https://outlet.example.com/timed-story");
    expect(row.title).toBe("Dated, the properly timed emission");
    expect(row.provider).toBe("currents");
    // The observation is NOT discarded — it is stored, counted, and carries its
    // own timestamp on its own row. It simply may not redefine the article.
    expect(row.sighting_count).toBe(2);
    const sighting = await harness.db
      .selectFrom("sightings")
      .select(["published", "plane"])
      .where("id", "=", dated.id)
      .executeTakeFirstOrThrow();
    expect(sighting.published.toISOString()).toBe("2026-08-13T07:00:00.000Z");
    expect(sighting.plane).toBe("deepening");
  });

  it("still lets a date-only sighting MINT an article with the only timestamp it has", async () => {
    // The limit of the fix, asserted so nobody reads it as wider than it is.
    // A date-only stamp is refused as a REDEFINITION of somebody else's article,
    // never as a value — when it is all there is, it is what the row gets, and a
    // real timestamp arriving later cannot repair it because `least` keeps the
    // earlier one. That is a known residue of this change, not an oversight.
    const dated = emission({
      url: "https://news.google.com/rss/articles/CBMiMINTED?oc=5",
      title: "Minted from a bare date",
      published: "2026-08-13T07:00:00.000Z",
      provider: "google-news",
      isAggregatorCopy: true,
      publishedIsDateOnly: true,
    });
    await ingestSightings(harness.db, {
      plane: "deepening",
      timeZone: "UTC",
      fingerprint: TOPIC,
      sightings: [dated],
    });

    const row = await article(dated.dedupKey);
    expect(row.published.toISOString()).toBe("2026-08-13T07:00:00.000Z");
    expect(row.url).toBe("https://news.google.com/rss/articles/CBMiMINTED?oc=5");
    expect(row.sighting_count).toBe(1);

    // AND IT IS PERMANENT, which is the half of the residue that matters. A real
    // clock time arriving afterwards is LATER than the day boundary, so `least`
    // keeps the boundary and the handover never fires. Asserted rather than
    // described, because ADR-0021 claims this is asserted.
    await ingestSightings(harness.db, {
      plane: "search",
      timeZone: "UTC",
      fingerprint: TOPIC,
      sightings: [
        {
          ...emission({
            url: "https://outlet.example.com/the-real-record",
            title: "The newsroom's own record, arriving later",
            published: "2026-08-13T14:22:07.000Z",
          }),
          dedupKey: dated.dedupKey,
        },
      ],
    });

    const after = await article(dated.dedupKey);
    expect(after.published.toISOString()).toBe("2026-08-13T07:00:00.000Z");
    expect(after.url).toBe("https://news.google.com/rss/articles/CBMiMINTED?oc=5");
    expect(after.sighting_count).toBe(2);
  });

  it("keeps an aggregator's EMPTY fields off a populated article", async () => {
    // The loss a url-only guard leaves behind, and the reason ADR-0021's
    // exception is the whole display handover rather than one column. This
    // sighting's stamp is honest and genuinely earlier — the leading-edge
    // regime, where 98.3% of items carry a real clock — so `publishedIsDateOnly`
    // is no defence at all here. The adapter sends description, author and
    // imageUrl as null and both category arrays empty BY CONSTRUCTION, so
    // without the guard this handover empties five populated fields and a
    // reader's card loses its summary and its hero image.
    const populated: Sighting = {
      ...emission({
        url: "https://outlet.example.com/populated",
        title: "The newsroom's record, with everything on it",
        published: "2026-08-13T12:09:10.000Z",
      }),
      description: "Crews worked through the night.",
      author: "Jane Reporter",
      imageUrl: "https://outlet.example.com/hero.jpg",
      categories: ["world"],
      sourceCategories: ["regional"],
    };
    const aggregated = emission({
      url: "https://news.google.com/rss/articles/CBMiEMPTY?oc=5",
      title: "The aggregator's rendering - Outlet Name",
      published: "2026-08-13T09:30:00.000Z",
      provider: "google-news",
      isAggregatorCopy: true,
    });
    await foldOnto(populated, aggregated);

    const row = await harness.db
      .selectFrom("articles")
      .select(["url", "title", "description", "author", "image_url", "categories", "provider"])
      .where("dedup_key", "=", Buffer.from(populated.dedupKey, "hex"))
      .executeTakeFirstOrThrow();
    expect(row.description).toBe("Crews worked through the night.");
    expect(row.author).toBe("Jane Reporter");
    expect(row.image_url).toBe("https://outlet.example.com/hero.jpg");
    expect(row.categories).toEqual(["world"]);
    expect(row.title).toBe("The newsroom's record, with everything on it");
    expect(row.url).toBe("https://outlet.example.com/populated");
    // `provider` is the one field that DOES move, and deliberately: which
    // upstream reported the earliest emission is a fact about the emission, not
    // a rendering of the article, and `articles.provider` is documented as that.
    expect(row.provider).toBe("google-news");
  });
});
