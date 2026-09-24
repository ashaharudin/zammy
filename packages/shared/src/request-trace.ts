/**
 * Request traces (ADR-0029, ADR-0031): the wire contract of the playback view.
 *
 * A TRACE is one API request made while tracing was on, recorded as the ordered TOUCHES it made
 * — one call from our code to one STATION — and joined by the JOB RUNS of the
 * jobs it enqueued. The playback page (`/?trace`) draws each station as a
 * machine on a warehouse floor and animates the request walking between them.
 *
 * Vocabulary (CONTEXT.md, "Operations"):
 *  - TRACE — one API request made while tracing was on, recorded as the ordered
 *    touches it made, joined by the job runs of the jobs it enqueued, and
 *    labelled with its SUBJECT: what it asked for (ADR-0031).
 *  - SUBJECT — what a traced request asked for: a search's keywords and
 *    filters, or the storylines a view or an open named (with each one's label
 *    where the reply carried it, and its id alone where it did not).
 *  - TOUCH — one call from our code to one station: a start offset, a duration,
 *    an outcome class, and never its arguments. The rate-limit touch is
 *    INFERRED from hooks and headers, not observed.
 *  - STATION — a dependency a touch can reach.
 *  - JOB RUN — one attempt at a job a trace enqueued, by whichever consumer ran
 *    it (a Vercel Queues delivery, a BullMQ attempt, or the drain).
 *  - PLAYBACK — the page, `/?trace`.
 * Never "span" (CONTEXT.md's Coverage owns that word) and never "replay"
 * (`apps/api/src/storyline-replay.ts` owns that one).
 *
 * **The schema IS the redaction boundary, with one deliberate opening.** Every
 * string a TOUCH can hold is an enum member or matches a pattern — no key, URL,
 * SQL text, header, error message, job id or fingerprint has anywhere to go —
 * and the server persists the PARSE OUTPUT, never the draft it built. The
 * opening is `subject` (ADR-0031, amending ADR-0029's "never what it asked"):
 * the reader's keywords, filters, storyline ids and labels, bounded in length
 * and held on the record alone, never on a touch or a job run. Objects are deliberately not
 * `.strict()` (for `timeline.ts`'s reason): zod strips unknown keys, and a
 * field a future recorder adds by mistake is dropped on the way to Redis rather
 * than stored. A fingerprint is a hash of the reader's search text, which is
 * why even that has no field here.
 *
 * A SUBPATH export (`@zammy/shared/request-trace`), deliberately NOT
 * re-exported from `index.ts`: the package does not declare
 * `sideEffects: false`, so the bundler keeps every schema the index reaches,
 * and these would otherwise ride in the reader's main chunk for a page almost
 * no reader opens.
 */
import { z } from "zod";
import { MAX_VIEW_STORYLINES, ResponseMeta } from "./timeline.js";

/** Bumped only by a change a stored record from the previous shape cannot parse under. */
export const TRACE_VERSION = 1 as const;

// ── headers and routes ──────────────────────────────────────────────────────

/** Response header on a traced request: the stored trace's id, or `TRACE_UNSTORED`. */
export const TRACE_ID_HEADER = "x-zammy-trace-id";
/** What `TRACE_ID_HEADER` says when the request was traced but its record never reached the store. */
export const TRACE_UNSTORED = "unstored";
export const TRACE_ROUTE_PREFIX = "/api/v1/traces/";
/** `GET` this for the newest traces (ADR-0031), newest first. */
export const RECENT_TRACES_PATH = "/api/v1/traces";

/** `GET` this for a stored trace. */
export function traceReadPath(id: string): string {
  return `${TRACE_ROUTE_PREFIX}${encodeURIComponent(id)}`;
}

// ── ceilings (server config may LOWER the touch cap, never raise it) ────────

/** Touches one record may hold. `REQUEST_TRACE_MAX_TOUCHES` may lower it. */
export const MAX_TRACE_TOUCHES = 400;
/** Traces the recent list holds (ADR-0031). */
export const MAX_RECENT_TRACES = 10;
/** A subject's keywords (the search box's own bound, `MAX_KEYWORDS_LENGTH`). */
export const MAX_SUBJECT_KEYWORDS = 200;
/** A storyline label on a subject; a longer one is cut to this, not refused. */
export const MAX_SUBJECT_LABEL = 200;
/** Job runs one trace keeps. Redeliveries and the drain each add one. */
export const MAX_TRACE_RUNS = 16;
/** Traces one job run may be appended to (the queue deduplicated a job several asked for). */
export const MAX_RUN_LINKS = 8;
/** Tables named on one Postgres touch. */
export const MAX_TOUCH_TABLES = 6;
/** How deep a job ref nests: "1" → "1.1" → "1.1.1" → "1.1.1.1". */
export const MAX_JOB_REF_DEPTH = 4;
/** The consumer's `maxDuration` (vercel.json): no record's offsets can exceed it. */
export const MAX_TRACE_MS = 300_000;

