import type { Redis } from "ioredis";
import type { Config } from "@zammy/config";
import {
  JOB_REF_PATTERN,
  JobRun,
  MAX_RECENT_TRACES,
  MAX_RUN_LINKS,
  MAX_TRACE_RUNS,
  MAX_TRACE_TOUCHES,
  RequestTrace,
  TRACE_ID_PATTERN,
  type RedisStatus,
  type RunSource,
  type TraceEnvironment,
  type TraceOrigin,
  type TraceReadResponse,
  type TraceSummary,
} from "@zammy/shared/request-trace";
import { TRACE_UNSTORED_MESSAGE } from "./observations.js";
import { waitForRedis } from "./redis-ready.js";
import type { ServiceLogger } from "./server.js";
import { redisStatusOf } from "./trace-redact.js";

/**
 * Where traces live, and the per-process state tracing needs (ADR-0029).
 *
 * **Three keys per trace and one shared list, all scoped by the queue's name**
 * the way `<queue>:trending:*` is — so production's are `ingest:trace:*`, and a
 * test harness's uniquely-named queue can never read or clobber them:
 *
 *   <q>:trace:<id>            the request record, a string, SET … PX ttl
 *   <q>:trace:<id>:runs       its job runs, a list, RPUSH (≤ MAX_TRACE_RUNS)
 *   <q>:trace:job:<jobId>     a SET of `<traceId>|<ref>` — which traces a job owes a run to
 *   <q>:trace:recent          the newest trace ids, a list, LPUSH + LTRIM (≤ MAX_RECENT_TRACES)
 *
 * The recent list (ADR-0031) holds ids only; `readRecent` reads the records
 * they name, so an entry whose record has expired simply drops out of the
 * answer rather than being listed as a trace nobody can open.
 *
 * The job key is the whole of the linkage. A job's own id and payload are
 * untouched — `parseIngestJob` whitelists fields, so a `traceId` on the
 * payload would vanish under Vercel Queues and survive under BullMQ, and a
 * trace id in `ingestJobId` would break the dedup the id exists for. So the
 * link sits BESIDE the job, keyed by the id every consumer already has.
 *
 * **Every call uses the raw boot client and fails open, bounded.** Traces are
 * diagnostics: losing one costs that trace and nothing else. So every method
 * except `readTrace` answers `false`/`[]`/`"failed"` rather than throwing, and
 * each has a deadline (the `TRACE_*_MS` constants below; ADR-0029's "What it
 * costs" gives what they add to a traced request) so a slow Redis costs a
 * traced request a bounded delay rather than a stall:
 *
 *   - the trace write waits up to `TRACE_READY_WAIT_MS` for a cold client to
 *     finish its handshake — the boot client has `enableOfflineQueue: false`,
 *     so a write issued mid-handshake would otherwise be refused instantly and
 *     every cold instance's first trace lost — then `TRACE_WRITE_DEADLINE_MS`;
 *   - the job link does NOT wait (it sits in front of a publish on the request
 *     path, and a cold instance must behave as it would untraced), and neither
 *     does the consumer's lookup: both get `TRACE_LINK_DEADLINE_MS`.
 *
 * `readTrace` is the exception, and throws `TraceStoreUnavailable` on a Redis
 * error so the read route can answer 503 rather than a 404 that would tell the
 * page the trace does not exist.
 *
 * What it deliberately does NOT do: PTTL. `expiresAt` is computed from the
 * record's own `startedAt` and the configured TTL, which saves a command per
 * poll and is exact to within the trace's own duration.
 */

/** How long the trace write waits for a cold client's handshake. */
export const TRACE_READY_WAIT_MS = 1_500;
/**
 * After a ready-wait that ran out, how long the next writes skip the wait and go straight
 * to the (refused, instant) write. Since ADR-0031 every traceable reader request is traced,
 * so a Redis that stays down would otherwise hold EVERY traced reply for the full wait; with
 * this, an instance pays it at most once a minute and the rest answer `unstored` at once.
 */
export const TRACE_READY_BACKOFF_MS = 60_000;
/** The trace write itself, once the client is ready (or given up on). */
export const TRACE_WRITE_DEADLINE_MS = 300;
/** A job link, the consumer's lookup, and a consumed link. */
export const TRACE_LINK_DEADLINE_MS = 250;
/** How often a store failure may be warned about, per process. */
export const TRACE_WARN_INTERVAL_MS = 60_000;

