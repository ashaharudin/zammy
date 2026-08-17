import { sql, type Kysely } from "kysely";

/**
 * Which upstream reported a sighting (ARCHITECTURE 5.6).
 *
 * §5.6 named this as one of the two things a second provider costs: "a new
 * client satisfying the same interface plus a `provider` column on `articles`".
 * It lands on `sightings` as well, and the two columns mean deliberately
 * different things:
 *
 *   `sightings.provider` — exact, one row per emission. This is the honest
 *   record and the one worth counting: per-provider yield, per-provider drop
 *   rate, and the answer to "would we still have this article without GNews?"
 *
 *   `articles.provider` — the provider of the EARLIEST sighting, following the
 *   same rule every other denormalized display field on `articles` follows
 *   (ADR-0002). An article can be seen by both providers; this says who got
 *   there first, not who is authoritative.
 *
 * `DEFAULT 'currents'` backfills every existing row correctly, because until
 * this migration there was exactly one provider. The default stays afterwards
 * rather than being dropped: a write path that forgot to set it would otherwise
 * fail at 3am, and being wrong about the provider of one row is much cheaper
 * than refusing to ingest it.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE sightings ADD COLUMN provider text NOT NULL DEFAULT 'currents'
  `.execute(db);
  await sql`
    ALTER TABLE articles ADD COLUMN provider text NOT NULL DEFAULT 'currents'
  `.execute(db);

  // Supports the §12 per-provider yield metric — "how many distinct articles is
  // each provider actually contributing" — which is the number that decides
  // whether a supplement is worth its budget.
  await sql`CREATE INDEX sightings_provider_idx ON sightings (provider)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS sightings_provider_idx`.execute(db);
  await sql`ALTER TABLE articles DROP COLUMN IF EXISTS provider`.execute(db);
  await sql`ALTER TABLE sightings DROP COLUMN IF EXISTS provider`.execute(db);
}
