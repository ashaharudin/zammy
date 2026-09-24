import type { Command, Redis } from "ioredis";
import type {
  Kysely,
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from "kysely";
import {
  CallPriority,
  MAX_JOB_REF_DEPTH,
  type RedisCommand,
  type RedisKeyClass,
  type UpstreamCall,
} from "@zammy/shared/request-trace";
import type { GenerateResult, TextGenerator } from "./gemini.js";
import { ingestJobId, type IngestJob } from "./ingest-queue.js";
import type { TouchHandle, TouchRecorder, TouchStart } from "./trace-recorder.js";
import {
  classifyRedisKey,
  jobKindOf,
  jobPlaneOf,
  pgOperationOf,
  pgTablesOf,
  redisCommandOf,
  redisFailureOf,
  redisKeyArg,
  redisOutcomeOf,
  upstreamFailureOf,
  upstreamOutcomeOf,
} from "./trace-redact.js";
import type { JobLink, TraceRuntime } from "./trace-store.js";

/**
 * The traced copy of a dependency bag (ADR-0029, "The change" 3).
 *
 * **Why a copy, and not AsyncLocalStorage.** Every planner here is already
 * handed its dependencies explicitly (`wiring.ts`, `buildServices`), so the
 * tracer does the same: a traced request's handler is given a bag whose `db`,
 * `redis`, news clients, queue and model clients RECORD, and an untraced one is
 * given the boot bag itself, by identity. Ambient context would lose the trace
 * in exactly the places the playback page cares about — the in-process BullMQ
 * worker, the Vercel consumer (another process), ioredis' offline-queue flush —
 * and Postgres would still need a Kysely hook. ADR-0029 has the whole argument.
 *
 * **The wrappers observe; they never intervene.** Each one calls the real
 * member with the same arguments and the same receiver, returns what it
 * returned, and rethrows the SAME error instance. The recorder calls around it
 * are each in their own try/catch — the inner call never is — so a bug in the
 * tracer can cost a touch and never a request. Three of them are worth
 * spelling out:
 *
 *   - **Redis** is a `Proxy` that traps `sendCommand` and nothing else. Every
 *     ioredis path funnels through it (`Commander`'s generated methods call
 *     `this.sendCommand`, and the other properties are read through the proxy
 *     unbound, so `this` is the proxy and calls come back to the trap). The
 *     trap attaches its own `then` to `command.promise` and returns the real
 *     return value UNCHANGED — never a chained promise, which would add ticks,
 *     change identity, and put the tracer's handler between a command and its
 *     caller.
 *   - **Kysely** gets `db.withPlugin(TouchPlugin)`: same driver, same pool,
 *     inherited by transactions and raw `sql`. It must never be destroyed —
 *     that would end the pool the boot bag shares.
 *   - **The queue** writes the job → trace link BEFORE it publishes, because
 *     both the in-process worker and a Vercel push can start the job before the
 *     request finishes, and a link written after would miss the run it exists
 *     for. The job object handed on is the caller's, untouched.
 *
 * What it deliberately does NOT do: see the callers that hold the boot client —
 * the rate limiter's EVALSHA, the quota governors' EVALs, the ledger's ZADD
 * inside an enqueue. The first is inferred from hooks and headers
 * (`trace-http.ts`); the other two happen INSIDE an upstream or queue touch, and
 * the ADR says so rather than pretending to a precision this cannot have.
 */

// ── the scope ───────────────────────────────────────────────────────────────

/** Bag members replaced by a recording copy. */
export const TRACED_KEYS = [
  "db",
  "redis",
  "currents",
  "deepening",
  "queue",
  "labeler",
  "summarizer",
] as const;

/**
 * Bag members passed through by identity: values and functions that reach no
 * station. `trace-deps.test.ts` builds real `Services` and pins that every key
 * of every bag is in one list or the other — so a dependency added later is a
 * failing test until someone decides which it is, rather than a station the
 * trace silently never sees.
 */
export const PASS_THROUGH_KEYS = [
  "config",
  "now",
  "log",
  "trending",
  "enabled",
  "gate",
  "maxDays",
  "budgetMs",
  "ratePerMinute",
  "sleep",
  "abortGraceMs",
] as const;

const TRACED: ReadonlySet<string> = new Set(TRACED_KEYS);

/** One traced request's or one job run's recorder, its links, and its wrapper cache. */
export interface TouchScope {
  readonly recorder: TouchRecorder;
  /**
   * The links an enqueue with local ref `local` writes. Request scope:
   * `[{ traceId, ref: local }]`. Run scope: each parent link L as
   * `${L.ref}.${local}`, dropping links already `MAX_JOB_REF_DEPTH` deep.
   */
  linksFor(local: string): readonly JobLink[];
  /**
   * A traced copy of a dependency bag: `TRACED_KEYS` replaced — memoized per
   * ORIGINAL object, so `deps.db` and `summarizeDeps.db` become one traced db —
   * and everything else passed by identity.
   */
  wrap<T extends object>(bag: T): T;
}

function refDepth(ref: string): number {
  return ref.split(".").length;
}

export function createTouchScope(options: {
  recorder: TouchRecorder;
  runtime: TraceRuntime;
  /** The request's own trace id, or null in a run scope. */
  traceId: string | null;
  /** The links a job run was dispatched under, or null in a request scope. */
  parentLinks: readonly JobLink[] | null;
}): TouchScope {
  const { recorder, runtime, traceId, parentLinks } = options;
  const memo = new Map<unknown, unknown>();

  const scope: TouchScope = {
    recorder,
    linksFor(local) {
      if (parentLinks === null) return traceId === null ? [] : [{ traceId, ref: local }];
      return parentLinks
        .filter((link) => refDepth(link.ref) < MAX_JOB_REF_DEPTH)
        .map((link) => ({ traceId: link.traceId, ref: `${link.ref}.${local}` }));
    },
    wrap<T extends object>(bag: T): T {
      const copy: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(bag)) {
        copy[key] = TRACED.has(key) ? traced(key, value) : value;
      }
      return copy as T;
    },
  };

  function traced(key: string, value: unknown): unknown {
    if (value === null || value === undefined || typeof value !== "object") return value;
    const cached = memo.get(value);
    if (cached !== undefined) return cached;
    let wrapped: unknown = value;
    switch (key) {
      case "db":
        wrapped = (value as Kysely<never>).withPlugin(new TouchPlugin(recorder));
        break;
      case "redis":
        wrapped = traceRedis(value as Redis, recorder, runtime.queueName);
        break;
      case "currents":
        wrapped = traceNewsClient(value, "currents", recorder);
        break;
      case "deepening":
        wrapped = traceNewsClient(value, "google_news", recorder);
        break;
      case "queue":
        wrapped = traceQueue(value, scope, runtime);
        break;
      case "labeler":
      case "summarizer": {
        const bag = value as { generator?: TextGenerator | null };
        wrapped = {
          ...bag,
          generator: bag.generator
            ? traceGenerator(bag.generator, recorder, key === "labeler" ? "label" : "summary")
            : bag.generator,
        };
        break;
      }
    }
    memo.set(value, wrapped);
    return wrapped;
  }

  return scope;
}