/** The one error `readTrace` throws: Redis answered with an error, or not at all. */
export class TraceStoreUnavailable extends Error {
  override readonly name = "TraceStoreUnavailable";
}

export const traceKey = (queue: string, id: string): string => `${queue}:trace:${id}`;
export const traceRunsKey = (queue: string, id: string): string => `${queue}:trace:${id}:runs`;
export const traceJobKey = (queue: string, jobId: string): string =>
  `${queue}:trace:job:${jobId}`;
export const traceRecentKey = (queue: string): string => `${queue}:trace:recent`;

/** One trace a job owes a run to, and the ref that trace knows the job by. */
export interface JobLink {
  traceId: string;
  ref: string;
}

/**
 * What became of one appended run.
 *
 *   stored   in the list, and read back by the next poll;
 *   capped   Redis TOOK it, and the trim to the first `MAX_TRACE_RUNS` then
 *            dropped it — the designed omission ADR-0029 lists among what a
 *            trace does not record ("any past the sixteenth"), not a failure;
 *   failed   a command errored or missed its deadline: Redis may not have it.
 *
 * Three rather than a boolean because the one caller warns on a failure, and a
 * capped run reported as one sends the operator looking at a Redis that is fine.
 */
export type AppendOutcome = "stored" | "capped" | "failed";

/** `<uuid>|<jobref>`, the job set's member format, parsed back. */
const LINK_MEMBER = new RegExp(
  `^(${TRACE_ID_PATTERN.source.slice(1, -1)})\\|(${JOB_REF_PATTERN.source.slice(1, -1)})$`,
);

/**
 * Everything tracing needs that outlives one request: the bounds, the
 * process's counter, and the store.
 *
 * Present on `Services` only when `REQUEST_TRACE_ENABLED` — its absence is how
 * every other module knows tracing is off, which is what makes "off" cost
 * nothing rather than a flag check per request.
 */
export interface TraceRuntime {
  readonly ttlMs: number;
  /** Config's cap, never above `MAX_TRACE_TOUCHES`. */
  readonly maxTouches: number;
  readonly queueName: string;
  readonly environment: TraceEnvironment;
  /** The consumer a run is labelled with when the caller names none: the queue driver's. */
  readonly defaultSource: RunSource;
  readonly log: ServiceLogger;
  /** A per-process counter, from 1: every request and job run this instance handled while on. */
  nextSequence(): number;
  /** The boot client's status, folded. */
  redisStatus(): RedisStatus;
  origin(sequence: number, redisAtStart: RedisStatus): TraceOrigin;
  /**
   * Store a PARSED record and put its id at the head of the recent list. The
   * answer is the RECORD's: true once it is stored, whatever became of the list
   * entry (a trace missing from the dropdown can still be opened by its id).
   * Bounded by ready-wait + write deadline.
   */
  putTrace(trace: RequestTrace): Promise<boolean>;
  /** Write a job's links before it is published. False on any failure; no ready-wait. */
  linkJob(jobId: string, links: readonly JobLink[]): Promise<boolean>;
  /** The consumer's lookup: parsed, capped, deduplicated, sorted. `[]` on any failure. */
  linksForJob(jobId: string): Promise<JobLink[]>;
  /** Append a PARSED run. `failed` on any failure; never throws. */
  appendRun(traceId: string, run: JobRun): Promise<AppendOutcome>;
  /** Remove a job's links after an ok run, so a later identical job is not appended here. */
  consumeLinks(jobId: string, links: readonly JobLink[]): Promise<void>;
  /** The read route's body, or null for an unknown, expired or unparseable trace. */
  readTrace(id: string): Promise<TraceReadResponse | null>;
  /**
   * The recent list's body (ADR-0031): the newest records still stored, newest
   * first, as summaries. Throws `TraceStoreUnavailable` on a Redis error, as
   * `readTrace` does.
   */
  readRecent(): Promise<TraceSummary[]>;
  /**
   * `TRACE_UNSTORED_MESSAGE`, at most once per `TRACE_WARN_INTERVAL_MS`, with a
   * count of how many were folded into it. `fields` must be classes and paths,
   * never content.
   */
  warnUnstored(fields: { reason: string; [field: string]: unknown }): void;
}

