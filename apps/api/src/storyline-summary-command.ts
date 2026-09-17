import type { Config } from "@zammy/config";
import {
  readStorylineSummaries,
  readSummaryCandidateDays,
  summaryDayBounds,
  summaryDayKey,
  type Database,
} from "@zammy/storage";
import type { Kysely } from "kysely";
import { runChorePass } from "./chore-runner.js";
import type { StorylinePassDeps } from "./chores.js";
import {
  EXIT_CONFIG,
  POSITIVE_NUMBER,
  UsageError,
  type Args,
  type CommandSpec,
} from "./operator-command.js";
import type { SummaryPassTally } from "./storyline-summary-service.js";
import { choreDepsFromConfig } from "./wiring.js";

/**
 * `pnpm summaries:storylines [--storyline=UUID] [--from=YYYY-MM-DD]
 * [--to=YYYY-MM-DD] [--max-summaries=N] [--rate=N] [--dry-run] [--show]` — the
 * operator half of the historical preserve (ADR-0023,
 * docs/STORYLINE-SUMMARIES.md).
 *
 * The nightly pass covers `SUMMARY_WINDOW_DAYS` and no more, which leaves two
 * jobs for a person:
 *
 *  - **the backfill.** Everything older than that window. Past the Google News
 *    pubDate cliff those days can only honestly carry ONE sentence — the
 *    service decides that from the day's age, not from a flag here, so the two
 *    entrypoints cannot disagree about what a day is owed. Whether to run it at
 *    all, and over what window, is a decision with a bill attached, which is why
 *    it is a command and not a schedule.
 *  - **the verification run.** `--storyline` with a small `--max-summaries` is
 *    the cheapest possible answer to "does the prompt contract hold against this
 *    model", which is a question fixtures cannot answer: the labeler's own
 *    history has the response SHAPE changing under a pinned model id.
 *
 * `--rate` exists because the pacer's scope is one PROCESS. A run against a live
 * server puts two pacers on one key and up to 2x the ceiling through it, and
 * what that costs is not this run — it is the server's labels falling back to
 * the bigram extractor, which are sticky until the drift trigger fires. Lower it.
 *
 * `--dry-run` names the days and their counts without calling the model, which
 * is what to run FIRST: it is the only way to see what a backfill would cost
 * before spending it.
 *
 * **`SUMMARIES_ENABLED` is deliberately not consulted here.** The flag exists so
 * the nightly pass does not start spending unattended; typing this command IS
 * the deliberate act it protects, exactly as naming `late-candidates` runs that
 * sweep regardless of its own gate.
 *
 * It declares no `labeler`: the summariser is `createSummarizer`'s, and the two
 * are separate lanes the moment `SUMMARY_API_KEY` is set (`wiring.ts`).
 *
 * ## It runs the PASS, and does not re-implement it
 *
 * A real run goes through `runChorePass("summaries", …)`, the same call the
 * 05:00 firing and `pnpm chores summaries` make. It used to take
 * `CHORE_LOCK_KEYS.summaries` by hand and call `summaryPass` directly, which
 * got the lock right and everything around it wrong: a manual preserve wrote no
 * `chore_runs` row at all, so the one pass whose rows nothing can rebuild was
 * the one pass with no durable record that it had run, no `model_calls` against
 * the night it spent them on, and no non-UTC `APP_TIMEZONE` warning — the thing
 * that says the day keys being written no longer name the same 24 hours as
 * `storyline_days`. On one-hour log retention that row is all that outlives the
 * terminal.
 *
 * `--from`/`--to`/`--storyline` reach the pass as `summaryWindow` and
 * `summaryStorylineId` on the deps rather than as a second call site, and
 * `SUMMARIES_ENABLED` is forced open rather than read — see below for both.
 *
 * `--dry-run` and `--show` stay outside all of it: they call no model, write
 * nothing, and a `chore_runs` row for a read would be a record of a night that
 * never happened.
 */

/** One page of the plan. A dry run is a cost estimate, not a full enumeration. */
const PLAN_LIMIT = 5_000;