// ── shared helpers ──────────────────────────────────────────────────────────

const NOOP_HANDLE: TouchHandle = { end: () => {} };

/** Begin, or a handle that does nothing — never a throw into the caller. */
function safeBegin(recorder: TouchRecorder, start: () => TouchStart): TouchHandle {
  try {
    return recorder.begin(start());
  } catch {
    return NOOP_HANDLE;
  }
}

function safeEnd(
  handle: TouchHandle,
  outcome: Parameters<TouchHandle["end"]>[0],
  patch?: Partial<Record<string, unknown>>,
): void {
  try {
    handle.end(outcome, patch);
  } catch {
    // The touch reads `open`.
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Call `fn`, and end `handle` by how it came out — returning its value and
 * rethrowing its error, the same instance either way. For interfaces whose
 * callers await the result; Redis has its own trap below precisely because it
 * must NOT chain.
 */
function observe<R>(
  handle: TouchHandle,
  fn: () => R,
  onValue: (value: unknown) => [Parameters<TouchHandle["end"]>[0], Record<string, unknown>?],
  onError: (error: unknown) => [Parameters<TouchHandle["end"]>[0], Record<string, unknown>?],
): R {
  let result: R;
  try {
    result = fn();
  } catch (error) {
    safeEnd(handle, ...onError(error));
    throw error;
  }
  if (!isThenable(result)) {
    safeEnd(handle, ...onValue(result));
    return result;
  }
  return Promise.resolve(result).then(
    (value) => {
      safeEnd(handle, ...onValue(value));
      return value;
    },
    (error: unknown) => {
      safeEnd(handle, ...onError(error));
      throw error;
    },
  ) as R;
}

// ── Redis ───────────────────────────────────────────────────────────────────

/**
 * The boot client, observed. `sendCommand` is ioredis' single funnel (marked
 * `@ignore` there, and pinned by `trace-deps.test.ts`'s identity cases); every
 * other property is `Reflect.get` through the proxy, so methods are returned
 * UNBOUND and call back into the trap, and `status`, `once`, `off` read the
 * real client.
 */
export function traceRedis(redis: Redis, recorder: TouchRecorder, queueName: string): Redis {
  const sendCommand = (command: Command, stream?: unknown): unknown => {
    let handle: TouchHandle | null = null;
    let name: RedisCommand = "other";
    let key: RedisKeyClass = "other";
    let args: readonly unknown[] = [];
    try {
      args = command.args;
      name = redisCommandOf(command.name);
      key = classifyRedisKey(redisKeyArg(command.name, args), queueName);
      handle = recorder.begin({ station: "redis", command: name, key });
    } catch {
      handle = null;
    }

    const result = (redis.sendCommand as (c: Command, s?: unknown) => unknown).call(
      redis,
      command,
      stream,
    );

    if (handle !== null) {
      const touch = handle;
      try {
        // Observed, NOT chained: the derived promise is ours and is discarded,
        // and both halves swallow their own faults so it can never reject.
        void command.promise.then(
          (value: unknown) => safeEnd(touch, redisOutcomeOf(name, key, args, value)),
          (error: unknown) => safeEnd(touch, redisFailureOf(error)),
        );
      } catch {
        // No promise to watch: the touch reads `open`.
      }
    }
    return result;
  };

  return new Proxy(redis, {
    get(target, property, receiver) {
      return property === "sendCommand" ? sendCommand : Reflect.get(target, property, receiver);
    },
  });
}

// ── Postgres ────────────────────────────────────────────────────────────────

/**
 * One touch per statement Kysely executes through the traced db.
 *
 * `transformQuery` runs synchronously at compile and ALWAYS returns the node it
 * was given — Kysely refuses a plugin that returns a node of another kind, and
 * this one changes nothing. `transformResult` runs only after a query that
 * SUCCEEDED (Kysely skips it on a throw), so a failed statement never ends and
 * reads `open`; the wire schema has no `failed` for Postgres for that reason.
 * Handles are queued per `queryId`, oldest first, because a builder executed
 * twice reuses its id.
 *
 * Not seen: BEGIN/COMMIT (they go through the driver, not the executor), and a
 * builder from this db embedded in another query as a subquery begins a touch
 * that never ends — `eb.selectFrom` and CTE callbacks compile through a
 * plugin-less executor, so this codebase's subqueries do not.
 */
export class TouchPlugin implements KyselyPlugin {
  readonly #recorder: TouchRecorder;
  readonly #handles = new WeakMap<object, TouchHandle[]>();

  constructor(recorder: TouchRecorder) {
    this.#recorder = recorder;
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    try {
      const handle = this.#recorder.begin({
        station: "postgres",
        operation: pgOperationOf(args.node),
        tables: pgTablesOf(args.node),
      });
      const queue = this.#handles.get(args.queryId);
      if (queue) queue.push(handle);
      else this.#handles.set(args.queryId, [handle]);
    } catch {
      // No touch for this statement; the statement is unaffected.
    }
    return args.node;
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    try {
      this.#handles.get(args.queryId)?.shift()?.end("ok");
    } catch {
      // The touch reads `open`.
    }
    return args.result;
  }
}

