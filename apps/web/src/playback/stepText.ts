/**
 * Every word the playback page says about a trace (ADR-0029).
 *
 * Two registers, kept apart on purpose:
 *  - CANVAS text — plates, captions, the route label — is drawn in the 5×7 pixel
 *    font, so it is uppercase, short and made only of `FONT_CHARS`: "HIT",
 *    "×83", "NO CONN". A caption that does not fit is shortened HERE, by its
 *    author; the font never truncates, and a character it lacks turns into `?`,
 *    which `frame.test.ts` forbids everywhere but the intended "?" of an open
 *    call.
 *  - DOM text — the step list, the scrubber's `aria-valuetext`, the headline and
 *    the honesty notes — is real prose in the page's own type, read by a screen
 *    reader as the equivalent of the animation (the canvas is `aria-hidden`).
 *    It says "Postgres", "single-flight lock", "1,204 ms"; it never says "span"
 *    or "replay" (CONTEXT.md's vocabulary: trace, touch, station, job run).
 *
 * The page is only honest if it says what it cannot see, so `honestyNotes` is as
 * much a part of this module as the captions: what was inferred, elided, still
 * running, unlinked, or never observed, each note present only when it applies.
 *
 * Deliberately not here: layout, timing, colour, and any number formatting that
 * depends on the reader's locale (`toLocaleString` would make the step list read
 * differently in a test than in a browser, and differently from reader to reader).
 */
import {
  MAX_TRACE_RUNS,
  type JobKind,
  type JobRun,
  type RedisKeyClass,
  type RequestTrace,
  type RunSource,
  type Station,
  type Touch,
  type TouchOutcome,
  type TraceEnvironment,
  type TraceReadResponse,
  type TraceSubject,
  type TraceSummary,
  type UpstreamFailure,
} from "@zammy/shared/request-trace";
import type { Step, Stop, Timeline } from "./choreography.js";

/**
 * Longest caption a bubble can hold, in glyphs: what `ActorPose.bubble` promises
 * (`frame.ts`), and `frame.test.ts` holds every frame of every fixture to it.
 */
export const CAPTION_MAX = 10;

// ── names ────────────────────────────────────────────────────────────────────

/**
 * A station's name in prose, from the live environment where it matters: the
 * queue is Vercel Queues or BullMQ depending on the driver, and Currents says when
 * it is answering from the fixture corpus or folding GNews in.
 */
export function stationName(station: Station, env: TraceEnvironment | null): string {
  switch (station) {
    case "edge":
      return "CDN edge";
    case "rate_limit":
      return "Rate limiter";
    case "redis":
      return "Redis";
    case "postgres":
      return "Postgres";
    case "queue":
      return env === null ? "Queue" : env.queue === "bullmq" ? "BullMQ" : "Vercel Queues";
    case "currents": {
      const fixture = env?.currents === "fixture" ? " (fixture)" : "";
      const gnews = env?.gnews ? " + GNews" : "";
      return `Currents${fixture}${gnews}`;
    }
    case "google_news":
      return env?.googleNews === "fixture" ? "Google News (fixture)" : "Google News";
    case "gemini":
      return "Gemini";
  }
}

const PLATES: Readonly<Record<Station, string>> = {
  edge: "EDGE",
  rate_limit: "LIMIT",
  redis: "REDIS",
  postgres: "POSTGRES",
  queue: "QUEUE",
  currents: "CURRENTS",
  google_news: "GOOGLE",
  gemini: "GEMINI",
};

/**
 * The name plate over a station: at most 8 glyphs, font-safe. The same in every
 * environment — what the environment changes rides on the station's TAG
 * (`frame.ts`: "FIXTURE", "VQS", "OFF"), so a plate's width is known when the
 * plan is laid out. `env` is taken so a future plate that does vary cannot be
 * added without every caller already passing it.
 */
export function stationPlate(station: Station, env: TraceEnvironment | null): string {
  void env;
  return PLATES[station];
}

