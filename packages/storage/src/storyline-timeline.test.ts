import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Article } from "@zammy/shared";
import { deriveAltKey, deriveDedupKey, type Sighting } from "@zammy/news-client";
import { ingestSightings, upsertTopic } from "./ingest.js";
import { migrateToLatest } from "./migrator.js";
import {
  readGroupMemberships,
  readStorylineTimelinePage,
  type StorylineTimelinePage,
} from "./storyline-timeline.js";
import {
  attachGroup,
  createProvisionalStoryline,
  promoteStoryline,
  setStorylineLabel,
} from "./storylines.js";
import { recordGrouping } from "./grouping.js";
import {
  createTestDatabase,
  loadClimateSightings,
  testFingerprint,
  type TestDatabase,
} from "./test-support.js";

/**
 * The keyset timeline read (ARCHITECTURE 7.3, ADR-0011), over the recorded
 * duplication payload.
 *
 * Ported from the day-bounded read's tests when S9 dropped it: the questions
 * are unchanged — a page of N must be N ARTICLES rather than N sightings that
 * collapse to 3, the cursor must reach every slot exactly once, a window is
 * inclusive-exclusive on an ARTICLE's own published — and only the unit they
 * are asked about moved, from a day-bounded storyline to a storyline-day.
 * The fixture is the same one: 100 sightings → 42 articles, one URL 50×.
 */

const TOPIC = testFingerprint("71e11e");
const OTHER_TOPIC = testFingerprint("07e7"); // registered, never ingested into
const TZ = "UTC";

/** Every article on the page, in timeline order. */
const articlesOn = (page: StorylineTimelinePage) =>
  page.items.flatMap((slot) => slot.members);

/**
 * Give every group its own provisional storyline — the state the linker leaves
 * behind when nothing links, and what makes a storyline-day slot equal to the
 * ordinary article slot (ADR-0011's Lifecycle).
 */
