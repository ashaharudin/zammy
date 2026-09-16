import type { Kysely } from "kysely";
import {
  bumpSummaryAttempts,
  readStorylineDaySegments,
  readSummaryCandidateDays,
  readStorylineDaySummaries,
  summaryDayBounds,
  writeStorylineDaySummary,
  type Database,
  type StoredSummary,
  type SummaryCandidateDay,
  type SummaryMember,
  type SummaryQuarter,
  type SummarySegment,
  type SummarySegmentInput,
} from "@zammy/storage";
import type { TextGenerator } from "./gemini.js";
import {
  buildDayFromArticlesPrompt,
  buildDayFromSegmentsPrompt,
  buildSegmentSummaryPrompt,
  validateSummary,
  SUMMARY_MAX_CHARS,
} from "./storyline-summary.js";

/**
 * The summariser's service half (ADR-0023): read the day, ask the model once per
 * populated quarter, then once more over those sentences, and write what comes
 * back. `storyline-label-service.ts` is the shape this follows, and the one
 * place it deliberately diverges is failure — a label falls back to the bigram
 * extractor, and prose has no such fallback, so a refusal here is a row that
 * says so rather than a worse sentence.
 */

export interface SummarizerDeps {
  db: Kysely<Database>;
  /** Null with no key configured: the pass writes nothing and says so. */
  generator: TextGenerator | null;
  /** Recorded on every row — `SUMMARY_MODEL`, or null with no generator. */
  modelId: string | null;
  /** Articles per quarter that reach the prompt. */
  sampleSize: number;
  /** Asks one span gets before it is retired. */
  maxAttempts: number;
  /** Days after a day closes during which it may still be rewritten. */
  settlingDays: number;
  /** Articles a span must GAIN before a rewrite is worth a model call. */
  recomputeDelta: number;
  /**
   * Days after which an article's published TIME is no longer trustworthy, so a
   * day is summarised whole rather than by quarters. Google News drops the
   * pubDate time beyond ~8 days and stamps 89.4% of those rows at midnight US
   * Pacific — four sentences off that would be four sentences about a bucket
   * boundary rather than about the news.
   */
  cliffDays: number;
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

/** What one storyline-day cost and produced. */
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
  /** Spans that needed no ask. */
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
 *  - Anything else → skip, at the cost of the reads and nothing else.
 */
export function decideSpan(input: {
  existing: StoredSummary | undefined;
  articleCount: number;
  withinSettlingWindow: boolean;
  recomputeDelta: number;
  maxAttempts: number;
  /** The day row only: its quarters were rewritten, so it is stale by construction. */
  forceRecompute?: boolean;
}): SpanDecision {
  const { existing, maxAttempts } = input;
  if (existing === undefined) return "write";
  // One cap over both kinds of ask. Three refusals on one span is a strong
  // enough signal to stop paying for it — and an operator who disagrees can
  // clear the row, which is the deliberate act this refuses to make automatic.
  if (existing.attempts >= maxAttempts) return "skip";
  if (existing.summary === null) return "retry";
  // BEFORE the window check, and that order is the bug this had.
  //
  // The force is set when a quarter of this day was just rewritten, and a
  // quarter can be rewritten past the window by the two paths that legitimately
  // ignore it: a FIRST write of a quarter that had no row (a late group lands
  // afternoon coverage on a day that had none), and a successful RETRY of an
  // earlier refusal. Checking the window first made the force unreachable in
  // exactly those cases, so the day sentence kept describing quarters that had
  // moved underneath it — a day summary that omits a quarter which now exists.
  //
  // It is not a hole in the freeze: the write that set the force was itself
  // permitted, and this only keeps the day consistent with the quarters it is
  // built from.
  if (input.forceRecompute === true) return "recompute";
  if (!input.withinSettlingWindow) return "skip";
  return input.articleCount - existing.articleCount > input.recomputeDelta
    ? "recompute"
    : "skip";
}

/**
 * Summarise one storyline-day.
 *
 * Order matters once: the quarters are written BEFORE the day, because the day
 * sentence is built from theirs. A run that is cut off between the two leaves
 * the quarters written and no day row, which the next run reads as "no row →
 * write" and completes — the resumability is the decision function's, not a
 * special case here.
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
  const segmentsAreHonest = ageDays < deps.cliffDays;

  const stored = new Map<SummarySegment, StoredSummary>();
  for (const row of await readStorylineDaySummaries(deps.db, candidate)) {
    stored.set(row.segment, row);
  }

  const segments = await readStorylineDaySegments(deps.db, {
    storylineId: candidate.storylineId,
    dayKey: candidate.dayKey,
    sampleSize: deps.sampleSize,
  });

  /** The sentence each quarter now carries — stored, or written by this run. */
  const sentences = new Map<SummaryQuarter, string>();
  for (const [segment, row] of stored) {
    if (segment !== "day" && row.summary !== null) {
      sentences.set(segment as SummaryQuarter, row.summary);
    }
  }
  let quartersRewritten = false;