const KEY_CLASS_LABELS: Readonly<Record<RedisKeyClass, string>> = {
  reference: "reference lists",
  page_cache: "page cache",
  trending_cache: "trending cache",
  sample_lock: "sample lock",
  fill_lock: "single-flight lock",
  deepen_lock: "deepening lock",
  summarize_lock: "summary lock",
  topic_budget: "topic budget",
  pending_ledger: "pending-job ledger",
  other: "other key",
};

/** What a Redis key class is for, in prose. */
export function keyClassLabel(key: RedisKeyClass): string {
  return KEY_CLASS_LABELS[key];
}

const JOB_LABELS: Readonly<Record<JobKind, string>> = {
  segment: "fill",
  topup: "top-up",
  fallback: "fallback fill",
  sample: "sample",
  deepen: "deepening",
  summarize: "summary",
};

const SOURCE_LABELS: Readonly<Record<RunSource, string>> = {
  vercel_queue: "a Vercel Queues delivery",
  bullmq: "a BullMQ attempt",
  drain: "the drain",
};

// ── numbers ──────────────────────────────────────────────────────────────────

/** "1 call was", "3 calls were": a count with the noun phrase it agrees with. */
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** An integer with comma thousands separators, independent of locale. */
function grouped(n: number): string {
  const digits = String(Math.round(Math.abs(n)));
  const out = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n < 0 ? `-${out}` : out;
}

/**
 * A duration in prose: "0.4 ms", "45 ms", "1,234 ms", "7.9 s", "305 s", "17 min",
 * "unknown". Milliseconds up to five seconds, because that is the scale the
 * request itself lives on and a reader comparing two touches should not have to
 * convert; seconds after that; minutes past ten of them (a drained run).
 */
export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "unknown";
  const abs = Math.abs(ms);
  if (abs < 10) return `${ms.toFixed(1)} ms`;
  if (abs < 5_000) return `${grouped(ms)} ms`;
  if (abs < 100_000) return `${(ms / 1000).toFixed(1)} s`;
  if (abs < 600_000) return `${grouped(ms / 1000)} s`;
  return `${grouped(ms / 60_000)} min`;
}

/**
 * A duration for the canvas: uppercase, no spaces, at most 7 glyphs — "0.4MS",
 * "712MS", "1.2S", "305S", "17MIN", "?" for no end. Used in the second half of a
 * dwell's bubble and in the HUD clock.
 */
export function canvasMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "?";
  const abs = Math.max(0, ms);
  if (abs < 10) return `${abs.toFixed(1)}MS`;
  if (abs < 1000) return `${Math.round(abs)}MS`;
  if (abs < 10_000) return `${(abs / 1000).toFixed(1)}S`;
  if (abs < 1_000_000) return `${Math.round(abs / 1000)}S`;
  return `${Math.round(abs / 60_000)}MIN`;
}

// ── captions (canvas) ────────────────────────────────────────────────────────

const FAILURE_CAPTIONS: Readonly<Record<UpstreamFailure, string>> = {
  quota: "NO QUOTA",
  circuit_open: "TRIPPED",
  timeout: "TIMEOUT",
  caller_aborted: "ABORTED",
  upstream: "UPSTREAM",
  schema: "SCHEMA",
  auth: "AUTH",
  blocked: "BLOCKED",
  invalid_query: "BAD QUERY",
  answered: "NO ANSWER",
  unreachable: "NO CONN",
  unknown: "FAILED",
};

const CALL_CAPTIONS = {
  search: "SEARCH",
  latest_news: "LATEST",
  available_languages: "LANGUAGES",
  available_regions: "REGIONS",
  available_categories: "CATEGORIES",
  generate: "GENERATE",
} as const;

const OUTCOME_CAPTIONS: Readonly<Record<TouchOutcome, string>> = {
  ok: "OK",
  hit: "HIT",
  miss: "MISS",
  acquired: "ACQUIRED",
  held: "HELD",
  released: "RELEASED",
  lost: "LOST",
  not_ready: "NO CONN",
  failed: "FAILED",
  open: "OPEN",
  refused: "REFUSED",
  counted: "COUNTED",
  limited: "429",
  fail_open: "FAIL OPEN",
  stale: "STALE",
};

