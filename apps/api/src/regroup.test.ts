import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { deriveDedupKey, type Sighting } from "@zammy/currents-client";
import { ingestSightings, recordGrouping, upsertTopic } from "@zammy/storage";
import { regroup } from "./regroup.js";
import { TOKENIZER_VERSION } from "./grouping.js";
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
    dedupKey: deriveDedupKey(url),
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
