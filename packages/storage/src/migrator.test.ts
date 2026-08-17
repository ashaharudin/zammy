import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { migrateToLatest } from "./migrator.js";
import * as storylineTables from "./migrations/0007-storyline-tables.js";
import * as storyTokenDf from "./migrations/0008-story-token-df.js";
import * as storylineBridges from "./migrations/0009-storyline-bridges.js";
import * as labelDrift from "./migrations/0010-storyline-label-drift.js";
import * as labelSource from "./migrations/0011-storyline-label-source.js";
import * as dropTermCloud from "./migrations/0014-drop-term-cloud.js";
import { createTestDatabase, type TestDatabase } from "./test-support.js";

/**
 * The migration path itself (ADR-0003): migrations are hand-written and run as
 * a discrete step, so "an empty database reaches the current schema" is a thing
 * that must be tested, not assumed — it is the first command every environment
 * ever runs.
 */

describe("migrateToLatest", () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await createTestDatabase();
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("brings an empty database to the current schema", async () => {
    const { error, results } = await migrateToLatest(harness.db);

    expect(error).toBeUndefined();
    expect(results?.length).toBeGreaterThan(0);
    expect(results?.every((result) => result.status === "Success")).toBe(true);

    // The §7.2 tables must actually exist afterwards — a migration that ran
    // "successfully" but created nothing would pass the assertions above.
    const { rows } = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = 'public'
    `.execute(harness.db);
    const tables = rows.map((row) => row.table_name);

    for (const expected of [
      "articles",
      "sightings",
      "topics",
      "topic_articles",
      "topic_coverage",
      "fetch_log",
      "storylines",
      "storyline_groups",
      "storyline_days",
      "story_token_days",
      "story_corpus_days",
      "storyline_bridges",
    ]) {
      expect(tables).toContain(expected);
    }

    // And the term cloud's three tables must NOT: 0002 and 0005 create them,
    // 0014 drops them, and a migration order that left one standing would leave
    // the schema disagreeing with `Database` (ADR-0013).
    for (const gone of ["trending_terms", "term_snapshots", "term_baseline"]) {
      expect(tables).not.toContain(gone);
    }
  });

  it("reverts and re-applies the storyline tables cleanly", async () => {
    // A migration whose `down` half-works is a rollback that leaves the next
    // deploy unable to run `up` — the failure mode hand-written DDL (ADR-0003)
    // buys us the ability to check. Driven through the migration module rather
    // than the runner: the ledger is untouched, so the database this suite
    // leaves behind is the same one it started the test with.
    const hasStorylineTables = async () => {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from information_schema.tables
        where table_schema = 'public'
          and table_name in ('storylines', 'storyline_groups', 'storyline_days')
      `.execute(harness.db);
      return Number(rows[0]?.n ?? 0);
    };

    const hasDriftColumn = async () => {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from information_schema.columns
        where table_schema = 'public' and table_name = 'storylines'
          and column_name = 'label_group_count'
      `.execute(harness.db);
      return Number(rows[0]?.n ?? 0) === 1;
    };

    // Newest first down, oldest first up, exactly as a rollback and the next
    // deploy run. Both later migrations hang off 0007's tables — 0009's
    // `storyline_bridges` by foreign key, 0010 by a column on `storylines` —
    // so reverting 0007 alone is something no deploy would do: Postgres
    // refuses the first (the key doing its job) and the second would silently
    // rebuild `storylines` without a column the ledger still claimed.
    expect(await hasDriftColumn()).toBe(true);
    await labelSource.down(harness.db);
    await labelDrift.down(harness.db);
    await storylineBridges.down(harness.db);
    await storylineTables.down(harness.db);
    expect(await hasStorylineTables()).toBe(0);

    await storylineTables.up(harness.db);
    await storylineBridges.up(harness.db);
    await labelDrift.up(harness.db);
    await labelSource.up(harness.db);
    expect(await hasStorylineTables()).toBe(3);
    expect(await hasDriftColumn()).toBe(true);
  });

  it("reverts and re-applies the bridge table cleanly", async () => {
    const hasBridges = async () => {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from information_schema.tables
        where table_schema = 'public' and table_name = 'storyline_bridges'
      `.execute(harness.db);
      return Number(rows[0]?.n ?? 0);
    };

    await storylineBridges.down(harness.db);
    expect(await hasBridges()).toBe(0);

    await storylineBridges.up(harness.db);
    expect(await hasBridges()).toBe(1);
  });

  it("reverts and re-applies the trailing-corpus tables cleanly", async () => {
    // Same check, same reason, for the df aggregate (ADR-0011). Its `down`
    // drops derived rows only — the corpus is rebuildable from `articles`, so
    // a rollback here costs a `--rebuild`, never history.
    const hasStoryDfTables = async () => {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from information_schema.tables
        where table_schema = 'public'
          and table_name in ('story_token_days', 'story_corpus_days')
      `.execute(harness.db);
      return Number(rows[0]?.n ?? 0);
    };

    await storyTokenDf.down(harness.db);
    expect(await hasStoryDfTables()).toBe(0);

    await storyTokenDf.up(harness.db);
    expect(await hasStoryDfTables()).toBe(2);
  });

  it("restores and re-drops the term cloud's tables cleanly", async () => {
    // 0014's `down` is the one rollback in this file that cannot return what it
    // took: the schema comes back EMPTY, because a week of hourly baseline
    // observations is not derivable from anything left standing (ADR-0013). What
    // is tested is that the rollback lands on a usable schema and that going
    // forward again drops all three — a `down` that recreated two of them would
    // leave the next `up` half-applying.
    const termTables = async () => {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from information_schema.tables
        where table_schema = 'public'
          and table_name in ('trending_terms', 'term_snapshots', 'term_baseline')
      `.execute(harness.db);
      return Number(rows[0]?.n ?? 0);
    };

    await dropTermCloud.down(harness.db);
    expect(await termTables()).toBe(3);
    // Restored empty, and writable — the state the tables were in at launch.
    await sql`
      insert into term_baseline (language, term, mean_df, updated_at)
      values ('en', 'kelowna', 1.5, now())
    `.execute(harness.db);

    await dropTermCloud.up(harness.db);
    expect(await termTables()).toBe(0);
  });

  it("is a no-op the second time", async () => {
    // Re-running against an up-to-date database must execute nothing — this is
    // what makes the deploy step safe to repeat after a half-failed release.
    const { error, results } = await migrateToLatest(harness.db);

    expect(error).toBeUndefined();
    expect(results).toEqual([]);
  });
});
