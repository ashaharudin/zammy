import { createDb } from "./database.js";
import { migrateToLatest } from "./migrator.js";

/**
 * `pnpm db:migrate` — the discrete migration step (ADR-0003). Locally it runs
 * against the compose Postgres; in AWS it runs as a deploy task, never on
 * application boot.
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required (e.g. postgres://zammy:zammy@localhost:5432/zammy)");
  process.exit(1);
}

const db = createDb(databaseUrl);
const { error, results } = await migrateToLatest(db);

for (const result of results ?? []) {
  console.log(`${result.status.padEnd(8)} ${result.migrationName}`);
}
if ((results ?? []).length === 0 && !error) {
  console.log("Nothing to migrate — database is up to date.");
}

await db.destroy();

if (error) {
  console.error("Migration failed:", error);
  process.exit(1);
}
