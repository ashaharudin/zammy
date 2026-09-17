import type { Kysely } from "kysely";
import {
  bumpSummaryAttempts,
  readStorylineDayArticles,
  readSummaryCandidateDays,
  readStorylineDaySummaries,
  summaryDayBounds,
  writeStorylineDaySummary,
  type Database,
  type StoredSummary,
  type SummaryCandidateDay,
  type SummarySegment,
} from "@zammy/storage";
import type { TextGenerator } from "./gemini.js";
import { buildDaySummaryPrompt, validateSummary, SUMMARY_MAX_CHARS } from "./storyline-summary.js";

/**
 * The summariser's service half (ADR-0023, amended by ADR-0027): read the day,
 * ask the model ONCE, and write what comes back.
 *
 * It used to ask once per populated six-hour quarter and then once more over
 * those four sentences — five calls for a day with coverage round the clock.
 * ADR-0027 removed the quarters: nothing ever read them, and a day is now one
 * sentence over its own articles. What that buys is a factor of five on the
 * cost of a day, which is what makes the click plane in
 * `storyline-summary-job.ts` affordable at all.
 *
 * `storyline-label-service.ts` is the shape this follows, and the one place it
 * deliberately diverges is failure — a label falls back to the bigram
 * extractor, and prose has no such fallback, so a refusal here is a row that
 * says so rather than a worse sentence.
 */

export interface SummarizerDeps {
  db: Kysely<Database>;
  /** Null with no key configured: the pass writes nothing and says so. */
  generator: TextGenerator | null;
  /** Recorded on every row — `SUMMARY_MODEL`, or null with no generator. */
  modelId: string | null;
  /**
   * Articles that reach the prompt. A DAY's worth since ADR-0027, where it was
   * a quarter's — see `SUMMARY_DAY_SAMPLE` for why the number moved with it.
   */
  sampleSize: number;
  /** Asks one span gets before it is retired. */
  maxAttempts: number;
  /** Days after a day closes during which it may still be rewritten. */
  settlingDays: number;
  /** Articles a span must GAIN before a rewrite is worth a model call. */
  recomputeDelta: number;
  /**
   * Write days that have NO sentence, and nothing else — no retry of a refusal,
   * no recompute of a day that gained articles.
   *
   * The click plane's setting (ADR-0027), and it is a dep rather than a pass
   * option because it narrows what a DAY may do, which is this module's
   * question and not the walk's.
   *
   * Why a click must not retry: a refusal is bounded by `SUMMARY_MAX_ATTEMPTS`
   * (3), and a reader can open an arc as often as they like. Three opens would
   * retire every refused day of that arc for ever, on the one table nothing can
   * rebuild — an anonymous POST spending a budget that exists to be spent
   * slowly, by a pass that knows how many nights it has left.
   */
  onlyMissing?: boolean;
  /**
   * The caller's abort, threaded into the model call itself.
   *
   * The pass checks its own signal before admitting a call, which stops it
   * starting new work — but a call already in flight would otherwise run out
   * the full `GEMINI_TIMEOUT_MS` and its retries after the caller has given up.
   */
  signal?: AbortSignal;
  now?: () => Date;
  logger?: {
    warn(fields: Record<string, unknown>, message: string): void;
    debug?(fields: Record<string, unknown>, message: string): void;
  };
}

/**
 * Permission to make one model call, asked immediately before each one.
 *
 * The pass owns every reason to stop — the abort signal, the wall clock, the
 * night's ceiling — and it owns the spacing between calls, so it is the pass
 * that answers this rather than the day summariser knowing about any of them. A
 * non-null answer is the reason, and it stops the day where it stands: what has
 * been written is written, and the next run picks the rest up because its own
 * decision reads the rows.
 */
export interface CallGate {
  before(): Promise<string | null>;
  /**
   * What the call it just admitted produced. The pass uses it to notice a run
   * of unreachable asks and stop, which is a decision about the NIGHT rather
   * than about any span — so it belongs here beside the other reasons to stop,
   * and not in the day summariser.
   */
  after?(kind: "answered" | "unavailable"): void;
}

/**
 * What one storyline-day cost and produced.
 *
 * Every counter here is now at most 1 — a day is one span (ADR-0027). They stay
 * counters rather than a verdict because the PASS sums them across days, and a
 * tally that can say "17 written, 3 refused, 1 unavailable" is the report an
 * operator reads.
 */
