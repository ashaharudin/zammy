# Research — OCI Always Free database services as a Postgres replacement

**Question:** could zammy use the Oracle Cloud Always Free database offerings — Oracle Autonomous
Database, MySQL HeatWave, and/or Oracle NoSQL Database Cloud Service — instead of self-hosted
Postgres?

Researched 2026-08-18 against Oracle's primary documentation. Every claim about an Oracle offering
carries an inline citation; anything Oracle's docs left ambiguous or that could not be verified at a
primary source is flagged as such rather than guessed. Codebase facts come from reading
`packages/storage` and `apps/api` in this repo.

## TL;DR

| Option | Verdict | One-line reason |
|---|---|---|
| **Oracle Autonomous Database** (Always Free) | ❌ **Not viable** | Full storage-layer rewrite (no first-class Kysely/Prisma/Drizzle Oracle dialect; heavy Postgres-only SQL), no private endpoint on the free tier, 7-day idle-stop / 90-day reclaim |
| **MySQL HeatWave** (Always Free) | ⚠️ **Viable-with-caveats as a database; not recommended for this project** | A real free DB in a VCN private subnet with a built-in Kysely dialect — but the migration touches every storage module (`RETURNING`, arrays, `tstzrange`+GiST, advisory locks are all load-bearing here) and breaks DEPLOYMENT-OCI §8's "no application code changes" rule |
| **Oracle NoSQL Database Cloud Service** (Always Free) | ❌ **Not viable** | Always Free tables exist **only in Phoenix** — the tenancy's home region is `ca-toronto-1` — and a 13-table relational schema with joins and transactions does not map to 3 NoSQL tables |
| **Baseline: Postgres 17 container on the Always Free VM** | ✅ **Keep (the current plan)** | Zero code change, zero cost, already planned and sized in DEPLOYMENT-OCI §7 |

The baseline wins. None of the three free database services buys anything staging needs, and two of
the three are not actually available to this tenancy's shape of deployment at all. The one that is
(HeatWave) costs a storage-layer migration to escape a `postgres:17-alpine` container that costs
nothing and already fits the VM with ~7 GB to spare (DEPLOYMENT-OCI §7).

---

## 1. What the Always Free database tier actually is (2026)