/** The touch among a stop's that its outcome came from: the first with that outcome. */
function leading(stop: Stop): Touch | undefined {
  return stop.touches.find((t) => t.outcome === stop.outcome) ?? stop.touches[0];
}

/** The distinct Redis commands of a stop, first seen first. */
function redisCommands(stop: Stop): string[] {
  return [...new Set(stop.touches.map((t) => (t.station === "redis" ? t.command : "other")))];
}

/** The distinct Postgres operations of a stop, first seen first. */
function pgOperations(stop: Stop): string[] {
  return [...new Set(stop.touches.map((t) => (t.station === "postgres" ? t.operation : "raw")))];
}

function baseCaption(stop: Stop): string {
  const touch = leading(stop);
  if (stop.outcome === "open") return "OPEN";
  if (!touch) return OUTCOME_CAPTIONS[stop.outcome];
  switch (touch.station) {
    case "rate_limit": {
      if (stop.outcome !== "counted") return OUTCOME_CAPTIONS[stop.outcome];
      if (touch.limit === null || touch.remaining === null) return "COUNTED";
      const left = `${touch.remaining}/${touch.limit}`;
      return left.length <= CAPTION_MAX ? left : "COUNTED";
    }
    case "redis": {
      if (stop.outcome !== "ok") return OUTCOME_CAPTIONS[stop.outcome];
      // A plain "ok" says nothing; the command does — unless the stop mixed several.
      const commands = redisCommands(stop);
      return commands.length === 1 && touch.command !== "other" ? touch.command : "OK";
    }
    case "postgres": {
      // One kind of statement says which; a mix, or raw SQL, is just SQL.
      const ops = pgOperations(stop);
      const only = ops.length === 1 ? ops[0] : undefined;
      return only === undefined || only === "raw" ? "SQL" : only.toUpperCase();
    }
    case "currents":
    case "google_news":
    case "gemini":
      if (stop.outcome === "ok") return CALL_CAPTIONS[touch.call];
      return touch.failure ? FAILURE_CAPTIONS[touch.failure] : OUTCOME_CAPTIONS[stop.outcome];
    case "queue":
      return stop.outcome === "ok" ? "QUEUED" : OUTCOME_CAPTIONS[stop.outcome];
    case "edge":
      return OUTCOME_CAPTIONS[stop.outcome];
  }
}

/**
 * A stop's bubble: at most 10 uppercase glyphs, font-safe — "HIT", "MISS",
 * "ACQUIRED", "117/120", "429", "OPEN", "NO CONN", "NO QUOTA". A merged stop leads
 * with its count ("×5 NO CONN") and keeps only the count ("×181") when the two
 * together would not fit.
 */
export function captionFor(stop: Stop): string {
  const base = baseCaption(stop);
  if (stop.count <= 1) return base.slice(0, CAPTION_MAX);
  const count = `×${stop.count}`;
  const both = `${count} ${base}`;
  return both.length <= CAPTION_MAX ? both : count.slice(0, CAPTION_MAX);
}

// ── describing (DOM) ─────────────────────────────────────────────────────────

const OUTCOME_WORDS: Readonly<Record<TouchOutcome, string>> = {
  ok: "ok",
  hit: "hit",
  miss: "miss",
  acquired: "acquired",
  held: "already held by another request",
  released: "released",
  lost: "lost (it expired mid-call)",
  not_ready: "not ready (no connection yet)",
  failed: "failed",
  open: "still running when the record was sealed",
  refused: "refused",
  counted: "counted",
  limited: "limited (429)",
  fail_open: "failed open (the limiter could not reach Redis)",
  stale: "stale",
};

const FAILURE_WORDS: Readonly<Record<UpstreamFailure, string>> = {
  quota: "out of quota",
  circuit_open: "the circuit breaker is open",
  timeout: "timed out",
  caller_aborted: "the caller gave up",
  upstream: "the upstream failed",
  schema: "the answer did not match its schema",
  auth: "not authorised",
  blocked: "blocked",
  invalid_query: "an invalid query",
  answered: "answered with nothing usable",
  unreachable: "unreachable",
  unknown: "an unknown error",
};