export interface DaySummaryOutcome {
  storylineId: string;
  dayKey: string;
  /** Rows written for the first time. */
  written: number;
  /** Rows rewritten because their span gained articles inside the window. */
  recomputed: number;
  /**
   * Asks the model ANSWERED and whose answer was unusable. These cost an
   * attempt, because three of them is a span the model will not describe.
   */
  refused: number;
  /**
   * Asks that never reached an answer — a timeout, a 5xx, a 429, or the pacer
   * refusing to queue any longer.
   *
   * Counted apart from `refused` and, crucially, costing NO attempt. Collapsing
   * the two is how an outage retires a span for ever: three nights of 429s
   * would take every span in the window to `maxAttempts` without the model
   * having declined a single one, and the days would then age out of the
   * window unwritten. "The model will not describe this" and "we could not ask"
   * are different facts and only the first is about the span.
   */
  unavailable: number;
  /** Days that needed no ask. */
  skipped: number;
  /** Model calls made. Every ask, including a retry of an earlier refusal. */
  modelCalls: number;
  /** Set when the gate stopped this day early. */
  stoppedBy?: string;
}

const EMPTY = (storylineId: string, dayKey: string): DaySummaryOutcome => ({
  storylineId,
  dayKey,
  written: 0,
  recomputed: 0,
  refused: 0,
  unavailable: 0,
  skipped: 0,
  modelCalls: 0,
});

/**
 * What one ask produced. Three outcomes, not two — see `DaySummaryOutcome`'s
 * `unavailable` for why the last two must not be one.
 */
type AskResult =
  | { kind: "sentence"; text: string }
  | { kind: "refused"; reason: string }
  | { kind: "unavailable"; reason: string };

/** What to do about one span, given what stands and what is there now. */
type SpanDecision = "write" | "retry" | "recompute" | "skip";

/**
 * The whole mutability rule, in one place.
 *
 *  - **No row → write.** A FIRST write is always allowed, however old the day
 *    is. A story that builds slowly and only clears the gate on its fourth day
 *    would otherwise be excluded from the preserve for ever, which is the
 *    opposite of what the preserve is for.
 *  - **Refused → retry**, until `maxAttempts`. A refusal has never produced a
 *    sentence, so retrying it is closer to a first write than to a rewrite, and
 *    it is bounded by the attempt count rather than by the window.
 *  - **Written, inside the settling window, and the span gained more than
 *    `recomputeDelta` articles → recompute.** Two conditions, ANDed: the window
 *    says when a day is still open to revision, the delta says whether the
 *    change was worth a model call. A day past the window is frozen, which is
 *    what makes it a preserve and what keeps the nightly pass reading three
 *    days of history rather than all of it.
 *  - Anything else → skip, at the cost of one read and nothing else.
 *
 * A fifth rule sat between the third and the fourth until ADR-0027: a day whose
 * quarters had just been rewritten was stale whatever its own count did, and it
 * had to outrank the freeze. There are no quarters, so there is no such day.
 */
export function decideSpan(input: {
  existing: StoredSummary | undefined;
  articleCount: number;
  withinSettlingWindow: boolean;
  recomputeDelta: number;
  maxAttempts: number;
  /** Only a day with no row at all may be written. See `SummarizerDeps.onlyMissing`. */
  onlyMissing?: boolean;
}): SpanDecision {
  const { existing, maxAttempts } = input;
  if (existing === undefined) return "write";
  // Before every other clause, because it is not a judgement about this span —
  // it is a statement about who is asking. A caller in `onlyMissing` mode is
  // buying first writes and nothing else, so a row of any kind ends it here.
  if (input.onlyMissing === true) return "skip";
  // One cap over both kinds of ask. Three refusals on one span is a strong
  // enough signal to stop paying for it — and an operator who disagrees can
  // clear the row, which is the deliberate act this refuses to make automatic.
  if (existing.attempts >= maxAttempts) return "skip";
  if (existing.summary === null) return "retry";
  if (!input.withinSettlingWindow) return "skip";
  return input.articleCount - existing.articleCount > input.recomputeDelta
    ? "recompute"
    : "skip";
}

