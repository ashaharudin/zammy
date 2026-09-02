import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHORE_MAX_DURATION_MS } from "./chore-status.js";
import {
  SCHEDULED_JOBS,
  SCHEDULE_PASSES,
  choreSchedules,
  expectedFireAt,
  parseDailyCron,
  passFromPath,
  previousFireAt,
} from "./chore-schedule.js";

/**
 * The schedule, against the file that applies it.
 *
 * `chore-schedule.ts` is a MIRROR: `deploy/vercel/supabase-cron.sql` is what a
 * person pastes into the SQL editor and therefore what pg_cron actually runs,
 * and the table in TypeScript exists because "is this pass overdue?" cannot be
 * asked at runtime by reading a `.sql` file that is not part of the function
 * bundle. Two copies of a fact are fine exactly as long as something fails when
 * they disagree — this file is that something.
 *
 * It caught one disagreement on the way in. The map this replaced,
 * `chore-route.ts`'s hand-written `SCHEDULE_PASSES`, had three entries for the
 * three schedules that existed when it was written; the two extra summary
 * firings added later (06:00 and 07:00, because one run cannot spend the ~120
 * model calls a day of coverage costs) were never added to it. Nothing broke,
 * because Supabase Cron always sends `?pass=` in the query — but a scheduler
 * taking the header path at 06:00 would have been answered 400 by the route that
 * runs that pass at 06:00 every night.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (file: string): string => readFileSync(`${ROOT}${file}`, "utf8");

/** Every `cron.schedule` call in the file, as (job, schedule, path). */
function scheduledInSql(): Array<{ job: string; schedule: string; path: string }> {
  const sql = read("deploy/vercel/supabase-cron.sql");
  return [
    ...sql.matchAll(
      /cron\.schedule\(\s*'([^']+)',\s*'([^']+)',\s*\$\$\s*select public\.zammy_cron_post\('([^']+)'/g,
    ),
  ].map((match) => ({
    job: match[1] as string,
    schedule: match[2] as string,
    path: match[3] as string,
  }));
}

describe("the schedule table mirrors the file that schedules", () => {
  it("holds every job the SQL schedules, and no others", () => {
    // Job name, expression AND path, all three: a mirror that only checked the
    // expressions would pass on the day a job was repointed at another pass.
    expect(SCHEDULED_JOBS.map((entry) => ({ ...entry }))).toEqual(scheduledInSql());
    // Seven, as `docs/chores.md` and the SQL header both say. Stated as a number
    // so that a job disappearing from the file takes this with it rather than
    // quietly shrinking both sides at once.
    expect(SCHEDULED_JOBS).toHaveLength(7);
  });

  it("posts only paths `zammy_cron_post` will accept", () => {
    // The function raises on any path not in its fixed allow-list, and the
    // failure surfaces in `cron.job_run_details` as a SQL error nobody is
    // watching. A schedule in this table whose path is not listed there is a job
    // that has never fired and looks scheduled.
    const sql = read("deploy/vercel/supabase-cron.sql");
    const allowList = /if path not in \(([^)]*)\)/.exec(sql)?.[1];
    expect(allowList, "zammy_cron_post's allow-list moved").toBeDefined();
    const allowed = [...(allowList as string).matchAll(/'([^']+)'/g)].map(
      (match) => match[1] as string,
    );
    for (const entry of SCHEDULED_JOBS) {
      expect(allowed, `${entry.job} posts an unlisted path`).toContain(entry.path);
    }
  });

  it("pins the stall ceiling to the platform's own maxDuration", () => {
    // `chore-status.ts` calls a run stalled when its row is unfinished past this,
    // which is only true if it IS the number Vercel kills the function at.
    // Mirrored rather than imported because `vercel.json` must not become a
    // build input of the bundle, so it is pinned here instead.
    const vercel = JSON.parse(read("vercel.json")) as {
      functions: Record<string, { maxDuration?: number }>;
    };
    expect(CHORE_MAX_DURATION_MS).toBe(
      (vercel.functions["api/chores.ts"]?.maxDuration as number) * 1000,
    );
  });
});

describe("SCHEDULE_PASSES", () => {
  it("maps every scheduled firing of a pass, including the repeats", () => {
    // The gap the derivation closed. All three summary firings are here now, not
    // just the first.
    expect(SCHEDULE_PASSES).toEqual({
      "0 3 * * *": "retention",
      "0 4 * * *": "storylines",
      "0 5 * * *": "summaries",
      "0 6 * * *": "summaries",
      "0 7 * * *": "summaries",
    });
  });

  it("leaves the two jobs that are not passes out of it", () => {
    // The keep-alive and the drain are in the table (it mirrors the file) and
    // must never be selectable as a pass: `?pass=` names a chore, and neither of
    // those is one.
    expect(passFromPath("/api/keepalive")).toBeNull();
    expect(passFromPath("/api/drain")).toBeNull();
    expect(SCHEDULE_PASSES["0 12 * * *"]).toBeUndefined();
    expect(SCHEDULE_PASSES["*/10 * * * *"]).toBeUndefined();
  });

  it("refuses a path naming something that is not a pass at all", () => {
    expect(passFromPath("/api/chores?pass=nightly")).toBeNull();
  });
});