const CALL_WORDS = {
  search: "search",
  latest_news: "latest news",
  available_languages: "available languages",
  available_regions: "available regions",
  available_categories: "available categories",
  generate: "generate",
} as const;

function jobName(ref: string, job: JobKind | undefined): string {
  return job ? `Job ${ref} (${JOB_LABELS[job]})` : `Job ${ref}`;
}

function runOf(timeline: Timeline, step: Step): JobRun | null {
  return step.part.kind === "run" ? (timeline.response.runs[step.part.run] ?? null) : null;
}

/** "Job 4 (fill), attempt 2" — the attempt only when the ref ran more than once. */
function runLabel(timeline: Timeline, run: JobRun, index: number): string {
  const attempts = timeline.response.runs
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.ref === run.ref)
    .sort((a, b) => Date.parse(a.r.startedAt) - Date.parse(b.r.startedAt) || a.i - b.i);
  const name = jobName(run.ref, run.job);
  if (attempts.length <= 1) return name;
  const n = attempts.findIndex(({ i }) => i === index) + 1;
  return `${name}, attempt ${n}`;
}

function partLabel(timeline: Timeline, step: Step): string {
  const run = runOf(timeline, step);
  if (run && step.part.kind === "run") return runLabel(timeline, run, step.part.run);
  if (step.actor.startsWith("helper")) return "Request, in parallel";
  return "Request";
}

/** The station-specific middle of a stop's description. */
function stopDetail(stop: Stop, env: TraceEnvironment | null): string[] {
  const touch = leading(stop);
  const parts: string[] = [stationName(stop.station, env)];
  if (!touch) return parts;
  switch (touch.station) {
    case "rate_limit":
      parts.push(
        touch.limit !== null && touch.remaining !== null
          ? `inferred · ${touch.remaining} of ${touch.limit} left`
          : "inferred",
      );
      break;
    case "redis": {
      parts.push(redisCommands(stop).join(", "), keyClassLabel(touch.key));
      break;
    }
    case "postgres": {
      const ops = pgOperations(stop);
      parts.push(
        stop.count > 1 ? `${stop.count} statements (${ops.join(", ")})` : ops.join(", "),
        stop.tables.length > 0 ? stop.tables.join(", ") : "no table named",
      );
      break;
    }
    case "currents":
    case "google_news":
    case "gemini": {
      const calls = [...new Set(stop.touches.map((t) => ("call" in t ? CALL_WORDS[t.call] : "")))];
      const purpose = touch.station === "gemini" && touch.purpose ? ` (${touch.purpose})` : "";
      parts.push(`${calls.join(" and ")}${purpose}`);
      if (touch.priority) parts.push(touch.priority);
      break;
    }
    case "queue": {
      const refs = stop.touches.flatMap((t) => (t.station === "queue" ? [t.ref] : []));
      const kinds = stop.touches.flatMap((t) => (t.station === "queue" ? [JOB_LABELS[t.job]] : []));
      const jobs = [...new Set(kinds)];
      parts.push(
        refs.length === 1
          ? `${jobs.join(", ")} job enqueued (ref ${refs[0]})`
          : `${refs.length} ${jobs.join(", ")} jobs enqueued (refs ${refs.join(", ")})`,
      );
      const unlinked = stop.touches.filter((t) => t.station === "queue" && !t.linked).length;
      if (unlinked > 0) parts.push(`${unlinked} not linked`);
      break;
    }
    case "edge":
      break;
  }
  // Postgres and queue stops already said how many.
  const counted = touch.station === "postgres" || touch.station === "queue";
  if (stop.count > 1 && !counted) parts.push(`×${stop.count}`);
  if (stop.parallel > 1) parts.push(`${stop.parallel} at once`);
  const failure = stop.touches.flatMap((t) => ("failure" in t && t.failure ? [t.failure] : []))[0];
  const outcome = OUTCOME_WORDS[stop.outcome];
  parts.push(failure ? `${outcome} (${FAILURE_WORDS[failure]})` : outcome);
  // An open stop's outcome words already say it never ended; a merged stop that
  // is only partly open says so here instead of a duration it does not have.
  if (stop.realEnd !== null) parts.push(formatMs(stop.realEnd - stop.realAt));
  else if (stop.outcome !== "open") parts.push("no end observed");
  return parts;
}