// ── identities ──────────────────────────────────────────────────────────────

/** `crypto.randomUUID()` output: lowercase, version 4. */
export const TRACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const TraceId = z.string().regex(TRACE_ID_PATTERN);
export type TraceId = z.infer<typeof TraceId>;

/**
 * How a trace names a job it caused: "2" is the request's second enqueue, and
 * "2.1" the first child a run of job "2" enqueued in turn. A local counter,
 * never the job's own id — `ingestJobId` embeds the topic's fingerprint.
 */
export const JOB_REF_PATTERN = /^[1-9][0-9]?(?:\.[1-9][0-9]?){0,3}$/;
export const JobRef = z.string().regex(JOB_REF_PATTERN);
export type JobRef = z.infer<typeof JobRef>;

// ── stations and their closed vocabularies ──────────────────────────────────

/** `edge` is only ever synthesized by the browser (a CDN answer runs no function), never recorded by the server. */
export const Station = z.enum([
  "edge",
  "rate_limit",
  "redis",
  "postgres",
  "queue",
  "currents",
  "google_news",
  "gemini",
]);
export type Station = z.infer<typeof Station>;

/** What a Redis key is FOR, classified by prefix. The key itself never leaves the classifier. */
export const RedisKeyClass = z.enum([
  "reference",
  "page_cache",
  "trending_cache",
  "sample_lock",
  "fill_lock",
  "deepen_lock",
  "summarize_lock",
  "topic_budget",
  "pending_ledger",
  "other",
]);
export type RedisKeyClass = z.infer<typeof RedisKeyClass>;

export const RedisCommand = z.enum([
  "GET",
  "MGET",
  "SET",
  "DEL",
  "INCR",
  "EXPIRE",
  "EVAL",
  "ZCARD",
  "other",
]);
export type RedisCommand = z.infer<typeof RedisCommand>;

export const PgOperation = z.enum(["select", "insert", "update", "delete", "raw"]);
export type PgOperation = z.infer<typeof PgOperation>;

/** Mirrors `Database` (packages/storage/src/database.ts); an apps/api test pins the match. */
export const PgTable = z.enum([
  "sightings",
  "articles",
  "topics",
  "topic_articles",
  "topic_coverage",
  "storyline_coverage",
  "fetch_log",
  "storylines",
  "storyline_groups",
  "storyline_days",
  "story_token_days",
  "story_corpus_days",
  "storyline_bridges",
  "storyline_formation_refusals",
  "storyline_day_summaries",
  "chore_runs",
]);
export type PgTable = z.infer<typeof PgTable>;

export const UpstreamCall = z.enum([
  "search",
  "latest_news",
  "available_languages",
  "available_regions",
  "available_categories",
  "generate",
]);
export type UpstreamCall = z.infer<typeof UpstreamCall>;

/** `NewsError` kinds (packages/news-client/src/errors.ts) plus `GenerateFailure` (apps/api/src/gemini.ts). */
export const UpstreamFailure = z.enum([
  "quota",
  "circuit_open",
  "timeout",
  "caller_aborted",
  "upstream",
  "schema",
  "auth",
  "blocked",
  "invalid_query",
  "answered",
  "unreachable",
  "unknown",
]);
export type UpstreamFailure = z.infer<typeof UpstreamFailure>;

export const CallPriority = z.enum(["interactive", "background"]);
export type CallPriority = z.infer<typeof CallPriority>;
export const GeneratorPurpose = z.enum(["label", "summary"]);
export type GeneratorPurpose = z.infer<typeof GeneratorPurpose>;
/** `fallback` is a refused search retried against Google News (ADR-0030). */
export const JobKind = z.enum(["segment", "topup", "fallback", "sample", "deepen", "summarize"]);
export type JobKind = z.infer<typeof JobKind>;
export const JobPlane = z.enum(["search", "breadth", "deepening"]);
export type JobPlane = z.infer<typeof JobPlane>;

