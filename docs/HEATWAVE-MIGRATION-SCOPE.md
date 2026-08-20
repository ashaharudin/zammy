# Scope — code changes required to run on MySQL HeatWave

Companion to [RESEARCH-OCI-ALWAYS-FREE-DATABASES.md](RESEARCH-OCI-ALWAYS-FREE-DATABASES.md), which
concluded HeatWave is *viable as a database but not recommended for this project*. This document
does not revisit that verdict; it prices it. Every codebase claim is grounded in a file:line
reference from a full sweep of `packages/storage`, `apps/api`, and the deploy/CI configuration
(2026-08-18).

**Bottom line: a rewrite of the storage layer's mechanisms, not a dialect swap.** Kysely's built-in
MySQL dialect makes the query-builder calls port cheaply, but the load-bearing SQL — the ingest
upsert, coverage merging, candidate retrieval, profile derivation, the group-identity trigger — was
designed in Postgres features MySQL lacks or expresses so differently that the surrounding module
logic changes shape. Estimated scale: **all 13 non-test modules in `packages/storage` change; 4 are
redesigns; all 15 migrations are replaced; all 10 integration-test files re-validate against new
SQL; plus config, compose, CI, and cloud-init.**

## 1. Change classes at a glance

| Class | Meaning | Modules |
|---|---|---|
| **Redesign** | The mechanism has no MySQL equivalent; module logic changes shape | `coverage.ts`, `ingest.ts`, migration 0003's trigger (moves into app code), `database.ts` type surface |
| **Rewrite** | Same shape, most statements rewritten (arrays→JSON, RETURNING removal, CTE splitting) | `storylines.ts`, `story-df.ts`, `grouping.ts`, `storyline-timeline.ts` |
| **Port** | Mechanical translation (syntax, casts, functions) | `trending-storylines.ts`, `retention.ts`, `topics.ts`, `migrator.ts`, `migrate-cli.ts`, `index.ts` |
| **Replace** | Thrown away and re-authored | all 15 files in `migrations/`, `test-support.ts` (CREATE/DROP DATABASE mechanics) |

Ports *cleanly* (MySQL 8.0+/HeatWave supports these): read-only CTEs, recursive CTEs (`resolveIn`,
[storylines.ts:994](../packages/storage/src/storylines.ts)), window functions, `LATERAL` joins
([trending-storylines.ts:97](../packages/storage/src/trending-storylines.ts)), `LEAST`/`GREATEST`,
`NOW()`, correlated subqueries, and transactions generally.

## 2. The six load-bearing mechanisms, priced

### 2.1 `RETURNING` + the `xmax = 0` insert-vs-update detection — **ingest.ts redesign**

MySQL's `INSERT` has no `RETURNING` and no system columns. The ingest fold
([ingest.ts:121–147](../packages/storage/src/ingest.ts)) does
upsert-and-return-id-and-was-created in one statement; the MySQL idiom is a different mechanism:

- **Get the id back:** `INSERT ... ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`, then read
  `LAST_INSERT_ID()` — the canonical trick, working only because `articles.id` is `AUTO_INCREMENT`.
- **Detect insert-vs-update:** the driver's `affectedRows` is 1 for a fresh insert, 2 for a
  duplicate-key update (with at least one column written). Kysely's MySQL dialect surfaces
  `numInsertedOrUpdatedRows`, so the 1-vs-2 distinction needs verifying through the dialect (or a
  raw `sql` escape hatch).

Every other `RETURNING` site needs its own removal:

| Site | Current | Replacement |
|---|---|---|
| [ingest.ts:159–161](../packages/storage/src/ingest.ts) sighting insert | `ON CONFLICT DO NOTHING RETURNING id` | `INSERT IGNORE` + affected-rows check (caveat: `INSERT IGNORE` swallows *all* ignorable errors, not just duplicate-key — data-truncation warnings become silent) |
| [storylines.ts:79–83](../packages/storage/src/storylines.ts) `createProvisionalStoryline` | `returningAll()` | generate the UUID app-side, insert it, no read-back |
| [storylines.ts:205–215](../packages/storage/src/storylines.ts) `markDormantStorylines` | `UPDATE ... RETURNING id`, counts rows | plain `UPDATE` + `ROW_COUNT()` / affected rows |
| [story-df.ts:206–222](../packages/storage/src/story-df.ts) rebuild counts via `RETURNING 1` | count of returned rows | `ROW_COUNT()` after each `INSERT ... SELECT` |

`ON CONFLICT (col) DO UPDATE` → `ON DUPLICATE KEY UPDATE` at 9 further sites
([ingest.ts:39](../packages/storage/src/ingest.ts), [ingest.ts:141](../packages/storage/src/ingest.ts),
[ingest.ts:201](../packages/storage/src/ingest.ts), [story-df.ts:103,114](../packages/storage/src/story-df.ts),
[storylines.ts:122,348,370,924,1058](../packages/storage/src/storylines.ts),
[storylines.ts:1193](../packages/storage/src/storylines.ts)). MySQL's form cannot name a conflict
target — it fires on *any* unique-key violation. Today every conflicted table has exactly one
candidate key per insert shape, so behavior is preserved, but that equivalence becomes an invariant
the schema must silently maintain: a second unique index on `articles` or `story_token_days` later
would change upsert semantics with no code diff.

### 2.2 `text[]` arrays + `&&`/`@>` + GIN — **schema change rippling through 5 modules**

MySQL has no array types. Seven array columns (`articles.title_tokens`, `articles.story_tokens`,
`articles.categories`, `articles.source_category`, `topics.keywords`,
`storylines.profile_tokens`, `storylines.label_words`) become `JSON`, and every operation
translates:

- **Overlap `&&`** (candidate narrowing [grouping.ts:74](../packages/storage/src/grouping.ts),
  candidate retrieval [storylines.ts:882](../packages/storage/src/storylines.ts)) →
  `JSON_OVERLAPS(col, CAST(? AS JSON))`.
- **Containment `@>`** (search surfacing, over BOTH of a storyline's vocabularies —
  `profile_tokens` and `label_words`
  [storyline-timeline.ts](../packages/storage/src/storyline-timeline.ts)) → `JSON_CONTAINS`. Two
  `JSON_CONTAINS` disjuncts per keyword, needing the optimizer to reach for both multi-valued
  indexes at once; worth measuring, since Postgres answers it as a BitmapOr.
- **The GIN indexes** ([0003:83](../packages/storage/src/migrations/0003-article-groups.ts),
  [0007:58–62](../packages/storage/src/migrations/0007-storyline-tables.ts),
  [0016](../packages/storage/src/migrations/0016-storyline-label-words.ts)) → MySQL **multi-valued
  indexes** (`CREATE INDEX ... ((CAST(col AS CHAR(64) ARRAY)))`). They serve `MEMBER OF`,
  `JSON_OVERLAPS` and `JSON_CONTAINS` — a real analog, but the optimizer's willingness to use one
  for `JSON_OVERLAPS` under an additional date-range predicate (the grouping query combines both)
  must be **benchmarked, not assumed**. If it degrades, grouping one article becomes a day-scan —
  the exact failure the GIN index exists to prevent.
- **`unnest`** ([storylines.ts:1137](../packages/storage/src/storylines.ts) profile derivation,
  [story-df.ts:219](../packages/storage/src/story-df.ts) rebuild) → `JSON_TABLE`.
- **`array_agg(... order by ...)`** ([storylines.ts:1145](../packages/storage/src/storylines.ts)) →
  `JSON_ARRAYAGG`, which does **not** guarantee element order — profile tokens are compared as sets
  so correctness survives, but deterministic output (tests, replay comparisons) needs an explicit
  sort somewhere.
