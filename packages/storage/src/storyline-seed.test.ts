import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveDedupKey, type Sighting } from "@zammy/currents-client";
import { ingestSightings, upsertTopic } from "./ingest.js";
import { migrateToLatest } from "./migrator.js";
import { recordGrouping, setStoryline } from "./grouping.js";
import { attachStorylineToTopic, readTimelinePage } from "./timeline.js";
import { createTestDatabase, testFingerprint, type TestDatabase } from "./test-support.js";

/**
 * Seeded topic membership (ADR-0010): the storage half of a storyline-phrase
 * click. Two properties, and the second is the reason the first is allowed to
 * exist —
 *
 *   1. the storyline the phrase was taken from lands in the topic it opens,
 *      before a single upstream call is made;
 *   2. the keyword gate holds, so a hand-written `?storyline=` cannot enroll
 *      an article that does not carry every word the user searched.
 *
 * Real Postgres, because the whole mechanism is an `insert … select` with an
 * array containment gate — the two things a fake would fake wrong.
 */

const PHRASE_TOPIC = testFingerprint("5eed"); // what a phrase click opens
const WRONG_TOPIC = testFingerprint("bad5eed"); // the crafted-link case

const STORYLINE_DAY = "2026-08-04T10:00:00.000Z";

/** title → the tokens `story_tokens` would hold for it, singularized. */
const TOKENS: Record<string, string[]> = {
  hub: ["police", "chief", "letter", "minister"],
  angle: ["police", "chief", "profile"],
  stranger: ["volcano", "eruption"],
};

let harness: TestDatabase;
let ids: Record<string, string>;

const sighting = (id: string, url: string): Sighting => ({
  id: `00000000-0000-4000-8000-0000000000${id}`,
  url,
  dedupKey: deriveDedupKey(url),
  title: `story at ${url}`,
  description: null,
  author: null,
  imageUrl: null,
  language: "en",
  categories: [],
  sourceCategories: [],
  sourceDomain: "example.com",
  published: STORYLINE_DAY,
  raw: { id, published: STORYLINE_DAY },
});

/** The storyline a reader is looking at: hub, angle piece, and a group that
 * shares the day but not the story. */
beforeAll(async () => {
  harness = await createTestDatabase();
  await migrateToLatest(harness.db);

  const source = testFingerprint("50urce"); // the topic the reader arrived FROM
  await upsertTopic(harness.db, { fingerprint: source, keywords: ["police"] });
  await upsertTopic(harness.db, { fingerprint: PHRASE_TOPIC, keywords: ["chiefs", "police"] });
  await upsertTopic(harness.db, { fingerprint: WRONG_TOPIC, keywords: ["bananas"] });

  await ingestSightings(harness.db, {
    fingerprint: source,
    sightings: [
      sighting("01", "https://example.com/hub"),
      sighting("02", "https://example.com/angle"),
      sighting("03", "https://example.com/stranger"),
    ],
  });

  const rows = await harness.db.selectFrom("articles").select(["id", "url"]).execute();
  ids = Object.fromEntries(
    rows.map((row) => [row.url.split("/").pop()!, row.id]),
  );

  for (const [name, tokens] of Object.entries(TOKENS)) {
    await recordGrouping(harness.db, {
      articleId: ids[name]!,
      titleTokens: tokens,
      storyTokens: tokens,
      tokensVersion: 3,
      groupId: null,
    });
  }
  // The angle piece hangs off the hub, one hop, as clustering would leave it.
  await setStoryline(harness.db, { groupId: ids.angle!, storylineId: ids.hub! });
});

afterAll(async () => {
  await harness.drop();
});

describe("attachStorylineToTopic", () => {
  it("puts the whole storyline in the topic its phrase opened", async () => {
    const inserted = await attachStorylineToTopic(harness.db, {
      fingerprint: PHRASE_TOPIC,
      storylineId: ids.hub!,
      tokens: ["chief", "police"],
      language: "en",
    });

    expect(inserted).toBe(2);

    const page = await readTimelinePage(harness.db, { fingerprint: PHRASE_TOPIC, limit: 25 });
    // One slot, because the two articles are one storyline — which is the
    // whole point: the reader clicked a phrase on that slot.
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.members.map((member) => member.article.id).sort()).toEqual(
      [ids.hub!, ids.angle!].sort(),
    );
  });

  it("is idempotent, so a re-read of the same link enrolls nothing new", async () => {
    const again = await attachStorylineToTopic(harness.db, {
      fingerprint: PHRASE_TOPIC,
      storylineId: ids.hub!,
      tokens: ["chief", "police"],
      language: "en",
    });

    // Zero is load-bearing at the caller: it is how the planner knows a cached
    // page is still trustworthy.
    expect(again).toBe(0);
  });

  it("refuses an article that does not carry every keyword", async () => {
    // The volcano shares nothing but the day, and a crafted link cannot put it
    // in a topic about police chiefs.
    const inserted = await attachStorylineToTopic(harness.db, {
      fingerprint: PHRASE_TOPIC,
      storylineId: ids.stranger!,
      tokens: ["chief", "police"],
      language: "en",
    });

    expect(inserted).toBe(0);
  });

  it("cannot be aimed at a topic whose keywords the storyline lacks", async () => {
    const inserted = await attachStorylineToTopic(harness.db, {
      fingerprint: WRONG_TOPIC,
      storylineId: ids.hub!,
      tokens: ["banana"],
      language: null,
    });

    expect(inserted).toBe(0);
    const page = await readTimelinePage(harness.db, { fingerprint: WRONG_TOPIC, limit: 25 });
    expect(page.items).toHaveLength(0);
  });

  it("refuses an article whose language is not the topic's", async () => {
    // The same two words, searched on a Spanish timeline. A topic's language
    // is part of what it IS, so English coverage does not belong in it however
    // well the tokens line up.
    const spanish = testFingerprint("e5"); // same phrase, Spanish timeline
    await upsertTopic(harness.db, {
      fingerprint: spanish,
      keywords: ["chiefs", "police"],
      language: "es",
    });

    const inserted = await attachStorylineToTopic(harness.db, {
      fingerprint: spanish,
      storylineId: ids.hub!,
      tokens: ["chief", "police"],
      language: "es",
    });

    expect(inserted).toBe(0);
  });

  it("enrolls nothing when the gate is empty or the id is not one", async () => {
    // An empty gate would enroll the storyline wholesale; a non-numeric id
    // would reach a bigint column as a cast error rather than a miss.
    expect(
      await attachStorylineToTopic(harness.db, {
        fingerprint: PHRASE_TOPIC,
        storylineId: ids.hub!,
        tokens: [],
        language: "en",
      }),
    ).toBe(0);
    expect(
      await attachStorylineToTopic(harness.db, {
        fingerprint: PHRASE_TOPIC,
        storylineId: "1; drop table articles",
        tokens: ["police"],
        language: "en",
      }),
    ).toBe(0);
  });
});
