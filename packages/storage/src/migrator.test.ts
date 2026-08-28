import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { deriveAltKey } from "@zammy/news-client";
import { migrateToLatest } from "./migrator.js";
import * as storylineTables from "./migrations/0007-storyline-tables.js";
import * as storyTokenDf from "./migrations/0008-story-token-df.js";
import * as storylineBridges from "./migrations/0009-storyline-bridges.js";
import * as labelDrift from "./migrations/0010-storyline-label-drift.js";
import * as labelSource from "./migrations/0011-storyline-label-source.js";
import * as formationRefusals from "./migrations/0015-storyline-formation-refusals.js";
import * as dropTermCloud from "./migrations/0014-drop-term-cloud.js";
import * as rowLevelSecurity from "./migrations/0019-enable-row-level-security.js";
import * as articleAltKey from "./migrations/0020-article-alt-key.js";
import * as providerCoverage from "./migrations/0021-provider-and-storyline-coverage.js";
import * as sightingPlane from "./migrations/0022-sighting-plane.js";
import { createTestDatabase, type TestDatabase } from "./test-support.js";

/**
 * The migration path itself (ADR-0003): migrations are hand-written and run as
 * a discrete step, so "an empty database reaches the current schema" is a thing
 * that must be tested, not assumed — it is the first command every environment
 * ever runs.
 */