  // Past the cliff no quarter is asked — but the day's quarters are still spans
  // that needed no ask, and a tally where the numbers do not add up is a tally
  // nobody trusts.
  if (!segmentsAreHonest) outcome.skipped += segments.length;

  if (segmentsAreHonest) {
    for (const input of segments) {
      const decision = decideSpan({
        existing: stored.get(input.segment),
        articleCount: input.articleCount,
        withinSettlingWindow,
        recomputeDelta: deps.recomputeDelta,
        maxAttempts: deps.maxAttempts,
      });
      if (decision === "skip") {
        outcome.skipped += 1;
        continue;
      }

      const stop = await gate?.before();
      if (stop) {
        outcome.stoppedBy = stop;
        return outcome;
      }

      const result = await ask(
        deps,
        buildSegmentSummaryPrompt({
          label: candidate.label,
          dayKey: candidate.dayKey,
          segment: input.segment,
          members: input.members,
        }),
        outcome,
        stored.get(input.segment)?.attempts ?? 0,
      );

      gate?.after?.(result.kind === "unavailable" ? "unavailable" : "answered");

      await record(deps, {
        candidate,
        segment: input.segment,
        existing: stored.get(input.segment),
        articleCount: input.articleCount,
        // Quarters exist only where they are honest, so a quarter row is always
        // written as segmented. The DAY row is where the distinction is read.
        segmented: true,
        result,
        now,
        outcome,
        decision,
      });

      if (result.kind === "sentence") {
        sentences.set(input.segment, result.text);
        quartersRewritten = true;
      }
    }
  }

  const dayRow = stored.get("day");
  // The DURABLE half of the force. `quartersRewritten` lives for the length of
  // this call, and the pass can end between the quarters and the day — the gate
  // stops on the budget or the ceiling, which is what the docs say actually
  // stops a healthy night. The flag would be gone by the next run, the quarter
  // would be current, and a day past its window would keep a sentence that
  // omits a quarter it has never seen. Comparing stamps survives that: every
  // row a single run writes carries the SAME `now`, so `>` is true only when a
  // later run genuinely wrote a quarter after this day sentence.
  const quartersOutranTheDay =
    dayRow !== undefined &&
    [...stored.values()].some(
      (row) =>
        row.segment !== "day" &&
        row.summary !== null &&
        row.generatedAt.getTime() > dayRow.generatedAt.getTime(),
    );

  await summarizeDay(deps, {
    candidate,
    segments,
    sentences,
    stored: dayRow,
    withinSettlingWindow,
    // `segmented` says whether this day's coverage could be placed in time, and
    // a day that ALREADY has quarter rows is such a day whatever its age is
    // now. Without the second clause, a day whose `day` row was refused while
    // it was fresh and retried past the cliff would be re-marked `false` with
    // its four quarter sentences still standing beside it — the one column
    // whose whole job is to not lie, lying.
    segmented:
      segmentsAreHonest ||
      [...stored.values()].some(
        // A quarter row with no sentence is not evidence the day's coverage
        // could be placed in time — it is a refusal, and a day whose every
        // quarter was refused and whose day row is retried past the cliff is
        // exactly the "we could not tell when this landed" case.
        (row) => row.segment !== "day" && row.summary !== null,
      ),
    quartersRewritten: quartersRewritten || quartersOutranTheDay,
    now,
    outcome,
    gate,
  });

  return outcome;
}