/** A value, or the rejection of whichever is first: the value or the deadline. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  // The command keeps running past a deadline; its eventual rejection must not
  // become an unhandled one.
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`trace store deadline ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Run each command and reject with the FIRST failure, keeping the others'
 * rejections handled so none becomes an unhandled one.
 *
 * It must reject, not settle: `linkJob` answers `false` off that rejection, and
 * a link that reads `true` over a refused `SADD` is a queue touch drawn
 * `linked: true` whose run can never arrive, and a page that goes on polling
 * for it. `Promise.allSettled` here would be exactly that bug.
 */
function settled<T>(promises: Array<Promise<T>>): Promise<T[]> {
  for (const promise of promises) promise.catch(() => {});
  return Promise.all(promises);
}

export function createTraceRuntime(
  config: Config,
  deps: {
    redis: Redis;
    queueName: string;
    environment: TraceEnvironment;
    log: ServiceLogger;
    /** Milliseconds, for the warning throttle. */
    clock?: () => number;
  },
): TraceRuntime {
  const { redis, queueName, environment, log } = deps;
  const clock = deps.clock ?? Date.now;
  const ttlMs = config.REQUEST_TRACE_TTL_SECONDS * 1000;
  let sequence = 0;
  let lastWarnedAt: number | null = null;
  let folded = 0;
  /** When the last ready-wait ran out, for `TRACE_READY_BACKOFF_MS`. */
  let readyWaitFailedAt: number | null = null;

  const members = (links: readonly JobLink[]): string[] =>
    links.map((link) => `${link.traceId}|${link.ref}`);

  return {
    ttlMs,
    maxTouches: Math.min(config.REQUEST_TRACE_MAX_TOUCHES, MAX_TRACE_TOUCHES),
    queueName,
    environment,
    defaultSource: config.INGEST_QUEUE_DRIVER === "vercel" ? "vercel_queue" : "bullmq",
    log,

    nextSequence() {
      sequence += 1;
      return sequence;
    },

    redisStatus() {
      return redisStatusOf(redis.status);
    },

    origin(instanceSequence, redisAtStart) {
      return { instanceSequence, redisAtStart, environment };
    },

    async putTrace(trace) {
      try {
        // `end` is terminal — a client closed for good never becomes ready on its
        // own — so it is not worth the wait.
        // And a wait that ran out recently is not repeated: a Redis that is down stays down
        // for longer than one request, and every traced reader would pay it.
        const backingOff =
          readyWaitFailedAt !== null && clock() - readyWaitFailedAt < TRACE_READY_BACKOFF_MS;
        if (redis.status !== "ready" && redis.status !== "end" && !backingOff) {
          await waitForRedis(redis, TRACE_READY_WAIT_MS).then(
            () => {
              readyWaitFailedAt = null;
            },
            () => {
              readyWaitFailedAt = clock();
            },
          );
        }
        // One round trip, in order: the record lands before its id is listed,
        // so a dropdown read between the two can never name a missing trace.
        // A pipeline, not MULTI — nothing here needs the four to be atomic.
        const recent = traceRecentKey(queueName);
        const results = await withDeadline(
          redis
            .pipeline()
            .set(traceKey(queueName, trace.id), JSON.stringify(trace), "PX", ttlMs)
            .lpush(recent, trace.id)
            .ltrim(recent, 0, MAX_RECENT_TRACES - 1)
            .pexpire(recent, ttlMs)
            .exec(),
          TRACE_WRITE_DEADLINE_MS,
        );
        const [set] = results ?? [];
        return set !== undefined && set[0] === null;
      } catch {
        return false;
      }
    },

    async linkJob(jobId, links) {
      if (links.length === 0) return false;
      try {
        const key = traceJobKey(queueName, jobId);
        await withDeadline(
          settled([redis.sadd(key, ...members(links)), redis.pexpire(key, ttlMs)]),
          TRACE_LINK_DEADLINE_MS,
        );
        return true;
      } catch {
        return false;
      }
    },

    async linksForJob(jobId) {
      try {
        const raw = await withDeadline(
          redis.smembers(traceJobKey(queueName, jobId)),
          TRACE_LINK_DEADLINE_MS,
        );
        const links: JobLink[] = [];
        for (const member of [...raw].sort()) {
          const match = LINK_MEMBER.exec(member);
          if (match?.[1] === undefined || match[2] === undefined) continue;
          links.push({ traceId: match[1], ref: match[2] });
          if (links.length >= MAX_RUN_LINKS) break;
        }
        return links;
      } catch {
        return [];
      }
    },

    async appendRun(traceId, run) {
      try {
        const key = traceRunsKey(queueName, traceId);
        const pushed = await withDeadline(
          (async () => {
            const length = await redis.rpush(key, JSON.stringify(run));
            await redis.pexpire(key, ttlMs);
            // The FIRST runs are kept: the original deliveries are the story, and
            // a run past the sixteenth is usually a redelivery of one already
            // there. Not always — a search that fans out to many child jobs can
            // pass sixteen on first runs alone — which is the price of a bound.
            if (length > MAX_TRACE_RUNS) await redis.ltrim(key, 0, MAX_TRACE_RUNS - 1);
            return length;
          })(),
          TRACE_WRITE_DEADLINE_MS,
        );
        // RPUSH's reply is the list's length WITH this run at its end, so past
        // the cap it is this run the trim removed, and nothing already there.
        return pushed > MAX_TRACE_RUNS ? "capped" : "stored";
      } catch {
        return "failed";
      }
    },

    async consumeLinks(jobId, links) {
      if (links.length === 0) return;
      try {
        await withDeadline(
          redis.srem(traceJobKey(queueName, jobId), ...members(links)),
          TRACE_LINK_DEADLINE_MS,
        );
      } catch {
        // The links expire with their TTL; a later identical job may be
        // appended to this trace until then, which is the cost and all of it.
      }
    },

    async readTrace(id) {
      let raw: string | null;
      let runs: string[];
      try {
        [raw, runs] = await Promise.all([
          redis.get(traceKey(queueName, id)),
          redis.lrange(traceRunsKey(queueName, id), 0, MAX_TRACE_RUNS - 1),
        ]);
      } catch (error) {
        throw new TraceStoreUnavailable(
          error instanceof Error ? error.message : "trace store unavailable",
        );
      }
      if (raw === null) return null;

      let record: unknown;
      try {
        record = JSON.parse(raw);
      } catch {
        return null;
      }
      // A future `v`, or a record this build cannot read, is "unknown" — the
      // page can do nothing better with it than with a missing one.
      const trace = RequestTrace.safeParse(record);
      if (!trace.success || trace.data.id !== id) return null;

      const parsedRuns: JobRun[] = [];
      for (const entry of runs) {
        try {
          const run = JobRun.safeParse(JSON.parse(entry));
          if (run.success) parsedRuns.push(run.data);
        } catch {
          // An unparseable run is dropped; the rest of the trace still reads.
        }
      }
      parsedRuns.sort(
        (a, b) =>
          Date.parse(a.startedAt) - Date.parse(b.startedAt) ||
          (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
      );

      return {
        trace: trace.data,
        runs: parsedRuns,
        expiresAt: new Date(Date.parse(trace.data.startedAt) + ttlMs).toISOString(),
      };
    },

    async readRecent() {
      let summaries: TraceSummary[];
      try {
        const ids = [
          ...new Set(
            (await redis.lrange(traceRecentKey(queueName), 0, MAX_RECENT_TRACES - 1)).filter(
              (id) => TRACE_ID_PATTERN.test(id),
            ),
          ),
        ];
        if (ids.length === 0) return [];
        const raws = await redis.mget(...ids.map((id) => traceKey(queueName, id)));
        summaries = [];
        for (const [index, raw] of raws.entries()) {
          if (raw === null) continue;
          let record: unknown;
          try {
            record = JSON.parse(raw);
          } catch {
            continue;
          }
          const trace = RequestTrace.safeParse(record);
          if (!trace.success || trace.data.id !== ids[index]) continue;
          const { id, route, method, status, startedAt, ms, subject } = trace.data;
          summaries.push({
            id,
            route,
            method,
            status,
            startedAt,
            ms,
            ...(subject === undefined ? {} : { subject }),
          });
        }
      } catch (error) {
        throw new TraceStoreUnavailable(
          error instanceof Error ? error.message : "trace store unavailable",
        );
      }
      return summaries;
    },

    warnUnstored(fields) {
      folded += 1;
      const at = clock();
      if (lastWarnedAt !== null && at - lastWarnedAt < TRACE_WARN_INTERVAL_MS) return;
      lastWarnedAt = at;
      const count = folded;
      folded = 0;
      try {
        log.warn({ ...fields, count }, TRACE_UNSTORED_MESSAGE);
      } catch {
        // A logger that throws is not a reason for a request to.
      }
    },
  };
}