async function seedStorylines(harness: TestDatabase): Promise<void> {
  const groups = await harness.db
    .selectFrom("articles")
    .select("group_id")
    .distinct()
    .execute();
  for (const { group_id } of groups) {
    await createProvisionalStoryline(harness.db, { groupId: group_id, timeZone: TZ });
  }
}

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

    await upsertTopic(harness.db, { fingerprint: TOPIC, keywords: ["climate"], language: "en" });
    await upsertTopic(harness.db, { fingerprint: OTHER_TOPIC, keywords: ["quiet"] });
    await ingestSightings(harness.db, { plane: "search", timeZone: TZ, fingerprint: TOPIC, sightings });
    await seedStorylines(harness);
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("returns a page of ARTICLES that satisfy the shared contract", async () => {
    // The §12 assertion: a limit=25 page returns ≤25 articles, never 25
    // sightings. With one URL occupying 50 of the 100 upstream slots, an
    // undeduplicated read would fill most of this page with one repeated post.
    const page = await readStorylineTimelinePage(harness.db, {
      fingerprint: TOPIC,
      limit: 25,
      timeZone: TZ,
    });
    const items = articlesOn(page);

    expect(page.items).toHaveLength(25);
    expect(items).toHaveLength(25);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();

    expect(new Set(items.map((item) => item.url)).size).toBe(25);
    for (const item of items) expect(() => Article.parse(item)).not.toThrow();

    // The 50×-emitted roundup is one card with its count, not fifty cards.
    const counts = items.map((item) => item.sightingCount);
    expect(counts.filter((count) => count === 50).length).toBeLessThanOrEqual(1);
  });

  it("orders by the slot's position DESC, newest first", async () => {
    const page = await readStorylineTimelinePage(harness.db, {
      fingerprint: TOPIC,
      limit: 42,
      timeZone: TZ,
    });

    const times = page.items.map((slot) => Date.parse(slot.published));
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]!);
    }

    // Spot-check against the input, computed independently of the SQL.
    const newest = Math.max(...earliestByKey().values());
    expect(Date.parse(page.items[0]!.published)).toBe(newest);
  });

  it("walks the whole timeline by cursor with no duplicates and no skips", async () => {
    const seen = new Set<string>();
    let cursor = undefined;
    let pages = 0;

    for (;;) {
      const page = await readStorylineTimelinePage(harness.db, {
        fingerprint: TOPIC,
        limit: 10,
        timeZone: TZ,
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

    // 41, not the fixture's 42 URLs: the fallback key folds one Times of India
    // blog post filed under two section paths onto one article (ADR-0018).
    expect(seen.size).toBe(41); // no skips: every article reached exactly once
    expect(pages).toBe(5); // 10 + 10 + 10 + 10 + 1
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

    const page = await readStorylineTimelinePage(harness.db, {
      fingerprint: TOPIC,
      from,
      to,
      limit: 42,
      timeZone: TZ,
    });

    expect(articlesOn(page)).toHaveLength(expected);
    for (const item of articlesOn(page)) {
      const t = Date.parse(item.published);
      expect(t).toBeGreaterThanOrEqual(from.getTime());
      expect(t).toBeLessThan(to.getTime());
    }
  });

  it("a topic with no articles reads as empty, not as an error", async () => {
    const page = await readStorylineTimelinePage(harness.db, {
      fingerprint: OTHER_TOPIC,
      limit: 25,
      timeZone: TZ,
    });

    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});

describe("a storyline's day is one slot in the timeline", () => {
  let harness: TestDatabase;
  const GROUPED_TOPIC = testFingerprint("62012");
  const DAY = "2026-08-04";

  let storylineId: string;

  const story = (id: string, url: string, published: string, title: string): Sighting => ({
    id,
    url,
    provider: "currents",
    providerSightingId: url,
    dedupKey: deriveDedupKey(url),
    altKey: deriveAltKey(new URL(url).hostname, title, published),
    title,
    description: null,
    author: null,
    imageUrl: null,
    language: "en",
    categories: [],
    sourceCategories: [],
    sourceDomain: new URL(url).hostname,
    published,
    raw: { id },
  });

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
    await upsertTopic(harness.db, { fingerprint: GROUPED_TOPIC, keywords: ["rate"] });

    // Two groups, both covering one story on one day: the syndicated pair and
    // an angle piece. Under ADR-0011 they are one storyline, so one slot.
    const ingested = await ingestSightings(harness.db, {
      plane: "search",
      timeZone: TZ,
      fingerprint: GROUPED_TOPIC,
      sightings: [
        story("00000000-0000-4000-8000-000000000021", "https://a.example/x", `${DAY}T09:00:00.000Z`, "Bank holds rate"),
        story("00000000-0000-4000-8000-000000000022", "https://b.example/x", `${DAY}T11:00:00.000Z`, "Bank holds rate"),
        story("00000000-0000-4000-8000-000000000023", "https://c.example/y", `${DAY}T13:00:00.000Z`, "What the hold means"),
      ],
    });

    const [first, second, angle] = ingested.createdArticles;
    // The syndicated pair is one group; the angle piece leads its own.
    await recordGrouping(harness.db, {
      articleId: second!.id,
      titleTokens: ["bank", "hold", "rate"],
      tokensVersion: 1,
      groupId: first!.id,
    });

    const storyline = await createProvisionalStoryline(harness.db, {
      groupId: first!.id,
      timeZone: TZ,
    });
    await attachGroup(harness.db, {
      storylineId: storyline.id,
      groupId: angle!.id,
      timeZone: TZ,
    });
    storylineId = storyline.id;
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("returns the storyline-day once, carrying every member group's articles", async () => {
    const page = await readStorylineTimelinePage(harness.db, {
      fingerprint: GROUPED_TOPIC,
      limit: 25,
      timeZone: TZ,
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.storylineId).toBe(storylineId);
    expect(page.items[0]!.dayKey).toBe(DAY);
    expect(page.items[0]!.members).toHaveLength(3);
  });

  it("positions the slot at that day's EARLIEST article", async () => {
    const page = await readStorylineTimelinePage(harness.db, {
      fingerprint: GROUPED_TOPIC,
      limit: 25,
      timeZone: TZ,
    });
    expect(page.items[0]!.published).toBe(`${DAY}T09:00:00.000Z`);
  });

  it("orders members newest first, whatever order they arrived in", async () => {
    const page = await readStorylineTimelinePage(harness.db, {
      fingerprint: GROUPED_TOPIC,
      limit: 25,
      timeZone: TZ,
    });
    const times = page.items[0]!.members.map((m) => Date.parse(m.published));
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]!);
    }
  });

  it("counts SLOTS against the page limit, so page size stays predictable", async () => {
    // ADR-0002's objection to read-time collapsing: a page of 25 that collapses
    // to 3 makes `hasMore` unreliable. One slot holding three articles is one.
    const page = await readStorylineTimelinePage(harness.db, {
      fingerprint: GROUPED_TOPIC,
      limit: 1,
      timeZone: TZ,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.members).toHaveLength(3);
    expect(page.hasMore).toBe(false);
  });

  it("carries only the members that belong to the topic being read", async () => {
    // A storyline is global; a topic's view of it is not. A global member list
    // could surface an article that never matched the search.
    const NARROW = testFingerprint("62013");
    await upsertTopic(harness.db, { fingerprint: NARROW, keywords: ["narrow"] });
    const only = await harness.db
      .selectFrom("articles")
      .select("id")
      .orderBy("published", "asc")
      .limit(1)
      .executeTakeFirstOrThrow();
    await harness.db
      .insertInto("topic_articles")
      .values({ fingerprint: Buffer.from(NARROW, "hex"), article_id: only.id })
      .execute();

    const page = await readStorylineTimelinePage(harness.db, {
      fingerprint: NARROW,
      limit: 25,
      timeZone: TZ,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.members).toHaveLength(1);
    expect(page.items[0]!.members[0]!.id).toBe(only.id);
  });

  it("splits a storyline's coverage across days into one slot each", async () => {
    // The property that makes "unbounded in time" free at read time: no slot
    // ever spans days, so the keyset survives unchanged in shape.
    const NEXT = "2026-08-05";
    const ingested = await ingestSightings(harness.db, {
      plane: "search",
      timeZone: TZ,
      fingerprint: GROUPED_TOPIC,
      sightings: [
        story("00000000-0000-4000-8000-000000000024", "https://d.example/z", `${NEXT}T08:00:00.000Z`, "Rate hold reaction"),
      ],
    });
    await attachGroup(harness.db, {
      storylineId,
      groupId: ingested.createdArticles[0]!.id,
      timeZone: TZ,
    });

    const page = await readStorylineTimelinePage(harness.db, {
      fingerprint: GROUPED_TOPIC,
      limit: 25,
      timeZone: TZ,
    });

    expect(page.items).toHaveLength(2);
    expect(page.items.map((slot) => slot.dayKey)).toEqual([NEXT, DAY]);
    expect(page.items.every((slot) => slot.storylineId === storylineId)).toBe(true);
  });
});

describe("slots sharing a position", () => {
  let harness: TestDatabase;
  const TIED_TOPIC = testFingerprint("d0dead");
  const TIE = "2026-08-04T10:00:00.000Z";

  const story = (id: string, url: string, published: string): Sighting => ({
    id,
    url,
    provider: "currents",
    providerSightingId: url,
    dedupKey: deriveDedupKey(url),
    altKey: deriveAltKey("example.com", `story at ${url}`, published),
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
    await ingestSightings(harness.db, {
      plane: "search",
      timeZone: TZ,
      fingerprint: TIED_TOPIC,
      sightings: [
        story("00000000-0000-4000-8000-000000000011", "https://example.com/a", TIE),
        story("00000000-0000-4000-8000-000000000012", "https://example.com/b", TIE),
        story("00000000-0000-4000-8000-000000000013", "https://example.com/c", TIE),
        story("00000000-0000-4000-8000-000000000014", "https://example.com/older", "2026-08-04T09:00:00.000Z"),
      ],
    });
    await seedStorylines(harness);
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("breaks ties by storyline id, and a cursor can stop mid-tie without skipping", async () => {
    // Many slots share a position (upstream re-ingests in bursts), so the id
    // half of the cursor is what gives the timeline a total order (§7.3).
    // Page size 1 forces the cursor to cut BETWEEN tied rows.
    const seen: string[] = [];
    let cursor = undefined;

    for (;;) {
      const page = await readStorylineTimelinePage(harness.db, {
        fingerprint: TIED_TOPIC,
        limit: 1,
        timeZone: TZ,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((slot) => slot.storylineId));
      if (!page.hasMore) break;
      cursor = page.nextCursor!;
    }

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);

    // Within the tie, ids descend — a total order the timestamps alone do not
    // provide, and the reason the cursor carries an id at all.
    const tied = seen.slice(0, 3);
    expect([...tied].sort().reverse()).toEqual(tied);
  });
});

/**
 * The storyline VIEW's read, over several arcs at once (ADR-0028): the same
 * keyset, a wider predicate. What is under test is that widening the predicate
 * is ALL it takes — the page comes out in time order across the arcs, and only
 * the arcs asked for are on it.
 */
describe("a view of several storylines", () => {
  let harness: TestDatabase;
  const VIEW_TOPIC = testFingerprint("a11ce");
  let flood: string;
  let strike: string;
  let bystander: string;

  const story = (id: string, url: string, published: string, title: string): Sighting => ({
    id,
    url,
    provider: "currents",
    providerSightingId: url,
    dedupKey: deriveDedupKey(url),
    altKey: deriveAltKey(new URL(url).hostname, title, published),
    title,
    description: null,
    author: null,
    imageUrl: null,
    language: "en",
    categories: [],
    sourceCategories: [],
    sourceDomain: new URL(url).hostname,
    published,
    raw: { id },
  });

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
    await upsertTopic(harness.db, { fingerprint: VIEW_TOPIC, keywords: ["news"] });

    // Three arcs, each its own group per day. The flood runs the 4th and the
    // 6th, the strike the 5th, the bystander the 5th too — so a view of the
    // flood and the strike interleaves (6th, 5th, 4th) and must skip the
    // bystander's 5th.
    const ingested = await ingestSightings(harness.db, {
      plane: "search",
      timeZone: TZ,
      fingerprint: VIEW_TOPIC,
      sightings: [
        story("00000000-0000-4000-8000-000000000031", "https://f.example/1", "2026-08-04T09:00:00.000Z", "Flood hits valley"),
        story("00000000-0000-4000-8000-000000000032", "https://f.example/2", "2026-08-06T09:00:00.000Z", "Flood waters recede"),
        story("00000000-0000-4000-8000-000000000033", "https://s.example/1", "2026-08-05T09:00:00.000Z", "Rail strike begins"),
        story("00000000-0000-4000-8000-000000000034", "https://b.example/1", "2026-08-05T12:00:00.000Z", "Unrelated bystander"),
      ],
    });
    const [flood1, flood2, strike1, bystander1] = ingested.createdArticles;

    const floodArc = await createProvisionalStoryline(harness.db, { groupId: flood1!.id, timeZone: TZ });
    await attachGroup(harness.db, { storylineId: floodArc.id, groupId: flood2!.id, timeZone: TZ });
    flood = floodArc.id;
    strike = (await createProvisionalStoryline(harness.db, { groupId: strike1!.id, timeZone: TZ })).id;
    bystander = (await createProvisionalStoryline(harness.db, { groupId: bystander1!.id, timeZone: TZ })).id;
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("pages both arcs' days on one keyset, newest first across them", async () => {
    const page = await readStorylineTimelinePage(harness.db, {
      fingerprint: null,
      storylineIds: [flood, strike],
      limit: 25,
      timeZone: TZ,
    });

    expect(page.items.map((slot) => [slot.storylineId, slot.dayKey])).toEqual([
      [flood, "2026-08-06"],
      [strike, "2026-08-05"],
      [flood, "2026-08-04"],
    ]);
    expect(page.items.some((slot) => slot.storylineId === bystander)).toBe(false);
  });

  it("carries a cursor across the arcs, so a reader resumes between them", async () => {
    const first = await readStorylineTimelinePage(harness.db, {
      fingerprint: null,
      storylineIds: [flood, strike],
      limit: 1,
      timeZone: TZ,
    });
    expect(first.hasMore).toBe(true);
    const second = await readStorylineTimelinePage(harness.db, {
      fingerprint: null,
      storylineIds: [flood, strike],
      limit: 1,
      timeZone: TZ,
      cursor: first.nextCursor!,
    });

    expect(first.items[0]!.storylineId).toBe(flood);
    expect(second.items[0]!.storylineId).toBe(strike);
  });

  it("reads one arc exactly as the single view always did", async () => {
    const page = await readStorylineTimelinePage(harness.db, {
      fingerprint: null,
      storylineIds: [strike],
      limit: 25,
      timeZone: TZ,
    });
    expect(page.items.map((slot) => slot.dayKey)).toEqual(["2026-08-05"]);
  });
});

/**
 * `readGroupMemberships` — which storylines a group is filed in (ADR-0025).
 *
 * The fact CONTEXT.md states and the wire could not carry: "A group may belong
 * to several storylines." Membership is a property of the GROUP, so these are
 * asked of group ids and answered without a slot in sight.
 */
describe("a group's storylines", () => {
  let harness: TestDatabase;
  const MEMBERSHIP_TOPIC = testFingerprint("9e11b0");
  const DAY = "2026-08-19";

  /** g1: only in `arcA`. g2: in BOTH arcs — the crossing. g3: only in `arcB`. */
  let g1: string;
  let g2: string;
  let g3: string;
  let arcA: string;
  let arcB: string;

  const story = (id: string, url: string, published: string, title: string): Sighting => ({
    id,
    url,
    provider: "currents",
    providerSightingId: url,
    dedupKey: deriveDedupKey(url),
    altKey: deriveAltKey(new URL(url).hostname, title, published),
    title,
    description: null,
    author: null,
    imageUrl: null,
    language: "en",
    categories: [],
    sourceCategories: [],
    sourceDomain: new URL(url).hostname,
    published,
    raw: { id },
  });

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
    await upsertTopic(harness.db, { fingerprint: MEMBERSHIP_TOPIC, keywords: ["tanker"] });

    const ingested = await ingestSightings(harness.db, {
      plane: "search",
      timeZone: TZ,
      fingerprint: MEMBERSHIP_TOPIC,
      sightings: [
        story("00000000-0000-4000-8000-000000000031", "https://a.example/1", `${DAY}T09:00:00.000Z`, "Tanker seized"),
        story("00000000-0000-4000-8000-000000000032", "https://b.example/2", `${DAY}T10:00:00.000Z`, "Safety review ordered"),
        story("00000000-0000-4000-8000-000000000033", "https://c.example/3", `${DAY}T11:00:00.000Z`, "Sanctions widened"),
      ],
    });
    const [first, second, third] = ingested.createdArticles;
    g1 = first!.id;
    g2 = second!.id;
    g3 = third!.id;

    // Arc A holds g1 and g2; arc B holds g3 and g2. The middle group is in two
    // real storylines, which is the whole fact under test.
    const a = await createProvisionalStoryline(harness.db, { groupId: g1, timeZone: TZ });
    await attachGroup(harness.db, { storylineId: a.id, groupId: g2, timeZone: TZ });
    await promoteStoryline(harness.db, { storylineId: a.id });
    arcA = a.id;

    const b = await createProvisionalStoryline(harness.db, { groupId: g3, timeZone: TZ });
    await attachGroup(harness.db, { storylineId: b.id, groupId: g2, timeZone: TZ });
    await promoteStoryline(harness.db, { storylineId: b.id });
    arcB = b.id;
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("reports a group filed in two storylines, naming both", async () => {
    const { byGroup } = await readGroupMemberships(harness.db, [g1, g2, g3]);
    expect([...(byGroup.get(g2) ?? [])].sort()).toEqual([arcA, arcB].sort());
  });

  it("says nothing about a group filed in exactly one", async () => {
    const { byGroup } = await readGroupMemberships(harness.db, [g1, g2, g3]);
    // Absent, not present-with-one-entry: the arc a single-membership group is
    // in is the arc of whatever slot it appears in, already on the wire.
    expect(byGroup.has(g1)).toBe(false);
    expect(byGroup.has(g3)).toBe(false);
  });

  it("describes every storyline it names, and no others", async () => {
    const { byGroup, storylines } = await readGroupMemberships(harness.db, [g2]);
    const named = new Set([...byGroup.values()].flat());
    expect(new Set(storylines.map((storyline) => storyline.id))).toEqual(named);
  });

  it("carries the label, the span and the whole-life size of each", async () => {
    await setStorylineLabel(harness.db, {
      storylineId: arcA,
      label: "Tanker Seizure",
      labelWords: ["tanker", "seizure"],
      labelAt: new Date(),
      labelGroupCount: 2,
      labelSource: "test",
    });

    const { storylines } = await readGroupMemberships(harness.db, [g2]);
    const a = storylines.find((storyline) => storyline.id === arcA)!;
    expect(a.label).toBe("Tanker Seizure");
    expect(a.spanFrom).toBe(`${DAY}T09:00:00.000Z`);
    expect(a.spanTo).toBe(`${DAY}T09:00:00.000Z`);
    // Two member groups of one article each, over the arc's whole life.
    expect(a.size).toBe(2);
    expect(a.status).toBe("active");
  });

  it("does not count a PROVISIONAL storyline as an arc a group is also in", async () => {
    // A storyline-of-one is invisible as a storyline (ADR-0011's Lifecycle),
    // and a slot in one already reaches the browser with `storyline: null`.
    // Naming one here would be the first place the UI called it a story.
    const shadow = await createProvisionalStoryline(harness.db, { groupId: g1, timeZone: TZ });
    try {
      const { byGroup } = await readGroupMemberships(harness.db, [g1]);
      expect(byGroup.has(g1)).toBe(false);
    } finally {
      await harness.db.deleteFrom("storylines").where("id", "=", shadow.id).execute();
    }
  });

  it("does not count an ALIAS, so a merged-away UUID is never offered", async () => {
    const alias = await createProvisionalStoryline(harness.db, { groupId: g1, timeZone: TZ });
    await promoteStoryline(harness.db, { storylineId: alias.id });
    await harness.db
      .updateTable("storylines")
      .set({ merged_into: arcA })
      .where("id", "=", alias.id)
      .execute();
    try {
      const { byGroup } = await readGroupMemberships(harness.db, [g1]);
      expect(byGroup.has(g1)).toBe(false);
    } finally {
      await harness.db.updateTable("storylines").set({ merged_into: null })
        .where("id", "=", alias.id).execute();
      await harness.db.deleteFrom("storylines").where("id", "=", alias.id).execute();
    }
  });

  it("counts NAMEABLE arcs, so a provisional one cannot make up the second", async () => {
    // The threshold is "two arcs this page will name", not "two rows in
    // storyline_groups" — the provisional filter runs first. So a group in one
    // real arc and one provisional arc is absent, and a slot under the
    // provisional one is told nothing, even though the piece really is running
    // in a named arc.
    //
    // That is a LIMITATION rather than a bug (ADR-0025): the braid's solid tick
    // says which arc you are standing in, and a provisional slot has no arc to
    // make solid. Pinned here so the rule the wire documents is the rule the
    // query implements — measured at 2 groups of 28,729 on the dev archive.
    const shadow = await createProvisionalStoryline(harness.db, { groupId: g1, timeZone: TZ });
    try {
      const { byGroup } = await readGroupMemberships(harness.db, [g1]);
      expect(byGroup.has(g1)).toBe(false);

      // And the sharper case, on the group that HAS two nameable arcs: the map
      // names those two and not the provisional slot's own, so a consumer
      // standing on that slot cannot assume its arc is in the list.
      const crossing = await createProvisionalStoryline(harness.db, {
        groupId: g2,
        timeZone: TZ,
      });
      try {
        const both = await readGroupMemberships(harness.db, [g2]);
        expect([...(both.byGroup.get(g2) ?? [])].sort()).toEqual([arcA, arcB].sort());
        expect(both.byGroup.get(g2)).not.toContain(crossing.id);
      } finally {
        await harness.db.deleteFrom("storylines").where("id", "=", crossing.id).execute();
      }
    } finally {
      await harness.db.deleteFrom("storylines").where("id", "=", shadow.id).execute();
    }
  });

  it("asks nothing of the database for an empty group list", async () => {
    const { byGroup, storylines } = await readGroupMemberships(harness.db, []);
    expect(byGroup.size).toBe(0);
    expect(storylines).toEqual([]);
  });
});
