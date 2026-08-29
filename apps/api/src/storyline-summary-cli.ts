import { loadConfig } from "@zammy/config";
import {
  readStorylineSummaries,
  readSummaryCandidateDays,
  summaryDayBounds,
  summaryDayKey,
} from "@zammy/storage";
import { summaryPass } from "./storyline-summary-service.js";
import { createConfiguredDb, createSummarizer } from "./wiring.js";

/**
 * `pnpm summaries:storylines [--storyline=UUID] [--from=YYYY-MM-DD]
 * [--to=YYYY-MM-DD] [--max-summaries=N] [--rate=N] [--dry-run] [--show]` — the
 * operator half of the historical preserve (ADR-0022,
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
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const dryRun = args.includes("--dry-run");
const show = args.includes("--show");

const num = (name: string): number | undefined => {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`--${name} must be a positive number (got '${raw}')`);
    process.exit(64);
  }
  return value;
};

const day = (name: string): Date | undefined => {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    console.error(`--${name} must be YYYY-MM-DD (got '${raw}')`);
    process.exit(64);
  }
  return summaryDayBounds(raw).from;
};

const storylineId = flag("storyline");
if (storylineId !== undefined && !/^[0-9a-f-]{36}$/i.test(storylineId)) {
  console.error(`--storyline must be a storyline UUID (got '${storylineId}')`);
  process.exit(64);
}

const config = loadConfig();
const db = createConfiguredDb(config);

try {
  if (show) await printSummaries();
  else await run();
} finally {
  await db.destroy();
}

/** `--show`: what is already preserved for one arc. A read, no model, no cost. */
async function printSummaries(): Promise<void> {
  if (storylineId === undefined) {
    console.error("--show needs --storyline=UUID");
    process.exitCode = 64;
    return;
  }
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

async function run(): Promise<void> {
  const summarizer = createSummarizer(config, {
    warn: (fields, message) => console.warn(message, JSON.stringify(fields)),
  });
  const now = new Date();
  // Defaults: the same window the nightly pass covers, so a bare invocation is
  // "run tonight's pass by hand" rather than "spend the archive".
  const to = day("to") ?? now;
  const from =
    day("from") ??
    new Date(
      summaryDayBounds(summaryDayKey(now)).from.getTime() -
        config.SUMMARY_WINDOW_DAYS * 86_400_000,
    );

  console.log(
    `model: ${
      summarizer.generator
        ? `${config.SUMMARY_MODEL} (live, ${num("rate") ?? config.GEMINI_MAX_RPM}/min)`
        : "none — no SUMMARY_API_KEY or GEMINI_API_KEY, nothing will be written"
    }`,
  );
  console.log(
    `window: ${summaryDayKey(from)} .. ${summaryDayKey(to)}` +
      `${storylineId ? `  storyline ${storylineId}` : ""}` +
      `  bar: >${config.SUMMARY_MIN_ARTICLES_PER_DAY} articles and ` +
      `>=${config.SUMMARY_MIN_GROUPS} groups\n`,
  );

  if (dryRun) {
    await printPlan(from, to);
    return;
  }

  const startedAt = Date.now();
  const tally = await summaryPass(
    { db, ...summarizer },
    {
      from,
      to,
      minArticlesExclusive: config.SUMMARY_MIN_ARTICLES_PER_DAY,
      minGroups: config.SUMMARY_MIN_GROUPS,
      maxSummaries: num("max-summaries") ?? config.SUMMARY_MAX_PER_RUN,
      ratePerMinute: num("rate") ?? config.GEMINI_MAX_RPM,
      ...(storylineId ? { storylineId } : {}),
      onProgress: ({ days, modelCalls }) => {
        // One line per day, so a long backfill is watchable rather than silent.
        if (days % 10 === 0) console.log(`  ${days} days, ${modelCalls} calls`);
      },
    },
  );

  console.log(
    `\n${tally.days} days: ${tally.written} written, ${tally.recomputed} rewritten, ` +
      `${tally.refused} refused, ${tally.skipped} already current, ` +
      `${tally.failures} failed`,
  );
  console.log(
    `${tally.model} model calls, stopped by ${tally.stoppedBy}, ` +
      `in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  if (tally.stoppedBy === "no-model") process.exitCode = 78; // EX_CONFIG
}

/**
 * `--dry-run`: the days that qualify and what they would cost.
 *
 * The cost is an UPPER bound — every populated quarter plus the day — because
 * what a day actually costs depends on what is already written, and reading that
 * per day would be the pass without the model calls. An operator sizing a
 * backfill wants the number that cannot surprise them.
 */
async function printPlan(from: Date, to: Date): Promise<void> {
  const candidates = await readSummaryCandidateDays(db, {
    from,
    to,
    minArticlesExclusive: config.SUMMARY_MIN_ARTICLES_PER_DAY,
    minGroups: config.SUMMARY_MIN_GROUPS,
    limit: 5_000,
    ...(storylineId ? { storylineId } : {}),
  });
  for (const candidate of candidates) {
    console.log(
      `  ${candidate.dayKey}  ${String(candidate.articleCount).padStart(3)}a ` +
        `${String(candidate.groupCount).padStart(3)}g  ${candidate.label ?? "—"}`,
    );
  }
  console.log(
    `\n${candidates.length} qualifying storyline-days, at most ` +
      `${candidates.length * 5} model calls`,
  );
}