/**
 * Summarise one storyline-day: at most ONE model call (ADR-0027).
 *
 * There used to be a second function under this one — `summarizeDay`, which
 * wrote the fifth sentence over the other four — and with it a whole mechanism
 * for keeping a day consistent with quarters that had moved underneath it
 * (`forceRecompute`, `quartersRewritten`, `quartersOutranTheDay`). None of that
 * survives the quarters, and none of it is missed: a day built from its own
 * articles cannot disagree with anything.
 *
 * The decision is taken on the candidate's OWN article count rather than on a
 * fresh read, which is what makes a skip cost nothing: the gate that selected
 * this day already counted it, and the sample is only read when there is going
 * to be an ask.
 */
export async function summarizeStorylineDay(
  deps: SummarizerDeps,
  candidate: SummaryCandidateDay,
  gate?: CallGate,
): Promise<DaySummaryOutcome> {
  const outcome = EMPTY(candidate.storylineId, candidate.dayKey);
  if (deps.generator === null) return outcome;

  const now = (deps.now ?? (() => new Date()))();
  const { to } = summaryDayBounds(candidate.dayKey);
  // Age from the day's END: a day that closed an hour ago is hours old, not a
  // day old, and the window is about how settled the day's article set is.
  const ageDays = (now.getTime() - to.getTime()) / 86_400_000;
  const withinSettlingWindow = ageDays < deps.settlingDays;

  const rows = await readStorylineDaySummaries(deps.db, candidate);
  const existing = rows.find((row) => row.segment === "day");

  const decision = decideSpan({
    existing,
    articleCount: candidate.articleCount,
    withinSettlingWindow,
    recomputeDelta: deps.recomputeDelta,
    maxAttempts: deps.maxAttempts,
    ...(deps.onlyMissing === true ? { onlyMissing: true } : {}),
  });
  if (decision === "skip") {
    outcome.skipped += 1;
    return outcome;
  }

  const day = await readStorylineDayArticles(deps.db, {
    storylineId: candidate.storylineId,
    dayKey: candidate.dayKey,
    sampleSize: deps.sampleSize,
  });
  // The gate counted this day and the sample read found nothing, which means
  // the day's articles went away between the two — retention, or a regroup. It
  // is not a span the model can say anything about.
  if (day.articleCount === 0) {
    outcome.skipped += 1;
    return outcome;
  }

  const stop = await gate?.before();
  if (stop) {
    outcome.stoppedBy = stop;
    return outcome;
  }

  const result = await ask(
    deps,
    buildDaySummaryPrompt({
      label: candidate.label,
      dayKey: candidate.dayKey,
      members: day.members,
    }),
    outcome,
    existing?.attempts ?? 0,
  );
  gate?.after?.(result.kind === "unavailable" ? "unavailable" : "answered");

  await record(deps, {
    candidate,
    segment: "day",
    existing,
    // The count the SAMPLE read saw, not the gate's. They are the same query in
    // different words and will normally agree; when they do not, the one that
    // describes what the model was actually shown is the one the recompute
    // trigger must compare against.
    articleCount: day.articleCount,
    // **Carried forward, never re-derived.** This column says whether a day's
    // coverage could be placed in time, which under ADR-0027 nothing new can
    // claim — so a first write is `false` and a rewrite keeps whatever the row
    // already said. Writing `false` onto a day that has four quarter sentences
    // sitting beside it would make the one column whose whole job is to not lie
    // about the past start lying about it.
    segmented: existing?.segmented ?? false,
    result,
    now,
    outcome,
    decision,
  });

  return outcome;
}

/**
 * One model call, validated.
 *
 * The distinction it draws is the important part. `generate` returns `ok:
 * false` for a 429, a 503, a network fault, a timeout AND for the pacer's own
 * "I will not queue you that long" — none of which is the model saying
 * anything about this span. Only an answer that fails the contract is a
 * REFUSAL, and only a refusal costs an attempt.
 */
