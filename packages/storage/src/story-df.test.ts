import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  dfLanguageKey,
  pruneStoryDf,
  readStoryDf,
  rebuildStoryDf,
  recordStoryDf,
} from "./story-df.js";
import { migrateToLatest } from "./migrator.js";
import { createTestDatabase, type TestDatabase } from "./test-support.js";

/**
 * The trailing corpus (ADR-0011): df of `story_tokens` over a rolling window
 * of APP_TIMEZONE days. Against real Postgres, because the parts that can be
 * wrong are the increment-on-conflict arithmetic, the day-key derivation under
 * a non-UTC timezone, and the range read — none of which a fake would fake
 * right.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
  await migrateToLatest(harness.db);
});

afterAll(async () => {
  await harness.drop();
});

beforeEach(async () => {
  await sql`truncate story_token_days, story_corpus_days, articles cascade`.execute(harness.db);
});

const EN = { language: "en" as string | null };

describe("recordStoryDf", () => {
  it("counts an article once per DISTINCT token, and once toward the corpus", async () => {
    await recordStoryDf(harness.db, [
      { day: "2026-08-10", ...EN, tokens: ["leavitt", "resign", "leavitt"] },
    ]);

    const read = await readStoryDf(harness.db, {
      language: "en",
      from: "2026-08-10",
      to: "2026-08-10",
      tokens: ["leavitt", "resign"],
    });
    expect(read.size).toBe(1);
    expect(read.df.get("leavitt")).toBe(1);
    expect(read.df.get("resign")).toBe(1);
  });

  it("accumulates across calls, so a later batch adds to the same day", async () => {
    await recordStoryDf(harness.db, [{ day: "2026-08-10", ...EN, tokens: ["leavitt"] }]);
    await recordStoryDf(harness.db, [
      { day: "2026-08-10", ...EN, tokens: ["leavitt", "successor"] },
      { day: "2026-08-10", ...EN, tokens: ["leavitt"] },
    ]);

    const read = await readStoryDf(harness.db, {
      language: "en",
      from: "2026-08-10",
      to: "2026-08-10",
      tokens: ["leavitt", "successor"],
    });
    expect(read.size).toBe(3);
    expect(read.df.get("leavitt")).toBe(3);
    expect(read.df.get("successor")).toBe(1);
  });

  it("keeps languages apart, counting a null language in its own corpus", async () => {
    await recordStoryDf(harness.db, [
      { day: "2026-08-10", language: "en", tokens: ["storm"] },
      { day: "2026-08-10", language: "es", tokens: ["storm"] },
      { day: "2026-08-10", language: null, tokens: ["storm"] },
    ]);

    for (const language of ["en", "es", null]) {
      const read = await readStoryDf(harness.db, {
        language,
        from: "2026-08-10",
        to: "2026-08-10",
        tokens: ["storm"],
      });
      expect(read.size).toBe(1);
      expect(read.df.get("storm")).toBe(1);
    }
  });
});

describe("readStoryDf", () => {
  beforeEach(async () => {
    await recordStoryDf(harness.db, [
      { day: "2026-08-08", ...EN, tokens: ["leavitt", "beat"] },
      { day: "2026-08-09", ...EN, tokens: ["beat"] },
      { day: "2026-08-10", ...EN, tokens: ["leavitt", "beat"] },
      { day: "2026-08-10", ...EN, tokens: ["beat"] },
    ]);
  });

  it("sums the window's days, inclusive of both edges", async () => {
    const whole = await readStoryDf(harness.db, {
      language: "en",
      from: "2026-08-08",
      to: "2026-08-10",
      tokens: ["leavitt", "beat"],
    });
    expect(whole.size).toBe(4);
    expect(whole.df.get("leavitt")).toBe(2);
    expect(whole.df.get("beat")).toBe(4);
  });

  it("drops days the window has rolled past — which is the whole point", async () => {
    const rolled = await readStoryDf(harness.db, {
      language: "en",
      from: "2026-08-09",
      to: "2026-08-10",
      tokens: ["leavitt", "beat"],
    });
    expect(rolled.size).toBe(3);
    expect(rolled.df.get("leavitt")).toBe(1);
    expect(rolled.df.get("beat")).toBe(3);
  });

  it("omits an unseen token rather than reporting it as df 1", async () => {
    const read = await readStoryDf(harness.db, {
      language: "en",
      from: "2026-08-08",
      to: "2026-08-10",
      tokens: ["nobody-said-this"],
    });
    expect(read.df.has("nobody-said-this")).toBe(false);
    // The corpus size still answers, so the caller can decide what df 0 means.
    expect(read.size).toBe(4);
  });

  it("reports an empty window as size 0 rather than failing", async () => {
    const read = await readStoryDf(harness.db, {
      language: "en",
      from: "2026-01-01",
      to: "2026-01-14",
      tokens: ["leavitt"],
    });
    expect(read).toEqual({ size: 0, df: new Map() });
  });
});

describe("rebuildStoryDf", () => {
  /** An article as the linker's input sees it: published, language, tokens. */
  async function insertArticle(input: {
    id: string;
    published: string;
    language: string | null;
    tokens: string[];
  }): Promise<void> {
    await sql`
      insert into articles (
        dedup_key, url, title, description, language, categories, source_category,
        published, latest_seen, sighting_count, story_tokens
      ) values (
        decode(${input.id.padEnd(64, "0")}, 'hex'),
        ${`https://example.test/${input.id}`}, ${input.id}, null, ${input.language},
        '{}', '{}', ${input.published}, ${input.published}, 1, ${input.tokens}
      )
    `.execute(harness.db);
  }

  it("recomputes a span from articles, replacing whatever was counted", async () => {
    await insertArticle({
      id: "a1",
      published: "2026-08-10T12:00:00Z",
      language: "en",
      tokens: ["leavitt", "resign"],
    });
    await insertArticle({
      id: "a2",
      published: "2026-08-10T18:00:00Z",
      language: "en",
      tokens: ["leavitt"],
    });
    // A drifted counter: too high on one token, and holding a token no article
    // carries. A rebuild must replace, not reconcile.
    await recordStoryDf(harness.db, [
      { day: "2026-08-10", ...EN, tokens: ["leavitt", "leavitt", "ghost"] },
    ]);

    await rebuildStoryDf(harness.db, {
      from: new Date("2026-08-10T00:00:00Z"),
      to: new Date("2026-08-11T00:00:00Z"),
      timeZone: "UTC",
    });

    const read = await readStoryDf(harness.db, {
      language: "en",
      from: "2026-08-10",
      to: "2026-08-10",
      tokens: ["leavitt", "resign", "ghost"],
    });
    expect(read.size).toBe(2);
    expect(read.df.get("leavitt")).toBe(2);
    expect(read.df.get("resign")).toBe(1);
    expect(read.df.has("ghost")).toBe(false);
  });

  it("buckets by the app's calendar day, not UTC's", async () => {
    // 05:00 UTC on the 11th is still the evening of the 10th in Vancouver —
    // the reason the day key is derived in the app's timezone at all (§10.1).
    await insertArticle({
      id: "b1",
      published: "2026-08-11T05:00:00Z",
      language: "en",
      tokens: ["evening"],
    });

    await rebuildStoryDf(harness.db, {
      from: new Date("2026-08-10T00:00:00Z"),
      to: new Date("2026-08-12T00:00:00Z"),
      timeZone: "America/Vancouver",
    });

    const rows = await harness.db
      .selectFrom("story_token_days")
      .select(["day", "token"])
      .execute();
    expect(rows).toEqual([{ day: "2026-08-10", token: "evening" }]);
  });

  it("rewrites whole days, so a span clipping one cannot halve it", async () => {
    await insertArticle({
      id: "c1",
      published: "2026-08-10T01:00:00Z",
      language: "en",
      tokens: ["dawn"],
    });
    await insertArticle({
      id: "c2",
      published: "2026-08-10T23:00:00Z",
      language: "en",
      tokens: ["dusk"],
    });

    // A span that starts at noon still owns the whole of 2026-08-10.
    await rebuildStoryDf(harness.db, {
      from: new Date("2026-08-10T12:00:00Z"),
      to: new Date("2026-08-11T00:00:00Z"),
      timeZone: "UTC",
    });

    const read = await readStoryDf(harness.db, {
      language: "en",
      from: "2026-08-10",
      to: "2026-08-10",
      tokens: ["dawn", "dusk"],
    });
    expect(read.size).toBe(2);
    expect(read.df.get("dawn")).toBe(1);
    expect(read.df.get("dusk")).toBe(1);
  });

  it("leaves days outside the span alone", async () => {
    await recordStoryDf(harness.db, [{ day: "2026-08-01", ...EN, tokens: ["older"] }]);
    await insertArticle({
      id: "d1",
      published: "2026-08-10T12:00:00Z",
      language: "en",
      tokens: ["newer"],
    });

    await rebuildStoryDf(harness.db, {
      from: new Date("2026-08-10T00:00:00Z"),
      to: new Date("2026-08-11T00:00:00Z"),
      timeZone: "UTC",
    });

    const read = await readStoryDf(harness.db, {
      language: "en",
      from: "2026-08-01",
      to: "2026-08-10",
      tokens: ["older", "newer"],
    });
    expect(read.size).toBe(2);
    expect(read.df.get("older")).toBe(1);
    expect(read.df.get("newer")).toBe(1);
  });
});

describe("pruneStoryDf", () => {
  it("drops buckets the window can no longer reach, both tables together", async () => {
    await recordStoryDf(harness.db, [
      { day: "2026-07-20", ...EN, tokens: ["ancient"] },
      { day: "2026-08-10", ...EN, tokens: ["current"] },
    ]);

    const pruned = await pruneStoryDf(harness.db, { before: "2026-08-01" });
    expect(pruned).toBe(1);

    const read = await readStoryDf(harness.db, {
      language: "en",
      from: "2026-07-01",
      to: "2026-08-10",
      tokens: ["ancient", "current"],
    });
    expect(read.size).toBe(1);
    expect(read.df.has("ancient")).toBe(false);
    expect(read.df.get("current")).toBe(1);
  });
});

describe("dfLanguageKey", () => {
  it("gives a null language a corpus of its own rather than dropping it", () => {
    expect(dfLanguageKey(null)).toBe("");
    expect(dfLanguageKey("en")).toBe("en");
  });
});