// ── news clients ────────────────────────────────────────────────────────────

/** The upstream methods traced, and where each takes its `CallOpts`. */
const NEWS_CALLS: Readonly<Record<string, { call: UpstreamCall; optsIndex: number }>> = {
  search: { call: "search", optsIndex: 1 },
  latestNews: { call: "latest_news", optsIndex: 1 },
  availableLanguages: { call: "available_languages", optsIndex: 0 },
  availableRegions: { call: "available_regions", optsIndex: 0 },
  availableCategories: { call: "available_categories", optsIndex: 0 },
};

function priorityOf(opts: unknown): "interactive" | "background" {
  const parsed = CallPriority.safeParse((opts as { priority?: unknown } | undefined)?.priority);
  // The transport's own default (`transport.ts`): no priority is interactive.
  return parsed.success ? parsed.data : "interactive";
}

/**
 * A news client (Currents, or the deepening plane's Google News), observed at
 * the interface — so fixture mode, which never reaches a transport, is traced
 * exactly as live mode is.
 *
 * Every property that is not a traced call is read off the client with the
 * client as receiver, and functions come back bound to it: `CountingClient`'s
 * `limits` getter, `quota()` and `close()` behave as if no proxy were there.
 * Priority is recorded; params (the keywords, the window) are never looked at.
 */
export function traceNewsClient<C extends object>(
  client: C,
  station: "currents" | "google_news",
  recorder: TouchRecorder,
): C {
  const wrappers = new Map<PropertyKey, { value: unknown; traced: unknown }>();
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      // Cached per property, and only while the property still holds the same
      // function — a test that installs a stub after wrapping gets the stub.
      const known = wrappers.get(property);
      if (known !== undefined && known.value === value) return known.traced;
      const traced =
        typeof property === "string" && Object.hasOwn(NEWS_CALLS, property)
          ? (...args: unknown[]) => {
              const { call, optsIndex } = NEWS_CALLS[property]!;
              const handle = safeBegin(recorder, () => ({
                station,
                call,
                priority: priorityOf(args[optsIndex]),
              }));
              return observe(
                handle,
                () => Reflect.apply(value, target, args) as unknown,
                () => ["ok"],
                (error) => {
                  const failure = upstreamFailureOf(error);
                  return [upstreamOutcomeOf(failure), { failure }];
                },
              );
            }
          : (value as (...args: unknown[]) => unknown).bind(target);
      wrappers.set(property, { value, traced });
      return traced;
    },
  });
}

