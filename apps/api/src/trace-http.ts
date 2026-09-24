import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  RECENT_TRACES_PATH,
  RequestTrace,
  TRACE_ID_HEADER,
  TRACE_ID_PATTERN,
  TRACE_UNSTORED,
  type PlaneStatuses,
  type RedisStatus,
  type TraceMeta,
  type TraceQueryKey,
  type TraceRoute,
  type TraceSubject,
} from "@zammy/shared/request-trace";
import { TRACE_NOT_OPENED_MESSAGE } from "./observations.js";
import { createTouchScope, type TouchScope } from "./trace-deps.js";
import { createTouchRecorder, type TouchRecorder } from "./trace-recorder.js";
import {
  headerCount,
  metaFromBody,
  planesFromBody,
  queryKeysOf,
  rateLimitOutcome,
  subjectOf,
  traceRouteOf,
  viewStorylinesOf,
  withViewLabels,
} from "./trace-redact.js";
import { TraceStoreUnavailable, type TraceRuntime } from "./trace-store.js";

/**
 * Request tracing on the HTTP surface (ADR-0029, "The change" 2, 5 and 7, as
 * amended by ADR-0031): the lifecycle hooks that open and persist a trace,
 * `scopedDeps`, the read route the playback page polls, and the recent list its
 * dropdown is filled from.
 *
 * **Registered only when `REQUEST_TRACE_ENABLED`.** `server.ts` calls
 * `registerRequestTracing` iff `Services.tracing` exists, so a deployment with
 * the flag off has no hook, no decorator and no `/api/v1/traces/:id` —
 * Fastify's own 404 — and runs the code it ran before this file existed.
 *
 * **With it on, EVERY request to a traceable route is traced (ADR-0031).** There
 * is no header and no token: the flag is the whole of the opt-in. Two
 * per-instance bounds keep the cost of that bounded: `TRACE_OPENS_PER_MINUTE`
 * opens in a fixed minute, and `MAX_OPEN_TRACES` at once. Beyond either the
 * request is served untraced, with no signal.
 *
 * **An untraced request is unchanged, byte for byte and command for command.**
 * The hooks are callback-style (no promise per request), and for a request
 * that is not traced — a route that is not traceable, or one past the bounds —
 * each does one counter increment or one property read and calls `done`. No
 * Redis command, no allocation of a scope, and `scopedDeps` hands the handler
 * the boot bag BY IDENTITY.
 *
 * **Where each piece of a trace comes from:**
 *   - `onRequest` opens the scope. It runs before the rate limiter's route-level
 *     hook (Fastify runs instance hooks first), so it can time the limiter.
 *   - `preParsing` closes that timing: the limiter's touch is INFERRED from the
 *     gap between the two plus its `x-ratelimit-*` headers, because the limiter
 *     holds the boot client and no proxy of ours ever sees its EVALSHA.
 *   - the handler runs over `scopedDeps(request, boot)`, which records.
 *   - `preSerialization` notes the body's `meta`, plane statuses and — for a
 *     storyline view — the labels of the arcs it named; never the body itself.
 *   - `onSend` seals, parses, stores, and adds `x-zammy-trace-id` and
 *     `cache-control: no-store`. The PAYLOAD IS UNCHANGED; only a traced reply's
 *     headers differ, and `no-store` is what keeps a CDN from handing the traced
 *     answer (and its id) to the next caller.
 *
 * What it deliberately does NOT do: trace HEAD, OPTIONS, `/topics`, the health
 * checks or its own routes; record the path, the IP or any header, or a query
 * value anywhere but the record's `subject`; or let anything in here throw into
 * a request. Every hook body is
 * in a try, and a failed persist is `x-zammy-trace-id: unstored` plus a
 * throttled warning.
 */

/** Traces this instance opens per fixed minute; the rest are served untraced. */
export const TRACE_OPENS_PER_MINUTE = 30;
/** Traces open at once on this instance; the ninth concurrent request is served untraced. */
export const MAX_OPEN_TRACES = 8;
/** The read route's own rate-limit bucket, so trace polling never spends a reader's allowance. */
export const TRACE_READS_PER_MINUTE = 30;
/**
 * The recent list's bucket (ADR-0031), tighter than the read route's: the page reads it
 * three times a minute, and each read costs an `LRANGE` and an `MGET` of up to ten records
 * on an endpoint anyone can call.
 */
