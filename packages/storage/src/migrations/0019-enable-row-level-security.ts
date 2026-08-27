import { sql, type Kysely } from "kysely";

/**
 * Row-level security ON, with no policies, on every table this schema owns.
 *
 * ## What this is defending against
 *
 * Nothing in this project speaks to Postgres through PostgREST: there is no
 * `@supabase/supabase-js` dependency anywhere, no anon key in `Config`, and
 * every read and write goes through `pg` and Kysely over a connection string
 * (`createDb`). That is *why* the exposure existed and went unnoticed. On
 * Supabase, `public` is the schema the Data API exposes, and a project's default
 * grants reach `anon` and `authenticated` — the same fact
 * `deploy/vercel/supabase-cron.sql` §2 names when it revokes EXECUTE on
 * `zammy_cron_post`, applied to tables instead of functions. Anyone holding the
 * project's publicly-shipped anon key could `GET /rest/v1/articles`, and the
 * default grants are not read-only.
 *
 * RLS with zero policies closes that: PostgREST's roles match no policy, so they
 * see nothing and can write nothing. Zero policies is the correct END STATE here
 * and not a stub to fill in later — the app has no users, no auth, and no
 * per-tenant rows, so there is no row-visibility rule to express. If this app
 * ever grows a Data API surface, the policies arrive with it.
 *
 * ## Why it does not touch the app
 *
 * **RLS never applies to a table's owner** unless the table also carries
 * `FORCE ROW LEVEL SECURITY`, which nothing here sets. Migrations run as the
 * role in `DATABASE_SESSION_URL` and the request path connects as the role in
 * `DATABASE_URL` — on Supabase both are `postgres`, which owns every table in
 * here because it created them, and which additionally carries `BYPASSRLS`. Two
 * independent reasons every existing query is unaffected, and no policy is
 * evaluated on the read path, so there is no cost either.
 *
 * The consequence worth writing down: **this migration is what makes a
 * least-privilege application role a breaking change rather than a free one.**
 * Point `DATABASE_URL` at a non-owner role and every query starts returning zero
 * rows, silently and correctly. That role needs policies (or `BYPASSRLS`) as
 * part of the same change.
 *
 * ## Why it enumerates rather than lists names
 *
 * The set is "every table in `public` this role owns", resolved at run time,
 * which is the same set on a database seeded by `pg_restore` and on one built
 * from migration 0001 — a hand-written list would have to track eighteen
 * `CREATE TABLE`s across six dropped or renamed tables and would be wrong the
 * first time somebody forgot to update it. `tableowner = current_user` is not
 * decoration: `ENABLE ROW LEVEL SECURITY` demands ownership, so a table in
 * `public` put there by anything but this schema would fail the migration
 * instead of being skipped.
 *
 * It deliberately includes Kysely's own `kysely_migration` and
 * `kysely_migration_lock`. Supabase's advisor flags those two like any other
 * table, and leaving them out means running this and still seeing warnings. The
 * migrator reads and writes them as their owner, before and after this
 * migration, so turning RLS on underneath itself is safe.
 *
 * ## The convention for tables added after this
 *
 * A blanket sweep is a one-time catch-up, not a standing mechanism: it cannot
 * cover a table that does not exist yet, and a table dropped and recreated by a
 * later `down`/`up` pair comes back without RLS. So, going forward:
 *
 *   **A migration that creates a table enables RLS on it, in the same `up`.**
 *
 * `migrator.test.ts` asserts that no public table reaches the current schema
 * with RLS off, which is what keeps the convention from being a comment nobody
 * reads.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  // `ENABLE ROW LEVEL SECURITY` changes one catalog flag and takes ACCESS
  // EXCLUSIVE to do it — instant on its own, and a full stop on `articles` if it
  // has to queue behind a long read, because every query arriving after it
  // queues too. The nightly passes are long enough to be that read. Failing the
  // deploy step, which is re-runnable, is the better end of that trade than
  // stalling the request path, so bound the wait rather than inheriting the
  // default of forever.
  //
  // `SET LOCAL` and a `RESET` at the end, rather than either alone: Kysely runs
  // the WHOLE migration set in one transaction (`supportsTransactionalDdl`), so
  // a `SET LOCAL` left standing here would silently govern every migration that
  // runs after this one in the same deploy — a timeout somebody would inherit
  // without choosing it. The pair keeps it to the statement it was reasoned
  // about. Outside a transaction — a test calling this directly — `SET LOCAL`
  // warns and does nothing, which is the right no-op.
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

  await sql`
    DO $$
    DECLARE t record;
    BEGIN
      FOR t IN
        SELECT tablename FROM pg_tables
         WHERE schemaname = 'public' AND tableowner = current_user
      LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
      END LOOP;
    END $$
  `.execute(db);

  await sql`RESET lock_timeout`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Symmetric, and it reopens the Data API hole described above — which is the
  // honest behaviour for a rollback of this migration, and the reason to reach
  // for it only as part of rolling back the release it shipped in.
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

  await sql`
    DO $$
    DECLARE t record;
    BEGIN
      FOR t IN
        SELECT tablename FROM pg_tables
         WHERE schemaname = 'public' AND tableowner = current_user
      LOOP
        EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t.tablename);
      END LOOP;
    END $$
  `.execute(db);

  await sql`RESET lock_timeout`.execute(db);
}