- **`json_agg` over ragged arrays** ([grouping.ts:377–382](../packages/storage/src/grouping.ts)) →
  `JSON_ARRAYAGG` directly; the comment explaining the Postgres 2-D-array workaround becomes moot.
- **Driver surface:** `pg` returns `text[]` as `string[]`; `mysql2` returns JSON columns as parsed
  values — close, but every `Generated<string[]>` type in
  [database.ts](../packages/storage/src/database.ts) and the raw-`sql` row types need re-checking.

### 2.3 `tstzrange` + `range_agg` + btree_gist — **coverage.ts redesign**

The coverage model ([coverage.ts](../packages/storage/src/coverage.ts), schema at
[0001:79–88](../packages/storage/src/migrations/0001-initial-schema.ts)) stores fetched windows as
`tstzrange` and merges them in one data-modifying CTE using `range_agg`/multirange. MySQL has no
range types, no range aggregate, no GiST, and **no data-modifying CTEs** — every leg dies.
Replacement:

- Schema: `span_from DATETIME(6)` + `span_to DATETIME(6)`, B-tree index `(fingerprint, span_from)`.
- Merge moves into TypeScript: under the per-fingerprint lock (§2.4), read all spans for the
  fingerprint, merge overlapping/adjacent intervals in JS (a 15-line sort-and-sweep), keep the
  oldest `fetched_at` per merged span, delete-and-rewrite. Same transaction, same guarantees.
- `readCoverage`'s `lower(span)/upper(span)` ([coverage.ts:74–79](../packages/storage/src/coverage.ts))
  becomes a plain two-column select.

The cleanest redesign of the four — interval-merge is well-understood and unit-testable — but it
moves an invariant ("reads see disjoint ranges") from the type system into code, and `apps/api`'s
gap computation ([coverage-gaps.ts](../apps/api/src/coverage-gaps.ts)) already merges intervals in
JS, so the logic exists twice unless shared.

### 2.4 Advisory locks — **3 sites, session-scoping re-plumb**

`pg_advisory_xact_lock` auto-releases on commit/rollback. MySQL's `GET_LOCK()` is
**session-scoped**: it survives rollback and releases only on explicit `RELEASE_LOCK()` or
connection death. Each site needs a pinned connection and a `try/finally`:

- [coverage.ts:35](../packages/storage/src/coverage.ts) — per-fingerprint writer serialization.
  `GET_LOCK(CONCAT('zammy.coverage.', ?), timeout)` inside the transaction's connection (a Kysely
  transaction pins one connection, so acquisition placement is fine), `RELEASE_LOCK` in `finally`.
  A crash between acquire and release leaves the lock held until the pool recycles that connection
  — a stall mode Postgres made impossible.
- [storylines.ts:305](../packages/storage/src/storylines.ts) — the global merge lock, same pattern
  (`hashtext(...)` disappears; `GET_LOCK` takes a string name directly).
- [migrator.ts:69–74](../packages/storage/src/migrator.ts) — already session-scoped with explicit
  unlock in Postgres, so the one *honest* port: `GET_LOCK`/`RELEASE_LOCK` on the pinned connection,
  nearly line-for-line.

Also: modern MySQL holds multiple locks (pre-5.7 semantics released the prior lock on second
acquire), but **lock names are server-global** — prefix them (`zammy.`) exactly as the merge lock
already does.

### 2.5 The seed-own-group trigger — **cannot be ported; the invariant moves into app code**

[Migration 0003:51–64](../packages/storage/src/migrations/0003-article-groups.ts) makes "every
article is in a group" structural with a `BEFORE INSERT` trigger defaulting `group_id := NEW.id`.
In MySQL the AUTO_INCREMENT value is not yet assigned when a `BEFORE INSERT` trigger runs
(`NEW.id` is 0), and an `AFTER INSERT` trigger may not update its own table — unimplementable as
designed. Options:

1. **App-code invariant (recommended):** the ingest insert
   ([ingest.ts:121](../packages/storage/src/ingest.ts)) follows with
   `UPDATE articles SET group_id = id, group_published = published WHERE id = ? AND group_id = 0`
   in the same transaction (schema default 0 instead of NOT NULL-with-trigger). Cost: one extra
   statement per created article, and the invariant now holds only for writers that remember —
   tests and future write paths included. The comment in 0003 explaining why the trigger exists
   ("true for the ingest path, for tests, and for whatever writes rows next") describes exactly
   what is lost.
2. App-generated UUID article ids — makes the id known before insert, but changes the cursor
   encoding, the `BigInt` ordering in
   [storylines.ts:1249](../packages/storage/src/storylines.ts), and every `bigint`-as-string type.
   Larger blast radius; not recommended.

### 2.6 Data-modifying CTEs and `DISTINCT ON` — **statement splitting in 3 modules**

MySQL CTEs are read-only. Beyond coverage.ts (§2.3):

- `refreshDaySlots` ([storylines.ts:1172–1196](../packages/storage/src/storylines.ts)) folds a
  `DELETE` into a CTE chain ending in an upsert. Splits into: derive slots (the `DISTINCT ON`
  becomes `ROW_NUMBER() OVER (PARTITION BY day_key ORDER BY ...)`), `DELETE` pruned days, then
  `INSERT ... ON DUPLICATE KEY UPDATE`. Three statements, same transaction.
- `readStorylineLabelInput` ([storylines.ts:501–517](../packages/storage/src/storylines.ts)) —
  `DISTINCT ON (group_id)` → `ROW_NUMBER()` window, mechanical.
- `rebuildStoryDf` ([story-df.ts:191–222](../packages/storage/src/story-df.ts)) — the
  delete-by-derived-day-key subqueries port, but `to_char(published AT TIME ZONE tz, 'YYYY-MM-DD')`
  becomes `DATE_FORMAT(CONVERT_TZ(published, 'UTC', ?), '%Y-%m-%d')` — see §3 timezone caveat —
  and `ANALYZE story_token_days, story_corpus_days`
  ([story-df.ts:242](../packages/storage/src/story-df.ts)) becomes `ANALYZE TABLE` (one per
  statement or comma-listed; it takes a brief flush lock).

## 3. Schema translation (all 15 migrations replaced)

