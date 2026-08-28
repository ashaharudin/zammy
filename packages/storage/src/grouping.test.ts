import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveAltKey, deriveDedupKey, type Sighting } from "@zammy/news-client";
import { ingestSightings, upsertTopic } from "./ingest.js";
import { migrateToLatest } from "./migrator.js";
import {
  countStaleTokenArticles,
  mergeGroups,
  readGroupCandidates,
  readStaleTokenArticles,
  recordGrouping,
} from "./grouping.js";
import {
  createTestDatabase,
  testFingerprint,
  type TestDatabase,
} from "./test-support.js";

/**
 * The storage half of article grouping (ARCHITECTURE 14.3). Judgement — which
 * headlines are the same story — lives in the API layer; what is tested here
 * is the persistence contract it depends on:
 *
 *   every article is in a group          (the insert trigger, unconditionally)
 *   candidates are day- and seed-bounded (the anti-chaining rule)
 *   a group's position is its earliest   (the §7.3 keyset axis stays true)
 *
 * Real Postgres, because all three are SQL invariants — a trigger, a bounded
 * candidate query and a MIN — and an in-memory fake would fake each of them.
 */

const TOPIC = testFingerprint("620");

const DAY_FROM = new Date("2026-08-11T00:00:00.000Z");
const DAY_TO = new Date("2026-08-12T00:00:00.000Z");
/** The zone the day bounds above are written in, and that mergeGroups re-buckets
 *  slots by. Omitted at both call sites until the tests were type-checked, which
 *  left the re-derivation bucketing by nothing at all (§12). */
const ZONE = "UTC";

let counter = 0;
function story(overrides: {
  url: string;
  title: string;
  published: string;
  language?: string | null;
}): Sighting {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    url: overrides.url,
    provider: "currents",
    providerSightingId: overrides.url,
    dedupKey: deriveDedupKey(overrides.url),
    altKey: deriveAltKey(new URL(overrides.url).hostname, overrides.title, overrides.published),
    title: overrides.title,
    description: null,
    author: null,
    imageUrl: null,
    language: overrides.language === undefined ? "en" : overrides.language,
    categories: [],
    sourceCategories: [],
    sourceDomain: new URL(overrides.url).hostname,
    published: overrides.published,
    raw: {},
  };
}

