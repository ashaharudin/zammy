import type { Kysely } from "kysely";
import {
  readArcDaysAwaitingSummary,
  resolveStoryline,
  summaryDayBounds,
  summaryDayKey,
  type Database,
  type SummaryCandidateDay,
} from "@zammy/storage";
import { summarizeJob, type IngestQueue, type SummarizeJob } from "./ingest-queue.js";
import {
  summarizeStorylineDay,
  type CallGate,
  type SummarizerDeps,
} from "./storyline-summary-service.js";

/**
 * THE CLICK PLANE (ADR-0027): opening a storyline submits its unsummarised days
 * for a sentence.
 *
 * Planner and consumer in one file, the same way `storyline-deepening.ts` keeps
 * its two halves together and for the same reason — the gate the planner applies
 * is the gate the consumer re-applies, and splitting them would put a module
 * edge through one argument. Here the split is even more lopsided: the planner
 * decides almost nothing (`queueStorylineSummaries` resolves an alias, checks a
 * flag and enqueues), because everything that could go stale between the click
 * and the work is deliberately decided at the far end.
 *
 * **Why a click is allowed to spend model calls at all.** ADR-0017 established
 * that opening a storyline is a real demand signal and may queue an upstream
 * fetch; this is the same signal spending a different budget. What made it
 * affordable is ADR-0027's other half: a day cost up to five model calls under
 * the six-hour quarters and costs exactly one now, so a reader's whole click
 * costs about what a single day used to.
 *
 * **What this plane deliberately cannot do** — and each of these is a way it
 * could have quietly become expensive:
 *
 *  - **It only ever writes days that have NO sentence.** No retry of a refusal,
 *    no recompute of a day that gained articles. Both belong to the nightly
 *    pass, which knows how many attempts a span has left; a reader can click as
 *    often as they like, and three clicks would otherwise retire every refused
 *    day of an arc for ever. `SummarizerDeps.onlyMissing` is that rule.
 *  - **It plans no window.** The nightly window bounds unattended spend across
 *    every arc. A click is one reader asking about one arc, so it reaches the
 *    arc's whole history and is bounded by a call count instead.
 *  - **It excludes today**, exactly as the nightly pass does: a day is
 *    summarised once it has finished, or the sentence describes a fraction of
 *    its own span and then freezes.
 */