/**
 * One step in prose, for the step list and the scrubber:
 * "Step 6 of 23 · Request · Redis · SET · single-flight lock · acquired · 1.1 ms",
 * "Step 19 of 23 · Job 4 (fill), attempt 2 · started 308 s after the request".
 */
export function describeStep(step: Step, timeline: Timeline): string {
  const head = `Step ${step.index + 1} of ${timeline.steps.length}`;
  const trace = timeline.response.trace;
  const env = trace.origin?.environment ?? null;
  const part = partLabel(timeline, step);
  const run = runOf(timeline, step);
  const body = ((): string[] => {
    switch (step.kind) {
      case "arrive": {
        const notes: string[] = [];
        const first = trace.origin?.instanceSequence === 1;
        if (first) notes.push("the first request this instance served");
        if (trace.origin?.redisAtStart === "connecting") notes.push("Redis still connecting");
        return [part, `${routeProse(trace)} arrives`, ...notes];
      }
      case "stop":
        return step.stop ? [part, ...stopDetail(step.stop, env)] : [part];
      case "elided": {
        const e = step.elided;
        if (!e) return [part, "touches not kept"];
        const where = Object.entries(e.stations)
          .map(([s, n]) => `${stationName(s as Station, env)} ${n}`)
          .join(", ");
        return [
          part,
          `${e.count} touches not kept (${where})`,
          `${formatMs(e.fromAt)} to ${formatMs(e.toAt)} into the record`,
        ];
      }
      case "think":
        return [part, `working in code for ${formatMs(step.realMs)}, no station touched`];
      case "later":
        return [part, `${formatMs(step.realMs)} pass`];
      case "respond": {
        const meta = trace.meta ? servedFrom(trace) : [];
        return [part, `responds ${trace.status} after ${formatMs(trace.ms)}`, ...meta];
      }
      case "run": {
        if (!run) return [part];
        const notes = [
          `started ${formatMs(step.realAt)} after the request`,
          `on ${SOURCE_LABELS[run.source]}`,
        ];
        if (run.sharedWith > 1) {
          notes.push(`shared with ${plural(run.sharedWith - 1, "other trace", "other traces")}`);
        }
        return [part, ...notes];
      }
      case "run_end": {
        if (!run) return [part];
        return [
          part,
          run.result === "ok"
            ? `finished ok in ${formatMs(run.ms)}`
            : `threw${run.failure ? ` (${FAILURE_WORDS[run.failure]})` : ""} after ` +
              `${formatMs(run.ms)}; it may be redelivered`,
        ];
      }
      case "unobserved": {
        const job = findEnqueue(timeline.response, step.jobRef ?? "")?.job;
        return [jobName(step.jobRef ?? "?", job), "no run recorded"];
      }
    }
  })();
  return [head, ...body].join(" · ");
}

function findEnqueue(response: TraceReadResponse, ref: string) {
  for (const record of [response.trace, ...response.runs]) {
    for (const t of record.touches) if (t.station === "queue" && t.ref === ref) return t;
  }
  return undefined;
}

const ROUTE_PATHS: Readonly<Record<RequestTrace["route"], string>> = {
  timeline_search: "/api/v1/timeline",
  timeline_view: "/api/v1/timeline",
  storylines_search: "/api/v1/storylines",
  storyline_open: "/api/v1/storylines/:id/refresh",
  trending: "/api/v1/trending",
  reference: "/api/v1/reference",
};

const ROUTE_KINDS: Readonly<Record<RequestTrace["route"], string>> = {
  timeline_search: "search",
  timeline_view: "view",
  storylines_search: "storyline search",
  storyline_open: "open",
  trending: "trending",
  reference: "reference",
};

function routeProse(trace: RequestTrace): string {
  return `${trace.method} ${ROUTE_PATHS[trace.route]}`;
}

const SERVED_FROM = {
  cache: "served from cache",
  store: "served from the store",
  upstream: "served from upstream",
} as const;

