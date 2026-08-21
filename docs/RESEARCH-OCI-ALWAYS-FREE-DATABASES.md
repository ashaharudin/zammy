# Research — OCI Always Free database services as a Postgres replacement


> ## ⛔ ARCHIVAL — NOT IN USE
>
> **zammy is not deploying on OCI (decided 2026-08-21 — see
> [DEPLOYMENT-OCI](DEPLOYMENT-OCI.md) for the reasoning and the capacity evidence).** So the
> question this document asks is no longer live: there is no OCI tenancy to host an Always Free
> database.
>
> **Its answer is still the answer, though, and that part was never OCI-specific.** The research
> concluded that self-hosted Postgres stays — on the strength of what the managed offerings would
> have cost us in schema and query rewrites, not on price or tier limits. Any *future* managed
> database on any provider faces the same test, so this doc is worth keeping as the standard to
> re-apply rather than a decision to re-litigate.
>
> Treat every OCI-specific tier limit, shape and service claim below as **frozen at 2026-08-18**
> and unverified since.

**Question:** could zammy use the Oracle Cloud Always Free database offerings — Oracle Autonomous
Database, MySQL HeatWave, and/or Oracle NoSQL Database Cloud Service — instead of self-hosted
Postgres?

Researched 2026-08-18 against Oracle's primary documentation. Every claim about an Oracle offering
carries an inline citation; anything ambiguous or unverifiable at a primary source is flagged
rather than guessed. Codebase facts come from reading `packages/storage` and `apps/api`.

## TL;DR

| Option | Verdict | One-line reason |
|---|---|---|
| **Oracle Autonomous Database** (Always Free) | ❌ **Not viable** | Full storage-layer rewrite (no first-class Kysely/Prisma/Drizzle Oracle dialect; heavy Postgres-only SQL), no private endpoint on the free tier, 7-day idle-stop / 90-day reclaim |
| **MySQL HeatWave** (Always Free) | ⚠️ **Viable-with-caveats as a database; not recommended for this project** | A real free DB in a VCN private subnet with a built-in Kysely dialect — but the migration touches every storage module (`RETURNING`, arrays, `tstzrange`+GiST, advisory locks are all load-bearing) and breaks DEPLOYMENT-OCI §8's "no application code changes" rule |
| **Oracle NoSQL Database Cloud Service** (Always Free) | ❌ **Not viable** | Always Free tables exist **only in Phoenix** — the tenancy's home region is `ca-toronto-1` — and a 13-table relational schema with joins and transactions does not map to 3 NoSQL tables |
| **Baseline: Postgres 17 container on the Always Free VM** | ✅ **Keep (the current plan)** | Zero code change, zero cost, already planned and sized in DEPLOYMENT-OCI §7 |

The baseline wins: none of the three buys anything staging needs, two are unavailable to this
tenancy's deployment at all, and the one that is (HeatWave) costs a storage-layer migration to
escape a `postgres:17-alpine` container that costs nothing and fits the VM with ~7 GB to spare
(DEPLOYMENT-OCI §7).

---

## 1. What the Always Free database tier actually is (2026)

Source of record: [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).
Caveats across all three services:

- **Home-region lock-in.** Always Free database resources are created in the tenancy's home region;
  for ADB the docs are explicit it "can only be created in the home region designated when signing
  up" ([ADB Always Free](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/autonomous-always-free.html)).
  For this tenancy that is `ca-toronto-1` (DEPLOYMENT-OCI §9.1) — fatal for NoSQL (§4), unverified
  for ADB (§2).
- **Not every region offers every Always Free database** — ADB's docs instruct checking the home
  region for support before creating.