describe("choreSchedules", () => {
  it("gives a pass every expression it fires at", () => {
    expect(choreSchedules("retention")).toEqual(["0 3 * * *"]);
    expect(choreSchedules("summaries")).toEqual(["0 5 * * *", "0 6 * * *", "0 7 * * *"]);
  });

  it("gives the on-demand halves of the night nothing", () => {
    // Which is what makes them unable to be overdue: `labels` and its siblings
    // are steps of the composite pass, addressable for a re-run and scheduled
    // nowhere. A default schedule for them would report six passes late every
    // night of a perfectly healthy deployment.
    for (const pass of ["dormancy", "bridges", "late-candidates", "labels", "label-merge", "graph"] as const) {
      expect(choreSchedules(pass), pass).toEqual([]);
    }
  });
});

describe("parseDailyCron", () => {
  it("reduces a daily expression to the minutes it fires at", () => {
    expect(parseDailyCron("0 3 * * *")?.minutesOfDay).toEqual([180]);
    expect(parseDailyCron("30 4 * * *")?.minutesOfDay).toEqual([270]);
  });

  it("understands the step, list and range forms", () => {
    // `*/10` is the drain's, and the only one of the three the seven jobs use —
    // the others are here because a schedule that grew one must not silently
    // become "unscheduled".
    expect(parseDailyCron("*/10 * * * *")?.minutesOfDay).toHaveLength(144);
    expect(parseDailyCron("0 3,4 * * *")?.minutesOfDay).toEqual([180, 240]);
    expect(parseDailyCron("0 3-5 * * *")?.minutesOfDay).toEqual([180, 240, 300]);
    expect(parseDailyCron("0 */6 * * *")?.minutesOfDay).toEqual([0, 360, 720, 1080]);
  });

  it("refuses anything that is not a DAILY expression", () => {
    // The refusal is the design. A weekly or monthly expression has a previous
    // firing this module would have to reason about calendars to find, and a
    // caller reads null as "not scheduled" — so an expression we do not
    // understand produces silence rather than a wrong alarm.
    expect(parseDailyCron("0 3 * * 1")).toBeNull();
    expect(parseDailyCron("0 3 1 * *")).toBeNull();
    expect(parseDailyCron("0 3 * 6 *")).toBeNull();
    expect(parseDailyCron("@daily")).toBeNull();
    expect(parseDailyCron("0 3 * *")).toBeNull();
    expect(parseDailyCron("0 99 * * *")).toBeNull();
    expect(parseDailyCron("0 nope * * *")).toBeNull();
  });
});

describe("previousFireAt", () => {
  it("finds the firing at or before now, to the minute", () => {
    // At 03:00:00 exactly the 03:00 job HAS fired — a scheduler means the minute,
    // and treating the boundary the other way would make every job look one day
    // late for its first sixty seconds.
    expect(previousFireAt("0 3 * * *", new Date("2026-09-01T03:00:00Z"))).toEqual(
      new Date("2026-09-01T03:00:00Z"),
    );
    expect(previousFireAt("0 3 * * *", new Date("2026-09-01T09:30:00Z"))).toEqual(
      new Date("2026-09-01T03:00:00Z"),
    );
  });

  it("reaches back to yesterday before today's first firing", () => {
    expect(previousFireAt("0 3 * * *", new Date("2026-09-01T02:59:59Z"))).toEqual(
      new Date("2026-08-31T03:00:00Z"),
    );
  });

  it("crosses a month boundary rather than arithmetic on the day number", () => {
    expect(previousFireAt("0 12 * * *", new Date("2026-09-01T00:10:00Z"))).toEqual(
      new Date("2026-08-31T12:00:00Z"),
    );
  });

  it("reads the expression in UTC and in no other zone", () => {
    // pg_cron reads these in the DATABASE's timezone, UTC on Supabase, and the
    // SQL file says so at length. A local-time reading would move every verdict
    // by the runner's offset — which on this laptop is six hours, i.e. the whole
    // distance between the retention job and the keep-alive.
    const fired = previousFireAt("0 4 * * *", new Date("2026-09-01T05:00:00Z"));
    expect(fired?.toISOString()).toBe("2026-09-01T04:00:00.000Z");
  });
});

describe("expectedFireAt", () => {
  it("takes the LATEST firing among a pass's several jobs", () => {
    // The summary pass fires three times a night, and at 06:30 a row from 05:02
    // does not discharge the 06:00 firing. Taking the earliest would make the
    // pass look current all night on the strength of its first run.
    expect(expectedFireAt("summaries", new Date("2026-09-01T06:30:00Z"))).toEqual(
      new Date("2026-09-01T06:00:00Z"),
    );
    expect(expectedFireAt("summaries", new Date("2026-09-01T05:30:00Z"))).toEqual(
      new Date("2026-09-01T05:00:00Z"),
    );
    // Before the night starts, the latest firing is yesterday's LAST one.
    expect(expectedFireAt("summaries", new Date("2026-09-01T01:00:00Z"))).toEqual(
      new Date("2026-08-31T07:00:00Z"),
    );
  });

  it("owes nothing for a pass nothing schedules", () => {
    expect(expectedFireAt("labels", new Date("2026-09-01T06:30:00Z"))).toBeNull();
  });
});
