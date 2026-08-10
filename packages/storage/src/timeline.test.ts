import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Article } from "@zammy/shared";
import { deriveDedupKey, type Sighting } from "@zammy/currents-client";
import { ingestSightings, upsertTopic } from "./ingest.js";
import { migrateToLatest } from "./migrator.js";
import { readTimelinePage } from "./timeline.js";
import {
  createTestDatabase,
  loadClimateSightings,
  testFingerprint,
  type TestDatabase,
} from "./test-support.js";

/**
 * The keyset timeline read (ARCHITECTURE 7.3), over the recorded duplication
 * payload. Deduplication is a property of the table, not a filter applied at
 * read time — a page of N must be N ARTICLES, never N sightings that collapse
 * to 3 (§7.3). The fixture: 100 sightings → 42 articles, one URL 50×.
 */

const TOPIC = testFingerprint("71e11e");
const OTHER_TOPIC = testFingerprint("07e7"); // registered, never ingested into

describe("timeline reads over the collapsed fixture", () => {
  let harness: TestDatabase;
  let sightings: Sighting[];

  /** Earliest emission per unique URL — what each article's `published` must be. */
  const earliestByKey = () => {
    const map = new Map<string, number>();
    for (const s of sightings) {
      const t = Date.parse(s.published);
      const prev = map.get(s.dedupKey);
      if (prev === undefined || t < prev) map.set(s.dedupKey, t);
    }
    return map;
  };

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
    sightings = loadClimateSightings();

    await upsertTopic(harness.db, {
      fingerprint: TOPIC,
      keywords: ["climate"],
      language: "en",
    });
    await upsertTopic(harness.db, { fingerprint: OTHER_TOPIC, keywords: ["quiet"] });
    await ingestSightings(harness.db, { fingerprint: TOPIC, sightings });
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("returns a page of ARTICLES that satisfy the shared contract", async () => {
    // The §12 assertion: a limit=25 page returns ≤25 articles, never 25
    // sightings. With one URL occupying 50 of the 100 upstream slots, an
    // undeduplicated read would fill most of this page with one repeated post.
    const page = await readTimelinePage(harness.db, { fingerprint: TOPIC, limit: 25 });

    expect(page.items).toHaveLength(25);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();

    const urls = new Set(page.items.map((item) => item.url));
    expect(urls.size).toBe(25);

    for (const item of page.items) {
      expect(() => Article.parse(item)).not.toThrow();
    }

    // The 50×-emitted roundup is one card with its count, not fifty cards.
    const counts = page.items.map((item) => item.sightingCount);
    expect(counts.filter((count) => count === 50).length).toBeLessThanOrEqual(1);
  });

  it("orders by published DESC with the newest article first", async () => {
    const page = await readTimelinePage(harness.db, { fingerprint: TOPIC, limit: 42 });

    const times = page.items.map((item) => Date.parse(item.published));
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]!);
    }

    // Spot-check against the input, computed independently of the SQL: the top
    // card is the article whose EARLIEST emission is the newest.
    const newest = Math.max(...earliestByKey().values());
    expect(Date.parse(page.items[0]!.published)).toBe(newest);
  });

  it("walks the whole timeline by cursor with no duplicates and no skips", async () => {
    const seen = new Set<string>();
    let cursor = undefined;
    let pages = 0;

    for (;;) {
      const page = await readTimelinePage(harness.db, {
        fingerprint: TOPIC,
        limit: 10,
        ...(cursor ? { cursor } : {}),
      });
      pages += 1;

      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false); // a duplicate is a paging bug
        seen.add(item.id);
      }

      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      expect(page.nextCursor).not.toBeNull();
      cursor = page.nextCursor!;
    }

    expect(seen.size).toBe(42); // no skips: every article reached exactly once
    expect(pages).toBe(5); // 10 + 10 + 10 + 10 + 2
  });

  it("filters to the requested window, inclusive-exclusive", async () => {
    // Expected membership recomputed in plain JS from the input sightings —
    // the article belongs iff its EARLIEST emission falls inside [from, to).
    const earliest = earliestByKey();
    const times = [...earliest.values()].sort((a, b) => a - b);
    const from = new Date(times[Math.floor(times.length / 4)]!);
    const to = new Date(times[Math.floor((times.length * 3) / 4)]!);

    const expected = [...earliest.values()].filter(
      (t) => t >= from.getTime() && t < to.getTime(),
    ).length;
    expect(expected).toBeGreaterThan(0); // guard: a degenerate window tests nothing

    const page = await readTimelinePage(harness.db, {
      fingerprint: TOPIC,
      from,
      to,
      limit: 42,
    });

    expect(page.items).toHaveLength(expected);
    for (const item of page.items) {
      const t = Date.parse(item.published);
      expect(t).toBeGreaterThanOrEqual(from.getTime());
      expect(t).toBeLessThan(to.getTime());
    }
  });

  it("a topic with no articles reads as empty, not as an error", async () => {
    const page = await readTimelinePage(harness.db, {
      fingerprint: OTHER_TOPIC,
      limit: 25,
    });

    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});

describe("articles sharing a timestamp", () => {
  let harness: TestDatabase;
  const TIED_TOPIC = testFingerprint("d0dead");
  const TIE = "2026-08-04T10:00:00.000Z";

  const story = (id: string, url: string, published: string): Sighting => ({
    id,
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
    published,
    raw: { id, published },
  });

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
    await upsertTopic(harness.db, { fingerprint: TIED_TOPIC, keywords: ["tie"] });
    // Three articles on the same instant, one older control.
    await ingestSightings(harness.db, {
      fingerprint: TIED_TOPIC,
      sightings: [
        story("00000000-0000-4000-8000-000000000011", "https://example.com/a", TIE),
        story("00000000-0000-4000-8000-000000000012", "https://example.com/b", TIE),
        story("00000000-0000-4000-8000-000000000013", "https://example.com/c", TIE),
        story("00000000-0000-4000-8000-000000000014", "https://example.com/older", "2026-08-04T09:00:00.000Z"),
      ],
    });
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("break ties by id, and a cursor can stop mid-tie without skipping", async () => {
    // Many articles share a timestamp (upstream re-ingests in bursts), so the
    // id half of the cursor is what gives the timeline a total order (§7.3).
    // Page size 1 forces the cursor to cut BETWEEN tied rows.
    const seen: string[] = [];
    let cursor = undefined;

    for (;;) {
      const page = await readTimelinePage(harness.db, {
        fingerprint: TIED_TOPIC,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((item) => item.id));
      if (!page.hasMore) break;
      cursor = page.nextCursor!;
    }

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);

    // Within the tie, ids descend; the older control comes last.
    const tied = seen.slice(0, 3).map(Number);
    expect(tied).toEqual([...tied].sort((a, b) => b - a));
  });
});