async function ask(
  deps: SummarizerDeps,
  prompt: string,
  outcome: DaySummaryOutcome,
  /** Asks already spent on this span. 0 on a first write. */
  attempt: number,
): Promise<AskResult> {
  // Counted here, at the ask, so the number means "what did this cost" — a
  // retry of an earlier refusal counts, because it is another call. The
  // client's OWN retries (a 503, a 429 it waited out) are invisible from here
  // and are not in this number.
  outcome.modelCalls += 1;
  const result = await deps.generator!.generate({
    prompt,
    // **A retry at temperature 0 is a replay.** Measured against the live model
    // on 2026-08-29: three of 45 answers failed the contract, and the one that
    // was re-asked came back byte-identical and 241 characters long again —
    // one over the cap. The whole retry budget would be spent re-reading the
    // same refusal, and the span retired for a sentence the model could easily
    // have written shorter.
    //
    // So the FIRST ask stays deterministic, because a replay of the same
    // coverage should name the same day; a retry deliberately does not, because
    // its purpose is a different sample rather than the same one.
    ...(attempt > 0 ? { temperature: RETRY_TEMPERATURE } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (!result.ok) {
    // `failure`, never the reason string: the client knows which of the two
    // happened and the reason is prose for a log line. A safety block and a
    // candidate that answered nothing ARE the model's verdict on this prompt
    // and cost an attempt; everything else is an outage and costs nothing.
    return result.failure === "answered"
      ? { kind: "refused", reason: result.reason }
      : { kind: "unavailable", reason: result.reason };
  }

  const validated = validateSummary(result.text);
  if (validated === null) {
    // The raw text is kept, bounded, for the same reason the labeler keeps it:
    // the prompt iterates on live output, and the answers it REFUSES are the
    // only evidence of which way to iterate.
    // Sliced past the CAP, not under it. At 120 characters every refusal looked
    // identical — a sentence cut off mid-word — and the line could not say
    // which clause of the contract failed: a 300-character answer and a
    // two-sentence one are indistinguishable from their first 120 characters.
    // The prompt is expected to iterate on live output (ADR-0023), and these
    // are the only evidence of which way to iterate, so the whole rejected
    // answer goes in the line.
    deps.logger?.warn(
      { text: result.text.slice(0, SUMMARY_MAX_CHARS + 60), length: result.text.length },
      "summary failed the one-sentence contract",
    );
    return { kind: "refused", reason: `contract: ${result.text.slice(0, 80)}` };
  }
  return { kind: "sentence", text: validated };
}

/**
 * Write the outcome of one ask.
 *
 * The one rule worth stating: **a failed ask never replaces a sentence that
 * stands.** A recompute that the model refuses leaves the older, shorter-lived
 * sentence in place and only bumps the attempt count — the alternative is a
 * preserve that loses history because the model was unavailable on the night a
 * late article arrived.
 */
async function record(
  deps: SummarizerDeps,
  input: {
    candidate: SummaryCandidateDay;
    segment: SummarySegment;
    existing: StoredSummary | undefined;
    articleCount: number;
    segmented: boolean;
    result: AskResult;
    now: Date;
    outcome: DaySummaryOutcome;
    decision: SpanDecision;
  },
): Promise<void> {
  const { candidate, segment, existing, result } = input;

  // Nothing was learned about this span, so nothing about it is written — not
  // even an attempt. The next run selects it again and asks again.
  if (result.kind === "unavailable") {
    input.outcome.unavailable += 1;
    deps.logger?.debug?.(
      { storylineId: candidate.storylineId, dayKey: candidate.dayKey, segment,
        reason: result.reason },
      "summary: could not reach the model; the span stands where it stood",
    );
    return;
  }

  const text = result.kind === "sentence" ? result.text : null;

  if (text === null) {
    input.outcome.refused += 1;
    if (existing?.summary != null) {
      await bumpSummaryAttempts(deps.db, {
        storylineId: candidate.storylineId,
        dayKey: candidate.dayKey,
        segment,
      });
      return;
    }
  }

  await writeStorylineDaySummary(deps.db, {
    storylineId: candidate.storylineId,
    dayKey: candidate.dayKey,
    segment,
    summary: text,
    articleCount: input.articleCount,
    // The label AS IT READS NOW, copied onto the row: labels drift by design,
    // and reading the live one back later would re-caption the past.
    label: candidate.label,
    modelId: deps.modelId,
    // Zero on success — the count is refusals SINCE the last sentence, so a
    // span that answers has nothing outstanding.
    attempts: text === null ? (existing?.attempts ?? 0) + 1 : 0,
    segmented: input.segmented,
    generatedAt: input.now,
  });

  if (text !== null) {
    if (input.decision === "recompute") input.outcome.recomputed += 1;
    else input.outcome.written += 1;
  }
}

/**
 * The pass: every qualifying storyline-day in a window, summarised.
 *
 * The same shape as `labelPass` and for the same reasons — a keyset walk, a
 * spend ceiling, a wall-clock budget, and a tally that says which of them
 * stopped it. It differs in one way worth knowing: the label pass MUTATES what
 * it selects (a labelled storyline stops needing a label), so its cursor
 * discipline is load-bearing. This one selects on `articles`, which it never
 * writes, so the walk is stable and re-running it is cheap — the decision
 * function re-reads the rows and skips whatever is already current.
 */
export interface SummaryPassOptions {
  /** Inclusive lower bound on an article's `published`. */
  from: Date;
  /** Exclusive upper bound. */
  to: Date;
  minArticlesExclusive: number;
  minGroups: number;
  /**
   * Ceiling on MODEL CALLS.
   *
   * Since ADR-0027 a day costs exactly one, so this is now also a count of days
   * — but it stays named for what it bounds, because what the budget is actually
   * protecting is the key's rate and token windows, and those are spent per call.
   */
  maxSummaries?: number;
  /** Wall-clock ceiling. Absent is unbounded — right for a CLI, wrong for a route. */
  budgetMs?: number;
  /**
   * Model calls per minute. Only the model is paced; the reads are not.
   *
   * **The spacing is measured from one call's START to the next call's start**,
   * not from the previous call's return, so it overlaps model latency instead of
   * being added to it. A pass that sleeps a full interval AFTER each answer runs
   * at `60000 / (spacing + latency)`, which is not the rate anybody configured:
   * measured in production on 2026-09-16, 2 s of spacing plus ~1.3 s of latency
   * gave 18 calls a minute against a key that allows 30, and about 40% of the
   * night was the pass asleep with the key idle.
   */
  ratePerMinute?: number;
  /**
   * Days at the NEWEST end of the window that are walked first, newest first,
   * before the oldest-first walk over the whole window. 0 disables the phase.
   *
   * See the walk itself for why this exists; the short version is that
   * oldest-first alone assumes the deficit is spread evenly over the window, and
   * a promotion burst violates that by adding one arc's whole back-history at
   * once.
   */
  freshDays?: number;
  /**
   * The share of `budgetMs` the fresh phase may spend before it yields to the
   * oldest-first walk, in [0, 1].
   *
   * It is a SHARE rather than a count of calls because what it is protecting is
   * the clock: the guarantee ADR-0023 bought with oldest-first is that the days
   * about to leave the window are reached, and the only thing that can break it
   * is the fresh phase spending the night. Without `budgetMs` there is no night
   * to divide and the fresh phase simply runs first.
   */
  freshShare?: number;
  batchSize?: number;
  /** One arc only. */
  storylineId?: string;
  signal?: AbortSignal;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (progress: { days: number; modelCalls: number }) => void;
}

export interface SummaryPassTally {
  /**
   * Storyline-days considered — DISTINCT, across both phases of the walk. A day
   * the fresh phase reached is not walked again by the window phase, so this
   * keeps the meaning it had when there was one walk.
   */
  days: number;
  /** Of `days`, how many the fresh-first phase reached. */
  fresh: number;
  written: number;
  recomputed: number;
  /** The model answered and the answer was unusable. Costs the span an attempt. */
  refused: number;
  /** The model could not be reached. Costs the span nothing — see the outcome type. */
  unavailable: number;
  skipped: number;
  /** Model calls spent — the `chore_runs.model_calls` number. */
  model: number;
  /** Days whose processing threw. One day's failure never stops the pass. */
  failures: number;
  stoppedBy:
    | "exhausted"
    | "max-summaries"
    | "budget"
    | "signal"
    | "no-model"
    | "unavailable";
}

/**
 * Consecutive unreachable asks that end the pass.
 *
 * Not a tuning knob and not in config: it is a circuit breaker on one shape of
 * night. When the key is 429ing or the endpoint is down, every ask costs a
 * timeout and returns the same nothing, and a pass that keeps going spends the
 * whole night's ceiling discovering that the API is still down. Five in a row is
 * past any plausible transient — the client has already retried each of them
 * internally — and stopping loses nothing, because an unreachable ask writes no
 * row and the next pass reselects the span.
 */
const CONSECUTIVE_UNAVAILABLE_LIMIT = 5;

/**
 * The sampling temperature a RETRY uses. The first ask is always 0.
 *
 * Low enough that the second answer is still about the same coverage, high
 * enough that it is not the same string — which is the whole point, since the
 * failures being retried are deterministic ones (`ask` has the measurement).
 */
const RETRY_TEMPERATURE = 0.4;

/**
 * The gate's answer when the FRESH phase has spent its share of the budget.
 *
 * Deliberately not one of `SummaryPassTally["stoppedBy"]`'s values: it never
 * reaches the tally, because it does not stop the night. It stops one phase, and
 * the walk that reads it starts the next one. Giving it a value the tally could
 * hold would make "the fresh phase yielded" indistinguishable from "the night
 * ran out", which is the difference the report exists to show.
 */
const FRESH_BUDGET = "fresh-budget";

export async function summaryPass(
  deps: SummarizerDeps,
  options: SummaryPassOptions,
): Promise<SummaryPassTally> {
  const tally: SummaryPassTally = {
    days: 0,
    fresh: 0,
    written: 0,
    recomputed: 0,
    refused: 0,
    unavailable: 0,
    skipped: 0,
    model: 0,
    failures: 0,
    stoppedBy: "exhausted",
  };
  // Not a failure: no key configured is a supported deployment state, and the
  // pass has nothing to do in it. `chore_runs` records `ok` with zero calls.
  if (deps.generator === null) {
    tally.stoppedBy = "no-model";
    return tally;
  }

  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const startedAt = now().getTime();
  const rate = options.ratePerMinute ?? 30;
  const spacingMs = rate > 0 ? Math.ceil(60_000 / rate) : 0;
  const batchSize = options.batchSize ?? 200;

  let consecutiveUnavailable = 0;
  // The abort reaches the model call itself, not just the admission check.
  const askDeps: SummarizerDeps = options.signal
    ? { ...deps, signal: options.signal }
    : deps;

  /**
   * The deadline the gate is currently enforcing, as ms from `startedAt`.
   *
   * The fresh phase lowers it to its share and the window phase restores it, so
   * there is ONE budget check rather than a phase-aware condition inside it.
   */
  let deadlineMs = options.budgetMs;
  /** Which stop reason a deadline means right now — see `FRESH_BUDGET`. */
  let deadlineReason: "budget" | typeof FRESH_BUDGET = "budget";
  const pastDeadline = (): boolean =>
    deadlineMs !== undefined && now().getTime() - startedAt >= deadlineMs;

  /**
   * The SPEND ceiling the gate is currently enforcing, and its twin reason.
   *
   * The fresh phase needs a share of this as well as of the clock, and the
   * reason is the CLI: `chores-command` and `storyline-summary-command` both
   * delete `summaryBudgetMs` (a terminal has no function timeout), while
   * `maxSummaries` stays at `SUMMARY_MAX_PER_RUN`. Bounding the fresh phase by
   * the clock alone leaves it UNBOUNDED there — and since a fresh phase that
   * ends on `max-summaries` ends the night rather than yielding, the oldest end
   * would never be walked at all. Against measured demand (107-211 calls for one
   * new UTC day) three fresh days can exceed the ceiling on their own, so this
   * is the ordinary case for `pnpm chores summaries`, not a corner of it.
   */
  let callCeiling = options.maxSummaries;
  let ceilingReason: "max-summaries" | typeof FRESH_BUDGET = "max-summaries";
  const pastCeiling = (): boolean =>
    callCeiling !== undefined && tally.model >= callCeiling;

  /**
   * When the last admitted call STARTED. The spacing is measured from here, so
   * a call's own latency counts towards the interval before the next one — see
   * `SummaryPassOptions.ratePerMinute`.
   */
  let lastCallStartedAt: number | null = null;

  const gate: CallGate = {
    async before(): Promise<string | null> {
      if (options.signal?.aborted) return "signal";
      // Checked BEFORE the spacing sleep and the call: a budget that notices it
      // is spent only once the call returns is a budget the deadline has passed.
      if (pastDeadline()) return deadlineReason;
      if (pastCeiling()) return ceilingReason;
      if (consecutiveUnavailable >= CONSECUTIVE_UNAVAILABLE_LIMIT) return "unavailable";

      if (lastCallStartedAt !== null && spacingMs > 0) {
        const wait = lastCallStartedAt + spacingMs - now().getTime();
        // Only when the previous call returned FASTER than the interval. A slow
        // call has already paid the spacing by taking it, and sleeping again
        // would be the double pacing this measures its way out of.
        if (wait > 0) await sleep(wait);
        // Re-checked after the sleep, which is the half a budget checked only
        // before it cannot see: the deadline can pass while we wait, and a call
        // STARTED past the deadline is a call the budget did not admit. The
        // abort in `runSummaryChore` is what bounds a call already in flight;
        // this is what stops one being started.
        if (options.signal?.aborted) return "signal";
        if (pastDeadline()) return deadlineReason;
      }

      lastCallStartedAt = now().getTime();
      tally.model += 1;
      return null;
    },
    after(kind): void {
      // The run is counted across DAYS as well as within one: an outage does
      // not stop at a day boundary.
      consecutiveUnavailable = kind === "unavailable" ? consecutiveUnavailable + 1 : 0;
    },
  };

  /**
   * Storyline-days this run has already walked, `dayKey|storylineId`.
   *
   * The window phase walks the WHOLE window rather than the window minus the
   * fresh range, so that budget the fresh phase did not spend still reaches
   * fresh days. This is what keeps it from paying for them twice — and what
   * keeps `days` and `skipped` counting each storyline-day once, as they did
   * when there was a single walk. Bounded by the candidates in one night.
   */
  const visited = new Set<string>();

  /**
   * Walk one range in one order.
   *
   * Returns the gate's reason if it stopped us, and WHICH day it stopped on —
   * the caller needs the second half to hand an unfinished day to the next
   * phase. See the fresh phase below.
   */
  async function walkRange(range: {
    from: Date;
    to: Date;
    order: "oldest" | "newest";
    phase: "fresh" | "window";
  }): Promise<{
    stoppedBy?: string;
    stoppedOn?: string;
    /** What the stopped day had already done, so the caller can undo it. */
    stoppedOutcome?: DaySummaryOutcome;
  }> {
    let after: { dayKey: string; storylineId: string } | undefined;

    for (;;) {
      const candidates = await readSummaryCandidateDays(deps.db, {
        from: range.from,
        to: range.to,
        minArticlesExclusive: options.minArticlesExclusive,
        minGroups: options.minGroups,
        limit: batchSize,
        order: range.order,
        ...(after ? { after } : {}),
        ...(options.storylineId ? { storylineId: options.storylineId } : {}),
      });
      if (candidates.length === 0) return {};

      for (const candidate of candidates) {
        // **The deadline bounds the WALK, not just the calls.**
        //
        // The gate is only consulted when a span needs a model call, so a day
        // whose spans are all current never reaches it — it costs two queries
        // and returns. That was survivable with one walk over a window the
        // budget usually outlasted; it is not now, because this commit adds a
        // second walk and the abort in `runSummaryChore` leaves only ~12 s of
        // headroom under `maxDuration`. Production's window holds ~246
        // qualifying storyline-days, and walking them against a pooler in
        // another region is seconds that used to land wherever they landed.
        if (options.signal?.aborted) return { stoppedBy: "signal" };
        if (pastDeadline()) return { stoppedBy: deadlineReason };

        // The cursor advances over every row READ, including ones already
        // walked — it is the keyset's position in the scan, not a record of
        // work done, and skipping it for a visited row would re-read that page.
        after = { dayKey: candidate.dayKey, storylineId: candidate.storylineId };

        const key = `${candidate.dayKey}|${candidate.storylineId}`;
        if (visited.has(key)) continue;
        visited.add(key);

        tally.days += 1;
        if (range.phase === "fresh") tally.fresh += 1;
        let outcome: DaySummaryOutcome;
        try {
          outcome = await summarizeStorylineDay(askDeps, candidate, gate);
        } catch (error) {
          // Never throws for one day's sake, exactly as the linker and the label
          // pass don't: a day this run could not summarise is a day standing
          // where it stood, and the next run selects it again.
          tally.failures += 1;
          deps.logger?.warn(
            {
              err: error instanceof Error ? error.message : String(error),
              storylineId: candidate.storylineId,
              dayKey: candidate.dayKey,
            },
            "summary pass: one storyline-day failed",
          );
          continue;
        }
        tally.written += outcome.written;
        tally.recomputed += outcome.recomputed;
        tally.refused += outcome.refused;
        tally.unavailable += outcome.unavailable;
        tally.skipped += outcome.skipped;
        options.onProgress?.({ days: tally.days, modelCalls: tally.model });

        if (outcome.stoppedBy !== undefined) {
          return { stoppedBy: outcome.stoppedBy, stoppedOn: key, stoppedOutcome: outcome };
        }
      }

      if (candidates.length < batchSize) return {};
    }
  }

  /**
   * Phase one: the few freshest days, newest first, under a share of the budget.
   *
   * ADR-0023 chose oldest-first because the days nearest to leaving the window
   * are the ones that cannot wait, and that argument still holds — it is why
   * this phase is BOUNDED rather than merely first. What it did not anticipate
   * is a promotion burst: a newly promoted arc brings its whole back-history as
   * first-write candidates, and a first write is allowed at any age, so one
   * night's inflow can be several times a normal one. Measured on 2026-09-16,
   * six consecutive firings spent 379 model calls and reached neither of the two
   * newest days, which had 45 qualifying storyline-days and no sentence at all.
   *
   * Every firing runs this phase, not just the first of the night: a phase that
   * finds its days already written costs reads and no model call, which is the
   * same property that makes the extra nightly firings nearly free.
   */
  const freshDays = options.freshDays ?? 0;
  const freshShare = options.freshShare ?? 0;
  const freshFrom = new Date(
    Math.max(options.from.getTime(), options.to.getTime() - freshDays * 86_400_000),
  );
  let stoppedBy: string | undefined;

  // `freshShare > 0` is a CONDITION on running the phase at all, not a detail
  // of bounding it. A phase allowed none of the budget does no work, and the
  // knob reads as "the share the first walk may spend" — so 0 has to mean "no
  // fresh phase", the same as `freshDays: 0`. Letting it fall through to an
  // unset bound would make 0 mean the OPPOSITE: the whole night, unbounded.
  if (freshDays > 0 && freshShare > 0 && freshFrom.getTime() < options.to.getTime()) {
    const share = Math.min(freshShare, 1);
    if (options.budgetMs !== undefined) {
      deadlineMs = Math.floor(options.budgetMs * share);
      deadlineReason = FRESH_BUDGET;
    }
    if (options.maxSummaries !== undefined) {
      // At least one call, so a tiny share is a small phase rather than a
      // phase that cannot ask anything and yields having achieved nothing.
      callCeiling = Math.max(1, Math.floor(options.maxSummaries * share));
      ceilingReason = FRESH_BUDGET;
    }
    const walked = await walkRange({
      from: freshFrom,
      to: options.to,
      order: "newest",
      phase: "fresh",
    });

    if (walked.stoppedBy === FRESH_BUDGET) {
      // Its share running out is this phase ENDING, not the night ending.
      //
      // The day it stopped on is handed back so the window walk can finish it,
      // because leaving it marked as walked would make the share boundary a
      // one-day hole — invisible, and reported as `exhausted`. That is this
      // whole change's own bug, reintroduced one day along.
      //
      // **But only when nothing was ASKED for that day, and that condition is
      // load-bearing.** Re-walking a day this run already worked on means
      // re-deciding its spans, and a span this run REFUSED now carries a row
      // with `attempts: 1` — which `decideSpan` reads as "retry", spending a
      // second of its three attempts in the same night. Three refusals retires
      // a span for ever, so that would retire it a night early, on a table
      // nothing can rebuild. A day with calls already spent keeps its place and
      // waits for the next firing, which is a deferral and not a hole: it is
      // still a fresh day, so it leads the next firing too.
      //
      // `modelCalls === 0` also makes the rollback exact — with no call there is
      // nothing written, recomputed, refused or unavailable, so `skipped` is the
      // only counter the day can have moved.
      if (walked.stoppedOn !== undefined && walked.stoppedOutcome?.modelCalls === 0) {
        visited.delete(walked.stoppedOn);
        tally.days -= 1;
        tally.fresh -= 1;
        tally.skipped -= walked.stoppedOutcome.skipped;
      }
    } else {
      stoppedBy = walked.stoppedBy;
    }

    deadlineMs = options.budgetMs;
    deadlineReason = "budget";
    callCeiling = options.maxSummaries;
    ceilingReason = "max-summaries";
  }

  // Phase two: the whole window, oldest first — the walk ADR-0023 describes.
  if (stoppedBy === undefined) {
    stoppedBy = (
      await walkRange({
        from: options.from,
        to: options.to,
        order: "oldest",
        phase: "window",
      })
    ).stoppedBy;
  }

  if (stoppedBy !== undefined) {
    tally.stoppedBy =
      stoppedBy === "signal" ||
      stoppedBy === "budget" ||
      stoppedBy === "max-summaries" ||
      stoppedBy === "unavailable"
        ? stoppedBy
        : "exhausted";
    if (tally.stoppedBy === "unavailable") {
      deps.logger?.warn(
        { days: tally.days, unavailable: tally.unavailable },
        "summary pass stopping: the model has been unreachable for every recent ask. " +
          "Nothing was written and nothing was retired; the next pass reselects it.",
      );
    }
  }

  return tally;
}