export const spec: CommandSpec = {
  name: "summaries:storylines",
  synopsis:
    "[--storyline=UUID] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] " +
    "[--max-summaries=N] [--rate=N] [--dry-run] [--show]",
  flags: {
    storyline: { kind: "value", placeholder: "UUID", describe: "one arc only" },
    from: { kind: "value", placeholder: "YYYY-MM-DD", describe: "first day, inclusive" },
    to: { kind: "value", placeholder: "YYYY-MM-DD", describe: "last day, inclusive" },
    "max-summaries": {
      kind: "value",
      placeholder: "N",
      describe: "model calls, not days — a day costs 1-5 (default SUMMARY_MAX_PER_RUN)",
    },
    rate: {
      kind: "value",
      placeholder: "N",
      describe: "model calls per minute; lower it when the server is labelling",
    },
    "dry-run": { kind: "boolean", describe: "name the days and their cost, call no model" },
    show: { kind: "boolean", describe: "print what is already preserved for --storyline" },
  },
  // `session: true`, which every other operator CLI here deliberately avoids:
  // this one takes the `summaries` pass lock, and a session-scoped advisory
  // lock through a transaction-mode pooler is taken on one backend and looked
  // for on another — `pg_try_advisory_lock` then returns true every time and
  // the lock is decoration (`chore-runner.ts` has the full argument).
  db: { session: true },
  async run({ args, config, db }) {
    const storylineId = args.value("storyline");
    if (storylineId !== undefined && !/^[0-9a-f-]{36}$/i.test(storylineId)) {
      throw new UsageError(`--storyline must be a storyline UUID (got '${storylineId}')`);
    }
    if (args.boolean("show")) return printSummaries(db, storylineId);
    return run(db, config, args, storylineId);
  },
};

/** `--show`: what is already preserved for one arc. A read, no model, no cost. */
async function printSummaries(
  db: Kysely<Database>,
  storylineId: string | undefined,
): Promise<void> {
  if (storylineId === undefined) throw new UsageError("--show needs --storyline=UUID");
  const rows = await readStorylineSummaries(db, { storylineId });
  if (rows.length === 0) {
    console.log("no summaries for that storyline");
    return;
  }
  // `segment` is still printed, and for one reason: ADR-0027 stopped WRITING
  // quarters and deliberately did not delete the ones already written, so an
  // arc summarised before it still has four rows a reader of this output would
  // otherwise see collapsed into an unexplained repeat of the same day.
  let sawQuarter = false;
  for (const row of rows) {
    if (row.segment !== "day") sawQuarter = true;
    console.log(
      `${row.dayKey}  ${row.segment.padEnd(10)} ${String(row.articleCount).padStart(3)}a  ` +
        (row.summary ?? `— refused after ${row.attempts} attempt(s)`),
    );
  }
  if (sawQuarter) {
    console.log(
      "\nRows above named night/morning/afternoon/evening are six-hour quarters " +
        "written before ADR-0027. Nothing reads them and nothing writes them now; " +
        "the `day` row is the sentence this arc is shown under.",
    );
  }
}

