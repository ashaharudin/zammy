import { describe, expect, it } from "vitest";
import type { ChoreRun } from "@zammy/storage";
import { CHORE_PASSES } from "./chore-runner.js";
import {
  CHORE_MAX_DURATION_MS,
  CHORE_STATUS_GRACE_MS,
  choreStatusDigest,
  choreStatusFrom,
  choreStatusResponse,
} from "./chore-status.js";

/**
 * The status predicates, as arithmetic — no Postgres anywhere in this file.
 *
 * That is the whole reason `choreStatusFrom` is separate from the query beside
 * it. "Overdue", "stalled" and "the last run per pass" are functions of rows and
 * a clock, and the interesting cases are the boundaries: the minute a firing
 * becomes late, the minute an unfinished row becomes a stall, the night the
 * third summary firing is owed while the first has already run.
 * `chore-runner.test.ts` pins the same predicates over rows a real pass wrote,
 * which is the half that proves the column names and the timestamps line up.
 *
 * The clock is fixed at 06:30 UTC on purpose: it is INSIDE the summary pass's
 * three firings (05:00, 06:00, 07:00) and after both of the others, so every
 * scheduled pass has something owed and the repeats are exercised rather than
 * described.
 */

const NOW = new Date("2026-09-01T06:30:00Z");

let nextId = 0;

function run(overrides: Partial<ChoreRun> & { pass: string; startedAt: Date }): ChoreRun {
  nextId += 1;
  return {
    id: `run-${nextId}`,
    source: "route",
    finishedAt: new Date(overrides.startedAt.getTime() + 30_000),
    outcome: "ok",
    report: null,
    error: null,
    modelCalls: null,
    ...overrides,
  };
}

/** A night that went perfectly, as of `NOW`: every scheduled firing has a row. */
const GOOD_NIGHT: ChoreRun[] = [
  run({ pass: "retention", startedAt: new Date("2026-09-01T03:00:04Z") }),
  run({ pass: "storylines", startedAt: new Date("2026-09-01T04:00:06Z") }),
  run({ pass: "summaries", startedAt: new Date("2026-09-01T05:00:03Z") }),
  run({ pass: "summaries", startedAt: new Date("2026-09-01T06:00:02Z") }),
];

const status = (runs: readonly ChoreRun[], now: Date = NOW) => choreStatusFrom(runs, { now });

describe("the last run per pass", () => {
  it("picks the newest row of each pass, and reports the rest as absent", () => {
    const result = status([
      run({ pass: "storylines", startedAt: new Date("2026-08-30T04:00:00Z") }),
      run({
        pass: "storylines",
        startedAt: new Date("2026-09-01T04:00:00Z"),
        source: "cli",
        modelCalls: 41,
      }),
    ]);

    const storylines = result.passes.find((entry) => entry.pass === "storylines");
    expect(storylines?.last).toMatchObject({
      startedAt: new Date("2026-09-01T04:00:00Z"),
      source: "cli",
      modelCalls: 41,
    });
    // A pass with no row inside the window read is `null`, which means "not
    // recently" rather than "never" — and no predicate depends on the
    // difference, because a pass with no schedule can never be overdue.
    expect(result.passes.find((entry) => entry.pass === "labels")?.last).toBeNull();
  });

  it("does not depend on the caller's ORDER BY", () => {
    // `readChoreRuns` returns newest-first and this takes the maximum anyway. A
    // predicate that silently relied on the query's ordering is one that breaks
    // the day somebody pages.
    const ascending = status([
      run({ pass: "retention", startedAt: new Date("2026-09-01T03:00:00Z") }),
      run({ pass: "retention", startedAt: new Date("2026-09-01T03:00:01Z"), source: "cli" }),
    ]);
    expect(ascending.passes.find((entry) => entry.pass === "retention")?.last?.source).toBe("cli");
  });

  it("covers every pass, scheduled or not, in the pass table's order", () => {
    // The listing is the pass TABLE and not the schedule: an operator asking
    // "what ran?" wants `label-merge` to appear with a row when they ran it by
    // hand, not to be invisible because nothing schedules it.
    expect(status([]).passes.map((entry) => entry.pass)).toEqual([...CHORE_PASSES]);
  });
});