Since nothing is deployed beyond dev/staging, replace the 15-file Postgres history with **one new
MySQL baseline migration** rather than translating each step — the migrator machinery
([migrator.ts](../packages/storage/src/migrator.ts)) and its static-record convention carry over
unchanged (ADR-0003's reasoning is engine-independent). The dev archive migrates via dump/reload
scripting, not migration replay.

| Postgres | MySQL | Notes |
|---|---|---|
| `bigint GENERATED ALWAYS AS IDENTITY` | `BIGINT AUTO_INCREMENT` | enables the `LAST_INSERT_ID(id)` trick (§2.1) |
| `uuid DEFAULT gen_random_uuid()` | `CHAR(36) DEFAULT (UUID())` or `BINARY(16)` | MySQL 8.0.13+ expression defaults; `CHAR(36)` keeps the wire format the API already speaks |
| `bytea` (sha256 keys) | `VARBINARY(32)` | `hexToBytea` ([database.ts:320](../packages/storage/src/database.ts)) unchanged |
| `timestamptz` | `DATETIME(6)`, UTC by convention | **not** `TIMESTAMP` (2038 ceiling). The tz-awareness the Postgres type carried becomes an application convention; the pg driver's Date handling in [database.ts:17](../packages/storage/src/database.ts) is replaced by mysql2's (`dateStrings`/timezone options need pinning) |
| `jsonb` (`sightings.raw`, `fetch_log.params`) | `JSON` | near-transparent |
| `text[]` ×6 | `JSON` + multi-valued indexes | §2.2 |
| `tstzrange` + GiST + `CREATE EXTENSION btree_gist` | two `DATETIME(6)` + B-tree | §2.3; the extension line disappears |
| `text` in keys (`day_key`, `token`, `status`) | `VARCHAR(n)` | MySQL index-length limits (3072 bytes InnoDB) force explicit lengths; `token` needs a real cap for the `(day, language, token)` PK |
| partial indexes (`WHERE merged_into IS NULL` ×2, [0007:58–68](../packages/storage/src/migrations/0007-storyline-tables.ts)) | full indexes | no partial indexes in MySQL; aliases stay in the index while query predicates keep excluding them — small index bloat, verify retrieval plans |
| `BEFORE INSERT` trigger | app code | §2.5 |
| `CHECK` constraints ([0007:45–49](../packages/storage/src/migrations/0007-storyline-tables.ts)) | port as-is | enforced since MySQL 8.0.16 |
| `TRUNCATE a, b, c` ([storylines.ts:738–740](../packages/storage/src/storylines.ts)) | one `TRUNCATE` per table, children first | MySQL refuses truncating an FK parent; `storyline_groups`/`storyline_days`/`storyline_bridges` before `storylines`, or `SET FOREIGN_KEY_CHECKS=0` scoped |

**Timezone functions:** `AT TIME ZONE` with IANA names
([storylines.ts:1174](../packages/storage/src/storylines.ts),
[storyline-timeline.ts:84](../packages/storage/src/storyline-timeline.ts),
[story-df.ts:186–192](../packages/storage/src/story-df.ts)) → `CONVERT_TZ` with named zones, which
requires the server's timezone tables populated. On managed HeatWave that is Oracle's
responsibility — **verify named-timezone support on the actual Always Free DB system before
anything else**: `zonedDayKey` in the API and the SQL day bucketing must agree, and there is no
self-managed fallback (no filesystem access to load tz tables on a managed service).

## 4. Query-level translations (mechanical but numerous)

- **Row-value keyset comparisons** — `(a, b) < (x, y)` at
  [grouping.ts:394–395](../packages/storage/src/grouping.ts),
  [storylines.ts:683](../packages/storage/src/storylines.ts),
  [storyline-timeline.ts:113–114](../packages/storage/src/storyline-timeline.ts). MySQL parses row
  constructors, but the optimizer's index use for them has historically been weak. **Benchmark; be
  prepared to expand to the `(a < x) OR (a = x AND b < y)` form** — the exact hot-path regression
  §7.3 exists to prevent.
- `IS NOT DISTINCT FROM` ([grouping.ts:73](../packages/storage/src/grouping.ts)) → `<=>`
  (NULL-safe equals). Direct.
- `ORDER BY ... NULLS LAST` ([storylines.ts:883](../packages/storage/src/storylines.ts)) →
  `ORDER BY (col IS NULL), col DESC`.
- `::uuid` / `::bigint` / `::text[]` / `::timestamptz` casts (~25 sites, heaviest in
  [storylines.ts](../packages/storage/src/storylines.ts)) → drop or `CAST(...)`.
- `||` string concat ([storyline-timeline.ts:131–139](../packages/storage/src/storyline-timeline.ts)
  slot keys) → `CONCAT()`.
- `hashtext()` → gone with the advisory-lock rewrite (§2.4).
- `count(*)::int` ([trending-storylines.ts:90–99](../packages/storage/src/trending-storylines.ts)) —
  mysql2 returns numbers where pg returned strings; every `Number(row.n)` coercion keeps working,
  but the `Generated<string>` types (`hit_count`, count aliases) in
  [database.ts](../packages/storage/src/database.ts) need re-typing.

## 5. Driver, config, infra, tests

- **Driver/dialect:** `pg` → `mysql2`; `PostgresDialect` → `MysqlDialect` in
  [database.ts:308–317](../packages/storage/src/database.ts). `createDb` also accepts a shared
  `pg.Pool` from [server.ts:80](../apps/api/src/server.ts) (health checks ping it directly) — the
  same pattern works with `mysql2`'s pool, but the health-route ping SQL and pool events change.
  `DATABASE_URL` is validated only as non-empty
  ([config/src/index.ts:56](../packages/config/src/index.ts)), so `mysql://` URLs pass — only
  example values and docs change.
- **Test harness:** [test-support.ts](../packages/storage/src/test-support.ts) and
  [apps/api/src/test-support.ts](../apps/api/src/test-support.ts) create/drop throwaway databases;
  MySQL has `CREATE/DROP DATABASE` but no `WITH (FORCE)` — dropping with lingering connections
  needs the pool destroyed first (already done) or a kill loop. All **10 integration-test files**
  in `packages/storage` run real SQL against a migrated database by design — the safety net for
  this migration; every one re-runs, and several re-write (tests asserting on `was_created`,
  coverage merging, and keyset pages encode Postgres behavior).
- **Compose/CI/deploy:** `postgres:17-alpine` → `mysql:8.x` in
  [docker-compose.yml:14–23](../docker-compose.yml), [ci.yml:34–41](../.github/workflows/ci.yml),
  and [deploy/staging/cloud-init.yaml:51–62](../deploy/staging/cloud-init.yaml) — except the whole
  point of HeatWave is that staging would *not* run a MySQL container; cloud-init instead points
  `DATABASE_URL` at the DB system's private endpoint, and the `--wait postgres` sequencing
  ([cloud-init.yaml:238](../deploy/staging/cloud-init.yaml)) becomes a TCP-reachability wait.
  Local dev keeps a MySQL container: dev/staging parity flips from "identical image" to "same
  engine, different operator" — patch/feature drift against the auto-upgraded managed service (it
  always runs the latest MySQL) becomes a real, if small, parity gap.