// ── Gemini ──────────────────────────────────────────────────────────────────

/**
 * A model client, observed: `{ ok: true }` is `ok`, the model answering with
 * nothing usable is `refused/answered`, never reaching it is
 * `failed/unreachable`, and a throw is `failed/unknown` (rethrown). The prompt
 * and the text are never looked at. No priority: the pacer is the model's.
 */
export function traceGenerator(
  generator: TextGenerator,
  recorder: TouchRecorder,
  purpose: "label" | "summary",
): TextGenerator {
  const generate = (request: Parameters<TextGenerator["generate"]>[0]) => {
    const handle = safeBegin(recorder, () => ({ station: "gemini", call: "generate", purpose }));
    return observe(
      handle,
      () => generator.generate(request),
      (value) => {
        const result = value as GenerateResult;
        if (result?.ok === true) return ["ok"];
        return result?.failure === "answered"
          ? ["refused", { failure: "answered" }]
          : ["failed", { failure: "unreachable" }];
      },
      () => ["failed", { failure: "unknown" }],
    );
  };
  return new Proxy(generator, {
    get(target, property) {
      if (property === "generate") return generate;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
}

// ── the queue ───────────────────────────────────────────────────────────────

const ENQUEUES = new Set(["enqueueSegment", "enqueueSample", "enqueueDeepen", "enqueueSummarize"]);

/**
 * The ingest queue, observed, and the one wrapper that WRITES: an enqueue first
 * links the job to this scope's trace(s) (`runtime.linkJob`, bounded, timed into
 * `overheadMs`), then publishes the identical job object. A link that fails or
 * times out records `linked: false` and the publish goes ahead regardless — a
 * trace that cannot follow its job is a smaller loss than a job not published.
 *
 * `pendingCount` becomes the ledger read it is (a `ZCARD pending_ledger` touch):
 * it runs on the queue's own Redis client, which no proxy of ours ever sees.
 * `name`, `settle` and the rest are the queue's, bound to it.
 */
export function traceQueue<Q extends object>(
  queue: Q,
  scope: TouchScope,
  runtime: TraceRuntime,
): Q {
  const { recorder } = scope;
  const wrappers = new Map<PropertyKey, { value: unknown; traced: unknown }>();

  const enqueue =
    (method: (job: IngestJob) => unknown, target: Q) =>
    async (job: IngestJob): Promise<unknown> => {
      let local = "99";
      let links: readonly JobLink[] = [];
      let jobId: string | null = null;
      try {
        local = recorder.nextRef();
        // Past 99 a ref would name two jobs, so the job is published unlinked.
        links = recorder.refsIssued > 99 ? [] : scope.linksFor(local);
        jobId = ingestJobId(job);
      } catch {
        links = [];
      }

      let linked = false;
      if (links.length > 0 && jobId !== null) {
        const started = performance.now();
        try {
          linked = await runtime.linkJob(jobId, links);
        } catch {
          linked = false;
        }
        try {
          recorder.addOverhead(performance.now() - started);
        } catch {
          // Overhead unrecorded; the timings are still honest about the rest.
        }
      }

      const handle = safeBegin(recorder, () => {
        const plane = jobPlaneOf(job);
        return {
          station: "queue",
          job: jobKindOf(job),
          ...(plane === undefined ? {} : { plane }),
          ref: local,
          linked,
        };
      });
      return observe(
        handle,
        () => Reflect.apply(method, target, [job]) as unknown,
        () => ["ok"],
        () => ["failed"],
      );
    };

  return new Proxy(queue, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      const known = wrappers.get(property);
      if (known !== undefined && known.value === value) return known.traced;
      let traced: unknown;
      if (typeof property === "string" && ENQUEUES.has(property)) {
        traced = enqueue(value as (job: IngestJob) => unknown, target);
      } else if (property === "pendingCount") {
        traced = (...args: unknown[]) => {
          const handle = safeBegin(recorder, () => ({
            station: "redis",
            command: "ZCARD",
            key: "pending_ledger",
          }));
          return observe(
            handle,
            () => Reflect.apply(value, target, args) as unknown,
            () => ["ok"],
            () => ["failed"],
          );
        };
      } else {
        traced = (value as (...args: unknown[]) => unknown).bind(target);
      }
      wrappers.set(property, { value, traced });
      return traced;
    },
  });
}