describe("overdue", () => {
  it("is nothing at all on a night that ran", () => {
    const result = status(GOOD_NIGHT);
    expect(result.overdue).toEqual([]);
    expect(result.stalled).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("names a pass whose firing produced no row", () => {
    // The whole point of the table. On Hobby the log is an hour long, so a
    // retention pass that never fired at 03:00 is invisible by 04:01 — this row's
    // ABSENCE is the only remaining evidence at 06:30.
    const result = status(GOOD_NIGHT.filter((entry) => entry.pass !== "retention"));
    expect(result.overdue).toEqual(["retention"]);
    expect(result.ok).toBe(false);
    expect(result.passes.find((entry) => entry.pass === "retention")?.expectedAt).toEqual(
      new Date("2026-09-01T03:00:00Z"),
    );
  });

  it("counts a run that STARTED since the firing, however it ended", () => {
    // Started, not finished: the row is opened before the pass, so a run in
    // flight has already discharged its schedule — and a pass that ran and
    // FAILED is not overdue either. "It did not run" and "it ran and broke" are
    // different problems and this predicate is only about the first.
    const failed = status([
      ...GOOD_NIGHT.filter((entry) => entry.pass !== "retention"),
      run({
        pass: "retention",
        startedAt: new Date("2026-09-01T03:00:02Z"),
        outcome: "failed",
        error: "Mars/Olympus is not an IANA zone",
      }),
    ]);
    expect(failed.overdue).toEqual([]);

    // And a skip counts too. The lock makes `skipped` a NORMAL outcome, so
    // treating it as a missing run would report an overdue pass every time two
    // runs overlapped.
    const skipped = status([
      ...GOOD_NIGHT.filter((entry) => entry.pass !== "storylines"),
      run({
        pass: "storylines",
        startedAt: new Date("2026-09-01T04:00:01Z"),
        outcome: "skipped",
      }),
    ]);
    expect(skipped.overdue).toEqual([]);
  });

  it("holds a firing to the grace period before calling it missed", () => {
    // The row is opened BEFORE the pass runs, so this bound covers only pg_net's
    // 15 s request, a cold Node boot and TLS — not how long a pass takes. Inside
    // it, a missing row is a request still in flight.
    const justFired = new Date("2026-09-01T03:05:00Z");
    expect(status([], justFired).overdue).not.toContain("retention");

    const wellPast = new Date(
      new Date("2026-09-01T03:00:00Z").getTime() + CHORE_STATUS_GRACE_MS,
    );
    expect(status([], wellPast).overdue).toContain("retention");
  });

  it("owes the LATEST of three summary firings, not the first", () => {
    // 05:00, 06:00 and 07:00, because one run spends about 48 model calls against
    // the ~120 a new day of coverage costs. At 06:30 the 05:00 row does not
    // discharge the 06:00 firing.
    const onlyFirst = status(
      GOOD_NIGHT.filter(
        (entry) => entry.startedAt.toISOString() !== "2026-09-01T06:00:02.000Z",
      ),
    );
    expect(onlyFirst.overdue).toEqual(["summaries"]);
  });

  it("never reports the on-demand halves of the night", () => {
    // Six of the nine passes are steps of the composite one, addressable for a
    // re-run and scheduled nowhere. An empty table must therefore name three
    // passes and not nine.
    expect(status([]).overdue).toEqual(["retention", "storylines", "summaries"]);
  });
});

describe("stalled", () => {
  it("names a pass whose newest row never finished, past the function ceiling", () => {
    // The shape a function killed at Vercel's `maxDuration` leaves: no `finally`
    // runs, so nothing closes the row. `finished_at IS NULL` on an old row is a
    // positive statement, which is the whole reason the row is opened first.
    const killed = status([
      ...GOOD_NIGHT.filter((entry) => entry.pass !== "storylines"),
      run({
        pass: "storylines",
        startedAt: new Date("2026-09-01T04:00:00Z"),
        finishedAt: null,
        outcome: null,
      }),
    ]);
    expect(killed.stalled).toEqual(["storylines"]);
    expect(killed.ok).toBe(false);
    // And NOT overdue: it started when it was supposed to. The two predicates
    // answer different questions and a run can satisfy one without the other.
    expect(killed.overdue).toEqual([]);
  });

  it("leaves a run alone until it has outlived the ceiling", () => {
    // A pass in flight has an unfinished row and is not stalled — most of the
    // 300 s of a storyline night looks exactly like this.
    const inFlight = [
      run({
        pass: "storylines",
        startedAt: new Date("2026-09-01T04:00:00Z"),
        finishedAt: null,
        outcome: null,
      }),
    ];
    const during = new Date(
      new Date("2026-09-01T04:00:00Z").getTime() + CHORE_MAX_DURATION_MS - 1_000,
    );
    expect(status(inFlight, during).stalled).toEqual([]);
  });

  it("clears once a later run of the same pass closes its own row", () => {
    // Self-clearing on purpose. An unfinished row from a week ago is a scar, not
    // a stuck process, and a predicate that kept reporting it would leave
    // `/readyz` permanently red for a night that has since been re-run.
    const healed = status([
      ...GOOD_NIGHT,
      run({
        pass: "storylines",
        startedAt: new Date("2026-08-26T04:00:00Z"),
        finishedAt: null,
        outcome: null,
      }),
    ]);
    expect(healed.stalled).toEqual([]);
    expect(healed.ok).toBe(true);
  });
});

describe("the two wire shapes", () => {
  it("gives the bearer-gated route the per-pass detail, and no report", () => {
    const response = choreStatusResponse(
      status([
        run({
          pass: "retention",
          startedAt: new Date("2026-09-01T03:00:00Z"),
          modelCalls: 3,
          report: { retention: { articleCandidates: 12 } },
        }),
        ...GOOD_NIGHT.filter((entry) => entry.pass !== "retention"),
      ]),
    ) as {
      checkedAt: string;
      passes: Array<{ pass: string; last: { startedAt: string; modelCalls: number } | null }>;
    };

    expect(response.checkedAt).toBe("2026-09-01T06:30:00.000Z");
    const retention = response.passes.find((entry) => entry.pass === "retention");
    expect(retention?.last).toEqual({
      runId: expect.any(String) as unknown as string,
      source: "route",
      startedAt: "2026-09-01T03:00:00.000Z",
      finishedAt: "2026-09-01T03:00:30.000Z",
      outcome: "ok",
      modelCalls: 3,
      error: null,
    });
    // `report` is the one member that can be kilobytes a row, and neither HTTP
    // surface carries it: `pnpm chores status` is where a report is read.
    expect(JSON.stringify(response)).not.toContain("articleCandidates");
  });

  it("gives the PUBLIC endpoint pass names, a flag and one timestamp", () => {
    // `/readyz` is unauthenticated, so the digest deliberately drops run ids,
    // sources, error strings and model-call counts. The full picture is behind
    // the bearer check.
    const digest = choreStatusDigest(
      status([
        ...GOOD_NIGHT.filter(
          (entry) => entry.pass !== "retention" && entry.pass !== "storylines",
        ),
        run({
          pass: "storylines",
          startedAt: new Date("2026-09-01T04:00:00Z"),
          finishedAt: null,
          outcome: null,
          error: "connection to server at 10.0.0.4 failed: password authentication",
        }),
      ]),
    );

    expect(digest).toEqual({
      ok: false,
      overdue: ["retention"],
      stalled: ["storylines"],
      lastRunAt: "2026-09-01T06:00:02.000Z",
    });
    expect(JSON.stringify(digest)).not.toContain("password");
  });

  it("says nothing has ever run rather than inventing a timestamp", () => {
    expect(choreStatusDigest(status([]))).toMatchObject({ lastRunAt: null });
  });
});
