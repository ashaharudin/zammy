import type { SightingPlane } from "@zammy/storage";

/**
 * The §12 numbers, as the structured log fields they now exist as.
 *
 * **This module exists because those fields are the only form of the numbers
 * that survives the deployment we actually run.** ADR-0015 deleted `/metrics` —
 * per-process prom-client counters mean nothing across ephemeral instances and
 * nothing scrapes them — and named the replacement: the numbers §12 cares about
 * "live on as structured log fields and in the chore-run record". This is the
 * first half of that sentence.
 *
 * What lives here is the VOCABULARY: the message each observation is written
 * under, and — for the three ingest planes — the fields themselves. The messages
 * are constants rather than literals at the call site so that the tests which
 * assert on them name them by symbol; a reworded message then moves both ends
 * at once, instead of leaving a test that quietly stops matching.
 *
 * The ingest fields are ONE function rather than three inline blocks because the
 * three planes have to be readable as one series. `search` (a reader's fill),
 * `breadth` (the sample) and `deepening` (an arc's own provider) each fetch and
 * fold, and the questions asked of them are ratios ACROSS them: articles
 * created per upstream call, the normalization drop rate, and the share of items
 * a provider dated rather than timed. A plane that spelled a field differently —
 * or omitted one — would not read as a missing plane, it would read as a smaller
 * denominator, which is the failure mode ADR-0021 warns about and the one that
 * already happened once on the breadth plane.
 *
 * The other three observations stay inline where the numbers are known, and only
 * borrow their message from here:
 *
 *   - `TIMELINE_READ_MESSAGE` (`timeline-read.ts`) — cache hit ratio by tier,
 *     and latency by `servedFrom`;
 *   - `SEGMENT_TRUNCATED_MESSAGE` (`coverage-fill.ts`) — the §11 truncation rate;
 *   - `ARTICLES_GROUPED_MESSAGE` (`grouping-service.ts`) — the ADR-0005 grouped
 *     rate, written in the one place that holds both halves of it.
 */

/** §12: cache hit ratio by tier (§6.4), and p95 latency by `servedFrom`. */
export const TIMELINE_READ_MESSAGE =
  "timeline read: which staleness tier the window sat in, whether the page cache had it, and where the answer came from";

/** §12's truncated-segment rate — a rise means timelines are thinning (§11). */
export const SEGMENT_TRUNCATED_MESSAGE =
  "segment truncated: the retrievable cap hid history, so this span subdivides (§11)";

/** §12's articles-grouped rate, `grouped / created` (ADR-0005). */
export const ARTICLES_GROUPED_MESSAGE =
  "grouping: how many of the batch's new articles joined an existing group (§14.3)";

/**
 * A traced request or a job run whose record never reached Redis (ADR-0029).
 *
 * Warned, throttled to once a minute per process, and never more than that: a
 * trace is a diagnostic, so the reader's response is unchanged and says
 * `x-zammy-trace-id: unstored`, and this line is for the operator wondering
 * why. Its fields are a reason class (`redis`, `schema`) and, for a schema
 * refusal, the issue PATHS — never a value, which is the redaction rule applied
 * to the tracer's own complaints.
 *
 * A job run the sixteen-run cap trimmed is NOT one of these: it reached Redis,
 * and ADR-0029 lists it among what a trace deliberately does not record, so
 * `trace-dispatch.ts` stays silent about it rather than blame Redis.
 */
export const TRACE_UNSTORED_MESSAGE =
  "request trace not stored: its record or a job run did not reach Redis (ADR-0029)";

/**
 * A traceable request that was not traced (ADR-0029, ADR-0031): the
 * per-minute open budget spent, or the concurrent cap hit.
 *
 * Logged at DEBUG, and the reason is deliberately the only field: with every
 * traceable request traced while the flag is on, a line at warn would be one
 * per reader request past the budget.
 */
export const TRACE_NOT_OPENED_MESSAGE =
  "request trace not opened: budget or capacity (ADR-0029)";

/** The narrowest logger these lines need. `info` optional, as every dep has it. */
export interface ObservationLog {
  info?: (fields: object, message: string) => void;
}