function servedFrom(trace: RequestTrace): string[] {
  const meta = trace.meta;
  if (!meta) return [];
  const from = SERVED_FROM[meta.servedFrom];
  const out: string[] = [from];
  if (meta.stale) out.push("stale");
  if (meta.degraded) out.push(`degraded (${meta.degraded})`);
  if (meta.ingest.state === "in_progress") {
    out.push(
      meta.ingest.pendingJobs > 0
        ? `${meta.ingest.pendingJobs} job${meta.ingest.pendingJobs === 1 ? "" : "s"} pending`
        : "ingest in progress",
    );
  }
  return out;
}

/**
 * The trace in one line, for the status plate:
 * "GET /api/v1/timeline (search, q) → 200 in 1,204 ms · served from upstream · 4 jobs pending".
 */
export function describeHeadline(trace: RequestTrace): string {
  const kind = ROUTE_KINDS[trace.route];
  const views = trace.viewStorylines;
  const view = views ? ` of ${plural(views, "storyline", "storylines")}` : "";
  const keys = trace.queryKeys.length > 0 ? `, ${trace.queryKeys.join(", ")}` : "";
  const answer = `${trace.status} in ${formatMs(trace.ms)}`;
  const parts = [`${routeProse(trace)} (${kind}${view}${keys}) → ${answer}`];
  parts.push(...servedFrom(trace));
  if (trace.planes) {
    parts.push(
      `refresh ${trace.planes.refresh.replace("_", " ")}`,
      `deepening ${trace.planes.deepening}`,
      `summaries ${trace.planes.summaries}`,
    );
  }
  const edge = edgeAnswer(trace);
  if (edge === "cache") parts.push("answered at the CDN edge; no function ran");
  if (edge === "timeout") parts.push("the platform answered in the API's place; nothing was recorded");
  return parts.join(" · ");
}

/**
 * What the request asked for, in words (ADR-0031), or null when it named nothing:
 * `“quokka zebra” (en, AU)`, `storyline “Nepal Flash Floods”`, or — where the reply carried no
 * label, as a storyline open's does not — the storyline's id.
 */
