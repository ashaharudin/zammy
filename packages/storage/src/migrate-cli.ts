import { createDb, databaseSsl, type DatabaseSslMode } from "./database.js";
import { migrateToLatest } from "./migrator.js";

/**
 * `pnpm db:migrate` — the discrete migration step (ADR-0003). Locally it runs
 * against the compose Postgres; in a deploy it runs as a deploy task, never on
 * application boot.
 *
 * The environment is read raw rather than through @zammy/config, as it always
 * has been: this package sits BELOW that one, and a library that reads the
 * process environment for four names is a smaller thing than a storage layer
 * that depends on the package holding the API keys. @zammy/config remains the
 * definition of what these names mean — it validates the same four for every
 * process that boots, and this file must not drift from it.
 */

const SSL_MODES = ["disable", "require", "verify-full"] as const;

function isSslMode(value: string): value is DatabaseSslMode {
  return (SSL_MODES as readonly string[]).includes(value);
}

/**
 * The SESSION-mode connection when there is one. The migrator holds
 * `pg_advisory_lock` on a pinned connection for the duration (migrator.ts), and
 * a pin from a pool is not a pin to a backend: through a transaction-mode
 * pooler the lock is taken on one backend and released against another, so two
 * racing deploys interleave DDL instead of serializing — the one failure this
 * lock exists to prevent (RESEARCH-VERCEL-SUPABASE §4.1).
 */
const databaseUrl = process.env.DATABASE_SESSION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is required (e.g. postgres://zammy:zammy@localhost:5432/zammy).\n" +
      "Set DATABASE_SESSION_URL instead when Postgres is behind a transaction-mode " +
      "pooler — the migration lock is session-scoped.",
  );
  process.exit(1);
}

const sslMode = process.env.DATABASE_SSL ?? "disable";
if (!isSslMode(sslMode)) {
  console.error(`DATABASE_SSL must be one of ${SSL_MODES.join(" | ")} (got '${sslMode}')`);
  process.exit(1);
}

const ssl = ((): ReturnType<typeof databaseSsl> => {
  try {
    return databaseSsl({ mode: sslMode, caCert: process.env.DATABASE_CA_CERT });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
})();

// Which connection, in the output: a migration that ran against the wrong one
// of two URLs is otherwise indistinguishable from one that ran against the right
// one, and this is the line an operator reads when a deploy did nothing.
console.log(
  `migrating via ${process.env.DATABASE_SESSION_URL ? "DATABASE_SESSION_URL" : "DATABASE_URL"}` +
    `, TLS ${sslMode}`,
);

// The default pool (10) stands: the migrator pins one connection for the lock
// and borrows others, so this handle must not be narrowed to 1.
const db = createDb(databaseUrl, { ssl });
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