/** What a fetch was, in the terms every plane can answer. */
export interface UpstreamFetch {
  plane: SightingPlane;
  /**
   * The provider this fetch was PLANNED against — which is not necessarily the
   * only one that answered, so the stamp tally below is attributed separately.
   */
  provider: string;
  /** The span asked for, or `null` for a fetch that asks for no range (the sample). */
  span: { from: Date; to: Date } | null;
  sightings: readonly { provider: string; publishedIsDateOnly?: boolean | undefined }[];
  /** Straight off the client's own report: `received - kept` is the drop rate's numerator. */
  normalization: { received: number; kept: number };
  /** Whichever identifier this plane plans by. Both optional; a plane has one. */
  storylineId?: string;
  fingerprint?: string;
}

/** The message both the writer and the tests that read it name by symbol. */
export const UPSTREAM_FETCH_MESSAGE =
  "upstream fetch: what came back, what normalization dropped, and how much of it the provider dated rather than timed";

/**
 * One line per upstream call, and it must be written BEFORE the fold.
 *
 * A throwing `ingestSightings` would otherwise take the observation with it,
 * and the stamp share is precisely the number whose ABSENCE is the alarm (see
 * below) — a detector that stops reporting on the runs that fail looks exactly
 * like a detector that stopped matching.
 *
 * `dateOnly` is the plane's half of plan §G6 / ADR-0021: whether a provider is
 * still TIMING the items it sends or only dating them. **It is a
 * detector-health number, and reading it as a data-quality one gets it exactly
 * backwards.** Google News stops reporting a publication time past about eight
 * days and sends midnight US Pacific instead — 1.7% of items inside that
 * window, 89.4% outside it — and `isDateOnlyStamp` recognises the convention so
 * the storage fold can refuse to let such a stamp redefine an article the
 * discovery plane already timed. Nothing in the type system can force an
 * adapter to set the flag, so the thing to watch is the share DISAPPEARING on
 * an old span, not it being high: a high share is the provider behaving as
 * measured, a share that falls to zero is the detector broken.
 *
 * Which is why this is logged on EVERY fetch rather than only when the share is
 * high. A line that fires only when the number is large cannot show its
 * absence.
 *
 * `dateOnlyProviders` rather than one line per provider: the tally has to be
 * attributable — "the convention belongs to whoever answered" — but `received`
 * and `dropped` are facts about the CALL, and splitting the line per provider
 * would either duplicate them or lose them. A composite fetch is one call whose
 * items came from several providers, and this says so.
 */
export function logUpstreamFetch(log: ObservationLog | undefined, fetch: UpstreamFetch): void {
  const dated = fetch.sightings.filter((sighting) => sighting.publishedIsDateOnly === true);
  log?.info?.(
    {
      plane: fetch.plane,
      provider: fetch.provider,
      ...(fetch.storylineId === undefined ? {} : { storylineId: fetch.storylineId }),
      ...(fetch.fingerprint === undefined ? {} : { fingerprint: fetch.fingerprint }),
      from: fetch.span?.from ?? null,
      to: fetch.span?.to ?? null,
      items: fetch.sightings.length,
      dateOnly: dated.length,
      dateOnlyProviders: [...new Set(dated.map((sighting) => sighting.provider))].sort(),
      received: fetch.normalization.received,
      dropped: fetch.normalization.received - fetch.normalization.kept,
    },
    UPSTREAM_FETCH_MESSAGE,
  );
}

/** The message both the writer and the tests that read it name by symbol. */
export const INGEST_OUTCOME_MESSAGE =
  "ingest: how many of the fetch's articles did not exist before it (§12: created per upstream call)";

/**
 * One line per fold, after it, carrying the numerator of §12's
 * unique-articles-per-upstream-call (baseline ~8 of 20 — a fall means upstream
 * duplication is worsening).
 *
 * After the fold rather than before, because the number does not exist until the
 * fold has run; the fetch line above is what covers a fold that throws.
 */
export function logIngestOutcome(
  log: ObservationLog | undefined,
  outcome: {
    plane: SightingPlane;
    provider: string;
    /** `IngestReport.articlesCreated` — articles that did not exist before this call. */
    created: number;
    storylineId?: string;
    fingerprint?: string;
  },
): void {
  log?.info?.(
    {
      plane: outcome.plane,
      provider: outcome.provider,
      ...(outcome.storylineId === undefined ? {} : { storylineId: outcome.storylineId }),
      ...(outcome.fingerprint === undefined ? {} : { fingerprint: outcome.fingerprint }),
      created: outcome.created,
    },
    INGEST_OUTCOME_MESSAGE,
  );
}
