import { Kysely, PostgresDialect } from "kysely";
import type { ColumnType, Generated } from "kysely";
import pg from "pg";

/**
 * The §7.2 schema, as Kysely table types. Hand-maintained against the
 * migrations, which are the source of truth (ADR-0003) — there is no generator,
 * and the two are kept honest by the integration tests running real SQL against
 * a migrated database.
 *
 * Postgres `bigint` surfaces as `string`: the pg driver refuses to guess about
 * 2^53, and article ids are part of the timeline cursor, so silent precision
 * loss here would corrupt paging. `bytea` surfaces as `Buffer`.
 */

/** timestamptz: read as Date, written as Date or ISO string. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;

/**
 * One row per upstream emission — the faithful record of what we were sent
 * (ADR-0002). `dedup_key` is deliberately NOT unique here: 58% of live rows
 * would violate it.
 */
export interface SightingsTable {
  /** Upstream UUID. Unique per emission, and NOT an identity for the story. */
  id: string;
  article_id: string;
  dedup_key: Buffer;
  published: Timestamp;
  first_seen_at: Generated<Date>;
  /** Original payload; lets us re-normalize without refetching. */
  raw: ColumnType<unknown, string, string>;
}

/**
 * One row per real-world story — what the timeline pages over and what anything
 * countable counts (ADR-0002). Display fields are denormalized from the EARLIEST
 * sighting so a timeline read needs no join back to sightings.
 */
export interface ArticlesTable {
  /** Surrogate identity; the cursor half. Never the URL hash (ADR-0002). */
  id: Generated<string>;
  dedup_key: Buffer;
  url: string;
  title: string;
  description: string | null;
  author: string | null;
  image_url: string | null;
  language: string | null;
  categories: string[];
  /** Undocumented upstream field, kept verbatim (PROBE-FINDINGS 1). */
  source_category: string[];
  source_domain: string | null;
  /** EARLIEST sighting; the timeline axis. */
  published: Timestamp;
  /** Most recent sighting. */
  latest_seen: Timestamp;
  sighting_count: number;
}

export interface TopicsTable {
  fingerprint: Buffer;
  keywords: string[];
  language: string | null;
  country: string | null;
  category: string | null;
  /** Reserved: topic summary, later phase. */
  summary: string | null;
  summary_at: Timestamp | null;
  created_at: Generated<Date>;
  /** Drives worker prioritization + retention. */
  last_hit_at: Generated<Date>;
  hit_count: Generated<string>;
}

/**
 * Topic membership per ARTICLE, so a topic's timeline cannot be flooded by one
 * repeatedly-re-emitted post.
 */
export interface TopicArticlesTable {
  fingerprint: Buffer;
  article_id: string;
}

/**
 * Which time windows have actually been fetched for a topic — what makes "do I
 * need an upstream call?" an exact question instead of a guess. Written by the
 * Phase 3 query planner; the table exists now because the schema ships whole.
 */
export interface TopicCoverageTable {
  fingerprint: Buffer;
  /** tstzrange, as its text representation. */
  span: string;
  fetched_at: Generated<Date>;
}

/** Quota accounting + observability. */
export interface FetchLogTable {
  id: Generated<string>;
  fingerprint: Buffer | null;
  params: ColumnType<unknown, string | null, string | null>;
  requested_at: Timestamp;
  duration_ms: number | null;
  http_status: number | null;
  sighting_count: number | null;
  error_kind: string | null;
}

export interface Database {
  sightings: SightingsTable;
  articles: ArticlesTable;
  topics: TopicsTable;
  topic_articles: TopicArticlesTable;
  topic_coverage: TopicCoverageTable;
  fetch_log: FetchLogTable;
}

/**
 * A Kysely instance over a pg pool.
 *
 * NOTE: `migrateToLatest` needs a pool of at least two connections — it pins one
 * for the advisory lock while the migrator borrows others. The default (10) is
 * fine; just don't pass `max: 1` to a handle you intend to migrate through.
 */
export function createDb(
  connectionString: string,
  options: { max?: number } = {},
): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: options.max ?? 10 }),
    }),
  });
}

/** sha256-hex (fingerprints, dedup keys) → the bytea the schema stores. */
export function hexToBytea(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`expected 64 lowercase hex chars, got: ${hex.slice(0, 80)}`);
  }
  return Buffer.from(hex, "hex");
}
