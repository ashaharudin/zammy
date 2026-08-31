-- The schedules, as Supabase Cron jobs (VERCEL-ALL-IN-SCOPE §3.3).
--
-- Run this in the Supabase SQL editor of the project the deployment points at,
-- ONCE per environment, after replacing the two placeholders below. It is
-- idempotent: `cron.schedule` upserts by job name, so re-running it after a
-- deployment URL changes is the supported way to update the jobs.
--
-- ── Why Supabase Cron and not Vercel Cron ────────────────────────────────────
--
-- Minute precision. Hobby's Vercel cron fires once a day within a ±59-minute
-- window, which is fine for a nightly report and useless for the drain, whose
-- whole job is a 5-15 minute cadence. Vercel Cron becomes the better choice on
-- Pro, where per-minute precision comes with the plan — at which point these
-- jobs are deleted and `vercel.json` grows a `crons` array. Do not run both:
-- the advisory lock would make the second run skip rather than double, but a
-- nightly "skipped" row for a reason nobody remembers is its own problem.
--
-- ── The two things that are easy to get wrong ────────────────────────────────
--
-- **`timeout_milliseconds`.** pg_net's default is short and has moved between
-- versions (2 s in the documentation §3.3 was written against, 5 s in current
-- pg_net), while the chores route's 202 from a cold function is a Node boot plus
-- TLS plus config parsing — the spike measured 669 ms cold for a route with NO
-- app behind it, on top of a ~550 ms platform container floor. Neither default
-- is comfortably clear of that, and a timed-out request is a night that silently
-- did not run. Set it explicitly rather than inheriting whichever number this
-- pg_net ships with.
--
-- **The timezone.** pg_cron reads these expressions in the DATABASE's timezone,
-- which is UTC on Supabase. The passes bucket by `APP_TIMEZONE` day boundaries,
-- and the schedules they have always run are 03:00 and 04:00 UTC. Changing
-- these expressions moves the day boundary the night's work sits relative to.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Extensions. Both are available on the free tier; `pg_net` is what makes a
--    cron job able to make an HTTP request at all.
-- ─────────────────────────────────────────────────────────────────────────────
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The secret, in Vault rather than inline in a job's command.
--
--    `cron.job.command` is readable by anyone who can read the table, and these
--    jobs run forever — a bearer token pasted into one is a token in a place
--    nobody thinks to rotate. Vault keeps it out of the job definition; the
--    jobs below read it back by name at fire time.
--
--    Run this line ONCE with the real value, then delete it from whatever you
--    pasted it into. Re-running it creates a SECOND secret of the same name.
-- ─────────────────────────────────────────────────────────────────────────────
-- select vault.create_secret('REPLACE_WITH_CRON_SECRET', 'zammy_cron_secret');
-- select vault.create_secret('https://REPLACE_WITH_DEPLOYMENT_HOST', 'zammy_base_url');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. One helper, so a URL or a token change is one place and not five.
--
--    SECURITY DEFINER because `vault.decrypted_secrets` is not readable by the
--    role pg_cron runs jobs as. Three hardening steps come WITH that decision
--    rather than after it, because a definer function that holds a bearer token
--    and lives in `public` is reachable from the internet on Supabase:
--    PostgREST exposes `public`, and Postgres grants EXECUTE to PUBLIC on every
--    new function by default. Without the three below, anyone holding the
--    project's (publicly shipped) anon key could POST
--    `/rest/v1/rpc/zammy_cron_post` and start the expensive pass on demand --
--    the exact thing CRON_SECRET exists to prevent -- with the function
--    helpfully supplying the token.
--
--    1. `path` is checked against a FIXED allowlist. It is concatenated onto a
--       base URL that has no trailing slash, so an unvalidated
--       `'@evil.example/'` would resolve to `https://<host>@evil.example/` and
--       send `Authorization: Bearer <CRON_SECRET>` to somebody else's server.
--       Adding a schedule means adding its path here, deliberately; an ad-hoc
--       re-run is a curl, not a cron job, and does not belong in this function.
--    2. `search_path = ''`, with every reference schema-qualified. The usual
--       definer footgun: any search path that leads with a writable schema lets
--       somebody who can create objects there decide what this function calls.
--    3. EXECUTE revoked from everyone but the owner (section 2b).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.zammy_cron_post(
  path text,
  timeout_ms integer default 15000
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  base   text;
  secret text;
begin
  if path not in (
    '/api/chores?pass=retention',
    '/api/chores?pass=storylines',
    '/api/chores?pass=summaries',
    '/api/keepalive',
    '/api/drain'
  ) then
    raise exception 'zammy_cron_post refuses an unlisted path: %', path;
  end if;

  select decrypted_secret into base
    from vault.decrypted_secrets where name = 'zammy_base_url';
  select decrypted_secret into secret
    from vault.decrypted_secrets where name = 'zammy_cron_secret';
  if base is null or secret is null then
    raise exception 'zammy_base_url or zammy_cron_secret is missing from vault';
  end if;

  return net.http_post(
    url     := base || path,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || secret,
      'Content-Type',  'application/json'
    ),
    body    := '{}'::jsonb,
    -- The number this whole file exists to get right. See the header.
    timeout_milliseconds := timeout_ms
  );
