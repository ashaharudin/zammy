import { isChorePass, type ChorePass } from "./chore-runner.js";

/**
 * The schedule, as one table — the thing "is this pass overdue?" cannot be
 * asked without.
 *
 * ## Why this module exists at all
 *
 * The schedule was already written down twice: `deploy/vercel/supabase-cron.sql`
 * schedules seven jobs and is the file a person pastes into the SQL editor, and
 * `chore-route.ts` carried a three-entry `SCHEDULE_PASSES` map for the
 * `x-vercel-cron-schedule` selection path. `chore-status.ts` needs a third
 * reader of the same fact, and a third copy is how three copies start
 * disagreeing.
 *
 * So this is the one copy the RUNNING CODE reads, and `SCHEDULE_PASSES` is
 * derived from it rather than spelled again. The SQL file stays authoritative
 * for what pg_cron actually has — nothing here can apply it, and `select
 * jobname, schedule, active from cron.job` is still the only statement of what
 * a deployment is really running — and `chore-schedule.test.ts` parses that file
 * and fails if this table and it have drifted. That is what makes "one source of
 * truth" a property rather than a comment: the SQL is the source, this is a
 * mirror, and the mirror cannot go stale quietly.
 *
 * **What it deliberately is not.** It is not a scheduler and not a cron library.
 * `parseDailyCron` refuses anything whose day-of-month, month and day-of-week
 * fields are not `*`, because every expression this system has ever run is a
 * daily one and an "overdue" derived from a half-understood expression would be
 * worse than no answer. A schedule this cannot parse reads as unscheduled, which
 * fails toward silence rather than toward a false alarm.
 *
 * ## The timezone
 *
 * pg_cron reads these expressions in the DATABASE's timezone, which is UTC on
 * Supabase, and the SQL file says so at length. Everything here is therefore
 * UTC arithmetic on purpose — `getUTCHours`, never `getHours`. `APP_TIMEZONE`
 * is what the passes BUCKET by and has nothing to do with when they fire.
 */

/** One `cron.schedule` call, as `supabase-cron.sql` spells it. */
export interface ScheduledJob {
  /** The pg_cron job name — the key `cron.schedule` upserts by. */
  readonly job: string;
  /** The cron expression, read in UTC. */
  readonly schedule: string;
  /**
   * The path it posts, exactly as `zammy_cron_post`'s allow-list spells it —
   * query string included, because that is what names the pass.
   */
  readonly path: string;
}

/**
 * All seven jobs, in the file's order.
 *
 * The keep-alive and the drain are here even though neither is a chore pass, and
 * that is the point of mirroring the FILE rather than the pass table: a test can
 * only say "this is complete" against something that claims to be complete, and
 * a partial mirror is one whose next omission looks intentional.
 */
export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  { job: "zammy-chores-retention", schedule: "0 3 * * *", path: "/api/chores?pass=retention" },
  { job: "zammy-chores-storylines", schedule: "0 4 * * *", path: "/api/chores?pass=storylines" },
  // Three firings, not one, and the arithmetic is in the SQL file: one run
  // spends about 48 model calls against the ~120 a new day of coverage costs,
  // and `SUMMARY_BUDGET_MS` cannot be raised past the 300 s function ceiling, so
  // the schedule absorbs what the budget cannot. Overlap is safe — the lock
  // makes a second run skip.
  { job: "zammy-chores-summaries", schedule: "0 5 * * *", path: "/api/chores?pass=summaries" },
  { job: "zammy-chores-summaries-2", schedule: "0 6 * * *", path: "/api/chores?pass=summaries" },
  { job: "zammy-chores-summaries-3", schedule: "0 7 * * *", path: "/api/chores?pass=summaries" },
  { job: "zammy-keepalive", schedule: "0 12 * * *", path: "/api/keepalive" },
  { job: "zammy-ingest-drain", schedule: "*/10 * * * *", path: "/api/drain" },
] as const;

/**
 * The nightly schedules, as the header a cron platform stamps a request with.
 *
 * VERCEL-ALL-IN-SCOPE §3.3 asks for the pass to come "from the query or from the
 * `x-vercel-cron-schedule` header", and the query is what every scheduler we
 * actually configure uses — Supabase Cron posts to a URL we wrote, and Vercel's
 * own `crons` entries carry their query string. The header path exists for the
 * scheduler that stamps a request without one.
 *
 * **Derived rather than declared**, which fixed a gap: the hand-written map had
 * three entries for the three schedules that existed when it was written, and
 * the two extra summary firings added later were never added to it. Nothing
 * broke, because Supabase Cron always sends the query — but a scheduler taking
 * the header path at 06:00 would have been answered 400 by a route that runs
 * that pass at 06:00 every night.
 *
 * Note this map is for SELECTION only. The header is client-settable and is
 * therefore never an authenticator — Vercel's own scheduler sends
 * `Authorization: Bearer $CRON_SECRET` for that, which is `cron-route.ts`'s
 * check.
 */
