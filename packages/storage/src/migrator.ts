import { Migrator, sql, type Kysely, type Migration, type MigrationResultSet } from "kysely";
import type { Database } from "./database.js";
import * as initialSchema from "./migrations/0001-initial-schema.js";
import * as dailyTerms from "./migrations/0002-daily-terms.js";
import * as articleGroups from "./migrations/0003-article-groups.js";
import * as tokenVersion from "./migrations/0004-token-version.js";
import * as rollingTerms from "./migrations/0005-rolling-terms.js";
import * as storylines from "./migrations/0006-storylines.js";
import * as storylineTables from "./migrations/0007-storyline-tables.js";
import * as storyTokenDf from "./migrations/0008-story-token-df.js";
import * as storylineBridges from "./migrations/0009-storyline-bridges.js";
import * as labelDrift from "./migrations/0010-storyline-label-drift.js";
import * as labelSource from "./migrations/0011-storyline-label-source.js";
import * as dropDayStorylines from "./migrations/0012-drop-day-storylines.js";
import * as sightingProvider from "./migrations/0013-sighting-provider.js";
import * as dropTermCloud from "./migrations/0014-drop-term-cloud.js";
import * as formationRefusals from "./migrations/0015-storyline-formation-refusals.js";
import * as labelWordsColumn from "./migrations/0016-storyline-label-words.js";
import * as linkDirty from "./migrations/0017-storyline-link-dirty.js";
import * as choreRuns from "./migrations/0018-chore-runs.js";
import * as rowLevelSecurity from "./migrations/0019-enable-row-level-security.js";
import * as articleAltKey from "./migrations/0020-article-alt-key.js";

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
  "0005-rolling-terms": rollingTerms,
  "0006-storylines": storylines,
  "0007-storyline-tables": storylineTables,
  "0008-story-token-df": storyTokenDf,
  "0009-storyline-bridges": storylineBridges,
  "0010-storyline-label-drift": labelDrift,
  "0011-storyline-label-source": labelSource,
  "0012-drop-day-storylines": dropDayStorylines,
  "0013-sighting-provider": sightingProvider,
  "0014-drop-term-cloud": dropTermCloud,
  "0015-storyline-formation-refusals": formationRefusals,
  "0016-storyline-label-words": labelWordsColumn,
  "0017-storyline-link-dirty": linkDirty,
  "0018-chore-runs": choreRuns,
  "0019-enable-row-level-security": rowLevelSecurity,
  "0020-article-alt-key": articleAltKey,
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