export const TRACE_LIST_READS_PER_MINUTE = 10;
/** The read route's pattern (`TRACE_ROUTE_PREFIX` + `:id`). */
export const TRACE_READ_ROUTE = "/api/v1/traces/:id";
/** The recent list's route (ADR-0031). */
export const TRACE_RECENT_ROUTE = RECENT_TRACES_PATH;

/** What a handler can do with the request's trace: wrap its deps. The rest is the hooks'. */
export interface RequestTraceScope {
  readonly id: string;
  readonly startedAt: Date;
  readonly recorder: TouchRecorder;
  wrap<T extends object>(bag: T): T;
}

declare module "fastify" {
  interface FastifyRequest {
    /** The open trace, or null — and absent altogether while tracing is off. */
    requestTrace: RequestTraceScope | null;
  }
}

/** Test seams. Production passes none. */
export interface RequestTracingOptions {
  /** Milliseconds, for the per-minute open budget. */
  clock?: () => number;
  /** How a scope's recorder is built — the tests inject one that throws. */
  createRecorder?: (maxTouches: number) => TouchRecorder;
}

/** The hooks' private half of a scope. */
class Scope implements RequestTraceScope {
  readonly id = randomUUID();
  readonly startedAt = new Date();
  readonly limiterStart: number;
  limiterEnd: number | null = null;
  meta: TraceMeta | null = null;
  planes: PlaneStatuses | null = null;
  #closed = false;
  readonly #touches: TouchScope;

  constructor(
    readonly recorder: TouchRecorder,
    runtime: TraceRuntime,
    readonly sequence: number,
    readonly redisAtStart: RedisStatus,
    readonly route: TraceRoute,
    readonly method: "GET" | "POST",
    readonly queryKeys: TraceQueryKey[],
    readonly viewStorylines: number | undefined,
    public subject: TraceSubject | null,
    private readonly onClose: () => void,
  ) {
    this.#touches = createTouchScope({ recorder, runtime, traceId: this.id, parentLinks: null });
    this.limiterStart = recorder.now();
  }

  wrap<T extends object>(bag: T): T {
    return this.#touches.wrap(bag);
  }

  noteBody(payload: unknown): void {
    this.meta = metaFromBody(payload);
    this.planes = planesFromBody(this.route, payload);
    this.subject = withViewLabels(this.route, this.subject, payload);
  }

