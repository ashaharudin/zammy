import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { migrateToLatest } from "./migrator.js";
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
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it("is a no-op the second time", async () => {
    // Re-running against an up-to-date database must execute nothing — this is
    // what makes the deploy step safe to repeat after a half-failed release.
    const { error, results } = await migrateToLatest(harness.db);

    expect(error).toBeUndefined();
    expect(results).toEqual([]);
  });
});