export const SCHEDULE_PASSES: Record<string, ChorePass> = Object.fromEntries(
  SCHEDULED_JOBS.flatMap((entry) => {
    const pass = passFromPath(entry.path);
    return pass ? [[entry.schedule, pass] as const] : [];
  }),
);

/** The `?pass=` a scheduled path names, or null for the two that are not passes. */
export function passFromPath(path: string): ChorePass | null {
  const pass = new URL(path, "http://localhost").searchParams.get("pass");
  return pass !== null && isChorePass(pass) ? pass : null;
}

/**
 * Every expression this pass is scheduled at. Empty for the six that are
 * on-demand halves of the composite night and for anything unscheduled — which
 * is exactly the set that can never be "overdue".
 */
export function choreSchedules(pass: ChorePass): readonly string[] {
  return SCHEDULED_JOBS.filter((entry) => passFromPath(entry.path) === pass).map(
    (entry) => entry.schedule,
  );
}

/** A daily cron expression, reduced to the minutes of the day it fires at. */
export interface DailyCron {
  /** Minutes past midnight UTC, ascending, at least one. */
  readonly minutesOfDay: readonly number[];
}

/**
 * A five-field cron expression, if it is a DAILY one.
 *
 * Returns null when the day-of-month, month or day-of-week field is anything but
 * `*`, and that refusal is the design: a weekly or monthly expression has a
 * previous firing this function would have to reason about calendars to find,
 * and every expression this system has ever scheduled is daily. A caller reads
 * null as "not scheduled", so an expression we cannot understand produces no
 * alarm rather than a wrong one.
 *
 * Supports `*`, `a`, `a-b`, `a,b`, and `*\/n` in the minute and hour fields,
 * which is a superset of what the seven jobs use.
 */
export function parseDailyCron(expression: string): DailyCron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") return null;

  const minutes = expandField(minute, 0, 59);
  const hours = expandField(hour, 0, 23);
  if (minutes === null || hours === null) return null;

  const minutesOfDay: number[] = [];
  for (const h of hours) for (const m of minutes) minutesOfDay.push(h * 60 + m);
  minutesOfDay.sort((a, b) => a - b);
  return { minutesOfDay };
}

/** One field, as the sorted set of values it names. Null on anything unparsed. */
function expandField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const term of field.split(",")) {
    const [range, stepText] = term.split("/");
    if (range === undefined || (stepText !== undefined && !/^\d+$/.test(stepText))) return null;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return null;

    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else if (/^\d+$/.test(range)) {
      from = Number(range);
      // A bare number with a step (`5/10`) means "from 5 to the end of the
      // range", which is how cron reads it.
      to = stepText === undefined ? from : max;
    } else {
      const bounds = /^(\d+)-(\d+)$/.exec(range);
      if (!bounds) return null;
      from = Number(bounds[1]);
      to = Number(bounds[2]);
    }
    if (from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values.size === 0 ? null : [...values].sort((a, b) => a - b);
}

/**
 * The most recent instant this expression fired at, at or before `now`.
 *
 * Null when the expression is not a daily one — see `parseDailyCron`. Truncated
 * to the minute, so a fire at 03:00 counts as having happened for every instant
 * from 03:00:00 onward, which is what a scheduler means by it.
 */
export function previousFireAt(expression: string, now: Date): Date | null {
  const parsed = parseDailyCron(expression);
  if (!parsed) return null;

  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  const today = parsed.minutesOfDay.filter((minute) => minute <= minuteOfDay).at(-1);
  if (today !== undefined) return new Date(midnight + today * 60_000);
  // Before the first firing of today: the previous one is yesterday's last.
  const yesterday = parsed.minutesOfDay.at(-1) as number;
  return new Date(midnight - 86_400_000 + yesterday * 60_000);
}

/**
 * The firing this pass most recently owed an appearance for, across every job
 * that runs it.
 *
 * The LATEST of them, which is what makes three summary firings a night read
 * correctly: at 06:30 the pass owes a run since 06:00, and a row from 05:02
 * does not discharge it. A pass with no parseable schedule has nothing to owe.
 */
export function expectedFireAt(pass: ChorePass, now: Date): Date | null {
  let latest: Date | null = null;
  for (const schedule of choreSchedules(pass)) {
    const fired = previousFireAt(schedule, now);
    if (fired && (latest === null || fired > latest)) latest = fired;
  }
  return latest;
}