  /** Seal if not already sealed, and give the slot back. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.recorder.seal();
    } catch {
      // Sealed or not, the slot is returned below.
    }
    this.onClose();
  }
}

function scopeOf(request: FastifyRequest): Scope | null {
  const scope = (request as { requestTrace?: unknown }).requestTrace;
  return scope instanceof Scope ? scope : null;
}

/**
 * Handler deps for this request: `deps` ITSELF (same identity) when the request
 * is not traced, otherwise the scope's traced copy. Never throws — a wrap that
 * fails hands back the boot bag, and the trace simply sees less.
 */
export function scopedDeps<T extends object>(request: FastifyRequest, deps: T): T {
  const scope = scopeOf(request);
  if (scope === null) return deps;
  try {
    return scope.wrap(deps);
  } catch {
    return deps;
  }
}

/**
 * Add the tracing hooks and the read route.
 *
 * DIRECTLY on `app`, never via `app.register`: a plugin's hooks are
 * encapsulated to the routes registered inside it, and the routes this traces
 * are registered on the root. Call it AFTER `@fastify/rate-limit` is registered
 * (so the read route's own `config.rateLimit` is picked up by the limiter's
 * `onRoute`) and BEFORE the query routes (so they inherit the hooks).
 */
export function registerRequestTracing(
  app: FastifyInstance,
  runtime: TraceRuntime,
  options: RequestTracingOptions = {},
): void {
  const clock = options.clock ?? Date.now;
  const createRecorder =
    options.createRecorder ?? ((maxTouches: number) => createTouchRecorder({ maxTouches }));

  let openScopes = 0;
  let window = -1;
  let opensInWindow = 0;

  const notOpened = (reason: "budget" | "busy"): void => {
    try {
      app.log.debug({ reason }, TRACE_NOT_OPENED_MESSAGE);
    } catch {
      // Debug logging is best-effort.
    }
  };

  app.decorateRequest("requestTrace", null);

  app.addHook("onRequest", (request, _reply, done) => {
    // Every request counts, traced or not: `instanceSequence` is "the Nth thing
    // this instance handled while tracing was on", and 1 is a cold instance.
    const sequence = runtime.nextSequence();
    try {
      const method = request.method;
      if (method !== "GET" && method !== "POST") {
        done();
        return;
      }
      const route = traceRouteOf(method, request.routeOptions.url, request.query);
      if (route === null) {
        done();
        return;
      }
      const minute = Math.floor(clock() / 60_000);
      if (minute !== window) {
        window = minute;
        opensInWindow = 0;
      }
      if (opensInWindow >= TRACE_OPENS_PER_MINUTE) {
        notOpened("budget");
        done();
        return;
      }
      if (openScopes >= MAX_OPEN_TRACES) {
        notOpened("busy");
        done();
        return;
      }

      const scope = new Scope(
        createRecorder(runtime.maxTouches),
        runtime,
        sequence,
        runtime.redisStatus(),
        route,
        method,
        queryKeysOf(request.query),
        viewStorylinesOf(request.query),
        subjectOf(route, request.query, request.params),
        () => {
          openScopes -= 1;
        },
      );
      opensInWindow += 1;
      openScopes += 1;
      request.requestTrace = scope;
    } catch {
      // A scope that could not be built is a request that is not traced.
    }
    done();
  });

  app.addHook("preParsing", (request, _reply, payload, done) => {
    const scope = scopeOf(request);
    if (scope !== null && scope.limiterEnd === null) {
      try {
        scope.limiterEnd = scope.recorder.now();
      } catch {
        // The rate-limit touch takes its end from `onSend` instead.
      }
    }
    done(null, payload);
  });

  app.addHook("preSerialization", (request, _reply, payload, done) => {
    const scope = scopeOf(request);
    if (scope !== null) {
      try {
        scope.noteBody(payload);
      } catch {
        // No meta, no planes; the trace still stores.
      }
    }
    done(null, payload);
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    const scope = scopeOf(request);
    if (scope === null) {
      done(null, payload);
      return;
    }
    persist(runtime, scope, reply).then(
      () => done(null, payload),
      () => done(null, payload),
    );
  });

  app.addHook("onResponse", (request, _reply, done) => {
    scopeOf(request)?.close();
    done();
  });

  app.addHook("onRequestAbort", (request, done) => {
    scopeOf(request)?.close();
    done();
  });

  registerTraceReadRoute(app, runtime);
  registerRecentTracesRoute(app, runtime);
}

/**
 * Seal the trace, store its PARSE OUTPUT, and mark the reply. Never rejects.
 *
 * `ms` is measured at seal, before the write, so the trace's own persistence —
 * up to ~1.8 s on a cold instance — is outside the duration it reports.
 */
async function persist(runtime: TraceRuntime, scope: Scope, reply: FastifyReply): Promise<void> {
  let stored = false;
  try {
    const { recorder } = scope;
    const limit = reply.getHeader("x-ratelimit-limit");
    const remaining = reply.getHeader("x-ratelimit-remaining");
    const outcome = rateLimitOutcome(reply.statusCode, limit, remaining);
    if (outcome !== null) {
      // A 429 is answered from the limiter's own hook and never reaches
      // `preParsing`, so its end is taken here.
      const end = scope.limiterEnd ?? recorder.now();
      recorder.prepend({
        station: "rate_limit",
        at: scope.limiterStart,
        ms: Math.max(0, Math.round((end - scope.limiterStart) * 10) / 10),
        outcome,
        inferred: true,
        limit: headerCount(limit),
        remaining: headerCount(remaining),
      });
    }
    const sealed = recorder.seal();
    const draft = {
      v: 1,
      id: scope.id,
      route: scope.route,
      method: scope.method,
      queryKeys: scope.queryKeys,
      subject: scope.subject,
      ...(scope.viewStorylines === undefined ? {} : { viewStorylines: scope.viewStorylines }),
      status: reply.statusCode,
      startedAt: scope.startedAt.toISOString(),
      ms: sealed.ms,
      overheadMs: sealed.overheadMs,
      origin: runtime.origin(scope.sequence, scope.redisAtStart),
      meta: scope.meta,
      planes: scope.planes,
      touches: sealed.touches,
      elided: sealed.elided,
    };
    // The PARSE OUTPUT is what is stored, never the draft: the schema strips any
    // field it does not declare, and refuses any string it does not recognise.
    const parsed = RequestTrace.safeParse(draft);
    if (!parsed.success) {
      runtime.warnUnstored({
        reason: "schema",
        paths: parsed.error.issues.map((issue) => issue.path.join(".")),
      });
    } else {
      stored = await runtime.putTrace(parsed.data);
      if (!stored) runtime.warnUnstored({ reason: "redis" });
    }
  } catch {
    stored = false;
  }
  try {
    reply.header(TRACE_ID_HEADER, stored ? scope.id : TRACE_UNSTORED);
    reply.header("cache-control", "no-store");
  } catch {
    // Headers already gone; nothing a trace can do about it.
  }
  scope.close();
}

/**
 * `GET /api/v1/traces/:id` — the playback page's poll.
 *
 * Its own rate-limit bucket (`config.rateLimit`, which gives the limiter a child
 * key per method and URL), so a page polling a trace for half an hour never
 * spends the reader allowance a search needs. No token. The id is 122 random
 * bits, but since ADR-0031 it is no capability: the recent list hands out the
 * newest ids to anyone, and the record holds the request's subject.
 *
 * **GET only, so the bucket is one bucket.** Fastify clones every GET as a HEAD
 * with the same `config` unless told not to, and because the limiter keys a
 * route's child store by method AND url, that HEAD would be a second
 * `TRACE_READS_PER_MINUTE` over the same handler and the same trace-store reads
 * — 60 a minute per address where ADR-0029 says 30. The page never sends HEAD,
 * so it is simply not served: Fastify's own 404.
 *
 * **`no-store` on every answer, the limiter's 429 included**, since a trace
 * still gathering runs must never be answered from a cache. It is set in the
 * route's own `onSend`, not the handler, because the 429 is thrown from the
 * limiter's `onRequest` and never reaches the handler; `onSend` sees every
 * reply this route makes — the handler's, the limiter's, and the error
 * handler's.
 *
 * A malformed id is refused before any trace-store command (the limiter's own
 * EVALSHA has run by then; nothing else has).
 */
function registerTraceReadRoute(app: FastifyInstance, runtime: TraceRuntime): void {
  app.get<{ Params: { id: string } }>(
    TRACE_READ_ROUTE,
    {
      exposeHeadRoute: false,
      config: { rateLimit: { max: TRACE_READS_PER_MINUTE, timeWindow: 60_000 } },
      onSend: (_request, reply, payload, done) => {
        reply.header("cache-control", "no-store");
        done(null, payload);
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!TRACE_ID_PATTERN.test(id)) {
        return reply
          .status(400)
          .send({ error: { message: "invalid query", fields: { id: "must be a trace id" } } });
      }
      try {
        const response = await runtime.readTrace(id);
        if (response === null) {
          return reply.status(404).send({ error: { message: "unknown trace" } });
        }
        return await reply.send(response);
      } catch (error) {
        if (error instanceof TraceStoreUnavailable) {
          return reply.status(503).send({ error: { message: "trace store unavailable" } });
        }
        throw error;
      }
    },
  );
}

/**
 * `GET /api/v1/traces` — the newest traces still stored, newest first
 * (ADR-0031): what the playback page's dropdown lists.
 *
 * The same posture as the read route and for the same reasons: its own
 * rate-limit bucket (`TRACE_LIST_READS_PER_MINUTE`), GET only, `no-store` on
 * every answer (a list a CDN held would hide the trace an operator just made),
 * and a 503 rather than an empty list when Redis errors, so the page can say
 * the store is down rather than that nothing was traced. No token, like
 * everything since ADR-0031: while tracing is on, anyone who polls this can
 * collect EVERY traced request's subject, ten at a time, and open each full
 * record by its id until its TTL — which is what "on for a session, then off"
 * is for.
 */
function registerRecentTracesRoute(app: FastifyInstance, runtime: TraceRuntime): void {
  app.get(
    TRACE_RECENT_ROUTE,
    {
      exposeHeadRoute: false,
      config: { rateLimit: { max: TRACE_LIST_READS_PER_MINUTE, timeWindow: 60_000 } },
      onSend: (_request, reply, payload, done) => {
        reply.header("cache-control", "no-store");
        done(null, payload);
      },
    },
    async (_request, reply) => {
      try {
        return await reply.send({ traces: await runtime.readRecent() });
      } catch (error) {
        if (error instanceof TraceStoreUnavailable) {
          return reply.status(503).send({ error: { message: "trace store unavailable" } });
        }
        throw error;
      }
    },
  );
}
