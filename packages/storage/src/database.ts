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
 * The same, but the schema supplies it when an insert omits it — spelled out
 * rather than wrapped in `Generated`, which infers the SELECT side back to the
 * ColumnType itself and makes `where` comparisons on the column unusable.
 */
type DefaultedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

/**
 * Why a fetch was made (ADR-0019). A closed set of three, mirrored by
 * `sightings_plane_check` in migration 0022 — the constraint is what makes a
 * typo a failed insert rather than a silent join to the discovery plane, and
 * this type is what makes it a compile error one layer earlier.
 *
 * Exported from the package because the callers that PLAN fetches live above it
 * (`apps/api`), and they are the ones that have to name a plane.
 */
export type SightingPlane = "search" | "breadth" | "deepening";

/**
 * One row per upstream emission — the faithful record of what we were sent
 * (ADR-0002). `dedup_key` is deliberately NOT unique here: 58% of live rows
 * would violate it.
 */
export interface SightingsTable {
  /**
   * Sighting identity, unique across providers and NOT an identity for the
   * story. Currents' own UUID where it sent one; a UUIDv5 derived from
   * `provider:id` where it did not (migration 0013).
   */
  id: string;
  article_id: string;
  dedup_key: Buffer;
  published: Timestamp;
  first_seen_at: Generated<Date>;
  /** Which upstream reported this emission. Exact, one row per emission. */
  provider: Generated<string>;
  /**
   * WHY this fetch was made: `search` | `breadth` | `deepening` (ADR-0019,
   * migration 0022). Not derivable from `provider` — the same provider answers
   * a reader's search and a cloud-driven deepening fetch — and not derivable
   * from anything else on the row, which is why the caller that PLANNED the
   * fetch supplies it.
   *
   * `null` on every row written before migration 0022: the reason was not
   * recorded, and inventing one would have been a claim the archive disproves
   * (the migration carries the numbers). Read it with `is distinct from`, never
   * with `<>` — see `readTrendingStorylines`, where the bare form measurably
   * empties the cloud.
   *
   * The `ColumnType` is doing three separate jobs and none of them is cosmetic:
   *
   *  - **read `SightingPlane | null`** — history is NULL and every reader has to
   *    handle it.
   *  - **insert `SightingPlane`, non-null and REQUIRED** — this is the `NOT
   *    NULL` the column cannot have. A bare `SightingPlane | null` would not do
   *    it: Kysely makes any column whose insert type admits `null` OPTIONAL on
   *    insert, so the nullability meant for history would have silently excused
   *    every future writer from naming a plane.
   *  - **update `never`** — a plane is minted by the fetch that recorded the
   *    sighting and is not a fact that can change afterwards. The same rule
   *    `dedup_key` and `alt_key` follow on `articles`, for a related reason: a
   *    row that could be re-planed could be moved in and out of the ranking
   *    after the fact.
   */
  plane: ColumnType<SightingPlane | null, SightingPlane, never>;
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
  /**
   * sha256 of the canonical URL. The PRIMARY identity, minted once from the URL
   * of the sighting that created the row and never rewritten — so a row whose
   * `url` was handed over to an earlier sighting under a different link (see
   * `alt_key`) keeps the key it was minted with. Identity is stable; `url` is a
   * display field.
   */
  dedup_key: Buffer;
  /**
   * The FALLBACK identity: sha256 of `(source_domain, folded title, UTC day)`,
   * consulted by ingest only when `dedup_key` matches nothing (ADR-0018,
   * migration 0020). NULL means "identified by URL alone" — either because the
   * title could not carry a key (`deriveAltKey` refuses a source-truncated one)
   * or because 0020's backfill declined to key a row whose historical key
   * collides. Unique where present, via a partial index.
   *
   * `Generated` because it is optional on insert, not because the database
   * computes it: a nullable column with no default supplies NULL, which is the
   * correct value for a caller with no key to offer.
   *
   * Minted once, like `dedup_key`, and for the same reason: rewriting it when a
   * later sighting hands over the title would change an article's identity under
   * a live unique index.
   */
  alt_key: Generated<Buffer | null>;
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
  /**
   * Which upstream reported the EARLIEST sighting, following the same rule as
   * every other denormalized field here (ADR-0002). "Who got there first", not
   * "who is authoritative": an article can be seen by both providers, and
   * `sightings.provider` is where the exact record lives.
   */
  provider: Generated<string>;
  /** EARLIEST sighting; the article's own place in time. */
  published: Timestamp;
  /** Most recent sighting. */
  latest_seen: Timestamp;
  sighting_count: number;
  /**
   * The group's identity: the SEED article's id, self for a group of one
   * (§14.3). Generated by a BEFORE INSERT trigger, hence `Generated` — an
   * insert may omit it, and every row still lands in a group.
   */
  group_id: Generated<string>;
  /** MIN(published) over the group. */
  group_published: DefaultedTimestamp;
  /** Headline tokens; what same-day grouping candidates are matched on. */
  title_tokens: Generated<string[]>;
  /**
   * Which tokenizer produced `title_tokens` AND `story_tokens` — both are
   * derivations of one tokenizer generation. Rows below the current version
   * compare against stale vocabulary until the regroup command re-derives them
   * (ADR-0005); 0 means "older than the version column".
   */
  tokens_version: Generated<number>;
  /**
   * Title+description tokens: the LINKER's input (ADR-0011) — what an arriving
   * group is compared on, and the GIN surface candidate retrieval overlaps
   * against `storylines.profile_tokens`. They outlived the day-bounded
   * storyline that introduced them; a storyline's own identity and position
   * live in `storylines` and `storyline_days` (migration 0012).
   */
  story_tokens: Generated<string[]>;
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
 * need an upstream call?" an exact question instead of a guess (ADR-0001).
 * Written by the query planner in `apps/api` as each gap segment completes.
 *
 * Per topic AND per provider since migration 0021, which is the one thing to
 * know before reading a row as "we have everything for this span": a row means
 * THAT provider fetched the span, not that every configured provider did.
 * ADR-0019 is the decision — coverage is `(subject, provider, span)`, no
 * provider privileged, each recording only what it actually walked — and it says
 * plainly that "is this span covered" therefore stops having a single answer.
 *
 * Both sides of `coverage.ts` are scoped to the provider accordingly. Which
 * provider a caller asks about is the planner's decision, not this table's.
 */
export interface TopicCoverageTable {
  fingerprint: Buffer;
  /**
   * Which upstream fetched this span (migration 0021), defaulting to
   * `'currents'` — a statement about the only provider that had ever written
   * here, not a designation.
   *
   * ADR-0019's shape: each provider's spans are separable, so no provider can
   * claim what another fetched. `readCoverage` and `recordCoverage` both filter
   * on it — a read that did not would union two providers' spans back into the
   * single answer ADR-0019 says this question no longer has.
   */
  provider: Generated<string>;
  /** tstzrange, as its text representation. */
  span: string;
  fetched_at: Generated<Date>;
}

/**
 * Coverage keyed on the arc rather than on a search — the subject a `deepening`
 * fetch covers (migration 0021; ADR-0019;
 * docs/DESIGN-DISCOVERY-AND-DEEPENING.md §2b).
 *
 * Same question as `topic_coverage` — "did we ask, or was nothing published?" —
 * about a different subject. A storyline is a persistent arc whose identity is a
 * UUID (ADR-0011), so a fetch pointed at an arc records what it covered without
 * inventing a topic fingerprint to hang it on, and, more importantly, without
 * being able to reach `topic_coverage` at all.
 *
 * No `Generated` on `provider`: unlike `topic_coverage` there is no history to
 * default, and which plane writes here is decided by its caller, not by the
 * schema. `storyline_id` is non-nullable in the schema as well as here — a
 * coverage row with no subject is a claim with no claimant, and unlike
 * `topic_coverage.fingerprint` this table had no existing rows to accommodate.
 */
export interface StorylineCoverageTable {
  storyline_id: string;
  provider: string;
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

/*
 * No cloud tables. The landing-page cloud names the storylines the rolling
 * window updated (ADR-0013), which `storylines` + `storyline_groups` already
 * hold; `trending_terms`, `term_snapshots` and `term_baseline` were dropped
 * with the term cloud they served (migration 0014).
 */

/**
 * Provisional until a second group attaches, active once promoted, dormant once
 * it has gone ~90 days without coverage (ADR-0011's Lifecycle). Nothing ends a
 * storyline: dormant means "out of the normal candidate set", not dead.
 */
export type StorylineStatus = "provisional" | "active" | "dormant";

/**
 * How a chore run ended. `skipped` is first-class because the advisory lock
 * makes it a NORMAL outcome — the second of two schedulers skipping is the
 * mechanism working, not a failure and not a success (migration 0018).
 */
export type ChoreOutcome = "ok" | "failed" | "skipped";

/**
 * One persistent arc of one event (ADR-0011). Identity is the UUID and only the
 * UUID — the label is non-unique presentation that regenerates as the storyline
 * drifts, so nothing may key off it.
 */
export interface StorylinesTable {
  id: Generated<string>;
  /** 2–5 words naming the event; null until promotion, and null is renderable. */
  label: string | null;
  /** When the label was generated — the drift-relabel clock (ADR-0011, Labels). */
  label_at: Timestamp | null;
  /**
   * Member groups at the moment the label was generated. The other half of the
   * drift clock, and not derivable: `storyline_groups.attached_at` survives a
   * merge, so a join older than `label_at` may have reached this storyline long
   * after it. Null means "no baseline" — the next trigger relabels.
   */
  label_group_count: number | null;
  /**
   * What produced the label: the model id, `bigram` for the extractor, or null
   * for unknown provenance. The model ID and not an enum, because "is this from
   * the model configured NOW" is the question a relabel campaign asks, and
   * upgrading between models is the same operation as upgrading from the
   * fallback.
   */
  label_source: string | null;
  /**
   * The label's own words, folded by `normalizeLabel` — the OTHER vocabulary a
   * search surfaces a storyline by (ADR-0011, as amended). Written beside the
   * label by its one writer rather than derived on read, because the fold is
   * `trimWordPunctuation` then `singular` and neither exists in SQL; deriving
   * it there would be a second definition of "the label's words" in another
   * language, drifting silently from this one.
   *
   * Folded the same way and in the same order as `story_tokens` and therefore
   * `profile_tokens`, which is what lets surfacing compare ONE spelling of a
   * keyword against both columns. `'{}'` for an unlabelled storyline, and for a
   * labelled one that migration 0016 has not yet had backfilled.
   */
  label_words: Generated<string[]>;
  /**
   * Tokens carried by at least half the member groups, and by no fewer than two
   * of them wherever there are two (ADR-0026): the storyline's own
   * vocabulary, and the GIN surface candidate retrieval overlaps against. The
   * majority rule is the percolation damper — a growing storyline's consensus
   * vocabulary tightens rather than loosens.
   */
  profile_tokens: Generated<string[]>;
  status: Generated<StorylineStatus>;
  /**
   * Set when this storyline lost a merge: the row survives as an alias so
   * nothing holding the UUID dangles. Non-null means "not a storyline, a
   * pointer" — resolve it before using it.
   */
  merged_into: string | null;
  created_at: Generated<Date>;
  /**
   * Something the LINKER reads about this arc changed, and no late-candidate
   * offer has been made against it since (migration 0017). Null means carried
   * forward. The nightly sweep's changed-set filter is the only reader, and it
   * clears what it consumed.
   */
  link_dirty_at: Timestamp | null;
}

/** Group ↔ storyline, many-to-many: a group may belong to several storylines. */
export interface StorylineGroupsTable {
  storyline_id: string;
  group_id: string;
  attached_at: Generated<Date>;
}

/**
 * One row per storyline per day it has coverage — the timeline's paginated unit
 * (ADR-0011). Position is precomputed here at write time, so step one of the
 * read stays a pure index scan and reads never re-sort (ADR-0002's spirit).
 */
export interface StorylineDaysTable {
  storyline_id: string;
  /** YYYY-MM-DD in APP_TIMEZONE; a bucket label, never arithmetic. */
  day_key: string;
  /** That day's earliest article's `published` — the keyset axis. */
  day_slot_published: Timestamp;
  /** That day's earliest article: the slot's hero. */
  lead_article_id: string;
}

/**
 * Per-day document frequency of `story_tokens` — the trailing corpus the v2
 * linker measures rarity against (ADR-0011). Counted per ARTICLE, bucketed by
 * the APP_TIMEZONE day so the window can roll; `language` is '' when the
 * article declares none. Derived from `articles` and rebuildable from it.
 */
export interface StoryTokenDaysTable {
  /** YYYY-MM-DD, text so the driver cannot reinterpret it as a local Date. */
  day: string;
  language: string;
  token: string;
  df: number;
}

/** The denominator to `story_token_days`: articles per day-language bucket. */
export interface StoryCorpusDaysTable {
  day: string;
  language: string;
  articles: number;
}

/**
 * One group that qualified for both storylines of a pair (ADR-0011). K distinct
 * such groups merge them; one is refused. Stored canonically ordered, so a pair
 * is one row set however the qualifiers happened to sort.
 */
export interface StorylineBridgesTable {
  storyline_lo: string;
  storyline_hi: string;
  group_id: string;
  observed_at: Generated<Date>;
}

/**
 * A formation a coherence verdict refused (migration 0015): these two groups are
 * not one story. Canonically ordered, and keyed on GROUPS rather than storyline
 * UUIDs because a provisional storyline-of-one can be merged away while the
 * groups the verdict read are still there.
 */
export interface StorylineFormationRefusalsTable {
  group_lo: string;
  group_hi: string;
  refused_at: Generated<Date>;
}

/**
 * Which 6-hour UTC quarter a summary covers, or `day` for the whole-day
 * sentence. Mirrored by `storyline_day_summaries_segment_check` in migration
 * 0024 — the constraint makes a typo a failed insert, this type makes it a
 * compile error one layer earlier.
 *
 * The quarters are even and UTC (night 00-06, morning 06-12, afternoon 12-18,
 * evening 18-24), which is what keeps a segment inside its own day: a "night"
 * spanning midnight would belong half to yesterday.
 */
export type SummarySegment = "night" | "morning" | "afternoon" | "evening" | "day";

/**
 * One preserved sentence about a storyline's day, or about one quarter of it
 * (migration 0024, ADR-0023).
 *
 * The one table here that retention must never reach, and the one with no
 * foreign key to `storylines`: the migration has both arguments. What matters
 * to a reader of this type is that every field is written from what was true at
 * generation time and none of it is re-derived on read — `label` in particular
 * is the label the sentence was generated under, not the label the arc carries
 * now.
 */
export interface StorylineDaySummariesTable {
  /** Soft pointer, deliberately unconstrained: a merge leaves this on the id it
   * was written for, and `storylines.merged_into` resolves it. */
  storyline_id: string;
  /** YYYY-MM-DD, always UTC — unlike `storyline_days.day_key`, which is APP_TIMEZONE. */
  day_key: string;
  segment: SummarySegment;
  /** Null means the model was asked and refused; no row at all means no articles. */
  summary: string | null;
  /** Articles this sentence was generated over — the recompute trigger's input. */
  article_count: number;
  /** The storyline's label AS IT READ at generation time. Labels drift. */
  label: string | null;
  /** The model id, or null when no model was configured. */
  model_id: string | null;
  attempts: Generated<number>;
  /** False on a day summarized without segments — see the migration's note on
   * the Google News pubDate cliff. */
  segmented: Generated<boolean>;
  generated_at: DefaultedTimestamp;
}

/**
 * One run of one nightly pass (migration 0018): the durable answer to "did last
 * night's chores run?", which a 202-and-`waitUntil` route plus one hour of log
 * retention cannot otherwise give (VERCEL-ALL-IN-SCOPE §3.3).
 *
 * The row is inserted BEFORE the pass and updated after it, so `finished_at IS
 * NULL` on an old row says the pass started and did not come back — a function
 * killed at `maxDuration` runs no `finally` and would otherwise leave nothing at
 * all.
 */
export interface ChoreRunsTable {
  id: Generated<string>;
  /** The addressable pass name, as the route's `?pass=` and the CLI spell it. */
  pass: string;
  /** `route` or `cli` — both entrypoints record here. */
  source: string;
  started_at: Generated<Date>;
  /** Null while the pass is in flight, and forever if it never returned. */
  finished_at: Timestamp | null;
  /** `ok` | `failed` | `skipped`; null exactly when `finished_at` is. */
  outcome: ChoreOutcome | null;
  /** The pass's own report, summarized — see `summarizeChoreReport`. */
  report: ColumnType<unknown, string | null, string | null>;
  /** The failure message for `failed`. The stack goes to the log. */
  error: string | null;
  /** Model calls spent, hoisted out of `report` because it is summed across rows. */
  model_calls: number | null;
}

export interface Database {
  sightings: SightingsTable;
  articles: ArticlesTable;
  topics: TopicsTable;
  topic_articles: TopicArticlesTable;
  topic_coverage: TopicCoverageTable;
  storyline_coverage: StorylineCoverageTable;
  fetch_log: FetchLogTable;
  storylines: StorylinesTable;
  storyline_groups: StorylineGroupsTable;
  storyline_days: StorylineDaysTable;
  story_token_days: StoryTokenDaysTable;
  story_corpus_days: StoryCorpusDaysTable;
  storyline_bridges: StorylineBridgesTable;
  storyline_formation_refusals: StorylineFormationRefusalsTable;
  storyline_day_summaries: StorylineDaySummariesTable;
  chore_runs: ChoreRunsTable;
}

/** How TLS to Postgres is decided. libpq's names, minus the modes nobody here wants. */
export type DatabaseSslMode = "disable" | "require" | "verify-full";

export interface DatabaseSslSettings {
  mode: DatabaseSslMode;
  /** PEM chain. Required by `verify-full`, meaningless otherwise. */
  caCert?: string | undefined;
}

/** What `pg` accepts as its `ssl` option: off, or a TLS configuration. */
export type DatabaseSslOption = false | { ca?: string; rejectUnauthorized: boolean };

/**
 * Build `pg`'s `ssl` option from validated settings.
 *
 * TLS lives here rather than in the connection string on purpose: node-postgres
 * silently ignores this object whenever the URL carries `sslmode`, so a URL and
 * an `ssl` option that disagree resolve in favour of the URL with nothing said
 * about it (@zammy/config's `PostgresUrl` refuses such a URL for that reason).
 *
 * `require` is spelled out as unverified rather than dressed up: it encrypts and
 * trusts whatever answers. That is a real, common choice against a managed
 * Postgres whose CA is not to hand; what it must not be is the thing that
 * *looks* like verification.
 *
 * Throws on `verify-full` with no certificate. @zammy/config catches that at
 * boot for every process that loads it, but `migrate-cli` reads the environment
 * raw (it sits below the config package), so the check has to exist here too.
 */
export function databaseSsl(settings: DatabaseSslSettings): DatabaseSslOption {
  if (settings.mode === "disable") return false;
  if (settings.mode === "require") return { rejectUnauthorized: false };
  const ca = normalizePem(settings.caCert);
  if (!ca) {
    throw new Error("DATABASE_SSL=verify-full requires DATABASE_CA_CERT (a PEM chain)");
  }
  return { ca, rejectUnauthorized: true };
}

/**
 * A PEM pasted into a dashboard field arrives as one line with the newlines
 * escaped; Node's TLS stack needs them real. Harmless on a PEM that already has
 * them, since a literal backslash-n cannot appear in base64.
 */
function normalizePem(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  return value.replaceAll("\\n", "\n");
}

/**
 * A Kysely instance over a pg pool — either a fresh one from a connection
 * string, or an existing pool the app already health-checks. `destroy()` ends
 * the pool in both cases, so an app sharing its pool must not end it twice.
 *
 * `ssl` applies only to a pool built here; a caller passing its own pool has
 * already decided its TLS (server.ts does, so `/readyz` and Kysely share one).
 *
 * NOTE: `migrateToLatest` needs a pool of at least two connections — it pins one
 * for the advisory lock while the migrator borrows others. The default (10) is
 * fine; just don't pass `max: 1` to a handle you intend to migrate through.
 */
export function createDb(
  connection: string | pg.Pool,
  options: { max?: number; ssl?: DatabaseSslOption } = {},
): Kysely<Database> {
  const pool =
    typeof connection === "string"
      ? new pg.Pool({
          connectionString: connection,
          max: options.max ?? 10,
          ssl: options.ssl ?? false,
        })
      : connection;
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** sha256-hex (fingerprints, dedup keys) → the bytea the schema stores. */
export function hexToBytea(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`expected 64 lowercase hex chars, got: ${hex.slice(0, 80)}`);
  }
  return Buffer.from(hex, "hex");
}