- **Always Free resources survive a PAYG upgrade.** All three grant their allocation to "each
  tenancy in the Commercial realm (whether free or paid)"
  ([HeatWave release note](https://docs.oracle.com/en-us/iaas/releasenotes/mysql-database/heatwave-always-free.htm)).
  DEPLOYMENT-OCI §7's warning transfers: on a paid tenancy nothing *stops* an oversized create from
  billing — the free shape is a discipline, not a guardrail.
- **Idle reclamation is per-service, not uniform.** ADB: stopped after 7 idle days, reclaimable
  after 90 cumulative stopped days (§2). NoSQL: inactive at 30 days, deleted at 90 (§4). HeatWave:
  **no policy found in the docs** (§3) — absence of a documented policy is not proof none exists.

## 2. Oracle Autonomous Database — Always Free

### The allowance

Per [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
and [ADB Always Free](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/autonomous-always-free.html):

- **Two** Always Free ADBs per tenancy, home region only.
- **1 Oracle CPU processor** (the Free Tier page's wording — not "ECPU" or "OCPU"; **unverified**
  which billing unit) and **20 GB storage**, neither scalable without paying.
- Workload types: **Transaction Processing (ATP), JSON, APEX, or Lakehouse (ADW)**.
- Simultaneous sessions: the Free Tier page says **20**, the ADB page says **30** — **the primary
  sources disagree**; plan on 20. Either is ample for two api instances with default `pg`-style
  pool sizes.
- Versions **19c** or **26ai**; 26ai only in PHX, IAD, LHR, CDG, SYD, BOM, SIN, NRT — Toronto not
  among them.

### Idle-stop and reclamation — the headline caveat

From the [ADB Always Free doc](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/autonomous-always-free.html):
**stopped automatically after 7 days of inactivity** (measured on connections and CPU; a successful
connection + SQL resets the clock); **reclaimed — permanently deleted — after 90 cumulative days
stopped.** Zammy's ingest loop would keep it active normally, but any staging pause (a broken
deploy over a vacation, a disabled scheduler) starts the 7-day clock, and a stopped database means
every `/readyz` goes unready until someone manually starts it.

### Backup, network, connectivity

- **No manual backups, no long-term backups, no restore** on Always Free; the documented remedy is
  upgrading to paid — *worse* than the VM baseline, where `pg_dump` and 5 free block-volume
  backups exist.
- **No private endpoint: Always Free ADBs "cannot reside within a Virtual Cloud Network"** —
  directly contradicting DEPLOYMENT-OCI §3's private-endpoint-only topology. Access is the public
  endpoint; hardening is IP ACLs plus mTLS. Walletless one-way TLS is possible but requires ACLs
  first ([TLS/mTLS network options](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/support-tls-mtls-authentication.html)).
  Whether the VM could reach the public endpoint via the service gateway rather than NAT was **not
  verified**.
- **Driver:** node-oracledb's default **Thin mode** (pure JS, no Instant Client) supports ADB; mTLS
  needs the wallet as a PEM (`ewallet.pem`)
  ([node-oracledb Appendix A](https://node-oracledb.readthedocs.io/en/latest/user_guide/appendix_a.html));
  walletless one-way TLS is supported by the thin drivers generally
  ([Connect Without a Wallet](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/connecting-python-tls.html)).
  The *driver* story is fine; everything above the driver is not.

### ORM / query-builder support — the disqualifier

- **Kysely** (used here) ships dialects for PostgreSQL, MySQL, MSSQL, SQLite and PGlite — **no
  Oracle** ([Kysely dialects](https://kysely.dev/docs/dialects)); Oracle support is only a
  community dialect, [`kysely-oracledb`](https://github.com/griffiths-waite/kysely-oracledb)
  (~27 stars, early-stage).
- **Prisma** ([supported databases](https://www.prisma.io/docs/orm/reference/supported-databases))
  and **Drizzle** ([get started](https://orm.drizzle.team/docs/get-started)) do not support Oracle.

Beyond the dialect gap, the SQL needs rewriting: Oracle has no `ON CONFLICT` (its upsert is
[`MERGE`](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/MERGE.html)), no
`tstzrange`/GiST, no `text[]` arrays with `&&` overlap, no `pg_advisory_xact_lock`, no `xmax`. §5
shows where each is load-bearing.

### Verdict: not viable

1. **A rewrite, not a port** — no first-class ORM dialect, and the schema/queries lean on six
   Postgres-only features (§5). DEPLOYMENT-OCI §8 names any OCI-driven app-code change a smell;
   this would be the largest one possible.
2. **The free tier cannot join the VCN** — no private endpoint, so §3's network posture is
   unachievable by construction.
3. **7-day idle-stop / 90-day reclaim plus no backup/restore** — a worse operational citizen than a
   Postgres container whose volume is backed up with the VM.

## 3. MySQL HeatWave — Always Free

### Yes, it exists now — precision on the commonly confused point

HeatWave historically had **no** Always Free allocation, only the separate
[$300 / 30-day trial credits](https://www.oracle.com/mysql/free/), which expire. That changed
**2024-08-07**: each Commercial-realm tenancy (free or paid) can create **one** Always Free DB
system, **home region** only
([release note](https://docs.oracle.com/en-us/iaas/releasenotes/mysql-database/heatwave-always-free.htm)).
The trial-credits page still exists and is a different thing; do not conflate them.

### The allowance

Per the [service features doc](https://docs.oracle.com/en-us/iaas/mysql-database/doc/features-mysql-heatwave-service.html)
and [Creating an Always Free DB System](https://docs.oracle.com/en-us/iaas/mysql-database/doc/creating-always-free-db-system.html):

- Shape **`MySQL.Free`** with an optional (default-on) one-node **`HeatWave.Free`** cluster.
- **50 GiB storage** (fixed) for data and logs, plus **50 GB backup storage**
  ([Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)).
- **ECPU / RAM of the MySQL node are not stated in the docs.** Oracle's MySQL blog reportedly says
  1 ECPU with a 16 GB HeatWave cluster, but it returned HTTP 403 during research — **unverified**.
- **Requires a VCN with a private subnet** — unlike Always Free ADB, it lives *inside* the VCN as a
  private endpoint, matching DEPLOYMENT-OCI §3.
- Automatic backups **enabled, fixed at 1-day retention, PITR disabled**; **no manual backups, no
  HA, no read replicas, no SLA, not eligible for Oracle Support**; always runs the latest MySQL,
  auto-upgraded each maintenance cycle.
- **No idle-stop or reclamation policy documented** — could not verify whether one exists.

### Compatibility with this codebase

The wire protocol is standard MySQL and the ORM story is genuinely good: Kysely ships a built-in
MySQL dialect; Prisma and Drizzle both support MySQL. But the SQL this codebase wrote does not
survive the move (details and file references in §5):

- **No `RETURNING`** in `INSERT`/`UPDATE`
  ([MySQL 8.4 INSERT](https://dev.mysql.com/doc/refman/8.4/en/insert.html)) — `ingest.ts` depends
  on it, including the `xmax = 0` created-vs-updated trick, which has no MySQL equivalent at all.
- **Upsert is `ON DUPLICATE KEY UPDATE`**, which cannot target a named constraint and has no
  per-conflict `DO NOTHING`/`WHERE`
  ([insert-on-duplicate](https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html)).
- **No array or range types**
  ([data types](https://dev.mysql.com/doc/refman/8.4/en/data-types.html)) — kills `title_tokens
  text[]` + `&&` overlap (grouping) and `topic_coverage.span tstzrange` + the btree_gist GiST index
  (coverage).
- **Advisory locks:** `GET_LOCK()` is session-scoped, not transaction-scoped
  ([locking functions](https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html)) —
  `pg_advisory_xact_lock` in `coverage.ts` and `pg_advisory_lock` in `migrator.ts` need re-plumbing
  with explicit release paths.

### Verdict: viable-with-caveats as a database — not recommended for this project

1. The only one of the three genuinely deployable into this plan's topology: free, in-VCN private
   endpoint, home region, automatic (if shallow) backups.
2. But adoption rewrites or restructures most of `packages/storage` — all six Postgres-specific
   mechanisms in §5 sit on the hot ingest path — against DEPLOYMENT-OCI §8's explicit rule.
3. And it buys nothing staging needs: the `postgres:17-alpine` container fits the VM with ~7 GB
   headroom, costs $0, needs zero code change. One-per-tenancy also means staging using it
   forecloses production using it — the same trap as the single free LB (DEPLOYMENT-OCI §7).

## 4. Oracle NoSQL Database Cloud Service — Always Free

### The allowance

Per [About Always Free NoSQL Database Service](https://docs.oracle.com/en-us/iaas/nosql-database/doc/always-free-nosql-database-service.html):

- Up to **3 Always Free tables**, each fixed at **50 read units, 50 write units, 25 GB storage**.
  The Free Tier page expresses the same allowance as "133 million reads / 133 million writes per
  month".
- **Available only in the Phoenix region** (at time of research).
- Inactivity: **30 days unused → inactive** (admin notified), reminder at 75 days, **deleted at
  90 days**; only data operations (get/put/delete) reactivate, DDL does not.
- Always Free tables must be singletons (no Global Active Table replicas) and cannot be converted
  to/from regular tables.

### What a migration would actually mean

Not a SQL database behind a different driver: a table API with its own SQL-like query language, via
the official Node SDK ([oracle/nosql-node-sdk](https://github.com/oracle/nosql-node-sdk), npm
`oracle-nosqldb`) or REST. Zammy's schema is 13 relational tables (§5) joined constantly — timeline
assembly alone joins articles → groups → storylines → days — with multi-table transactions on the
ingest path and cascading foreign keys. None of that exists in a NoSQL table model; the "migration"
is a redesign of the storage model, still forced into **three** tables.

### Verdict: not viable

1. **Not available to this tenancy at all:** Always Free NoSQL tables exist only in Phoenix, Always
   Free resources live in the home region, and this tenancy's home region is `ca-toronto-1`
   (DEPLOYMENT-OCI §9.1). Full stop.
2. A 13-table joined, transactional, FK-cascaded relational model does not map to 3 singleton
   NoSQL tables — a data-model rewrite, not a migration.
3. The 30/90-day inactivity-then-deletion policy is the most aggressive of the three.

## 5. Codebase fit — what Postgres is actually doing here

Stack: **Kysely + `pg`** (`apps/api/package.json`, `packages/storage/package.json`). Schema: **13
tables** across 15 migrations (`packages/storage/src/migrations/0001` … `0015`): articles,
sightings, topics, topic_articles, topic_coverage, fetch_log, storylines, storyline_groups,
storyline_days, storyline_bridges, story_token_days, story_corpus_days,
storyline_formation_refusals — plus Kysely's two migration-ledger tables. Migrations are raw
Postgres DDL run by Kysely's migrator as a discrete deploy step (DEPLOYMENT-OCI §5).

Postgres-specific features in live use, each a migration cost line item:

| Feature | Where | Portable to Oracle? | Portable to MySQL? |
|---|---|---|---|
| `tstzrange` column + GiST index via `CREATE EXTENSION btree_gist` | `topic_coverage.span`, `migrations/0001` (the coverage design, ARCHITECTURE 7.2) | No — redesign as (start, end) columns + app logic | No — same redesign |
| `text[]` arrays + `&&` overlap operator | `articles.title_tokens`, matched in `grouping.ts:74`; `categories`/`source_category` in `ingest.ts` | No native arrays — junction table or JSON | No arrays ([MySQL data types](https://dev.mysql.com/doc/refman/8.4/en/data-types.html)) |
| `pg_advisory_xact_lock` / `pg_advisory_lock` | `coverage.ts:35` (per-fingerprint serialization), `migrator.ts:69` (migration lock) | No equivalent primitive — `DBMS_LOCK` re-plumb | `GET_LOCK()` is session-, not txn-scoped ([locking functions](https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html)) |
| `ON CONFLICT … DO UPDATE / DO NOTHING` + `RETURNING` | `ingest.ts` (5 sites), `story-df.ts` (2 sites) | `MERGE` rewrite ([Oracle MERGE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/MERGE.html)) | `ON DUPLICATE KEY UPDATE`, no `RETURNING` ([insert-on-duplicate](https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html)) |
| `xmax = 0` to detect insert-vs-update in one statement | `ingest.ts:146` | No — Postgres system column | No |
| `jsonb` (`sightings.raw`, `fetch_log.params`), `gen_random_uuid()`, `json_agg` (a deliberate workaround for ragged 2-D arrays, `grouping.ts:377`), row-value keyset comparisons (`grouping.ts:394`), `least()` merge logic, `ANALYZE` after bulk folds | throughout | Each has an Oracle analog, each is a rewrite line | Mostly has MySQL analogs (`JSON_ARRAYAGG` etc.), each still a rewrite line |

The blunt summary: this is not a codebase that happens to sit on Postgres — the coverage model, the
grouping matcher and the ingest upsert were *designed in* Postgres features. Any engine change is a
redesign of `packages/storage`'s core modules, not a dialect swap — exactly the class of change
DEPLOYMENT-OCI §8 forbids OCI work from forcing.

## 6. Operational comparison against the baseline

The baseline (DEPLOYMENT-OCI §7): `postgres:17-alpine` as a container on the Always Free Ampere VM,
2 GB memory limit, data on the boot volume (200 GB free block allowance, 5 free backups), seeded
from the dev archive, `pg_dump` for logical backups.

| Concern | Postgres on VM (baseline) | Always Free ADB | Always Free HeatWave | Always Free NoSQL |
|---|---|---|---|---|
| Reachable from the VM privately | localhost/VCN | **No VCN presence** — public endpoint + ACL/mTLS | Yes — private subnet endpoint | N/A (wrong region) |
| Idle behavior | none | stop @7d, reclaim @90d | not documented | inactive @30d, deleted @90d |
| Backups | pg_dump + 5 block-volume backups | **none on free tier** | automatic, 1-day retention, no PITR | N/A |
| App code change | **zero** | storage-layer rewrite | storage-layer rewrite (smaller) | data-model redesign |
| Survives `docker compose` parity with dev | yes — identical image | no | no | no |
| Cost | $0 (inside VM allowance) | $0 | $0 | $0 |

## 7. Could not verify (explicitly)

- **Always Free ADB availability in `ca-toronto-1`.** Availability is a per-home-region subset;
  Oracle points at its [data regions page](https://www.oracle.com/cloud/data-regions.html), which
  is not statically readable — the definitive check is the console's create-ADB flow. Until
  checked, assume it may not be offered in Toronto.
- **ADB Always Free CPU unit** — "1 Oracle CPU processor" without naming OCPU or ECPU.
- **ADB Always Free session cap** — 20 (Free Tier page) vs 30 (ADB Always Free page); the primary
  sources disagree.
- **HeatWave Always Free idle-stop/reclamation policy** — none found; could not confirm whether
  none exists or it is documented elsewhere.
- **HeatWave Always Free MySQL-node ECPU/RAM** — not in the docs; the blog (HTTP 403) reportedly
  says 1 ECPU with a 16 GB HeatWave cluster.
- **Whether an Always Free ADB public endpoint is reachable via the VCN service gateway** (vs NAT)
  — not researched, since ADB was disqualified earlier.

## 8. Sources

All sources are cited inline above: Oracle/OCI primary documentation (the Always Free Resources
page, the ADB Serverless Always Free / TLS-mTLS / walletless-TLS pages, the HeatWave release note,
service-features and create-DB-system pages, the HeatWave $300 trial page, the Always Free NoSQL
page, and the Oracle `MERGE` reference), official driver/SDK/ORM sources (node-oracledb Appendix A,
oracle/nosql-node-sdk, Kysely dialects, kysely-oracledb, Prisma and Drizzle supported-database
pages), and the MySQL 8.4 reference manual for each feature-gap claim (INSERT, ON DUPLICATE KEY
UPDATE, locking functions, data types).