end;
$$;

-- 2b. Nobody but the owner may call it. `revoke from public` is the one that
--     matters -- it is the default grant. The two role names are Supabase's
--     PostgREST roles, revoked explicitly because a project's default grants on
--     `public` reach them, and because an explicit revoke survives someone
--     re-running a blanket `grant ... on all functions in schema public` later.
revoke all on function public.zammy_cron_post(text, integer) from public;
revoke all on function public.zammy_cron_post(text, integer) from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The jobs.
-- ─────────────────────────────────────────────────────────────────────────────

-- The retention report, the trailing-corpus prune, and the REINDEX CONCURRENTLY
-- sweep. 03:00 UTC, which is the schedule this pass has always run on.
select cron.schedule(
  'zammy-chores-retention',
  '0 3 * * *',
  $$ select public.zammy_cron_post('/api/chores?pass=retention') $$
);

-- The storyline lifecycle pass: dormancy, bridge sweep, labels, label merge,
-- graph shape. An hour after retention, deliberately — the prune moves the
-- trailing corpus the linker judges against, and a sweep offered against a
-- window that is about to change is a decision made on stale evidence.
select cron.schedule(
  'zammy-chores-storylines',
  '0 4 * * *',
  $$ select public.zammy_cron_post('/api/chores?pass=storylines') $$
);

-- The historical preserve (ADR-0022): one sentence per storyline-day and per
-- populated 6-hour UTC segment of it, for the days that clear the volume bar.
-- An hour after the storyline pass, and for a reason that is not just tidiness:
-- both spend the same model key, and the 04:00 pass is the one that has been
-- killed at maxDuration before. Its own schedule means a slow label night costs
-- labels rather than costing labels AND a day of history.
--
-- It writes nothing at all until SUMMARIES_ENABLED=true. Scheduling it while it
-- is off is deliberate: the job exists, records a chore_runs row every night,
-- and starts working the moment the flag flips — rather than being the step
-- somebody forgets to add afterwards.
select cron.schedule(
  'zammy-chores-summaries',
  '0 5 * * *',
  $$ select public.zammy_cron_post('/api/chores?pass=summaries') $$
);

-- The pause guard. Its OWN job, and that is the point: Supabase does not promise
-- that pg_cron's internal activity prevents the 7-day free-tier pause — it
-- defines inactivity as insufficient USER database activity and prescribes
-- external requests. The chore route's pooler queries qualify, but only on
-- nights the chore runs AND reaches the database, so "the database stays awake"
-- must not be a downstream consequence of the most complex nightly job.
--
-- Daily rather than weekly: a guard with one chance a week has no margin for the
-- week it fails.
select cron.schedule(
  'zammy-keepalive',
  '0 12 * * *',
  $$ select public.zammy_cron_post('/api/keepalive', 10000) $$
);

-- The manual ingest drain, on the cadence its own docs ask for. Anything slower
-- and only genuinely cold topics are ever covered; this is the half of the
-- schedule Hobby's Vercel cron could not do at all.
select cron.schedule(
  'zammy-ingest-drain',
  '*/10 * * * *',
  $$ select public.zammy_cron_post('/api/drain') $$
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Reading it back.
--
--    Note what the response table can and cannot tell you. It records that the
--    202 arrived, which is a statement about the REQUEST — the route answers
--    before the pass starts, by design, so a 202 here is not evidence the night
--    ran. `chore_runs` is (`pnpm chores status`, or the query below).
-- ─────────────────────────────────────────────────────────────────────────────
-- select jobid, jobname, schedule, active from cron.job;
-- select j.jobname, r.status, r.return_message, r.start_time
--   from cron.job_run_details r join cron.job j using (jobid)
--  order by r.start_time desc limit 20;
-- select id, status_code, error_msg, created from net._http_response
--  order by created desc limit 20;
--
-- And the one that actually answers "did last night's chores run?":
-- select pass, source, started_at, finished_at, outcome, model_calls
--   from chore_runs order by started_at desc limit 20;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Removing them.
-- ─────────────────────────────────────────────────────────────────────────────
-- select cron.unschedule('zammy-chores-retention');
-- select cron.unschedule('zammy-chores-summaries');
-- select cron.unschedule('zammy-chores-storylines');
-- select cron.unschedule('zammy-keepalive');
-- select cron.unschedule('zammy-ingest-drain');
-- drop function if exists public.zammy_cron_post(text, integer);