/** The fifth sentence. */
async function summarizeDay(
  deps: SummarizerDeps,
  input: {
    candidate: SummaryCandidateDay;
    segments: SummarySegmentInput[];
    sentences: Map<SummaryQuarter, string>;
    stored: StoredSummary | undefined;
    withinSettlingWindow: boolean;
    segmented: boolean;
    quartersRewritten: boolean;
    now: Date;
    outcome: DaySummaryOutcome;
    gate?: CallGate;
  },
): Promise<void> {
  const articleCount = input.segments.reduce((sum, entry) => sum + entry.articleCount, 0);
  const decision = decideSpan({
    existing: input.stored,
    articleCount,
    withinSettlingWindow: input.withinSettlingWindow,
    recomputeDelta: deps.recomputeDelta,
    maxAttempts: deps.maxAttempts,
    // A day whose quarters were just rewritten is stale whatever its own count
    // did — the sentences it is built from are not the ones it was built from.
    forceRecompute: input.quartersRewritten,
  });
  if (decision === "skip" || articleCount === 0) {
    input.outcome.skipped += 1;
    return;
  }

  const stop = await input.gate?.before();
  if (stop) {
    input.outcome.stoppedBy = stop;
    return;
  }

  // From the quarters when there are any, which is the cheap and consistent
  // path; from the articles when there are not — a day past the pubDate cliff,
  // or one whose every quarter was refused.
  const fromSegments = input.segments
    .map((entry) => {
      const summary = input.sentences.get(entry.segment);
      return summary === undefined ? null : { segment: entry.segment, summary };
    })
    .filter((entry): entry is { segment: SummaryQuarter; summary: string } => entry !== null);

  const prompt =
    fromSegments.length > 0
      ? buildDayFromSegmentsPrompt({
          label: input.candidate.label,
          dayKey: input.candidate.dayKey,
          segments: fromSegments,
        })
      : buildDayFromArticlesPrompt({
          label: input.candidate.label,
          dayKey: input.candidate.dayKey,
          members: dayMembers(input.segments, deps.sampleSize),
        });

  const result = await ask(deps, prompt, input.outcome, input.stored?.attempts ?? 0);
  input.gate?.after?.(result.kind === "unavailable" ? "unavailable" : "answered");
  await record(deps, {
    candidate: input.candidate,
    segment: "day",
    existing: input.stored,
    articleCount,
    segmented: input.segmented,
    result,
    now: input.now,
    outcome: input.outcome,
    decision,
  });
}

/**
 * The day's own sample, for the articles-based prompt.
 *
 * The union of the quarters' samples re-ranked, rather than a second query: the
 * per-quarter samples are already the most-syndicated coverage of each part of
 * the day, so the most-syndicated of THEM is the most-syndicated of the day.
 * (On the path this actually serves — a day past the pubDate cliff — nearly
 * every article is in one quarter anyway, so the two are the same set.)
 */
function dayMembers(segments: SummarySegmentInput[], sampleSize: number): SummaryMember[] {
  return segments
    .flatMap((entry) => entry.members)
    .sort(
      (a, b) =>
        b.sightingCount - a.sightingCount || a.published.getTime() - b.published.getTime(),
    )
    .slice(0, sampleSize)
    .sort((a, b) => a.published.getTime() - b.published.getTime());
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
  /** Ceiling on MODEL CALLS, not on days: a day costs between 1 and 5. */
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
      if (options.maxSummaries !== undefined && tally.model >= options.maxSummaries) {
        return "max-summaries";
      }
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
  }): Promise<{ stoppedBy?: string; stoppedOn?: string }> {
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
          return { stoppedBy: outcome.stoppedBy, stoppedOn: key };
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

  if (freshDays > 0 && freshFrom.getTime() < options.to.getTime()) {
    if (options.budgetMs !== undefined && freshShare > 0) {
      deadlineMs = Math.floor(options.budgetMs * Math.min(freshShare, 1));
      deadlineReason = FRESH_BUDGET;
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
      // And the day it stopped on is handed back rather than kept: the gate
      // refused that day a call, so it is unfinished, and leaving it marked as
      // walked would make the share boundary a hole. It is exactly one day per
      // night and it would be invisible — the pass would report `exhausted`
      // having silently skipped the second-newest day, which is the bug this
      // whole change exists to fix, reintroduced one day further along.
      if (walked.stoppedOn !== undefined) {
        visited.delete(walked.stoppedOn);
        tally.days -= 1;
        tally.fresh -= 1;
      }
    } else {
      stoppedBy = walked.stoppedBy;
    }

    deadlineMs = options.budgetMs;
    deadlineReason = "budget";
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