describe("article groups in storage", () => {
  let harness: TestDatabase;

  const ingest = async (...sightings: Sighting[]) =>
    ingestSightings(harness.db, { timeZone: ZONE, fingerprint: TOPIC, sightings });

  const readArticle = async (id: string) =>
    harness.db
      .selectFrom("articles")
      .select(["id", "group_id", "group_published", "title_tokens", "published"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
    await upsertTopic(harness.db, { fingerprint: TOPIC, keywords: ["group"] });
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("seeds every new article into a group of its own", async () => {
    // Unconditional, and enforced by the schema rather than by the caller: a
    // row with a null group_id would sort first under ORDER BY group_published
    // DESC and corrupt paging for every reader.
    const result = await ingest(
      story({
        url: "https://alone.example/1",
        title: "A lone article",
        published: "2026-08-11T10:00:00.000Z",
      }),
    );

    const id = result.createdArticles[0]!.id;
    const row = await readArticle(id);
    expect(row.group_id).toBe(id);
    expect(row.group_published).toEqual(new Date("2026-08-11T10:00:00.000Z"));
    expect(row.title_tokens).toEqual([]);
  });

  it("offers same-day seeds that share a headline token", async () => {
    const wire = await ingest(
      story({
        url: "https://wire.example/rate",
        title: "Bank of Canada holds interest rate",
        published: "2026-08-11T09:00:00.000Z",
      }),
    );
    const wireId = wire.createdArticles[0]!.id;
    await recordGrouping(harness.db, {
      articleId: wireId,
      titleTokens: ["bank", "canada", "holds", "interest", "rate"],
      tokensVersion: 2,
      groupId: null,
    });

    const seeds = await readGroupCandidates(harness.db, {
      from: DAY_FROM,
      to: DAY_TO,
      language: "en",
      titleTokens: ["bank", "canada", "rate", "unchanged"],
      excludeArticleId: "0",
      limit: 50,
    });

    const found = seeds.find((seed) => seed.id === wireId);
    expect(found).toMatchObject({ id: wireId, groupId: wireId });
    expect(found?.titleTokens).toContain("interest");
    expect(found?.published).toEqual(new Date("2026-08-11T09:00:00.000Z"));
  });

  it("offers nothing to an article with no tokens in common", async () => {
    const seeds = await readGroupCandidates(harness.db, {
      from: DAY_FROM,
      to: DAY_TO,
      language: "en",
      titleTokens: ["kelp", "harvest"],
      excludeArticleId: "0",
      limit: 50,
    });

    expect(seeds).toEqual([]);
  });

  it("never offers the article itself, another day, or another language", async () => {
    const tokens = ["ferry", "service", "suspended"];

    const mine = await ingest(
      story({
        url: "https://mine.example/ferry",
        title: "Ferry service suspended",
        published: "2026-08-11T11:00:00.000Z",
      }),
    );
    const yesterday = await ingest(
      story({
        url: "https://old.example/ferry",
        title: "Ferry service suspended",
        published: "2026-08-10T11:00:00.000Z",
      }),
    );
    const french = await ingest(
      story({
        url: "https://fr.example/ferry",
        title: "Ferry service suspended",
        published: "2026-08-11T11:30:00.000Z",
        language: "fr",
      }),
    );
    for (const created of [mine, yesterday, french]) {
      await recordGrouping(harness.db, {
        articleId: created.createdArticles[0]!.id,
        titleTokens: tokens, tokensVersion: 2,
        groupId: null,
      });
    }

    const seeds = await readGroupCandidates(harness.db, {
      from: DAY_FROM,
      to: DAY_TO,
      language: "en",
      titleTokens: tokens,
      excludeArticleId: mine.createdArticles[0]!.id,
      limit: 50,
    });

    const ids = seeds.map((seed) => seed.id);
    expect(ids).not.toContain(mine.createdArticles[0]!.id);
    // The midnight cliff, accepted in §14.3: 23:50 and 00:10 never group.
    expect(ids).not.toContain(yesterday.createdArticles[0]!.id);
    expect(ids).not.toContain(french.createdArticles[0]!.id);
  });

  it("offers a group's MEMBERS too, each carrying its group", async () => {
    // Seed-only candidates were the original rule and measurably lost real
    // syndication (ADR-0005): a newcomer was judged against whichever article
    // arrived first rather than the one it resembles. Members are offered now,
    // and each reports the group a newcomer would be joining — the day window
    // is what bounds the drift that the seed rule used to bound.
    const tokens = ["storm", "floods", "coastal", "towns"];
    const seed = await ingest(
      story({
        url: "https://seed.example/storm",
        title: "Storm floods coastal towns",
        published: "2026-08-11T06:00:00.000Z",
      }),
    );
    const joiner = await ingest(
      story({
        url: "https://joiner.example/storm",
        title: "Storm floods coastal towns overnight",
        published: "2026-08-11T07:00:00.000Z",
      }),
    );
    const seedId = seed.createdArticles[0]!.id;
    const joinerId = joiner.createdArticles[0]!.id;

    await recordGrouping(harness.db, { articleId: seedId, titleTokens: tokens, tokensVersion: 2, groupId: null });
    await recordGrouping(harness.db, {
      articleId: joinerId,
      titleTokens: [...tokens, "overnight"],
      tokensVersion: 2,
      groupId: seedId,
    });

    const candidates = await readGroupCandidates(harness.db, {
      from: DAY_FROM,
      to: DAY_TO,
      language: "en",
      titleTokens: tokens,
      excludeArticleId: "0",
      limit: 50,
    });

    const member = candidates.find((c) => c.id === joinerId);
    expect(candidates.map((c) => c.id)).toContain(seedId);
    expect(member?.groupId).toBe(seedId);
    // The title comes back too: the figure rule reads numerals that the
    // tokenizer drops, so it needs the headline itself.
    expect(member?.title).toBe("Storm floods coastal towns overnight");
  });

  it("positions a group at its earliest member, whenever that changes", async () => {
    const tokens = ["harbour", "bridge", "closed"];
    const seed = await ingest(
      story({
        url: "https://a.example/bridge",
        title: "Harbour bridge closed",
        published: "2026-08-11T12:00:00.000Z",
      }),
    );
    const seedId = seed.createdArticles[0]!.id;
    await recordGrouping(harness.db, { articleId: seedId, titleTokens: tokens, tokensVersion: 2, groupId: null });

    // An EARLIER member joins: the group moves back to it, even though the
    // seed — the comparison anchor, and possibly the headline — does not move.
    const earlier = await ingest(
      story({
        url: "https://b.example/bridge",
        title: "Harbour bridge closed after crash",
        published: "2026-08-11T08:00:00.000Z",
      }),
    );
    const earlierId = earlier.createdArticles[0]!.id;
    await recordGrouping(harness.db, {
      articleId: earlierId,
      titleTokens: [...tokens, "crash"],
      tokensVersion: 2,
      groupId: seedId,
    });

    for (const id of [seedId, earlierId]) {
      const row = await readArticle(id);
      expect(row.group_id).toBe(seedId);
      expect(row.group_published).toEqual(new Date("2026-08-11T08:00:00.000Z"));
    }

    // A LATER member joins: the position must not follow the newest article,
    // or every arrival would re-sort the timeline (§7.3).
    const later = await ingest(
      story({
        url: "https://c.example/bridge",
        title: "Harbour bridge closed all evening",
        published: "2026-08-11T20:00:00.000Z",
      }),
    );
    await recordGrouping(harness.db, {
      articleId: later.createdArticles[0]!.id,
      titleTokens: [...tokens, "evening"],
      tokensVersion: 2,
      groupId: seedId,
    });

    const row = await readArticle(seedId);
    expect(row.group_published).toEqual(new Date("2026-08-11T08:00:00.000Z"));
  });

  it("moves the group when a re-emission drags a member's published earlier", async () => {
    // ADR-0002: `published = LEAST(existing, incoming)`, so an article's own
    // place in time can move backwards after ingest. The group's position is
    // derived from it and has to follow, or the keyset axis starts lying.
    const tokens = ["cabinet", "shuffle", "announced"];
    const seed = await ingest(
      story({
        url: "https://x.example/cabinet",
        title: "Cabinet shuffle announced",
        published: "2026-08-11T15:00:00.000Z",
      }),
    );
    const member = await ingest(
      story({
        url: "https://y.example/cabinet",
        title: "Cabinet shuffle announced today",
        published: "2026-08-11T16:00:00.000Z",
      }),
    );
    const seedId = seed.createdArticles[0]!.id;
    await recordGrouping(harness.db, { articleId: seedId, titleTokens: tokens, tokensVersion: 2, groupId: null });
    await recordGrouping(harness.db, {
      articleId: member.createdArticles[0]!.id,
      titleTokens: tokens, tokensVersion: 2,
      groupId: seedId,
    });

    // The same URL re-emitted with an earlier timestamp.
    await ingest(
      story({
        url: "https://y.example/cabinet",
        title: "Cabinet shuffle announced today",
        published: "2026-08-11T09:30:00.000Z",
      }),
    );

    const row = await readArticle(seedId);
    expect(row.group_published).toEqual(new Date("2026-08-11T09:30:00.000Z"));
  });

  it("refuses to move an article that already has members of its own", async () => {
    // Grouping only ever absorbs singletons. Re-pointing a seed would strand
    // its members in a group whose seed is elsewhere — and a retried batch
    // must be able to re-run this call harmlessly (§7.4 idempotence).
    const tokens = ["census", "results", "delayed"];
    const seed = await ingest(
      story({
        url: "https://p.example/census",
        title: "Census results delayed",
        published: "2026-08-11T13:00:00.000Z",
      }),
    );
    const member = await ingest(
      story({
        url: "https://q.example/census",
        title: "Census results delayed again",
        published: "2026-08-11T13:30:00.000Z",
      }),
    );
    const other = await ingest(
      story({
        url: "https://r.example/census",
        title: "Census results delayed by weeks",
        published: "2026-08-11T14:00:00.000Z",
      }),
    );
    const seedId = seed.createdArticles[0]!.id;
    const otherId = other.createdArticles[0]!.id;

    await recordGrouping(harness.db, { articleId: seedId, titleTokens: tokens, tokensVersion: 2, groupId: null });
    await recordGrouping(harness.db, {
      articleId: member.createdArticles[0]!.id,
      titleTokens: tokens, tokensVersion: 2,
      groupId: seedId,
    });
    await recordGrouping(harness.db, { articleId: otherId, titleTokens: tokens, tokensVersion: 2, groupId: null });

    await recordGrouping(harness.db, { articleId: seedId, titleTokens: tokens, tokensVersion: 2, groupId: otherId });

    expect((await readArticle(seedId)).group_id).toBe(seedId);
  });
});

describe("what the storyline layer reads from storage", () => {
  let harness: TestDatabase;

  const ingest = async (...sightings: Sighting[]) =>
    ingestSightings(harness.db, { timeZone: ZONE, fingerprint: TOPIC, sightings });

  const readRow = async (id: string) =>
    harness.db
      .selectFrom("articles")
      .select(["id", "group_id", "group_published", "story_tokens"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
    await upsertTopic(harness.db, { fingerprint: TOPIC, keywords: ["storyline"] });
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("merges one group into another, position included", async () => {
    // What SURVIVED the cutover from this block: the group layer's own
    // behaviour. The storyline half — a hub's spokes following a merge, a
    // winner re-pointing at itself — went with migration 0012, because a
    // storyline holds GROUPS now and a group that ceases to exist leaves
    // through `storyline_groups` rather than through a column here.
    const mk = async (url: string, title: string, published: string) => {
      const result = await ingest(story({ url, title, published }));
      const id = result.createdArticles[0]!.id;
      await recordGrouping(harness.db, {
        articleId: id,
        titleTokens: ["merge", "test"],
        tokensVersion: 4,
        groupId: null,
      });
      return id;
    };

    // Two multi-member poles of one story — the shape ADR-0005 could not heal.
    const a1 = await mk("https://p1.example/m", "Pole one first", "2026-08-11T10:00:00.000Z");
    const a2 = await mk("https://p2.example/m", "Pole one second", "2026-08-11T11:00:00.000Z");
    const b1 = await mk("https://p3.example/m", "Pole two first", "2026-08-11T09:00:00.000Z");
    const b2 = await mk("https://p4.example/m", "Pole two second", "2026-08-11T12:00:00.000Z");
    await recordGrouping(harness.db, { articleId: a2, titleTokens: ["merge", "test"], tokensVersion: 4, groupId: a1 });
    await recordGrouping(harness.db, { articleId: b2, titleTokens: ["merge", "test"], tokensVersion: 4, groupId: b1 });

    const outcome = await mergeGroups(harness.db, { winnerGroupId: a1, loserGroupId: b1, timeZone: ZONE });
    expect(outcome.merged).toBe(true);

    for (const id of [a1, a2, b1, b2]) {
      const row = await readRow(id);
      expect(row.group_id).toBe(a1);
      // The merged group's position reaches back to pole two's 09:00 member.
      expect(row.group_published).toEqual(new Date("2026-08-11T09:00:00.000Z"));
    }

    // Idempotent: the loser is empty now, so a replay is a no-op.
    expect((await mergeGroups(harness.db, { winnerGroupId: a1, loserGroupId: b1, timeZone: ZONE })).merged).toBe(
      false,
    );
  });

  it("records story tokens alongside title tokens", async () => {
    // `story_tokens` outlived the model that introduced it: it is the LINKER's
    // input now (ADR-0011), which is why 0012 dropped its neighbours and left
    // this one standing.
    const result = await ingest(
      story({
        url: "https://tokens.example/1",
        title: "Copper prices surge",
        published: "2026-08-11T13:00:00.000Z",
      }),
    );
    const id = result.createdArticles[0]!.id;
    await recordGrouping(harness.db, {
      articleId: id,
      titleTokens: ["copper", "price", "surge"],
      storyTokens: ["copper", "price", "surge", "mine", "chile"],
      tokensVersion: 4,
      groupId: null,
    });

    expect((await readRow(id)).story_tokens).toEqual([
      "copper",
      "price",
      "surge",
      "mine",
      "chile",
    ]);
  });
});

describe("tokenizer staleness is findable", () => {
  let harness: TestDatabase;
  const OLD = 1;
  const CURRENT = 2;

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
    await upsertTopic(harness.db, { fingerprint: TOPIC, keywords: ["group"] });
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("counts and returns only rows behind the current tokenizer", async () => {
    // `title_tokens` is a materialized derivation of a rule that keeps
    // changing. Without the version, a row written under an older tokenizer
    // degrades every comparison it takes part in and nothing can find it.
    const stale = await ingestSightings(harness.db, {
      timeZone: ZONE,
      fingerprint: TOPIC,
      sightings: [
        story({
          url: "https://stale.example/one",
          title: "Police chiefs urge action",
          published: "2026-08-11T10:00:00.000Z",
        }),
      ],
    });
    const fresh = await ingestSightings(harness.db, {
      timeZone: ZONE,
      fingerprint: TOPIC,
      sightings: [
        story({
          url: "https://fresh.example/one",
          title: "Police chief urges action",
          published: "2026-08-11T11:00:00.000Z",
        }),
      ],
    });

    await recordGrouping(harness.db, {
      articleId: stale.createdArticles[0]!.id,
      titleTokens: ["police", "chiefs", "urge", "action"],
      tokensVersion: OLD,
      groupId: null,
    });
    await recordGrouping(harness.db, {
      articleId: fresh.createdArticles[0]!.id,
      titleTokens: ["police", "chief", "urge", "action"],
      tokensVersion: CURRENT,
      groupId: null,
    });

    const from = new Date("2026-08-11T00:00:00.000Z");
    expect(await countStaleTokenArticles(harness.db, { version: CURRENT, from })).toBe(1);

    const rows = await readStaleTokenArticles(harness.db, { version: CURRENT, from, limit: 50 });
    expect(rows.map((row) => row.id)).toEqual([stale.createdArticles[0]!.id]);
    // A group of one is what the maintenance pass is allowed to move.
    expect(rows[0]?.isGroupOfOne).toBe(true);
    expect(rows[0]?.groupId).toBe(stale.createdArticles[0]!.id);
  });
});