// ── outcomes, per station ───────────────────────────────────────────────────

/** `open` = no end observed before the record was sealed. */
export const RedisOutcome = z.enum([
  "ok",
  "hit",
  "miss",
  "acquired",
  "held",
  "released",
  "lost",
  "not_ready",
  "failed",
  "open",
]);
export type RedisOutcome = z.infer<typeof RedisOutcome>;
/**
 * No `failed`: Kysely never calls a plugin's `transformResult` for a query that
 * threw, so a failed statement and one still running both read `open`.
 */
export const PostgresOutcome = z.enum(["ok", "open"]);
export type PostgresOutcome = z.infer<typeof PostgresOutcome>;
export const UpstreamOutcome = z.enum(["ok", "refused", "failed", "open"]);
export type UpstreamOutcome = z.infer<typeof UpstreamOutcome>;
export const QueueOutcome = z.enum(["ok", "failed", "open"]);
export type QueueOutcome = z.infer<typeof QueueOutcome>;
export const RateLimitOutcome = z.enum(["counted", "limited", "fail_open"]);
export type RateLimitOutcome = z.infer<typeof RateLimitOutcome>;
export const EdgeOutcome = z.enum(["hit", "stale", "miss"]);
export type EdgeOutcome = z.infer<typeof EdgeOutcome>;

/** ms from the record's own t0, rounded to 0.1 ms server-side. */
const Offset = z.number().min(0).max(MAX_TRACE_MS);
/** null = no end observed before seal. */
const Duration = z.number().min(0).max(MAX_TRACE_MS).nullable();

export const RedisTouch = z.object({
  station: z.literal("redis"),
  at: Offset,
  ms: Duration,
  outcome: RedisOutcome,
  command: RedisCommand,
  key: RedisKeyClass,
});
export const PostgresTouch = z.object({
  station: z.literal("postgres"),
  at: Offset,
  ms: Duration,
  outcome: PostgresOutcome,
  operation: PgOperation,
  tables: z.array(PgTable).max(MAX_TOUCH_TABLES),
});
const upstreamFields = {
  at: Offset,
  ms: Duration,
  outcome: UpstreamOutcome,
  call: UpstreamCall,
  priority: CallPriority.optional(),
  failure: UpstreamFailure.optional(),
};
export const CurrentsTouch = z.object({ station: z.literal("currents"), ...upstreamFields });
export const GoogleNewsTouch = z.object({ station: z.literal("google_news"), ...upstreamFields });
export const GeminiTouch = z.object({
  station: z.literal("gemini"),
  ...upstreamFields,
  purpose: GeneratorPurpose.optional(),
});
export const QueueTouch = z.object({
  station: z.literal("queue"),
  at: Offset,
  ms: Duration,
  outcome: QueueOutcome,
  job: JobKind,
  plane: JobPlane.optional(),
  ref: JobRef,
  /** Whether the job → trace link landed, so a run of it can find its way back here. */
  linked: z.boolean(),
});
export const RateLimitTouch = z.object({
  station: z.literal("rate_limit"),
  at: Offset,
  ms: Duration,
  outcome: RateLimitOutcome,
  /** Always true: read off hook timing and `x-ratelimit-*`, not observed (the limiter holds the boot client). */
  inferred: z.literal(true),
  limit: z.int().min(0).nullable(),
  remaining: z.int().min(0).nullable(),
});
export const EdgeTouch = z.object({
  station: z.literal("edge"),
  at: Offset,
  ms: Duration,
  outcome: EdgeOutcome,
});

export const Touch = z.discriminatedUnion("station", [
  RedisTouch,
  PostgresTouch,
  CurrentsTouch,
  GoogleNewsTouch,
  GeminiTouch,
  QueueTouch,
  RateLimitTouch,
  EdgeTouch,
]);
export type Touch = z.infer<typeof Touch>;
export type TouchOf<S extends Station> = Extract<Touch, { station: S }>;
export type TouchOutcome = Touch["outcome"];

/** The middle of a record that overflowed its cap: head and tail are kept, and this says what went. */
export const Elision = z.object({
  /** Index in `touches` of the last touch BEFORE the gap. */
  after: z.int().min(0).max(MAX_TRACE_TOUCHES - 1),
  count: z.int().min(1),
  stations: z.partialRecord(Station, z.int().min(1)),
  fromAt: Offset,
  toAt: Offset,
});
export type Elision = z.infer<typeof Elision>;

// ── the request record ──────────────────────────────────────────────────────