async function run(
  db: Kysely<Database>,
  config: Config,
  args: Args,
  storylineId: string | undefined,
): Promise<number | void> {
  // The configured night, over the handle this command already holds. Building
  // it rather than a bare summariser is what routes the run through
  // `runChorePass` below — see the header — and it also means the pacer, the
  // model id, the sample size and every gate come from `wiring.ts` exactly as
  // they do at 05:00, instead of from a second construction here.
  const log = {
    info: (fields: object, message: string) =>
      console.log(JSON.stringify({ level: "info", pass: "summaries", msg: message, ...fields })),
    warn: (fields: object, message: string) =>
      console.warn(JSON.stringify({ level: "warn", pass: "summaries", msg: message, ...fields })),
  };
  const deps = choreDepsFromConfig(config, log, { db });
  const summarizer = deps.summarizer;
  const now = new Date();
  const todayStart = summaryDayBounds(summaryDayKey(now)).from;
  // Defaults: the same window the nightly pass covers, so a bare invocation is
  // "run tonight's pass by hand" rather than "spend the archive" — including
  // its end, which is the start of TODAY rather than `now`. A day is summarised
  // once it has finished (`runSummaryChore` has why).
  const to = day(args, "to", true) ?? todayStart;
  const from =
    day(args, "from") ?? new Date(todayStart.getTime() - config.SUMMARY_WINDOW_DAYS * 86_400_000);
  const rate = args.number("rate", POSITIVE_NUMBER);
  const maxSummaries = args.number("max-summaries", POSITIVE_NUMBER);

  console.log(
    `model: ${
      summarizer.generator
        ? `${config.SUMMARY_MODEL} (live, ${rate ?? config.SUMMARY_MAX_RPM}/min)`
        : "none — no SUMMARY_API_KEY or GEMINI_API_KEY, nothing will be written"
    }`,
  );
  console.log(
    // `to` is exclusive as an instant, so the last day it covers is the one
    // before it — printing the raw key would name a day that is not in scope.
    `window: ${summaryDayKey(from)} .. ${summaryDayKey(new Date(to.getTime() - 1))}` +
      `${storylineId ? `  storyline ${storylineId}` : ""}` +
      `  bar: >${config.SUMMARY_MIN_ARTICLES_PER_DAY} articles and ` +
      `>=${config.SUMMARY_MIN_GROUPS} groups\n`,
  );

  if (args.boolean("dry-run")) {
    await printPlan(db, config, from, to, storylineId, maxSummaries);
    return;
  }

  // **Through `runChorePass`, exactly as the 05:00 firing goes.**
  //
  // This used to take `CHORE_LOCK_KEYS.summaries` by hand and call `summaryPass`
  // directly, which got the lock right and everything around it wrong: a manual
  // preserve left NO `chore_runs` row, so the one pass whose rows nothing can
  // rebuild was the one pass with no durable record that it ran, no
  // `model_calls` against the night it spent them on, and — because the
  // non-UTC `APP_TIMEZONE` warning lives in `runSummaryChore` — no word that
  // the day keys it was writing no longer name the same 24 hours as
  // `storyline_days`. On Hobby's one-hour log retention that record is the only
  // thing that outlives the terminal.
  //
  // The lock is unchanged: `choreLockKey("summaries")` IS
  // `CHORE_LOCK_KEYS.summaries`, so this still contends with the nightly pass
  // for the same reason it always did — both runs read "no row", both call the
  // model, and whichever finishes second writes its verdict over the first, so
  // a contract failure on this side can bury a sentence the nightly pass had
  // just written. (The upsert refuses to null a standing summary as well, which
  // is the belt to that lock's braces.)
  //
  // The knobs below are applied to the configured night as overrides, one run
  // at a time — `wiring.ts`'s rule for exactly this — rather than being a
  // second configuration.
  //
  // **`SUMMARIES_ENABLED` is still not consulted**, which is the one thing the
  // chore path would otherwise impose. Typing this command IS the deliberate act
  // the flag protects, exactly as naming `late-candidates` as a pass runs that
  // sweep regardless of its own gate — so the gate is forced open rather than
  // read.
  deps.summariesEnabled = true;
  deps.summaryWindow = { from, to };
  if (storylineId !== undefined) deps.summaryStorylineId = storylineId;
  if (maxSummaries !== undefined) deps.maxSummaries = maxSummaries;
  if (rate !== undefined) deps.summaryRatePerMinute = rate;
  // One line per ten days, so a long backfill is watchable rather than silent.
  // The nightly pass declares none because nobody is watching it.
  deps.summaryProgress = ({ days, modelCalls }) => {
    if (days % 10 === 0) console.log(`  ${days} days, ${modelCalls} calls`);
  };
  // The budget is the ROUTE's, dropped here for the reason `chores-command.ts`
  // drops it: `SUMMARY_BUDGET_MS` exists to beat a serverless function's 300 s
  // deadline, a terminal has none, and inheriting it would truncate the one run
  // whose whole purpose is to drain a backfill in a single sitting.
  delete deps.summaryBudgetMs;

  const result = await runChorePass("summaries", deps, { source: "cli" });

  if (result.outcome === "skipped") {
    console.error(
      "another summary run holds the lock — nothing was done. The nightly pass " +
        "is at 05:00 UTC; wait for it, or re-run after it finishes.",
    );
    return; // Overlap is expected, exactly as it is for a chore: exit 0.
  }
  if (result.outcome === "failed") {
    console.error(result.error);
    return 1;
  }
  return report(result.report, result.ms);
}