## 6. Effort summary

| Work item | Class | Size |
|---|---|---|
| §2.5 group-identity invariant into app code | Redesign | M — small diff, high blast radius (every write path + tests) |
| §2.3 coverage span redesign | Redesign | M |
| §2.1 ingest upsert/`RETURNING` removal | Redesign | M — the hottest, most invariant-dense path in the codebase |
| §2.2 arrays→JSON across schema + 5 modules | Rewrite | L — the single largest line count |
| §2.4 advisory locks ×3 | Rewrite | S–M |
| §2.6 CTE/`DISTINCT ON` splits | Rewrite | S–M |
| §3 baseline migration + data migration script | Replace | M |
| §4 mechanical SQL translations | Port | M (many small sites) |
| §5 driver/config/infra/CI | Port | S–M |
| Test suite re-validation (10 files) | — | L — most of the calendar time |
| Performance re-verification (keysets, multi-valued indexes, `CONVERT_TZ`) | — | M, and it gates go/no-go |

Rough overall: **2–4 weeks of focused work** for someone who knows this codebase, dominated by test
re-validation and the performance benchmarks — with two hard gates to check *first*, because either
can kill the plan on day one:

1. **Named-timezone support (`CONVERT_TZ`) on the managed Always Free DB system** (§3).
2. **Multi-valued index + keyset performance** on the grouping and timeline hot paths (§2.2, §4).

## 7. What this buys, restated

Nothing staging needs. The baseline (`postgres:17-alpine` on the Always Free VM) costs $0, zero
code change, identical dev/staging images. This scope exists so the cost of the alternative is a
number rather than a feeling — and the number is a month of storage-layer surgery plus permanent
loss of one structural invariant (§2.5), the conflict-target precision of every upsert (§2.1), and
image-level dev/staging parity (§5). Per DEPLOYMENT-OCI §8, an OCI choice forcing app-code change
of this magnitude is the smell the rule was written for.