export const TraceRoute = z.enum([
  "timeline_search",
  "timeline_view",
  "storylines_search",
  "storyline_open",
  "trending",
  "reference",
]);
export type TraceRoute = z.infer<typeof TraceRoute>;

/** Names of the query parameters present. NEVER their values. */
export const TraceQueryKey = z.enum([
  "q",
  "storyline",
  "cursor",
  "limit",
  "language",
  "country",
  "from",
  "to",
]);
export type TraceQueryKey = z.infer<typeof TraceQueryKey>;

/** ioredis `status`, folded: wait/connecting/connect → connecting; end/close → down. */
export const RedisStatus = z.enum(["ready", "connecting", "reconnecting", "down"]);
export type RedisStatus = z.infer<typeof RedisStatus>;

/** Live configuration facts of the process that recorded it, so the page draws what ran rather than what it assumes. */
export const TraceEnvironment = z.object({
  queue: z.enum(["bullmq", "vercel"]),
  currents: z.enum(["live", "fixture"]),
  gnews: z.boolean(),
  googleNews: z.enum(["live", "fixture", "off"]),
  summaries: z.boolean(),
  /** A labeler model key is configured, so the label tail can call Gemini. */
  labeler: z.boolean(),
});
export type TraceEnvironment = z.infer<typeof TraceEnvironment>;

export const TraceOrigin = z.object({
  /** 1 = the first request or job run this instance handled while tracing was on. */
  instanceSequence: z.int().min(1),
  redisAtStart: RedisStatus,
  environment: TraceEnvironment,
});
export type TraceOrigin = z.infer<typeof TraceOrigin>;

/** The response's own `meta`, less the clock reading it would add nothing to. */
export const TraceMeta = ResponseMeta.omit({ asOf: true });
export type TraceMeta = z.infer<typeof TraceMeta>;

/** What each plane's gate decided on a storyline open (ADR-0017, ADR-0019, ADR-0027). */
export const PlaneStatuses = z.object({
  /** `deferred`: the deepening plane planned this arc, so no Currents call was spent (ADR-0017). */
  refresh: z.enum(["queued", "fresh", "deferred", "no_keywords"]),
  deepening: z.enum(["queued", "fresh", "unavailable", "ungrounded", "unknown"]),
  summaries: z.enum(["queued", "disabled", "unknown"]),
});
export type PlaneStatuses = z.infer<typeof PlaneStatuses>;

/** One storyline a subject names. `label` is absent where the reply did not carry it. */
export const TraceSubjectStoryline = z.object({
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  label: z.string().max(MAX_SUBJECT_LABEL).nullable().optional(),
});
export type TraceSubjectStoryline = z.infer<typeof TraceSubjectStoryline>;

/**
 * What a traced request ASKED FOR (ADR-0031), read off its query, its route
 * params and — for a storyline view's labels — its reply:
 *
 *   timeline_search, storylines_search  `keywords`, and `language`/`country`
 *   timeline_view                       `storylines`, each with its label, then
 *                                       any requested id the reply did not name
 *   storyline_open                      `storylines`: the one id, no label
 *   trending                            `language`, when one was asked for
 *   reference                           nothing: the record's subject is null
 *
 * The values as the reader sent them, before canonicalization — a bad one is
 * what a 400 was about — and cut to the bounds here rather than refused.
 */
export const TraceSubject = z.object({
  keywords: z.string().max(MAX_SUBJECT_KEYWORDS).optional(),
  language: z.string().max(8).optional(),
  country: z.string().max(8).optional(),
  storylines: z.array(TraceSubjectStoryline).max(MAX_VIEW_STORYLINES).optional(),
});
export type TraceSubject = z.infer<typeof TraceSubject>;

export const RequestTrace = z.object({
  v: z.literal(TRACE_VERSION),
  id: TraceId,
  route: TraceRoute,
  method: z.enum(["GET", "POST"]),
  queryKeys: z.array(TraceQueryKey).max(8),
  /**
   * What the request asked for (ADR-0031). Null for a route that asks nothing
   * (reference) and for a browser-synthesized trace; absent on a record from
   * before ADR-0031, which is why it is optional rather than a `v` bump.
   */
  subject: TraceSubject.nullable().optional(),
  /** timeline_view only: how many storylines the view named. */
  viewStorylines: z.int().min(1).max(MAX_VIEW_STORYLINES).optional(),
  status: z.int().min(100).max(599),
  startedAt: z.iso.datetime(),
  /** Measured at seal, BEFORE the trace's own write. */
  ms: z.number().min(0).max(MAX_TRACE_MS),
  /** The tracer's own awaited work (job-link writes) inside `ms`; not drawn. */
  overheadMs: z.number().min(0).max(MAX_TRACE_MS),
  /** Null only for a browser-synthesized trace: no function ran. */
  origin: TraceOrigin.nullable(),
  meta: TraceMeta.nullable(),
  planes: PlaneStatuses.nullable(),
  touches: z.array(Touch).max(MAX_TRACE_TOUCHES),
  elided: Elision.nullable(),
});
export type RequestTrace = z.infer<typeof RequestTrace>;