export interface StorylineSummaryJobDeps {
  db: Kysely<Database>;
  /** Only `enqueueSummarize`: one click, one job, nothing else. */
  queue: Pick<IngestQueue, "enqueueSummarize">;
  /**
   * `SUMMARIES_ENABLED`. The flag exists so the feature writes nothing
   * unattended before an operator turns it on, and a click is no more attended
   * than the cron is — the reader did not ask for a model call, they asked for a
   * storyline.
   */
  enabled: boolean;
  now: () => Date;
  log?: {
    info?(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
}

export type StorylineSummaryOutcome =
  | { status: "unknown" }
  /**
   * `SUMMARIES_ENABLED` is false. Nothing queued, nothing spent — and nothing
   * READ either, so there is no id to report: the flag is checked before the
   * alias resolution, on a path every storyline open takes.
   */
  | { status: "disabled" }
  | { status: "queued"; storylineId: string; job: SummarizeJob };

/**
 * Queue one arc's summary work. The request-path half, and it makes no model
 * call and reads no candidate.
 *
 * **It does not check whether there is anything to do**, which is the one
 * decision here worth defending. Asking "does this arc have unsummarised days?"
 * on the request path would put the plane's real query — a grouped scan over the
 * arc's whole history — on a fire-and-forget POST that a reader is waiting
 * behind, to save a Redis publish. The consumer plans against the rows as they
 * stand when it runs, which is later and therefore more correct anyway, and an
 * arc with nothing to do costs one delivery and two queries there.
 *
 * The job's identity is the arc alone, so a storyline several readers open in
 * the same window is one job (`ingestJobId`).
 */
export async function queueStorylineSummaries(
  deps: StorylineSummaryJobDeps,
  input: { storylineId: string },
): Promise<StorylineSummaryOutcome> {
  // The flag BEFORE the query, so a deployment with the feature off pays nothing
  // on a path every storyline open takes. It costs the `disabled` outcome its
  // resolved id, which no caller uses — the route logs the status and reports it.
  if (!deps.enabled) return { status: "disabled" };

  // Forward, to the winner. The preserve never follows a merge — its rows stay
  // on the id they were written for — but the WORK belongs to the arc a reader
  // is actually looking at, and `readArcDaysAwaitingSummary` walks back down the
  // chain to see what that arc already has.
  const storylineId = await resolveStoryline(deps.db, input.storylineId);
  if (storylineId === null) return { status: "unknown" };

  // Snapped onto the minute grid: readers opening one arc together cost one job,
  // and the next minute's click is a different message rather than one the
  // transport's dedup window swallows. `SummarizeJob` has the measurement.
  const job = summarizeJob(storylineId, deps.now());
  await deps.queue.enqueueSummarize(job);
  return { status: "queued", storylineId, job };
}

/** What one click's job cost and produced. */
export interface SummarizeJobTally {
  /** Days the plan found. Zero is the common case on a warm arc. */
  planned: number;
  written: number;
  refused: number;
  unavailable: number;
  skipped: number;
  /** Model calls spent. One per day asked. */
  model: number;
  /** Days whose processing threw. One day's failure never fails the job. */
  failures: number;
  stoppedBy: "exhausted" | "max-days" | "budget" | "no-model" | "disabled";
}

export interface SummarizeJobDeps {
  db: Kysely<Database>;
  /** The same summariser the nightly pass uses, with `onlyMissing` forced on. */
  summarizer: Omit<SummarizerDeps, "db" | "onlyMissing">;
  enabled: boolean;
  gate: {
    minArticlesExclusive: number;
    minGroups: number;
  };
  /** `SUMMARY_CLICK_MAX_DAYS`. */
  maxDays: number;
  /** `SUMMARY_CLICK_BUDGET_MS`. */
  budgetMs: number;
  /** Calls per minute, shared with everything else on this key. */
  ratePerMinute: number;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: {
    info?(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
}

/**
 * Run one click's summary job: plan the arc's unsummarised days, then write as
 * many as the bound allows.
 *
 * **This is not `summaryPass` scoped to one arc, and the difference is the
 * point.** That pass discovers work by walking a window across every arc with a
 * keyset, in two phases, because it is draining a backlog under a night's
 * budget. This has one arc and one question — which of its days have no
 * sentence — and `readArcDaysAwaitingSummary` answers it in a single query. A
 * walk here would read every summarised day of the arc to be told to skip it.
 *
 * **It takes no advisory lock, and that is a considered position rather than an
 * omission.** The nightly pass takes `CHORE_LOCK_KEYS.summaries` because two
 * full passes deciding independently what a span should say, with the loser
 * overwriting the winner, is not a race worth having. This job cannot enter that
 * race in the damaging direction:
 *
 *  - it only writes days with NO row, so the sentence it could overwrite does
 *    not exist when it plans;
 *  - `writeStorylineDaySummary` will not let a null summary replace one that
 *    stands, in SQL, which is the one unrecoverable outcome;
 *  - the worst real collision is the nightly pass and a click both writing a
 *    first sentence for the same day, which costs one duplicate model call and
 *    leaves a valid sentence either way.
 *
 * Taking the global lock instead would mean every click during a five-minute
 * nightly pass is dropped, and taking a per-arc lock would add a Redis
 * round-trip to prevent a collision the queue's own dedup already makes rare
 * (one job per arc while one is outstanding).
 */
export async function runSummarizeJob(
  deps: SummarizeJobDeps,
  job: SummarizeJob,
): Promise<SummarizeJobTally> {
  const tally: SummarizeJobTally = {
    planned: 0,
    written: 0,
    refused: 0,
    unavailable: 0,
    skipped: 0,
    model: 0,
    failures: 0,
    stoppedBy: "exhausted",
  };

  // Both are supported states rather than faults, and both are silent: the
  // caller is a queue consumer acting on a reader's click, and there is nobody
  // to tell.
  if (!deps.enabled) {
    tally.stoppedBy = "disabled";
    return tally;
  }
  if (deps.summarizer.generator === null) {
    tally.stoppedBy = "no-model";
    return tally;
  }
  if (deps.maxDays <= 0) {
    tally.stoppedBy = "max-days";
    return tally;
  }

  const now = deps.now;
  const startedAt = now().getTime();
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const spacingMs = deps.ratePerMinute > 0 ? Math.ceil(60_000 / deps.ratePerMinute) : 0;

  // Today is excluded, for the nightly pass's reason: a day is summarised once
  // it has finished, and a sentence written over a fraction of a day then
  // freezes describing that fraction. `summaryDayBounds` of today's key gives
  // the instant today started, which is the exclusive upper bound on `published`.
  const before = summaryDayBounds(summaryDayKey(now())).from;

  // **`maxDays + 1`, and the extra row is the whole reason.** Asking for exactly
  // the bound makes a job that fills it indistinguishable from one that drained
  // the arc: both walk every candidate and end normally, and `stoppedBy` would
  // read `exhausted` on a cold arc with thirty days still owed. One more row
  // costs nothing and turns that into the honest `max-days` — which is the
  // difference the log line exists to show, and the signal that a reader's next
  // open has something to do.
  const planned = await readArcDaysAwaitingSummary(deps.db, {
    storylineId: job.storylineId,
    minArticlesExclusive: deps.gate.minArticlesExclusive,
    minGroups: deps.gate.minGroups,
    limit: deps.maxDays + 1,
    before,
  });
  const more = planned.length > deps.maxDays;
  const candidates = more ? planned.slice(0, deps.maxDays) : planned;
  // What this job will WORK on, not what the arc owes — `more` says there is
  // an unknown amount beyond it.
  tally.planned = candidates.length;
  if (candidates.length === 0) return tally;
  if (more) tally.stoppedBy = "max-days";

  let lastCallStartedAt: number | null = null;
  const pastDeadline = (): boolean => now().getTime() - startedAt >= deps.budgetMs;

  /**
   * The same gate shape the nightly pass builds, with the night's reasons
   * removed: there is no consecutive-unavailable circuit breaker here, because
   * the ceiling is eight calls and a breaker that trips at five would save four.
   *
   * The spacing is measured from one call's START, not from its return — the
   * distinction the nightly pass measured its way into. Sleeping a full interval
   * after each answer runs at `60000 / (spacing + latency)`, which is not the
   * rate anybody configured.
   */
  const gate: CallGate = {
    async before(): Promise<string | null> {
      if (pastDeadline()) return "budget";
      if (tally.model >= deps.maxDays) return "max-days";

      if (lastCallStartedAt !== null && spacingMs > 0) {
        const wait = lastCallStartedAt + spacingMs - now().getTime();
        if (wait > 0) await sleep(wait);
        if (pastDeadline()) return "budget";
      }

      lastCallStartedAt = now().getTime();
      tally.model += 1;
      return null;
    },
  };

  // **The deadline the PLATFORM enforces, as an abort the model call can hear.**
  //
  // `budgetMs` stops this job ADMITTING calls and cannot stop one already in
  // flight: that call runs to `GEMINI_TIMEOUT_MS` (20 s) times `maxRetries + 1`
  // (3) plus backoff, up to 60.75 s past the deadline. `runSummaryChore` arms
  // exactly this for the nightly pass and writes down the arithmetic; this plane
  // shipped without it, which left a 120 s job with a ~181 s worst case.
  //
  // Survivable on the queue consumer's 300 s, and NOT survivable on
  // `api/drain.ts`, which checks its own deadline only BETWEEN jobs — a
  // summarize job it dispatched late would run past the function's ceiling and
  // take every later entry's settle down with it.
  //
  // An abort costs the preserve nothing: it surfaces as `unreachable`, which
  // writes no row and spends no attempt, and the next open re-plans the day.
  const controller = new AbortController();
  const deadlineTimer = setTimeout(
    () => controller.abort(),
    deps.budgetMs + SUMMARIZE_ABORT_GRACE_MS,
  );
  // Never the reason this process stays alive.
  deadlineTimer.unref?.();

  const summarizer: SummarizerDeps = {
    db: deps.db,
    ...deps.summarizer,
    now,
    signal: controller.signal,
    // The whole of what makes this plane safe to hand a reader. See the type.
    onlyMissing: true,
  };

  try {
    for (const candidate of candidates) {
      if (pastDeadline()) {
        tally.stoppedBy = "budget";
        break;
      }
      if (tally.model >= deps.maxDays) {
        tally.stoppedBy = "max-days";
        break;
      }

      let outcome;
      try {
        outcome = await summarizeStorylineDay(summarizer, candidate, gate);
      } catch (error) {
        // One day's failure never fails the job, exactly as it never fails the
        // nightly pass: a day this run could not summarise has no row, so the next
        // click's plan selects it again.
        tally.failures += 1;
        deps.log?.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            storylineId: candidate.storylineId,
            dayKey: candidate.dayKey,
          },
          "summarize job: one storyline-day failed",
        );
        continue;
      }

      tally.written += outcome.written;
      tally.refused += outcome.refused;
      tally.unavailable += outcome.unavailable;
      tally.skipped += outcome.skipped;

      if (outcome.stoppedBy !== undefined) {
        tally.stoppedBy = outcome.stoppedBy === "budget" ? "budget" : "max-days";
        break;
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
  }

  return tally;
}

/**
 * How long past `budgetMs` an in-flight call is allowed before it is aborted.
 *
 * The nightly pass's `SUMMARY_ABORT_GRACE_MS` by another name and for the same
 * reason: the budget bounds when a call is ADMITTED, and the grace is what turns
 * "we stopped asking" into "the last ask is over".
 */
const SUMMARIZE_ABORT_GRACE_MS = 10_000;

/** The consumer's entry point, as `ingestDispatch` calls it. */
export async function processSummarizeJob(
  deps: SummarizeJobDeps,
  job: SummarizeJob,
): Promise<void> {
  const tally = await runSummarizeJob(deps, job);
  // One line per delivered job, because nothing else reports this plane: it
  // writes no article, touches no coverage row and answers no request. How to
  // read it — `planned` high with `written` low and `stoppedBy: "max-days"` is a
  // cold arc draining over several opens, which is the design; `unavailable`
  // dominating is the key refusing, and costs nothing because an unreachable ask
  // writes no row; `planned: 0` on most lines is a warm archive, which is what
  // this should look like once the arcs readers open have been summarised.
  deps.log?.info?.(
    { storyline: job.storylineId, ...tally },
    "storyline open: what the click's summary job wrote (ADR-0027)",
  );
}

/** Re-exported for the route, which reports the planner's answer. */
export type { SummarizeJob };

/** Narrow a candidate list for tests and the CLI's dry run. */
export type { SummaryCandidateDay };