/**
 * The tally, printed for a person — and the run id, which is the new half.
 *
 * `runChorePass` returns the SUMMARIZED report (`summarizeChoreReport`), which
 * for this pass is scalars and passes through untouched. Read defensively
 * anyway: the type is `unknown` because a report is whatever a pass returned,
 * and a printer that assumed otherwise would throw on the shape rather than
 * saying it could not read it.
 */
function report(reported: unknown, ms: number): number | void {
  const tally = reported as (SummaryPassTally & { enabled?: boolean }) | null;
  if (!tally || typeof tally.stoppedBy !== "string") {
    console.log(`\nno tally reported, in ${(ms / 1000).toFixed(1)}s`);
    return;
  }
  console.log(
    `\n${tally.days} days: ${tally.written} written, ${tally.recomputed} rewritten, ` +
      `${tally.refused} refused, ${tally.unavailable} unreachable, ` +
      `${tally.skipped} already current, ${tally.failures} failed`,
  );
  console.log(
    `${tally.model} model calls, stopped by ${tally.stoppedBy}, ` +
      `in ${(ms / 1000).toFixed(1)}s`,
  );
  if (tally.stoppedBy === "no-model") return EXIT_CONFIG;
  return;
}

/**
 * `--dry-run`: the days that qualify and what they would cost.
 *
 * The cost is an UPPER bound — every populated quarter plus the day — because
 * what a day actually costs depends on what is already written, and reading that
 * per day would be the pass without the model calls. An operator sizing a
 * backfill wants the number that cannot surprise them.
 */
async function printPlan(
  db: Kysely<Database>,
  config: Config,
  from: Date,
  to: Date,
  storylineId: string | undefined,
  maxSummaries: number | undefined,
): Promise<void> {
  const candidates = await readSummaryCandidateDays(db, {
    from,
    to,
    minArticlesExclusive: config.SUMMARY_MIN_ARTICLES_PER_DAY,
    minGroups: config.SUMMARY_MIN_GROUPS,
    limit: PLAN_LIMIT,
    ...(storylineId ? { storylineId } : {}),
  });
  for (const candidate of candidates) {
    console.log(
      `  ${candidate.dayKey}  ${String(candidate.articleCount).padStart(3)}a ` +
        `${String(candidate.groupCount).padStart(3)}g  ${candidate.label ?? "—"}`,
    );
  }
  const ceiling = maxSummaries ?? config.SUMMARY_MAX_PER_RUN;
  const upperBound = candidates.length * 5;
  console.log(
    `\n${candidates.length} qualifying storyline-days, at most ` +
      `${upperBound} model calls` +
      // The upper bound alone reads as the cost of ONE run, and it is not:
      // the run stops at the ceiling and the rest waits for the next one.
      (upperBound > ceiling
        ? ` — but this run would stop at ${ceiling} (--max-summaries), so it ` +
          `would take about ${Math.ceil(upperBound / ceiling)} runs`
        : ""),
  );
  // The plan reads ONE page. Saying so beats a silently truncated cost estimate
  // for somebody about to decide whether a backfill is affordable.
  if (candidates.length === PLAN_LIMIT) {
    console.log(
      `(that is the first ${PLAN_LIMIT} only — narrow --from/--to to see the rest)`,
    );
  }
}

/**
 * A day flag as an instant. `end: true` gives the day's END, so `--to` is
 * INCLUSIVE — `--to=2026-08-18` covers the 18th, which is what somebody typing
 * a date means and what the banner prints.
 */
function day(args: Args, name: "from" | "to", end = false): Date | undefined {
  const raw = args.value(name);
  if (raw === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new UsageError(`--${name} must be YYYY-MM-DD (got '${raw}')`);
  }
  const bounds = summaryDayBounds(raw);
  return end ? bounds.to : bounds.from;
}