// ── job runs ────────────────────────────────────────────────────────────────

export const RunSource = z.enum(["vercel_queue", "bullmq", "drain"]);
export type RunSource = z.infer<typeof RunSource>;

export const JobRun = z.object({
  v: z.literal(TRACE_VERSION),
  /** The ref THIS trace knows the job by (rendered per link). */
  ref: JobRef,
  job: JobKind,
  plane: JobPlane.optional(),
  source: RunSource,
  startedAt: z.iso.datetime(),
  ms: z.number().min(0).max(MAX_TRACE_MS),
  overheadMs: z.number().min(0).max(MAX_TRACE_MS),
  result: z.enum(["ok", "threw"]),
  failure: UpstreamFailure.optional(),
  /** How many traces this one run was appended to (>1 = the queue deduplicated a shared job). */
  sharedWith: z.int().min(1).max(MAX_RUN_LINKS),
  origin: TraceOrigin,
  touches: z.array(Touch).max(MAX_TRACE_TOUCHES),
  elided: Elision.nullable(),
});
export type JobRun = z.infer<typeof JobRun>;

/** `GET /api/v1/traces/:id` → 200. */
export const TraceReadResponse = z.object({
  trace: RequestTrace,
  /** Sorted by (startedAt, ref). */
  runs: z.array(JobRun).max(MAX_TRACE_RUNS),
  /** trace.startedAt + REQUEST_TRACE_TTL_SECONDS, computed rather than read back with PTTL. */
  expiresAt: z.iso.datetime(),
});
export type TraceReadResponse = z.infer<typeof TraceReadResponse>;

/** One entry of the recent list: enough to choose a trace by, not the trace. */
export const TraceSummary = RequestTrace.pick({
  id: true,
  route: true,
  method: true,
  status: true,
  startedAt: true,
  ms: true,
  subject: true,
});
export type TraceSummary = z.infer<typeof TraceSummary>;

/** `GET /api/v1/traces` → 200: the newest traces still stored, newest first. */
export const RecentTracesResponse = z.object({
  traces: z.array(TraceSummary).max(MAX_RECENT_TRACES),
});
export type RecentTracesResponse = z.infer<typeof RecentTracesResponse>;

// ── the fidelity signature: shared so both sides compare the SAME thing ─────

/**
 * A trace's path as the CODE decides it, stripped of what timing and cache
 * warmth vary: Postgres (the label tail interleaves it), the reference refill
 * (warmth), and label-tail Gemini calls (fire-and-forget). Consecutive
 * duplicates collapse.
 *
 * A test's way of stating the path a request took without pinning its timing
 * (`apps/api/src/trace-http.test.ts` reads a real cold search's with it). It
 * pinned ADR-0029's built-in examples to the code until ADR-0031 took them off
 * the page.
 */
export function traceSignature(touches: readonly Touch[]): string[] {
  const tokens: string[] = [];
  for (const touch of touches) {
    const token = signatureToken(touch);
    if (token !== null && tokens.at(-1) !== token) tokens.push(token);
  }
  return tokens;
}

function signatureToken(t: Touch): string | null {
  switch (t.station) {
    case "postgres":
      return null;
    case "redis":
      return t.key === "reference" && t.command === "SET" ? null : `redis:${t.key}`;
    case "currents":
      return t.call === "available_languages" ||
        t.call === "available_regions" ||
        t.call === "available_categories"
        ? null
        : `currents:${t.call}`;
    case "gemini":
      return t.purpose === "label" ? null : `gemini:${t.call}`;
    case "google_news":
      return `google_news:${t.call}`;
    case "queue":
      return `queue:${t.job}`;
    case "rate_limit":
      return `rate_limit:${t.outcome}`;
    case "edge":
      return `edge:${t.outcome}`;
  }
}
