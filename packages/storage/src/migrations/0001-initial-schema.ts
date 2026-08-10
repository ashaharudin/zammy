import { sql, type Kysely } from "kysely";

/**
 * The §7.2 schema, verbatim. Hand-written DDL (ADR-0003): the hard parts —
 * the tstzrange coverage span with its GiST index and the composite timeline
 * index — are the point of the schema, and no generator writes them.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  // The GiST index on (fingerprint bytea, span tstzrange) mixes a btree-ish
  // column into a GiST index, which stock Postgres refuses without this.
  await sql`CREATE EXTENSION IF NOT EXISTS btree_gist`.execute(db);

  // One row per real-world story. Display fields are denormalized from the
  // EARLIEST sighting so a timeline read needs no join back to sightings.
  await sql`
    CREATE TABLE articles (
      id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      dedup_key       bytea NOT NULL,
      url             text NOT NULL,
      title           text NOT NULL,
      description     text,
      author          text,
      image_url       text,
      language        text,
      categories      text[] NOT NULL DEFAULT '{}',
      source_category text[] NOT NULL DEFAULT '{}',
      source_domain   text,
      published       timestamptz NOT NULL,
      latest_seen     timestamptz NOT NULL,
      sighting_count  int NOT NULL DEFAULT 1
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX articles_dedup_key_idx ON articles (dedup_key)`.execute(db);
  // The keyset axis: ORDER BY published DESC, id DESC (§7.3).
  await sql`CREATE INDEX articles_timeline_idx ON articles (published DESC, id DESC)`.execute(db);

  // One row per upstream emission. dedup_key is NOT unique here — 58% of live
  // rows would violate it (ADR-0002).
  await sql`
    CREATE TABLE sightings (
      id            uuid PRIMARY KEY,
      article_id    bigint NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      dedup_key     bytea NOT NULL,
      published     timestamptz NOT NULL,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      raw           jsonb NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX sightings_article_idx ON sightings (article_id)`.execute(db);
  await sql`CREATE INDEX sightings_dedup_idx ON sightings (dedup_key)`.execute(db);

  await sql`
    CREATE TABLE topics (
      fingerprint   bytea PRIMARY KEY,
      keywords      text[] NOT NULL,
      language      text,
      country       text,
      category      text,
      summary       text,
      summary_at    timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      last_hit_at   timestamptz NOT NULL DEFAULT now(),
      hit_count     bigint NOT NULL DEFAULT 0
    )
  `.execute(db);

  // Membership per ARTICLE, so one repeatedly-re-emitted post cannot flood a
  // topic's timeline (§7.2).
  await sql`
    CREATE TABLE topic_articles (
      fingerprint bytea  REFERENCES topics   ON DELETE CASCADE,
      article_id  bigint REFERENCES articles ON DELETE CASCADE,
      PRIMARY KEY (fingerprint, article_id)
    )
  `.execute(db);

  // What separates "nothing was published then" from "we never asked" (§7.2).
  await sql`
    CREATE TABLE topic_coverage (
      fingerprint bytea REFERENCES topics ON DELETE CASCADE,
      span        tstzrange NOT NULL,
      fetched_at  timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE INDEX topic_coverage_gist ON topic_coverage USING gist (fingerprint, span)
  `.execute(db);

  await sql`
    CREATE TABLE fetch_log (
      id             bigserial PRIMARY KEY,
      fingerprint    bytea,
      params         jsonb,
      requested_at   timestamptz NOT NULL,
      duration_ms    int,
      http_status    int,
      sighting_count int,
      error_kind     text
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS fetch_log`.execute(db);
  await sql`DROP TABLE IF EXISTS topic_coverage`.execute(db);
  await sql`DROP TABLE IF EXISTS topic_articles`.execute(db);
  await sql`DROP TABLE IF EXISTS topics`.execute(db);
  await sql`DROP TABLE IF EXISTS sightings`.execute(db);
  await sql`DROP TABLE IF EXISTS articles`.execute(db);
}
