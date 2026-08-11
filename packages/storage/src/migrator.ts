import { Migrator, sql, type Kysely, type Migration, type MigrationResultSet } from "kysely";
import type { Database } from "./database.js";
import * as initialSchema from "./migrations/0001-initial-schema.js";
import * as dailyTerms from "./migrations/0002-daily-terms.js";
import * as articleGroups from "./migrations/0003-article-groups.js";
import * as tokenVersion from "./migrations/0004-token-version.js";

/**
 * Migrations as a static record rather than a directory scan: the file provider
 * resolves paths differently from `src` and `dist`, and a migration that exists
 * in one and not the other is a deploy that half-works. Names sort
 * lexicographically; keep the numeric prefix.
 */
const migrations: Record<string, Migration> = {
  "0001-initial-schema": initialSchema,
  "0002-daily-terms": dailyTerms,
  "0003-article-groups": articleGroups,
  "0004-token-version": tokenVersion,
};

/**
 * Session-scoped advisory lock key for the migration runner. Arbitrary but
 * stable; shared by every process that might migrate this database.
 */
const MIGRATION_LOCK_KEY = 7_226_461_501;

/**
 * Run all pending migrations.
 *
 * Migrations run as a discrete deploy step, never on application boot — but a
 * Postgres advisory lock guards the runner anyway, as a backstop for anyone who
 * wires it into boot regardless (ADR-0003). The lock is held on a pinned
 * connection for the duration, so two racing runners serialize instead of
 * interleaving DDL.
 */
export async function migrateToLatest(db: Kysely<Database>): Promise<MigrationResultSet> {
  const migrator = new Migrator({
    db,
    provider: {
      getMigrations: () => Promise.resolve(migrations),
    },
  });

  // The pinned connection holds the lock; the migrator borrows others from the
  // same pool. This is why createDb warns against max: 1.
  return db.connection().execute(async (connection) => {
    await sql`select pg_advisory_lock(${sql.lit(MIGRATION_LOCK_KEY)})`.execute(connection);
    try {
      return await migrator.migrateToLatest();
    } finally {
      await sql`select pg_advisory_unlock(${sql.lit(MIGRATION_LOCK_KEY)})`.execute(connection);
    }
  });
}
