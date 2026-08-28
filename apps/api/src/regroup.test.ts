import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { deriveAltKey, deriveDedupKey, type Sighting } from "@zammy/currents-client";
import {
  createProvisionalStoryline,
  ingestSightings,
  readStoryline,
  recordGrouping,
  upsertTopic,
} from "@zammy/storage";
import { regroup } from "./regroup.js";
import { headlineTokens, TOKENIZER_VERSION } from "./grouping.js";
import { storyTokens } from "./storyline.js";
import { createTestHarness, type TestHarness } from "./test-support.js";

/**
 * The maintenance pass (ADR-0005): bring stored grouping state up to the
 * current rules.
 *
 * The scenario is the live one that forced this to exist. Two articles are the
 * same story under today's tokenizer and were NOT under yesterday's, because
 * `title_tokens` was materialized before plurals were folded — so the rows
 * store `chiefs` while the rule now says `chief`, and every comparison against
 * them has been quietly scoring low ever since.
 */

const NOW = new Date("2026-08-11T22:00:00.000Z");

let harness: TestHarness;

afterEach(async () => {
  await harness.teardown();
});

let uuid = 0;
function sighting(domain: string, title: string, published: string): Sighting {
  uuid += 1;
  const url = `https://${domain}/story-${uuid}`;
  return {
    id: `e0000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`,
    url,
    provider: "currents",
    providerSightingId: url,
    dedupKey: deriveDedupKey(url),
    altKey: deriveAltKey(domain, title, published),
    title,
    description: null,
    author: null,
    imageUrl: null,
    language: "en",
    categories: [],
    sourceCategories: [],
    sourceDomain: domain,
    published,
    raw: {},
  };
}

const BBC = "Police chiefs call for PM to prevent early release of PC Harper's killers";
const MAIL = "Every police chief is urging PM to stop release of PC Harper's killers";

/**
 * Two rows as they exist on a database written before the current tokenizer:
 * separate groups, and tokens in the OLD vocabulary (`chiefs`, `killers`).
 */
async function seedStaleRows() {
  harness = await createTestHarness({}, NOW);
  const fingerprint = randomBytes(32).toString("hex");
  await upsertTopic(harness.deps.db, { fingerprint, keywords: ["harper"], language: "en" });

  const ingested = await ingestSightings(harness.deps.db, {
    plane: "search",
    timeZone: "UTC",
    fingerprint,
    sightings: [
      sighting("dailymail.com", MAIL, "2026-08-11T20:06:00.000Z"),
      sighting("bbc.co.uk", BBC, "2026-08-11T21:21:00.000Z"),
    ],
  });

  const unstemmed: Record<string, string[]> = {
    [MAIL]: ["every", "police", "chief", "urging", "pm", "stop", "release", "pc", "harper", "killers"],
    [BBC]: ["police", "chiefs", "call", "pm", "prevent", "early", "release", "pc", "harper", "killers"],
  };
  for (const article of ingested.createdArticles) {
    await recordGrouping(harness.deps.db, {
      articleId: article.id,
      titleTokens: unstemmed[article.title]!,
      tokensVersion: TOKENIZER_VERSION - 1,
      groupId: null,
    });
  }

  return ingested.createdArticles.map((a) => a.id);
}

const groupsOf = async (ids: string[]) => {
  const rows = await harness.deps.db
    .selectFrom("articles")
    .select(["id", "group_id", "title_tokens", "tokens_version"])
    .where("id", "in", ids)
    .execute();
  return rows;
};

