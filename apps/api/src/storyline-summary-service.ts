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
} from "./storyline-summary.js";

/**
 * The summariser's service half (ADR-0022): read the day, ask the model once per
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
}

/** What one storyline-day cost and produced. */
export interface DaySummaryOutcome {
  storylineId: string;
  dayKey: string;
  /** Rows written for the first time. */
  written: number;
  /** Rows rewritten because their span gained articles inside the window. */
  recomputed: number;
  /** Asks that produced nothing usable. */
  refused: number;
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
  skipped: 0,
  modelCalls: 0,
});

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
  if (!input.withinSettlingWindow) return "skip";
  if (input.forceRecompute === true) return "recompute";
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

      const text = await ask(
        deps,
        buildSegmentSummaryPrompt({
          label: candidate.label,
          dayKey: candidate.dayKey,
          segment: input.segment,
          members: input.members,
        }),
        outcome,
      );

      await record(deps, {
        candidate,
        segment: input.segment,
        existing: stored.get(input.segment),
        articleCount: input.articleCount,
        // Quarters exist only where they are honest, so a quarter row is always
        // written as segmented. The DAY row is where the distinction is read.
        segmented: true,
        text,
        now,
        outcome,
        decision,
      });

      if (text !== null) {
        sentences.set(input.segment, text);
        quartersRewritten = true;
      }
    }
  }

  await summarizeDay(deps, {
    candidate,
    segments,
    sentences,
    stored: stored.get("day"),
    withinSettlingWindow,
    segmented: segmentsAreHonest,
    quartersRewritten,
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
  if (decision === "skip") {
    input.outcome.skipped += 1;
    return;
  }
  if (articleCount === 0) return;

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

  const text = await ask(deps, prompt, input.outcome);
  await record(deps, {
    candidate: input.candidate,
    segment: "day",
    existing: input.stored,
    articleCount,
    segmented: input.segmented,
    text,
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

/** One model call, validated. Null means nothing usable came back. */
async function ask(
  deps: SummarizerDeps,
  prompt: string,
  outcome: DaySummaryOutcome,
): Promise<string | null> {
  // Counted here, at the ask, so the number means "what did this cost" — a
  // retry of an earlier refusal counts, because it is another call. The
  // client's OWN retries (a 503, a 429 it waited out) are invisible from here
  // and are not in this number.
  outcome.modelCalls += 1;
  const result = await deps.generator!.generate({ prompt });
  if (!result.ok) {
    deps.logger?.debug?.({ reason: result.reason }, "summary: the model did not answer");
    return null;
  }
  const validated = validateSummary(result.text);
  if (validated === null) {
    // The raw text is kept, bounded, for the same reason the labeler keeps it:
    // the prompt iterates on live output, and the answers it REFUSES are the
    // only evidence of which way to iterate.
    deps.logger?.warn(
      { text: result.text.slice(0, 120) },
      "summary failed the one-sentence contract",
    );
    return null;
  }
  return validated;
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
    text: string | null;
    now: Date;
    outcome: DaySummaryOutcome;
    decision: SpanDecision;
  },
): Promise<void> {
  const { candidate, segment, existing, text } = input;

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
  /** Model calls per minute. Only the model is paced; the reads are not. */
  ratePerMinute?: number;
  batchSize?: number;
  /** One arc only. */
  storylineId?: string;
  signal?: AbortSignal;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (progress: { days: number; modelCalls: number }) => void;
}

export interface SummaryPassTally {
  /** Storyline-days considered. */
  days: number;
  written: number;
  recomputed: number;
  refused: number;
  skipped: number;
  /** Model calls spent — the `chore_runs.model_calls` number. */
  model: number;
  /** Days whose processing threw. One day's failure never stops the pass. */
  failures: number;
  stoppedBy: "exhausted" | "max-summaries" | "budget" | "signal" | "no-model";
}

export async function summaryPass(
  deps: SummarizerDeps,
  options: SummaryPassOptions,
): Promise<SummaryPassTally> {
  const tally: SummaryPassTally = {
    days: 0,
    written: 0,
    recomputed: 0,
    refused: 0,
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
  const overBudget = (): boolean =>
    options.budgetMs !== undefined && now().getTime() - startedAt >= options.budgetMs;
  const rate = options.ratePerMinute ?? 30;
  const spacingMs = rate > 0 ? Math.ceil(60_000 / rate) : 0;
  const batchSize = options.batchSize ?? 200;

  const gate: CallGate = {
    async before(): Promise<string | null> {
      if (options.signal?.aborted) return "signal";
      // Checked BEFORE the spacing sleep and the call: a budget that notices it
      // is spent only once the call returns is a budget the deadline has passed.
      if (overBudget()) return "budget";
      if (options.maxSummaries !== undefined && tally.model >= options.maxSummaries) {
        return "max-summaries";
      }
      if (tally.model > 0 && spacingMs > 0) await sleep(spacingMs);
      tally.model += 1;
      return null;
    },
  };

  let after: { dayKey: string; storylineId: string } | undefined;

  walk: for (;;) {
    const candidates = await readSummaryCandidateDays(deps.db, {
      from: options.from,
      to: options.to,
      minArticlesExclusive: options.minArticlesExclusive,
      minGroups: options.minGroups,
      limit: batchSize,
      ...(after ? { after } : {}),
      ...(options.storylineId ? { storylineId: options.storylineId } : {}),
    });
    if (candidates.length === 0) break;

    for (const candidate of candidates) {
      after = { dayKey: candidate.dayKey, storylineId: candidate.storylineId };
      tally.days += 1;
      let outcome: DaySummaryOutcome;
      try {
        outcome = await summarizeStorylineDay(deps, candidate, gate);
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
      tally.skipped += outcome.skipped;
      options.onProgress?.({ days: tally.days, modelCalls: tally.model });

      if (outcome.stoppedBy !== undefined) {
        tally.stoppedBy =
          outcome.stoppedBy === "signal" ||
          outcome.stoppedBy === "budget" ||
          outcome.stoppedBy === "max-summaries"
            ? outcome.stoppedBy
            : "exhausted";
        break walk;
      }
    }

    if (candidates.length < batchSize) break;
  }

  return tally;
}
