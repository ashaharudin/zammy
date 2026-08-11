import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Article } from "@zammy/shared";
import { deriveDedupKey, type Sighting } from "@zammy/currents-client";
import { ingestSightings, upsertTopic } from "./ingest.js";
import { migrateToLatest } from "./migrator.js";
import { readTimelinePage, type TimelinePage } from "./timeline.js";
import { recordGrouping } from "./grouping.js";
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

/**
 * Every article on the page, in timeline order. A page is a page of GROUPS
 * (§14.3); with no grouping applied each group holds exactly one article, so
 * the collapse assertions below read the same as they did before groups
 * existed — which is the point: grouping must not change an ungrouped store.
 */
const articlesOn = (page: TimelinePage) => page.items.flatMap((group) => group.members);

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
    const items = articlesOn(page);

    expect(page.items).toHaveLength(25);
    expect(items).toHaveLength(25);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();

    const urls = new Set(items.map((item) => item.url));
    expect(urls.size).toBe(25);

    for (const item of items) {
      expect(() => Article.parse(item)).not.toThrow();
    }

    // The 50×-emitted roundup is one card with its count, not fifty cards.
    const counts = items.map((item) => item.sightingCount);
    expect(counts.filter((count) => count === 50).length).toBeLessThanOrEqual(1);
  });

  it("orders by published DESC with the newest article first", async () => {
    const page = await readTimelinePage(harness.db, { fingerprint: TOPIC, limit: 42 });

    const times = page.items.map((group) => Date.parse(group.published));
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]!);
    }

    // Spot-check against the input, computed independently of the SQL: the top
    // card is the article whose EARLIEST emission is the newest.
    const newest = Math.max(...earliestByKey().values());
    expect(Date.parse(page.items[0]!.published)).toBe(newest);
    expect(Date.parse(articlesOn(page)[0]!.published)).toBe(newest);
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

      for (const item of articlesOn(page)) {
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

    expect(articlesOn(page)).toHaveLength(expected);
    for (const item of articlesOn(page)) {
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

describe("a grouped story is one slot in the timeline", () => {
  let harness: TestDatabase;
  const GROUPED_TOPIC = testFingerprint("62012");
  const NARROW_TOPIC = testFingerprint("6201d");

  /** Same story, three outlets, three URLs — what URL dedup cannot collapse. */
  const syndicated = (n: number, published: string): Sighting => ({
    id: `00000000-0000-4000-8000-0000000009${String(n).padStart(2, "0")}`,
    url: `https://outlet${n}.example/rate-decision`,
    dedupKey: deriveDedupKey(`https://outlet${n}.example/rate-decision`),
    title: "Bank of Canada holds interest rate",
    description: null,
    author: null,
    imageUrl: null,
    language: "en",
    categories: [],
    sourceCategories: [],
    sourceDomain: `outlet${n}.example`,
    published,
    raw: {},
  });

  let groupId: string;
  let members: string[];

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
    await upsertTopic(harness.db, { fingerprint: GROUPED_TOPIC, keywords: ["rate"] });
    await upsertTopic(harness.db, { fingerprint: NARROW_TOPIC, keywords: ["boc"] });

    // Ingested newest-first, as upstream sorts them: the seed is therefore
    // NOT the earliest member, which is exactly the case that would break a
    // position derived from the seed instead of from the group.
    const ingested = await ingestSightings(harness.db, {
      fingerprint: GROUPED_TOPIC,
      sightings: [
        syndicated(1, "2026-08-11T18:00:00.000Z"),
        syndicated(2, "2026-08-11T15:00:00.000Z"),
        syndicated(3, "2026-08-11T09:00:00.000Z"),
      ],
    });
    members = ingested.createdArticles.map((article) => article.id);
    groupId = members[0]!;

    const tokens = ["bank", "canada", "holds", "interest", "rate"];
    for (const id of members) {
      await recordGrouping(harness.db, {
        articleId: id,
        titleTokens: tokens,
        groupId: id === groupId ? null : groupId,
      });
    }

    // One member also matched a second, narrower topic.
    await ingestSightings(harness.db, {
      fingerprint: NARROW_TOPIC,
      sightings: [syndicated(2, "2026-08-11T15:00:00.000Z")],
    });

    // An unrelated article, to prove a page counts groups and not articles.
    await ingestSightings(harness.db, {
      fingerprint: GROUPED_TOPIC,
      sightings: [
        {
          ...syndicated(9, "2026-08-11T12:00:00.000Z"),
          title: "Unrelated ferry story",
          url: "https://outlet9.example/ferry",
          dedupKey: deriveDedupKey("https://outlet9.example/ferry"),
        },
      ],
    });
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("returns the group once, carrying every member", async () => {
    const page = await readTimelinePage(harness.db, { fingerprint: GROUPED_TOPIC, limit: 25 });

    expect(page.items).toHaveLength(2); // the group + the ferry story
    const group = page.items.find((item) => item.id === groupId);
    expect(group?.members.map((member) => member.id).sort()).toEqual([...members].sort());
  });

  it("positions the group at its earliest member, not its seed", async () => {
    const page = await readTimelinePage(harness.db, { fingerprint: GROUPED_TOPIC, limit: 25 });
    const group = page.items.find((item) => item.id === groupId);

    expect(group?.published).toBe("2026-08-11T09:00:00.000Z");
    // …and therefore BELOW the ferry story, which is the reordering a naive
    // "position by newest member" would get backwards.
    expect(page.items[0]?.id).not.toBe(groupId);
  });

  it("orders members newest first, whatever order they arrived in", async () => {
    const page = await readTimelinePage(harness.db, { fingerprint: GROUPED_TOPIC, limit: 25 });
    const group = page.items.find((item) => item.id === groupId);

    expect(group?.members.map((member) => member.published)).toEqual([
      "2026-08-11T18:00:00.000Z",
      "2026-08-11T15:00:00.000Z",
      "2026-08-11T09:00:00.000Z",
    ]);
  });

  it("carries only the members that belong to the topic being read", async () => {
    // Groups are global; membership is per-topic. A narrower topic must see
    // its own article, never the two that never matched its keywords (§14.3).
    const page = await readTimelinePage(harness.db, { fingerprint: NARROW_TOPIC, limit: 25 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(groupId);
    expect(page.items[0]?.members).toHaveLength(1);
    expect(page.items[0]?.members[0]?.sourceDomain).toBe("outlet2.example");
  });

  it("counts GROUPS against the page limit, so page size stays predictable", async () => {
    // The objection ADR-0002 raised against read-time collapse: a page of 25
    // collapsing to 3 makes `hasMore` a lie. A page of 1 must be one group,
    // three articles and all.
    const first = await readTimelinePage(harness.db, { fingerprint: GROUPED_TOPIC, limit: 1 });

    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await readTimelinePage(harness.db, {
      fingerprint: GROUPED_TOPIC,
      limit: 1,
      cursor: first.nextCursor!,
    });

    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(second.hasMore).toBe(false);

    // Two slots hold all four articles, each exactly once: a member is never
    // both inside its group and loose on some other page.
    const slots = [...first.items, ...second.items];
    const seen = slots.flatMap((slot) => slot.members.map((member) => member.id));
    expect(slots).toHaveLength(2);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(4);
  });

  it("keeps an in-window article whose group sits before the window", async () => {
    // The window asks about the afternoon; this group was first reported at
    // 09:00 and covered again at 15:00 and 18:00. Selecting groups by their
    // POSITION would drop those two articles from a window they fall squarely
    // inside — and coverage would record the window as fetched, so nothing
    // would go looking for them again (§7.2).
    const page = await readTimelinePage(harness.db, {
      fingerprint: GROUPED_TOPIC,
      from: new Date("2026-08-11T13:00:00.000Z"),
      to: new Date("2026-08-11T20:00:00.000Z"),
      limit: 25,
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(groupId);
    expect(page.items[0]?.members).toHaveLength(3);
    // …and it still reports when the story broke, outside the window or not.
    expect(page.items[0]?.published).toBe("2026-08-11T09:00:00.000Z");
  });

  it("excludes a group with no member in the window", async () => {
    const page = await readTimelinePage(harness.db, {
      fingerprint: GROUPED_TOPIC,
      from: new Date("2026-08-11T10:00:00.000Z"),
      to: new Date("2026-08-11T11:00:00.000Z"),
      limit: 25,
    });

    expect(page.items).toEqual([]);
  });

  it("resumes from a cursor on the group's position, not the member's", async () => {
    const page = await readTimelinePage(harness.db, {
      fingerprint: GROUPED_TOPIC,
      limit: 25,
      // Just after the group's position: the group must be excluded whole,
      // including the 18:00 member that sits later than this cursor.
      cursor: { published: "2026-08-11T09:00:00.000Z", articleId: groupId },
    });

    expect(page.items).toHaveLength(0);
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
      seen.push(...articlesOn(page).map((item) => item.id));
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