describe("migrateToLatest", () => {
  let harness: TestDatabase;

  /**
   * The harness connection as a migration sees it.
   *
   * A migration takes `Kysely<unknown>` — it runs against whatever schema is
   * current, which is by definition not the one `Database` describes — and
   * Kysely's type parameter is invariant, so a `Kysely<Database>` is not
   * assignable to it. The real migrator passes an untyped instance; this is the
   * same widening, named once instead of cast at sixteen call sites.
   */
  const migrationDb = (): Kysely<unknown> => harness.db as unknown as Kysely<unknown>;

  beforeAll(async () => {
    harness = await createTestDatabase();
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("brings an empty database to the current schema", async () => {
    const { error, results } = await migrateToLatest(harness.db);

    expect(error).toBeUndefined();
    expect(results?.length).toBeGreaterThan(0);
    expect(results?.every((result) => result.status === "Success")).toBe(true);

    // The §7.2 tables must actually exist afterwards — a migration that ran
    // "successfully" but created nothing would pass the assertions above.
    const { rows } = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = 'public'
    `.execute(harness.db);
    const tables = rows.map((row) => row.table_name);

    for (const expected of [
      "articles",
      "sightings",
      "topics",
      "topic_articles",
      "topic_coverage",
      "fetch_log",
      "storylines",
      "storyline_groups",
      "storyline_days",
      "story_token_days",
      "story_corpus_days",
      "storyline_bridges",
      "storyline_coverage",
    ]) {
      expect(tables).toContain(expected);
    }

    // And the term cloud's three tables must NOT: 0002 and 0005 create them,
    // 0014 drops them, and a migration order that left one standing would leave
    // the schema disagreeing with `Database` (ADR-0013).
    for (const gone of ["trending_terms", "term_snapshots", "term_baseline"]) {
      expect(tables).not.toContain(gone);
    }

    // And every table standing must have row-level security ON (migration 0019).
    //
    // This is the assertion that keeps 0019's convention — *a migration that
    // creates a table enables RLS on it, in the same `up`* — from being a
    // comment nobody reads. 0019 itself is a one-time sweep over what existed
    // when it shipped; it cannot cover a table added after it, so without this
    // check the next `CREATE TABLE` silently reopens the Data API hole 0019
    // closed. On Supabase, `public` is the schema PostgREST exposes and a
    // project's default grants reach `anon`, so a table with RLS off is a table
    // the internet can read with a key that ships in public.
    //
    // It lives in THIS test, not its own, on purpose: the revert/re-apply tests
    // below drop and recreate tables — which legitimately come back without RLS
    // — so the invariant only holds on the freshly-migrated schema this test
    // asserts about.
    const { rows: unprotected } = await sql<{ relname: string }>`
      select c.relname
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and pg_get_userbyid(c.relowner) = current_user
         and not c.relrowsecurity
       order by c.relname
    `.execute(harness.db);
    expect(unprotected.map((row) => row.relname)).toEqual([]);
  });

  it("reverts and re-applies row-level security cleanly", async () => {
    // 0019 is the one migration in here that changes no schema, so its
    // revert/re-apply is a statement about a table PROPERTY rather than about
    // tables existing. Worth the check for the same reason as the others: its
    // `up` and `down` are both blanket sweeps resolved at run time, and a sweep
    // whose predicate stopped matching would be indistinguishable from a sweep
    // that ran — silently doing nothing, in the direction that reopens the Data
    // API. Runs before the tests below drop and recreate tables, so "every
    // table" still means the freshly-migrated set.
    const rlsOff = async () => {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and pg_get_userbyid(c.relowner) = current_user
           and not c.relrowsecurity
      `.execute(harness.db);
      return Number(rows[0]?.n ?? 0);
    };

    expect(await rlsOff()).toBe(0);
    await rowLevelSecurity.down(migrationDb());
    expect(await rlsOff()).toBeGreaterThan(0);
    await rowLevelSecurity.up(migrationDb());
    expect(await rlsOff()).toBe(0);

    // And `up` is safe to run against a database that already has it, which is
    // what a re-run of the deploy step does and what production — where this was
    // enabled by hand before it was a migration — sees the first time.
    await rowLevelSecurity.up(migrationDb());
    expect(await rlsOff()).toBe(0);
  });

  /**
   * The fallback identity (ADR-0018), which is the one migration in here that
   * has to run over EXISTING ROWS and get a different answer for different ones.
   *
   * Three things can go wrong and none of them raises on its own: the partial
   * unique index could fail to build because the archive it is added to already
   * contains collisions; the backfill could key a colliding row and merge two
   * stories; or it could key nothing at all and leave the feature silently off
   * for history. So the seed below deliberately contains all three cases, and
   * the `up` has to survive it.
   */
  describe("the fallback article identity", () => {
    const DAY = "2026-08-27T09:00:00.000Z";
    const seed = async (rows: Array<{ url: string; title: string; domain: string }>) => {
      for (const row of rows) {
        await sql`
          insert into articles (dedup_key, url, title, source_domain, published, latest_seen)
          values (digest(${row.url}, 'sha256'), ${row.url}, ${row.title}, ${row.domain},
                  ${DAY}::timestamptz, ${DAY}::timestamptz)
        `.execute(harness.db);
      }
    };

    const altKeyOf = async (url: string): Promise<string | null> => {
      const { rows } = await sql<{ hex: string | null }>`
        select encode(alt_key, 'hex') as hex from articles where url = ${url}
      `.execute(harness.db);
      return rows[0]?.hex ?? null;
    };

    beforeAll(async () => {
      // `digest()` for the seed's dedup keys — the column is NOT NULL and
      // unique, and the values are irrelevant to what is under test here.
      await sql`create extension if not exists pgcrypto`.execute(harness.db);
    });

    afterAll(async () => {
      await sql`delete from articles`.execute(harness.db);
    });

    it("builds its unique index over an archive that already contains collisions", async () => {
      await articleAltKey.down(migrationDb());
      await seed([
        // Two URLs, one story — the 1.1% of production this exists for. Both
        // fold to one key, so the backfill must decline to key EITHER: keying
        // one and not the other would be arbitrary, and keying both cannot be
        // done at all under a unique index.
        { url: "https://ansa.it/sport/zelensky-serbia", title: "Zelensky visits Serbia", domain: "ansa.it" },
        { url: "https://ansa.it/mondo/zelensky-serbia", title: "Zelensky visits Serbia", domain: "ansa.it" },
        // Unique, and therefore keyed.
        { url: "https://ansa.it/mondo/budget", title: "Budget passes second reading", domain: "ansa.it" },
        // No key to compute: the source truncated its own title.
        { url: "https://hkexnews.hk/1", title: "[00232.HK] Disclosure of...", domain: "hkexnews.hk" },
      ]);

      // The assertion that matters most: this does not throw. A non-partial
      // unique index, or a backfill that keyed the colliding pair, would fail
      // here — and would fail in production, mid-deploy, against a live archive.
      await articleAltKey.up(migrationDb());

      const { rows: indexes } = await sql<{ indexdef: string }>`
        select indexdef from pg_indexes
         where tablename = 'articles' and indexname = 'articles_alt_key_idx'
      `.execute(harness.db);
      expect(indexes).toHaveLength(1);
      expect(indexes[0]!.indexdef).toContain("UNIQUE");
      // The partial predicate is what lets every unkeyed row coexist.
      expect(indexes[0]!.indexdef).toContain("WHERE (alt_key IS NOT NULL)");
    });

    it("keys the rows whose key is unique and leaves the colliding ones NULL", async () => {
      // Forward-only, deliberately. Merging the colliding rows would mean
      // DELETING article rows, and `group_id` is a bigint article id carrying no
      // foreign key (migrations 0003 and 0007) — so a merge would dangle group
      // seeds and orphan storyline attachments with nothing raising.
      expect(await altKeyOf("https://ansa.it/sport/zelensky-serbia")).toBeNull();
      expect(await altKeyOf("https://ansa.it/mondo/zelensky-serbia")).toBeNull();
      expect(await altKeyOf("https://hkexnews.hk/1")).toBeNull();

      // And the keyed row carries exactly what the ingest path would compute for
      // it — the property that makes backfilled history foldable at all. A
      // backfill that computed the fold its own way would leave rows no future
      // sighting could ever match, and nothing would say so.
      expect(await altKeyOf("https://ansa.it/mondo/budget")).toBe(
        deriveAltKey("ansa.it", "Budget passes second reading", DAY),
      );
    });

    it("refuses a second row claiming a key that is already taken", async () => {
      const taken = deriveAltKey("ansa.it", "Budget passes second reading", DAY)!;
      await expect(
        sql`
          insert into articles (dedup_key, url, title, source_domain, alt_key, published, latest_seen)
          values (digest('dupe', 'sha256'), 'https://ansa.it/other/budget', 'Budget passes second reading',
                  'ansa.it', decode(${taken}, 'hex'), ${DAY}::timestamptz, ${DAY}::timestamptz)
        `.execute(harness.db),
      ).rejects.toThrow();
    });

    it("reverts and re-applies cleanly, taking its index with it", async () => {
      const columnExists = async () => {
        const { rows } = await sql<{ n: string }>`
          select count(*) as n from information_schema.columns
          where table_schema = 'public' and table_name = 'articles' and column_name = 'alt_key'
        `.execute(harness.db);
        return Number(rows[0]!.n) === 1;
      };
      const indexExists = async () => {
        const { rows } = await sql<{ n: string }>`
          select count(*) as n from pg_indexes
          where tablename = 'articles' and indexname = 'articles_alt_key_idx'
        `.execute(harness.db);
        return Number(rows[0]!.n) === 1;
      };

      expect(await columnExists()).toBe(true);
      expect(await indexExists()).toBe(true);

      await articleAltKey.down(migrationDb());
      // The index goes with the column rather than being left behind for the
      // next `up` to trip over — the failure mode a hand-written `down` buys us
      // the ability to check (ADR-0003).
      expect(await columnExists()).toBe(false);
      expect(await indexExists()).toBe(false);

      await articleAltKey.up(migrationDb());
      expect(await columnExists()).toBe(true);
      expect(await indexExists()).toBe(true);
    });
  });

  it("reverts and re-applies the storyline tables cleanly", async () => {
    // A migration whose `down` half-works is a rollback that leaves the next
    // deploy unable to run `up` — the failure mode hand-written DDL (ADR-0003)
    // buys us the ability to check. Driven through the migration module rather
    // than the runner: the ledger is untouched, so the database this suite
    // leaves behind is the same one it started the test with.
    const hasStorylineTables = async () => {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from information_schema.tables
        where table_schema = 'public'
          and table_name in ('storylines', 'storyline_groups', 'storyline_days')
      `.execute(harness.db);
      return Number(rows[0]?.n ?? 0);
    };

    const hasDriftColumn = async () => {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from information_schema.columns
        where table_schema = 'public' and table_name = 'storylines'
          and column_name = 'label_group_count'
      `.execute(harness.db);
      return Number(rows[0]?.n ?? 0) === 1;
    };

    // Newest first down, oldest first up, exactly as a rollback and the next
    // deploy run. Three later migrations hang off 0007's tables — 0009's
    // `storyline_bridges` and 0021's `storyline_coverage` by foreign key, 0010
    // by a column on `storylines` — so reverting 0007 alone is something no
    // deploy would do: Postgres refuses the first two (the keys doing their job)
    // and the third would silently rebuild `storylines` without a column the
    // ledger still claimed.
    expect(await hasDriftColumn()).toBe(true);
    await providerCoverage.down(migrationDb());
    await labelSource.down(migrationDb());
    await labelDrift.down(migrationDb());
    await storylineBridges.down(migrationDb());
    await storylineTables.down(migrationDb());
    expect(await hasStorylineTables()).toBe(0);

    await storylineTables.up(migrationDb());
    await storylineBridges.up(migrationDb());
    await labelDrift.up(migrationDb());
    await labelSource.up(migrationDb());
    await providerCoverage.up(migrationDb());
    expect(await hasStorylineTables()).toBe(3);
    expect(await hasDriftColumn()).toBe(true);
  });

  it("reverts and re-applies the bridge table cleanly", async () => {
    const hasBridges = async () => {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from information_schema.tables
        where table_schema = 'public' and table_name = 'storyline_bridges'
      `.execute(harness.db);
      return Number(rows[0]?.n ?? 0);
    };

    await storylineBridges.down(migrationDb());
    expect(await hasBridges()).toBe(0);

    await storylineBridges.up(migrationDb());
    expect(await hasBridges()).toBe(1);
  });

  it("reverts and re-applies the trailing-corpus tables cleanly", async () => {
    // Same check, same reason, for the df aggregate (ADR-0011). Its `down`
    // drops derived rows only — the corpus is rebuildable from `articles`, so
    // a rollback here costs a `--rebuild`, never history.
    const hasStoryDfTables = async () => {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from information_schema.tables
        where table_schema = 'public'
          and table_name in ('story_token_days', 'story_corpus_days')
      `.execute(harness.db);
      return Number(rows[0]?.n ?? 0);
    };

    await storyTokenDf.down(migrationDb());
    expect(await hasStoryDfTables()).toBe(0);

    await storyTokenDf.up(migrationDb());
    expect(await hasStoryDfTables()).toBe(2);
  });

  it("restores and re-drops the term cloud's tables cleanly", async () => {
    // 0014's `down` is the one rollback in this file that cannot return what it
    // took: the schema comes back EMPTY, because a week of hourly baseline
    // observations is not derivable from anything left standing (ADR-0013). What
    // is tested is that the rollback lands on a usable schema and that going
    // forward again drops all three — a `down` that recreated two of them would
    // leave the next `up` half-applying.
    const termTables = async () => {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from information_schema.tables
        where table_schema = 'public'
          and table_name in ('trending_terms', 'term_snapshots', 'term_baseline')
      `.execute(harness.db);
      return Number(rows[0]?.n ?? 0);
    };

    await dropTermCloud.down(migrationDb());
    expect(await termTables()).toBe(3);
    // Restored empty, and writable — the state the tables were in at launch.
    await sql`
      insert into term_baseline (language, term, mean_df, updated_at)
      values ('en', 'kelowna', 1.5, now())
    `.execute(harness.db);

    await dropTermCloud.up(migrationDb());
    expect(await termTables()).toBe(0);
  });

  it("reverts and re-applies per-provider coverage cleanly", async () => {
    // Migration 0021, both directions. The `up` is an ALTER on a table holding
    // data plus a CREATE, so its `down` has two halves that can rot
    // independently: a rollback that dropped the table and left the column
    // would leave the next `up` failing on a duplicate column, which is a deploy
    // that cannot go forward OR back.
    const shape = async () => {
      const { rows } = await sql<{ column_default: string | null }>`
        select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'topic_coverage'
          and column_name = 'provider'
      `.execute(harness.db);
      const { rows: tables } = await sql<{ n: string }>`
        select count(*) as n from information_schema.tables
        where table_schema = 'public' and table_name = 'storyline_coverage'
      `.execute(harness.db);
      return { provider: rows[0]?.column_default ?? null, table: Number(tables[0]?.n ?? 0) };
    };

    expect(await shape()).toEqual({ provider: "'currents'::text", table: 1 });

    // The default is what backfills history, so prove it on a row written the
    // way every pre-0021 row was — with no provider named at all.
    await sql`
      insert into topics (fingerprint, keywords) values (decode(repeat('a', 64), 'hex'), '{x}')
      on conflict do nothing
    `.execute(harness.db);
    await sql`
      insert into topic_coverage (fingerprint, span)
      values (decode(repeat('a', 64), 'hex'),
              tstzrange('2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z', '[)'))
    `.execute(harness.db);
    const { rows: backfilled } = await sql<{ provider: string }>`
      select provider from topic_coverage where fingerprint = decode(repeat('a', 64), 'hex')
    `.execute(harness.db);
    expect(backfilled.map((row) => row.provider)).toEqual(["currents"]);

    await providerCoverage.down(migrationDb());
    expect(await shape()).toEqual({ provider: null, table: 0 });

    await providerCoverage.up(migrationDb());
    expect(await shape()).toEqual({ provider: "'currents'::text", table: 1 });

    // The pre-0021 row survives the round trip and comes back stamped, which is
    // the backfill claim the migration makes about production's 383 rows.
    const { rows: after } = await sql<{ provider: string }>`
      select provider from topic_coverage where fingerprint = decode(repeat('a', 64), 'hex')
    `.execute(harness.db);
    expect(after.map((row) => row.provider)).toEqual(["currents"]);

    // A coverage row with no subject is refused. `topic_coverage` permits one —
    // 0001 left `fingerprint` nullable — and this table deliberately does not:
    // the row's whole meaning is "this span was fetched for THIS arc", so a null
    // subject is a claim with no claimant that no read here would ever surface.
    await expect(
      sql`
        insert into storyline_coverage (storyline_id, provider, span)
        values (null, 'google-news',
                tstzrange('2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z', '[)'))
      `.execute(harness.db),
    ).rejects.toThrow();

    // And the recreated table carries RLS, per 0019's convention. The blanket
    // sweep cannot reach a table created after it, and a `down`/`up` pair is the
    // other way a table comes back unprotected.
    const { rows: rls } = await sql<{ relrowsecurity: boolean }>`
      select relrowsecurity from pg_class where relname = 'storyline_coverage'
    `.execute(harness.db);
    expect(rls[0]?.relrowsecurity).toBe(true);

    await sql`delete from topic_coverage where fingerprint = decode(repeat('a', 64), 'hex')`.execute(
      harness.db,
    );
    await sql`delete from topics where fingerprint = decode(repeat('a', 64), 'hex')`.execute(
      harness.db,
    );
  });

  it("reverts and re-applies the sighting plane cleanly, constraint included", async () => {
    // Migration 0022, both directions. The `down` drops a CHECK and a column and
    // has to do them in that order — a rollback that dropped only the column
    // would leave a constraint naming a column that no longer exists, and the
    // next `up` would fail on a duplicate constraint name.
    const shape = async () => {
      const { rows: columns } = await sql<{ is_nullable: string; column_default: string | null }>`
        select is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'sightings' and column_name = 'plane'
      `.execute(harness.db);
      const { rows: checks } = await sql<{ n: string }>`
        select count(*) as n from pg_constraint where conname = 'sightings_plane_check'
      `.execute(harness.db);
      return { column: columns[0] ?? null, checks: Number(checks[0]!.n) };
    };

    // Nullable and DEFAULT-less, which is the decision this migration argues at
    // length: no single value describes history — 1,791 of the dev archive's
    // articles belong only to the breadth sample's keyword-less topic, which
    // disproves `'search'` — so the honest value for a row minted before the
    // column existed is no value at all.
    expect(await shape()).toEqual({
      column: { is_nullable: "YES", column_default: null },
      checks: 1,
    });

    await sightingPlane.down(migrationDb());
    expect(await shape()).toEqual({ column: null, checks: 0 });

    await sightingPlane.up(migrationDb());
    expect(await shape()).toEqual({
      column: { is_nullable: "YES", column_default: null },
      checks: 1,
    });
  });

  describe("the plane a fetch was made on", () => {
    // A sighting needs an article to hang off, and `articles` is emptied by the
    // alt-key block above, so this seeds its own.
    const seedSighting = (plane: string | null) => sql`
      with a as (
        insert into articles (dedup_key, url, title, source_domain, published, latest_seen)
        values (digest(${`https://plane.example/${plane ?? "null"}`}, 'sha256'),
                ${`https://plane.example/${plane ?? "null"}`}, 'Plane fixture', 'plane.example',
                now(), now())
        returning id
      )
      insert into sightings (id, article_id, dedup_key, published, provider, plane, raw)
      select gen_random_uuid(), a.id, digest('s', 'sha256'), now(), 'currents',
             ${plane}::text, '{}'::jsonb
        from a
    `.execute(harness.db);

    afterAll(async () => {
      await sql`delete from articles where source_domain = 'plane.example'`.execute(harness.db);
    });

    it("admits the three ADR-0019 planes and NULL, and nothing else", async () => {
      // The CHECK exists for a failure that is silent in one direction only.
      // `readTrendingStorylines` reads `plane is distinct from 'deepening'`,
      // which is TRUE of every misspelling — so a typo does not fail closed, it
      // joins the discovery plane and re-opens the endogenous loop with nothing
      // raising. This constraint is what turns that into a failed insert, and
      // until now nothing asserted it.
      for (const plane of ["search", "breadth", "deepening", null]) {
        await expect(seedSighting(plane)).resolves.toBeDefined();
      }

      await expect(seedSighting("deepning")).rejects.toThrow(/sightings_plane_check/);
      await expect(seedSighting("DEEPENING")).rejects.toThrow(/sightings_plane_check/);
      await expect(seedSighting("")).rejects.toThrow(/sightings_plane_check/);
    });
  });

  it("is a no-op the second time", async () => {
    // Re-running against an up-to-date database must execute nothing — this is
    // what makes the deploy step safe to repeat after a half-failed release.
    const { error, results } = await migrateToLatest(harness.db);

    expect(error).toBeUndefined();
    expect(results).toEqual([]);
  });

  it("reverts and re-applies cleanly, and holds the pair ordering it claims", async () => {
    const exists = async () => {
      const { rows } = await sql<{ n: string }>`
        select count(*) as n from information_schema.tables
        where table_schema = 'public' and table_name = 'storyline_formation_refusals'
      `.execute(harness.db);
      return Number(rows[0]?.n ?? 0) === 1;
    };

    expect(await exists()).toBe(true);
    await formationRefusals.down(migrationDb());
    expect(await exists()).toBe(false);
    await formationRefusals.up(migrationDb());
    expect(await exists()).toBe(true);

    // The CHECK is the invariant `recordFormationRefusal` relies on to make a
    // symmetric refusal one row: an unordered pair must be impossible to write,
    // or the same refusal could be stored twice and neither read would find both.
    await expect(
      sql`insert into storyline_formation_refusals (group_lo, group_hi) values (9, 8)`.execute(
        harness.db,
      ),
    ).rejects.toThrow();

    await sql`insert into storyline_formation_refusals (group_lo, group_hi) values (8, 9)`.execute(
      harness.db,
    );
    // Idempotent by primary key: the backfill replays every formation.
    await sql`
      insert into storyline_formation_refusals (group_lo, group_hi) values (8, 9)
      on conflict do nothing
    `.execute(harness.db);
    const { rows } = await sql<{ n: string }>`
      select count(*) as n from storyline_formation_refusals
    `.execute(harness.db);
    expect(Number(rows[0]!.n)).toBe(1);

    await sql`delete from storyline_formation_refusals`.execute(harness.db);
  });
});
