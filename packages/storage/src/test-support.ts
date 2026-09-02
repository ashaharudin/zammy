import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import type { Kysely } from "kysely";
import { RawSighting, normalizeSightings, type Sighting } from "@zammy/currents-client";
import type { Database } from "./database.js";
import { createDb } from "./database.js";

/**
 * Ephemeral Postgres databases for integration tests (ARCHITECTURE 12).
 *
 * These tests run against a real Postgres — the collapse is ON CONFLICT
 * arithmetic and the timeline is composite-tuple keyset SQL, exactly the two
 * things an in-memory fake would fake wrong. Each suite gets its own throwaway
 * database on the local dev server (`pnpm infra:up`), so files can run in
 * parallel and a crashed run leaves nothing behind that the next `CREATE
 * DATABASE` trips over.
 *
 * **That argument is true of the upserts and false of the rules ABOVE them, and
 * the difference is worth stating because it was read too widely.** "The
 * collapse is ON CONFLICT arithmetic" justifies a database for the arithmetic:
 * the `dedup_key` arbiter, the savepoints, the CHECK constraints, the keyset
 * order. It does not justify one for the fold's PRECEDENCE table — which
 * candidate row wins, and what a sighting may hand over — because those are
 * decisions over domain values and nothing about them is arithmetic. They live
 * in `fold.ts` and are asserted without a database, against the SQL they came
 * out of in `fold-differential.test.ts`. A truth table asserted through a
 * throwaway database is asserted at one sample per migration.
 *
 * So the question to ask before calling this is not "does this test touch
 * storage" but "does the thing being asserted need Postgres to be TRUE".
 */

const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://zammy:zammy@localhost:5432/zammy";

export interface TestDatabase {
  db: Kysely<Database>;
  /** Drops the database. Always call in afterAll, even when tests fail. */
  drop: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `zammy_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const db = createDb(url.toString());

  return {
    db,
    drop: async () => {
      await db.destroy();
      const cleanup = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/**
 * The recorded duplication payload: 100 sightings, 100 unique ids, 42 unique
 * URLs, one link-roundup page appearing 50 times (PROBE-FINDINGS 4). Normalized
 * through the real client path, so these tests exercise the same sightings the
 * ingest path will see in production — synthetic articles are exactly what would
 * have hidden the duplication bug.
 */
export function loadClimateSightings(): Sighting[] {
  const data = JSON.parse(
    readFileSync(
      new URL("../../../fixtures/search-climate-duplicates.json", import.meta.url),
      "utf8",
    ),
  ) as { pages: Array<{ news: unknown[] }> };

  const raw = data.pages
    .flatMap((page) => page.news)
    .map((item) => RawSighting.parse(item));

  const { sightings, stats } = normalizeSightings(raw);
  if (stats.kept !== stats.received) {
    throw new Error(`fixture sightings failed normalization: ${JSON.stringify(stats)}`);
  }
  return sightings;
}

/** A syntactically valid sha256-hex fingerprint for tests. */
export function testFingerprint(seed: string): string {
  return seed.padEnd(64, "0").slice(0, 64).replaceAll(/[^0-9a-f]/g, "0");
}