Source of record: [Oracle Cloud Free Tier — Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

General caveats that apply across all three services:

- **Home-region lock-in.** Always Free database resources are created in the tenancy's home region
  ([Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm));
  for Autonomous Database the docs are explicit that it "can only be created in the home region
  designated when signing up"
  ([Always Free Autonomous AI Database](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/autonomous-always-free.html)).
  For this tenancy that is `ca-toronto-1` (DEPLOYMENT-OCI §9.1) — which is fatal for NoSQL (§4
  below) and unverified for Autonomous Database (§2).
- **Not every region offers every Always Free database.** ADB's docs instruct you to "check your
  home region for Always Free Autonomous AI Database support" before creating one
  ([Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)).
- **Always Free resources survive a PAYG upgrade.** All three services grant their free allocation
  to "all tenancies" / "each tenancy in the Commercial realm (whether free or paid)"
  ([HeatWave release note](https://docs.oracle.com/en-us/iaas/releasenotes/mysql-database/heatwave-always-free.htm)) —
  consistent with what DEPLOYMENT-OCI §7 already established about this (likely PAYG-upgraded)
  tenancy. The §7 warning transfers, though: on a paid tenancy nothing *stops* an oversized create
  from billing; the free shape is a discipline, not a guardrail.
- **Idle reclamation is per-service, not uniform.** ADB: stopped after 7 idle days, reclaimable
  after 90 cumulative stopped days (§2). NoSQL: inactive at 30 days, deleted at 90 (§4). HeatWave:
  **no idle/reclamation policy found in the docs** (§3) — absence of a documented policy is not
  proof none exists.

## 2. Oracle Autonomous Database — Always Free

### The allowance

Per [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
and [Always Free Autonomous AI Database](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/autonomous-always-free.html):

- **Two** Always Free Autonomous Databases per tenancy, home region only.
- **1 Oracle CPU processor** (the Free Tier page's wording; it does not say "ECPU" or "OCPU" —
  **unverified** which billing unit this corresponds to) and **20 GB storage**, neither scalable
  without upgrading to paid.
- Workload types: **Transaction Processing (ATP), JSON, APEX, or Lakehouse (ADW)**.
- Simultaneous sessions: the Free Tier page says **20**; the ADB Always Free page says **30** —
  **the two primary sources disagree**, so treat 20 as the safe planning number. Either way it is
  ample for two api instances with default `pg`-style pool sizes.
- Database versions **19c** or **26ai**, and 26ai only in specific regions (PHX, IAD, LHR, CDG,
  SYD, BOM, SIN, NRT — Toronto not among them)
  ([Always Free Autonomous AI Database](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/autonomous-always-free.html)).

### Idle-stop and reclamation — the headline caveat

From [Always Free Autonomous AI Database](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/autonomous-always-free.html):

- **Stopped automatically after 7 days of inactivity** (measured on connections and CPU; a
  successful connection + SQL resets the clock).
- **Reclaimed — permanently deleted — after 90 cumulative days stopped.**

Zammy's ingest loop would keep the database active in normal operation, but any pause in staging
(a broken deploy left over a vacation, a disabled scheduler) starts the 7-day clock, and a stopped
database means every `/readyz` goes unready until someone manually starts it.

### Backup, network, connectivity

- **No manual backups, no long-term backups, no restore** on Always Free; upgrading to paid is the
  documented remedy
  ([Always Free Autonomous AI Database](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/autonomous-always-free.html)).
  That is *worse* than the VM baseline, where `pg_dump` and block-volume backups (5 free) exist.
- **No private endpoint: Always Free ADBs "cannot reside within a Virtual Cloud Network"**
  ([Always Free Autonomous AI Database](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/autonomous-always-free.html)).
  This directly contradicts DEPLOYMENT-OCI §3's topology ("private-endpoint only, which is the
  topology we want anyway"). Access is via the public endpoint; hardening options are IP ACLs plus
  mTLS. One-way (walletless) TLS is possible but requires ACLs to be defined first
  ([Update Network Options to Allow TLS or Require mTLS](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/support-tls-mtls-authentication.html)).
  Whether the VM could reach the public endpoint through the VCN's service gateway rather than NAT
  was **not verified** in this research.
- **Driver:** node-oracledb's default **Thin mode** (pure JS, no Instant Client) supports ADB; for
  mTLS the wallet must be supplied as a PEM (`ewallet.pem`) in Thin mode
  ([node-oracledb Appendix A: Thin and Thick modes](https://node-oracledb.readthedocs.io/en/latest/user_guide/appendix_a.html));
  walletless one-way TLS is supported by the thin JDBC-style drivers generally
  ([Connect Without a Wallet (TLS)](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/connecting-python-tls.html)).
  So the *driver* story is fine; it is everything above the driver that is not.

### ORM / query-builder support — the disqualifier

- **Kysely** (what this codebase uses) ships dialects for PostgreSQL, MySQL, MSSQL, SQLite and
  PGlite — **no Oracle**. Oracle support exists only as a community dialect,
  [`kysely-oracledb`](https://github.com/griffiths-waite/kysely-oracledb) (~27 stars, early-stage)
  ([Kysely dialects](https://kysely.dev/docs/dialects)).
- **Prisma** does not support Oracle
  ([Prisma supported databases](https://www.prisma.io/docs/orm/reference/supported-databases)).
- **Drizzle** does not support Oracle
  ([Drizzle get started](https://orm.drizzle.team/docs/get-started)).

On top of the dialect gap, the SQL itself would need rewriting: Oracle has no `ON CONFLICT`
(its upsert is [`MERGE`](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/MERGE.html)),
no `tstzrange`/GiST, no `text[]` array columns with an `&&` overlap operator, no
`pg_advisory_xact_lock`, and no `xmax` system column. See §5 for where each of those is
load-bearing in this codebase.

### Verdict: not viable

1. **The storage layer would be a rewrite, not a port** — no first-class Kysely/Prisma/Drizzle
   Oracle dialect, and the schema/queries lean on six Postgres-only features (§5). DEPLOYMENT-OCI
   §8 names any OCI-driven app-code change a smell; this would be the largest one possible.
2. **The free tier cannot join the VCN** — no private endpoint, so the §3 network posture (no
   public path to data stores) is unachievable by construction.
3. **7-day idle-stop / 90-day reclaim plus no backup/restore** makes it a worse operational citizen
   than a Postgres container whose volume is backed up with the VM.

## 3. MySQL HeatWave — Always Free

### Yes, it exists now — precision on the commonly confused point

MySQL HeatWave historically had **no** Always Free allocation (only the separate
[$300 / 30-day trial credits](https://www.oracle.com/mysql/free/), which expire). That changed on
**2024-08-07**: "each tenancy in the Commercial realm (whether free or paid)" can create **one**
Always Free DB system, in the **home region** only
([release note: Availability of Always Free DB system](https://docs.oracle.com/en-us/iaas/releasenotes/mysql-database/heatwave-always-free.htm)).
The trial-credits page still exists and is a different thing; do not conflate them.

### The allowance

Per the [HeatWave service features doc](https://docs.oracle.com/en-us/iaas/mysql-database/doc/features-mysql-heatwave-service.html)
and [Creating an Always Free DB System](https://docs.oracle.com/en-us/iaas/mysql-database/doc/creating-always-free-db-system.html):

- Shape **`MySQL.Free`** with an optional (default-on) one-node **`HeatWave.Free`** cluster.
- **50 GiB storage** (fixed) for data and logs, plus **50 GB backup storage**
  ([Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)).
- **ECPU / RAM of the MySQL node are not stated in the docs.** Oracle's MySQL blog reportedly
  describes it as 1 ECPU with a 16 GB HeatWave cluster, but the blog returned HTTP 403 during this
  research, so treat the figure as **unverified**.
- **Requires a VCN with a private subnet** — i.e. unlike Always Free ADB, it lives *inside* the
  VCN as a private endpoint, matching DEPLOYMENT-OCI §3's topology
  ([Creating an Always Free DB System](https://docs.oracle.com/en-us/iaas/mysql-database/doc/creating-always-free-db-system.html)).
- Automatic backups **enabled, fixed at 1-day retention, PITR disabled**; **no manual backups, no
  HA, no read replicas, no SLA, not eligible for Oracle Support**; always runs the latest MySQL
  version and is auto-upgraded each maintenance cycle
  ([features doc](https://docs.oracle.com/en-us/iaas/mysql-database/doc/features-mysql-heatwave-service.html)).
- **No idle-stop or reclamation policy is documented** for the Always Free DB system in the pages
  above — could not verify whether one exists.

### Compatibility with this codebase

The wire protocol is standard MySQL, and the ORM story is genuinely good: Kysely ships a built-in
MySQL dialect ([Kysely dialects](https://kysely.dev/docs/dialects)), and Prisma/Drizzle both support
MySQL ([Prisma](https://www.prisma.io/docs/orm/reference/supported-databases),
[Drizzle](https://orm.drizzle.team/docs/get-started)). But the SQL this codebase actually wrote does
not survive the move (details and file references in §5):

- **No `RETURNING` clause** in MySQL's `INSERT`/`UPDATE`
  ([MySQL 8.4 INSERT syntax](https://dev.mysql.com/doc/refman/8.4/en/insert.html)) — `ingest.ts`
  depends on `RETURNING`, including the `xmax = 0` created-vs-updated trick, which has no MySQL
  equivalent at all.
- **Upsert is `ON DUPLICATE KEY UPDATE`**, which cannot target a named constraint and has no
  per-conflict `DO NOTHING`/`WHERE`
  ([MySQL INSERT ... ON DUPLICATE KEY UPDATE](https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html)).
- **No array types, no range types** in MySQL's type system
  ([MySQL 8.4 data types](https://dev.mysql.com/doc/refman/8.4/en/data-types.html)) — kills
  `title_tokens text[]` + `&&` overlap (grouping) and `topic_coverage.span tstzrange` + the
  btree_gist GiST index (coverage).
- **Advisory locks:** MySQL's `GET_LOCK()` is session-scoped, not transaction-scoped
  ([MySQL locking functions](https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html)) —
  `pg_advisory_xact_lock` in `coverage.ts` and `pg_advisory_lock` in `migrator.ts` need re-plumbing
  with explicit release paths.

### Verdict: viable-with-caveats as a database — not recommended for this project

1. It is the only one of the three that is genuinely deployable into this plan's topology: free,
   in-VCN private endpoint, home region, automatic (if shallow) backups.
2. But adopting it means rewriting or restructuring most of `packages/storage` — every one of the
   six Postgres-specific mechanisms in §5 is exercised on the hot ingest path — against
   DEPLOYMENT-OCI §8's explicit rule.
3. And what it buys over the baseline is nothing staging needs: the `postgres:17-alpine` container
   already fits the VM with ~7 GB of headroom (DEPLOYMENT-OCI §7), costs $0, and needs zero code
   change. One-per-tenancy also means staging using it forecloses production using it — the same
   trap as the single free load balancer (DEPLOYMENT-OCI §7).

## 4. Oracle NoSQL Database Cloud Service — Always Free

### The allowance

Per [About Always Free NoSQL Database Service](https://docs.oracle.com/en-us/iaas/nosql-database/doc/always-free-nosql-database-service.html):

- Up to **3 Always Free tables**, each fixed at **50 read units, 50 write units, 25 GB storage**
  (none changeable). The Free Tier page expresses the same allowance as "133 million reads per
  month, 133 million writes per month"
  ([Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)).
- **Available only in the Phoenix region** (at time of research).
- Inactivity policy: **30 days unused → inactive** (admin notified), reminder at 75 days,
  **deleted at 90 days**; only data operations (get/put/delete) reactivate, DDL does not.
- Always Free tables must be singletons (no Global Active Table replicas) and cannot be converted
  to/from regular tables.

### What a migration would actually mean

This is not a SQL database behind a different driver; it is a table API with its own SQL-like query
language, accessed via the official Node SDK
([`oracle-nosqldb` / oracle/nosql-node-sdk](https://github.com/oracle/nosql-node-sdk)) or REST.
Zammy's schema is 13 relational tables (see §5) joined constantly — timeline assembly alone joins
articles → groups → storylines → days — with multi-table transactions on the ingest path and
cascading foreign keys. None of that exists in a NoSQL table model; the "migration" would be a
redesign of the storage model, and it would still have to fit in **three** tables.

### Verdict: not viable

1. **It is not available to this tenancy at all:** Always Free NoSQL tables exist only in Phoenix
   ([Always Free NoSQL doc](https://docs.oracle.com/en-us/iaas/nosql-database/doc/always-free-nosql-database-service.html)),
   Always Free resources live in the home region, and this tenancy's home region is `ca-toronto-1`
   (DEPLOYMENT-OCI §9.1). Full stop.
2. A 13-table joined, transactional, FK-cascaded relational model does not map to 3 singleton
   NoSQL tables; this is a rewrite of the data model, not a migration.
3. The 30/90-day inactivity-then-deletion policy is the most aggressive of the three services.

## 5. Codebase fit — what Postgres is actually doing here

Stack: **Kysely + `pg`** (`apps/api/package.json`, `packages/storage/package.json`). Schema: **13
tables** across 15 migrations (`packages/storage/src/migrations/0001` … `0015`): articles,
sightings, topics, topic_articles, topic_coverage, fetch_log, storylines, storyline_groups,
storyline_days, storyline_bridges, story_token_days, story_corpus_days,
storyline_formation_refusals — plus Kysely's two migration-ledger tables. Migrations are raw
Postgres DDL run by Kysely's migrator with a discrete deploy step (DEPLOYMENT-OCI §5).

The Postgres-specific features in live use, each a migration cost line item:

| Feature | Where | Portable to Oracle? | Portable to MySQL? |
|---|---|---|---|
| `tstzrange` column + GiST index via `CREATE EXTENSION btree_gist` | `topic_coverage.span`, `migrations/0001` (the coverage design, ARCHITECTURE 7.2) | No — redesign as (start, end) columns + app logic | No — same redesign |
| `text[]` arrays + `&&` overlap operator | `articles.title_tokens`, matched in `grouping.ts:74`; `categories`/`source_category` in `ingest.ts` | No native arrays — junction table or JSON | No arrays ([MySQL data types](https://dev.mysql.com/doc/refman/8.4/en/data-types.html)) |
| `pg_advisory_xact_lock` / `pg_advisory_lock` | `coverage.ts:35` (per-fingerprint serialization), `migrator.ts:69` (migration lock) | No equivalent primitive — `DBMS_LOCK` re-plumb | `GET_LOCK()` is session-, not txn-scoped ([locking functions](https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html)) |
| `ON CONFLICT … DO UPDATE / DO NOTHING` + `RETURNING` | `ingest.ts` (5 sites), `story-df.ts` (2 sites) | `MERGE` rewrite ([Oracle MERGE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/MERGE.html)) | `ON DUPLICATE KEY UPDATE`, no `RETURNING` ([insert-on-duplicate](https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html)) |
| `xmax = 0` to detect insert-vs-update in one statement | `ingest.ts:146` | No — Postgres system column | No |
| `jsonb` (`sightings.raw`, `fetch_log.params`), `gen_random_uuid()`, `json_agg` (a deliberate workaround for ragged 2-D arrays, `grouping.ts:377`), row-value keyset comparisons (`grouping.ts:394`), `least()` merge logic, `ANALYZE` after bulk folds | throughout | Each has an Oracle analog, each is a rewrite line | Mostly has MySQL analogs (`JSON_ARRAYAGG` etc.), each still a rewrite line |

The blunt summary: this is not a codebase that happens to sit on Postgres; the coverage model, the
grouping matcher, and the ingest upsert were *designed in* Postgres features. Any engine change is
a redesign of `packages/storage`'s core modules, not a dialect swap — which is exactly the class of
change DEPLOYMENT-OCI §8 forbids OCI work from forcing.

## 6. Operational comparison against the baseline

The baseline (DEPLOYMENT-OCI §7): `postgres:17-alpine` as a container on the Always Free Ampere VM,
2 GB memory limit, data on the boot volume (200 GB free block allowance, 5 free backups
([Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm))),
seeded from the dev archive, `pg_dump` for logical backups.

| Concern | Postgres on VM (baseline) | Always Free ADB | Always Free HeatWave | Always Free NoSQL |
|---|---|---|---|---|
| Reachable from the VM privately | localhost/VCN | **No VCN presence** — public endpoint + ACL/mTLS | Yes — private subnet endpoint | N/A (wrong region) |
| Idle behavior | none | stop @7d, reclaim @90d | not documented | inactive @30d, deleted @90d |
| Backups | pg_dump + 5 block-volume backups | **none on free tier** | automatic, 1-day retention, no PITR | N/A |
| App code change | **zero** | storage-layer rewrite | storage-layer rewrite (smaller) | data-model redesign |
| Survives `docker compose` parity with dev | yes — identical image | no | no | no |
| Cost | $0 (inside VM allowance) | $0 | $0 | $0 |

## 7. Could not verify (explicitly)

- **Always Free ADB availability in `ca-toronto-1`.** Oracle says availability is a per-home-region
  subset and points at its [data regions page](https://www.oracle.com/cloud/data-regions.html),
  which is not statically readable; the definitive check is the console's create-ADB flow in the
  tenancy. Until checked, assume it may not be offered in Toronto.
- **ADB Always Free CPU unit** — the Free Tier page says "1 Oracle CPU processor" without naming
  OCPU or ECPU.
- **ADB Always Free session cap** — 20 per the
  [Free Tier page](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
  vs 30 per the
  [ADB Always Free page](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/autonomous-always-free.html);
  the primary sources disagree.
- **HeatWave Always Free idle-stop/reclamation policy** — no policy found in the service docs;
  could not confirm whether none exists or it is documented elsewhere.
- **HeatWave Always Free MySQL-node ECPU/RAM** — not in the docs; Oracle's MySQL blog (HTTP 403
  during research) reportedly says 1 ECPU node with a 16 GB HeatWave cluster.
- **Whether an Always Free ADB public endpoint is reachable via the VCN service gateway** (vs NAT)
  was not researched, since ADB was disqualified earlier.

## 8. Sources

Oracle / OCI primary documentation:

- [Oracle Cloud Free Tier — Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [Always Free Autonomous AI Database (ADB Serverless docs)](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/autonomous-always-free.html)
- [ADB Serverless — Update Network Options to Allow TLS or Require Only Mutual TLS](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/support-tls-mtls-authentication.html)
- [ADB Serverless — Connect Without a Wallet (TLS)](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/connecting-python-tls.html)
- [MySQL HeatWave release note — Availability of Always Free DB system (2024-08-07)](https://docs.oracle.com/en-us/iaas/releasenotes/mysql-database/heatwave-always-free.htm)
- [MySQL HeatWave service features (Always Free DB system section)](https://docs.oracle.com/en-us/iaas/mysql-database/doc/features-mysql-heatwave-service.html)
- [Creating an Always Free DB System (MySQL HeatWave)](https://docs.oracle.com/en-us/iaas/mysql-database/doc/creating-always-free-db-system.html)
- [MySQL HeatWave $300 / 30-day trial (distinct from Always Free)](https://www.oracle.com/mysql/free/)
- [About Always Free NoSQL Database Service](https://docs.oracle.com/en-us/iaas/nosql-database/doc/always-free-nosql-database-service.html)
- [Oracle SQL Language Reference — MERGE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/MERGE.html)

Official driver / SDK / ORM sources:

- [node-oracledb — Appendix A: Thin and Thick modes](https://node-oracledb.readthedocs.io/en/latest/user_guide/appendix_a.html)
- [oracle/nosql-node-sdk (official Node.js SDK, npm `oracle-nosqldb`)](https://github.com/oracle/nosql-node-sdk)
- [Kysely — Dialects](https://kysely.dev/docs/dialects)
- [griffiths-waite/kysely-oracledb (community Oracle dialect)](https://github.com/griffiths-waite/kysely-oracledb)
- [Prisma — supported databases](https://www.prisma.io/docs/orm/reference/supported-databases)
- [Drizzle ORM — get started (supported dialects)](https://orm.drizzle.team/docs/get-started)

MySQL reference manual (feature-gap claims):

- [MySQL 8.4 — INSERT ... ON DUPLICATE KEY UPDATE](https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html)
- [MySQL 8.4 — INSERT statement (no RETURNING clause)](https://dev.mysql.com/doc/refman/8.4/en/insert.html)
- [MySQL 8.4 — Locking functions (GET_LOCK)](https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html)
- [MySQL 8.4 — Data types (no array/range types)](https://dev.mysql.com/doc/refman/8.4/en/data-types.html)