describe("regroup", () => {
  it("re-derives tokens left behind by an older tokenizer", async () => {
    const ids = await seedStaleRows();

    const result = await regroup(deps(), { days: 1, tokensOnly: true, now: () => NOW });

    expect(result.stale).toBe(2);
    expect(result.retokenized).toBe(2);
    const rows = await groupsOf(ids);
    for (const row of rows) {
      expect(row.tokens_version).toBe(TOKENIZER_VERSION);
      expect(row.title_tokens).toContain("killer"); // was `killers`
      expect(row.title_tokens).not.toContain("killers");
    }
  });

  it("re-derives the profile of every arc holding a retokenized row", async () => {
    // Version 8's fold made `story_tokens` say `nino` where they said `niño`,
    // and `profile_tokens` is materialized from them. Nothing else recomputes
    // it without a membership change, so a fold that stopped at the article
    // layer left the two disagreeing — and an accented search that used to
    // match an arc would have stopped matching it.
    const ids = await seedStaleRows();
    const [first] = await groupsOf(ids);
    const arc = await createProvisionalStoryline(harness.deps.db, {
      groupId: first!.group_id,
      timeZone: "UTC",
    });
    // The profile as an older vocabulary left it: the word the fold changes.
    await harness.deps.db
      .updateTable("storylines")
      .set({ profile_tokens: ["killers"] })
      .where("id", "=", arc.id)
      .execute();

    const result = await regroup(deps(), { days: 1, tokensOnly: true, now: () => NOW });

    expect(result.refreshed).toBeGreaterThan(0);
    const profile = (await readStoryline(harness.deps.db, arc.id))?.profileTokens ?? [];
    expect(profile).toContain("killer");
    expect(profile).not.toContain("killers");
    // And the marker the re-derivation owes (migration 0017): `linkGroup` READS
    // an arc's profile, so a profile that moved is an answer that could have
    // moved, and without this the late-candidate sweep never re-offers it — for
    // a quiet arc, never. Asserted because omitting the call was a review
    // finding once already.
    const marked = await harness.deps.db
      .selectFrom("storylines")
      .select("link_dirty_at")
      .where("id", "=", arc.id)
      .executeTakeFirstOrThrow();
    expect(marked.link_dirty_at).not.toBeNull();
  });

  it("refreshes nothing when a bumped row's tokens come out identical", async () => {
    // A version bump marks the WHOLE window stale while a fold moves a fraction
    // of it (version 8: 513 rows of 32,279). Refreshing a profile per row looked
    // at rather than per row moved cost 14,670 rebuilds to repair 188.
    harness = await createTestHarness({}, NOW);
    const fingerprint = randomBytes(32).toString("hex");
    await upsertTopic(harness.deps.db, { fingerprint, keywords: ["harper"], language: "en" });
    const ingested = await ingestSightings(harness.deps.db, {
      plane: "search",
      timeZone: "UTC",
      fingerprint,
      sightings: [sighting("bbc.co.uk", BBC, "2026-08-11T21:21:00.000Z")],
    });
    // Behind the version clock, but tokenized by the CURRENT rules — the shape
    // every row in the window has after a bump that does not touch its words.
    for (const article of ingested.createdArticles) {
      await recordGrouping(harness.deps.db, {
        articleId: article.id,
        titleTokens: headlineTokens(article.title),
        storyTokens: storyTokens(article.title, article.description),
        tokensVersion: TOKENIZER_VERSION - 1,
        groupId: null,
      });
    }
    const [row] = await groupsOf(ingested.createdArticles.map((a) => a.id));
    await createProvisionalStoryline(harness.deps.db, {
      groupId: row!.group_id,
      timeZone: "UTC",
    });

    const result = await regroup(deps(), { days: 1, tokensOnly: true, now: () => NOW });

    expect(result.retokenized).toBe(1);
    expect(result.refreshed).toBe(0);
  });

  it("changes no groupings at all in --tokens-only mode", async () => {
    const ids = await seedStaleRows();
    const before = await groupsOf(ids);

    const result = await regroup(deps(), { days: 1, tokensOnly: true, now: () => NOW });

    expect(result.regrouped).toBe(0);
    const after = await groupsOf(ids);
    expect(after.map((r) => r.group_id).sort()).toEqual(before.map((r) => r.group_id).sort());
  });

  it("groups articles the current rules would have grouped", async () => {
    // The whole point: 0.429 against the stored tokens, 0.538 re-derived.
    const ids = await seedStaleRows();

    const result = await regroup(deps(), { days: 1, now: () => NOW });

    expect(result.regrouped).toBe(1);
    const rows = await groupsOf(ids);
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1);
  });

  it("leaves a window it was not asked about alone", async () => {
    const ids = await seedStaleRows();

    // A window starting tomorrow contains neither article.
    const result = await regroup(deps(), {
      days: 1,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    });

    expect(result).toMatchObject({ stale: 0, retokenized: 0, regrouped: 0 });
    expect(new Set((await groupsOf(ids)).map((r) => r.group_id)).size).toBe(2);
  });

  it("heals a two-pole split on bridge evidence (ADR-0009 pass 3)", async () => {
    // The split merge-repair exists for: both poles have members, so pass 2
    // (singletons only) can never reunite them. The bridge article's matches
    // span both groups at the bar, and pass 3 acts on it.
    harness = await createTestHarness({}, NOW);
    const fingerprint = randomBytes(32).toString("hex");
    await upsertTopic(harness.deps.db, { fingerprint, keywords: ["mayor"], language: "en" });

    const titles = {
      a1: "Mayor resigns in budget scandal over audit report",
      a2: "Mayor resigns in budget scandal over audit reports",
      b1: "Mayor resigns at city hall council meeting",
      b2: "Mayor resigns at city hall council meetings",
      bridge: "Mayor resigns over budget scandal at city hall",
    };
    const ingested = await ingestSightings(harness.deps.db, {
      plane: "search",
      timeZone: "UTC",
      fingerprint,
      sightings: Object.values(titles).map((title, i) =>
        sighting(`outlet${i}.example`, title, `2026-08-11T10:0${i}:00.000Z`),
      ),
    });
    const ids = new Map(ingested.createdArticles.map((a) => [a.title, a.id]));

    // Stored as the split would exist on a pre-ADR-0009 database: two
    // two-member groups, the bridge filed with pole A, tokens current.
    const tokens: Record<string, { tokens: string[]; group: string }> = {
      [titles.a1]: { tokens: ["mayor", "resign", "budget", "scandal", "audit", "report"], group: titles.a1 },
      [titles.a2]: { tokens: ["mayor", "resign", "budget", "scandal", "audit", "report"], group: titles.a1 },
      [titles.b1]: { tokens: ["mayor", "resign", "city", "hall", "council", "meeting"], group: titles.b1 },
      [titles.b2]: { tokens: ["mayor", "resign", "city", "hall", "council", "meeting"], group: titles.b1 },
      [titles.bridge]: { tokens: ["mayor", "resign", "budget", "scandal", "city", "hall"], group: titles.a1 },
    };
    for (const [title, spec] of Object.entries(tokens)) {
      await recordGrouping(harness.deps.db, {
        articleId: ids.get(title)!,
        titleTokens: spec.tokens,
        tokensVersion: TOKENIZER_VERSION,
        groupId: title === spec.group ? null : ids.get(spec.group)!,
      });
    }

    const result = await regroup(deps(), { days: 1, now: () => NOW });

    expect(result.merged).toBeGreaterThanOrEqual(1);
    const rows = await harness.deps.db
      .selectFrom("articles")
      .select(["group_id"])
      .where("id", "in", [...ids.values()])
      .execute();
    expect(new Set(rows.map((row) => row.group_id)).size).toBe(1);

  });

  it("never takes an existing group apart", async () => {
    const ids = await seedStaleRows();
    // Put both rows in one group first; the pass must not move either out.
    await recordGrouping(harness.deps.db, {
      articleId: ids[1]!,
      titleTokens: ["police", "chiefs"],
      tokensVersion: TOKENIZER_VERSION - 1,
      groupId: ids[0]!,
    });

    await regroup(deps(), { days: 1, now: () => NOW });

    const rows = await groupsOf(ids);
    expect(new Set(rows.map((r) => r.group_id))).toEqual(new Set([ids[0]!]));
  });
});

function deps() {
  return { db: harness.deps.db, config: harness.deps.config.grouping };
}
