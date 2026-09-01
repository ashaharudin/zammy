import type { Config } from "@zammy/config";
import {
  readStorylineSummaries,
  readSummaryCandidateDays,
  summaryDayBounds,
  summaryDayKey,
  type Database,
} from "@zammy/storage";
import type { Kysely } from "kysely";
import { CHORE_LOCK_KEYS, withPassLock } from "./chore-runner.js";
import {
  EXIT_CONFIG,
  POSITIVE_NUMBER,
  UsageError,
  type Args,
  type CommandSpec,
} from "./operator-command.js";
import { summaryPass } from "./storyline-summary-service.js";
import { createSummarizer } from "./wiring.js";

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
  for (const row of rows) {
    const marker = row.segment === "day" ? (row.segmented ? "DAY" : "DAY*") : row.segment;
    console.log(
      `${row.dayKey}  ${marker.padEnd(10)} ${String(row.articleCount).padStart(3)}a  ` +
        (row.summary ?? `— refused after ${row.attempts} attempt(s)`),
    );
  }
  // The asterisk is the one thing a reader of this output has to be told, and
  // it is the difference between "that day had no evening" and "we could not
  // tell when that day's coverage landed".
  console.log("\n* day summarised without segments (past the pubDate cliff)");
}

async function run(
  db: Kysely<Database>,
  config: Config,
  args: Args,
  storylineId: string | undefined,
): Promise<number | void> {
  const summarizer = createSummarizer(config, {
    warn: (fields, message) => console.warn(message, JSON.stringify(fields)),
  });
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
        ? `${config.SUMMARY_MODEL} (live, ${rate ?? config.GEMINI_MAX_RPM}/min)`
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

  const startedAt = Date.now();
  let code: number | undefined;
  // The SAME lock the nightly pass takes, because this writes the same rows.
  //
  // Every other operator CLI in this repo writes state a later pass rebuilds,
  // so overlapping a scheduled run costs duplicated work and nothing else.
  // These rows are the one thing here that nothing rebuilds, and the race is
  // not benign: both runs read "no row", both call the model, and whichever
  // finishes second writes its own verdict over the first — so a contract
  // failure on this side can bury a sentence the nightly pass had just
  // written. (The upsert refuses to null a standing summary as well, which is
  // the belt to this lock's braces.)
  const ran = await withPassLock(db, CHORE_LOCK_KEYS.summaries, async () => {
    code = (await runPass({
      db,
      config,
      summarizer,
      from,
      to,
      startedAt,
      storylineId,
      rate,
      maxSummaries,
    })) as number | undefined;
  });
  if (!ran) {
    console.error(
      "another summary run holds the lock — nothing was done. The nightly pass " +
        "is at 05:00 UTC; wait for it, or re-run after it finishes.",
    );
    return; // Overlap is expected, exactly as it is for a chore: exit 0.
  }
  return code;
}

async function runPass(input: {
  db: Kysely<Database>;
  config: Config;
  summarizer: ReturnType<typeof createSummarizer>;
  from: Date;
  to: Date;
  startedAt: number;
  storylineId: string | undefined;
  rate: number | undefined;
  maxSummaries: number | undefined;
}): Promise<number | void> {
  const { db, config, from, to, startedAt, storylineId } = input;
  const tally = await summaryPass(
    { db, ...input.summarizer },
    {
      from,
      to,
      minArticlesExclusive: config.SUMMARY_MIN_ARTICLES_PER_DAY,
      minGroups: config.SUMMARY_MIN_GROUPS,
      maxSummaries: input.maxSummaries ?? config.SUMMARY_MAX_PER_RUN,
      ratePerMinute: input.rate ?? config.GEMINI_MAX_RPM,
      ...(storylineId ? { storylineId } : {}),
      onProgress: ({ days, modelCalls }) => {
        // One line per day, so a long backfill is watchable rather than silent.
        if (days % 10 === 0) console.log(`  ${days} days, ${modelCalls} calls`);
      },
    },
  );

  console.log(
    `\n${tally.days} days: ${tally.written} written, ${tally.recomputed} rewritten, ` +
      `${tally.refused} refused, ${tally.unavailable} unreachable, ` +
      `${tally.skipped} already current, ${tally.failures} failed`,
  );
  console.log(
    `${tally.model} model calls, stopped by ${tally.stoppedBy}, ` +
      `in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
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