export function describeSubject(subject: TraceSubject | null | undefined): string | null {
  if (!subject) return null;
  const parts: string[] = [];
  if (subject.keywords !== undefined) parts.push(`“${subject.keywords}”`);
  if (subject.storylines && subject.storylines.length > 0) {
    const names = subject.storylines.map((s) => (s.label ? `“${s.label}”` : s.id));
    parts.push(`${subject.storylines.length === 1 ? "storyline" : "storylines"} ${names.join(", ")}`);
  }
  if (parts.length > 0) {
    const filters = [subject.language, subject.country].filter((f) => f !== undefined);
    if (filters.length > 0) parts.push(`(${filters.join(", ")})`);
  } else {
    // Filters alone (a trending cloud's language, a 400 whose keywords were refused): named.
    if (subject.language !== undefined) parts.push(`language ${subject.language}`);
    if (subject.country !== undefined) parts.push(`country ${subject.country}`);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * One recent trace as the dropdown lists it:
 * "12:04:31 · search “quokka zebra” → 200 in 812 ms". `time` formats the start (a parameter so
 * a test need not depend on the machine's time zone).
 */
export function describeSummary(summary: TraceSummary, time: (iso: string) => string): string {
  const subject = describeSubject(summary.subject);
  const kind = ROUTE_KINDS[summary.route];
  const ask = subject === null ? kind : `${kind} ${subject}`;
  return `${time(summary.startedAt)} · ${ask} → ${summary.status} in ${formatMs(summary.ms)}`;
}

/**
 * What a trace with no origin says answered it, read off its one edge touch —
 * or null for a trace a function recorded, which is every trace the API stores.
 *
 * Kept for the renderer's sake rather than the page's: the record panel that
 * drew such traces in the browser (a CDN hit, a platform 504) went with
 * ADR-0031, and only the `edge-hit` fixture still has one. Two stories share
 * `origin: null`: an edge `hit`/`stale` is the CDN's cache answering, so no
 * function ran; an edge `miss` was a platform 504, where a function most likely
 * DID run and hit its time limit — and "no function ran" must never be said of it.
 */
function edgeAnswer(trace: RequestTrace): "cache" | "timeout" | null {
  if (trace.origin !== null) return null;
  const edge = trace.touches.find((t) => t.station === "edge");
  return edge?.outcome === "miss" ? "timeout" : "cache";
}

/** The route for the canvas HUD, font-safe: "GET /API/V1/TIMELINE". */
export function routeLabel(trace: RequestTrace): string {
  return `${trace.method} ${ROUTE_PATHS[trace.route].replace(":id", "ID")}`.toUpperCase();
}

// ── honesty ──────────────────────────────────────────────────────────────────


/**
 * What the page cannot see, or is only guessing, about this trace — each note
 * present only when it applies. Shown under the stage as the legend.
 */
export function honestyNotes(response: TraceReadResponse): readonly string[] {
  const { trace, runs } = response;
  const notes: string[] = [];
  const records = [trace, ...runs];
  const all = records.flatMap((r) => r.touches);
  const upstream = new Set<Station>(["queue", "currents", "google_news", "gemini"]);

  const edge = edgeAnswer(trace);
  if (edge === "cache") {
    notes.push(
      "No function ran: the CDN answered, so the browser drew this trace from the " +
        "response headers.",
    );
  }
  if (edge === "timeout") {
    notes.push(
      "Nothing was recorded: the platform answered 504 in the API's place — most likely " +
        "the function reached its time limit before its trace could be stored — so the " +
        "browser drew this from the response alone.",
    );
  }
  if (trace.touches.some((t) => t.station === "rate_limit")) {
    notes.push(
      "The rate-limit step is inferred from hook timing and the x-ratelimit headers, not observed.",
    );
  }
  const open = trace.touches.filter((t) => t.ms === null).length;
  if (open > 0) {
    notes.push(`${plural(open, "call was", "calls were")} still running when the response left.`);
  }
  const elided = records.reduce((n, r) => n + (r.elided?.count ?? 0), 0);
  if (elided > 0) {
    notes.push(
      `${plural(elided, "touch was", "touches were")} elided: the middle of a record past ` +
        "its cap is counted, not kept.",
    );
  }
  if (all.some((t) => upstream.has(t.station))) {
    notes.push(
      "Quota bookkeeping and the queue's own Redis commands happen inside their stations " +
        "and are not drawn separately.",
    );
  }
  if (runs.length > 0) {
    notes.push("Job run offsets come from wall clocks on different instances and are approximate.");
  }
  const enqueues = all.flatMap((t) => (t.station === "queue" ? [t] : []));
  const unlinked = enqueues.filter((t) => !t.linked).length;
  if (unlinked > 0) {
    const them = unlinked === 1 ? "it" : "them";
    notes.push(
      `${plural(unlinked, "enqueue was", "enqueues were")} not linked, so no run of ${them} ` +
        "can be found.",
    );
  }
  const ran = new Set(runs.map((r) => r.ref));
  const missing = new Set(enqueues.filter((t) => t.linked && !ran.has(t.ref)).map((t) => t.ref));
  if (missing.size > 0) {
    notes.push(
      `${plural(missing.size, "linked job has", "linked jobs have")} no recorded run: the ` +
        "run started before the link, ran on an older deployment, or has not happened yet.",
    );
  }
  if (runs.some((r) => r.sharedWith > 1)) {
    notes.push(
      "A job run was shared with another trace: the queue deduplicated a job both asked for.",
    );
  }
  const overhead = records.reduce((n, r) => n + r.overheadMs, 0);
  if (overhead > 0) {
    notes.push(
      `The tracer spent ${formatMs(overhead)} of its own writing job links; it is not drawn.`,
    );
  }
  if (records.some((r) => r.origin?.environment.currents === "fixture")) {
    notes.push("Currents is in fixture mode: its calls answer from a local corpus, in no time.");
  }
  if (runs.length >= MAX_TRACE_RUNS) {
    notes.push(`At most ${MAX_TRACE_RUNS} job runs are kept per trace.`);
  }
  return notes;
}
