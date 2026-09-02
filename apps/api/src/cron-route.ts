import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import { ConfigError, loadConfig, type Config } from "@zammy/config";
import type { ServiceLogger } from "./server.js";

/**
 * The shape every serverless entrypoint has, owned once.
 *
 * This is `operator-command.ts`'s argument applied to the other half of the
 * deployment. There are five functions in `api/` — `chores`, `drain`,
 * `keepalive`, `index` and `queues/ingest` — and until this module existed
 * there were five copies of the same thirty lines: a JSON-line logger, a
 * `json(status, body)`, a `secretFromEnvironment`, a `loadConfig` wrapped in a
 * `ConfigError → console.error → rethrow`, and a `bootOnce`. Copies drift, and
 * these had:
 *
 *   - **the bearer check living inside the ingest drain.** `isAuthorized` was
 *     exported from `drain.ts` and imported by `chore-route.ts` and
 *     `keepalive.ts`, so the one function that decides whether an anonymous
 *     caller may spend Gemini quota, rewrite the storyline graph or hold a
 *     Postgres connection sat in the module about draining a Redis pending set.
 *     Nothing was wrong with the check. Everything was wrong with where a
 *     sixth route would have gone looking for it.
 *   - **`platformDefer` in exactly one of the five.** The "is `waitUntil` real
 *     in this environment?" check is thirty lines of measured reasoning about a
 *     silent no-op, and only `chore-route.ts` had it. A route that adopts the
 *     202 shape without it is a route that answers "accepted" and runs nothing.
 *   - **five `bootOnce`s, one of them tested.** `vercel.ts`'s inline copy is
 *     pinned by `vercel.test.ts`; the four module-private copies were asserted
 *     nowhere, and the forget-a-failed-boot half of it is the half that matters
 *     — the things that fail at boot here (Postgres reachable, Supabase awake)
 *     are transient, and an instance is reused for hours.
 *   - **the fail-closed auth rule as prose in five doc comments.** Every file
 *     says an unset `CRON_SECRET` disables the route rather than opening it,
 *     `.env.example` and `deploy/vercel/README.md` promise it to operators, and
 *     no test held it over the set. `cron-routes.test.ts` now does.
 *
 * ## The seam
 *
 * A route declares what it is — its name, the methods it answers, whether it
 * defers work past the response — and hands over a `handle` body that receives
 * everything it needs as an argument. `createCronRoute` does the rest, in this
 * order and no other: **method, then auth, then the body**. So the body is an
 * ordinary importable async function that touches neither `process.env` nor the
 * network, and the three route files are a spec plus a body.
 *
 * ## What it deliberately does NOT own
 *
 * **The boot.** Not when it happens, either. `createCronRoute` wraps the spec's
 * `boot` in `bootOnce` and hands the body a `ready()` — it does not call it,
 * because *when* the boot happens is the difference between the three routes
 * and not an implementation detail: `keepalive` boots inside the try whose
 * result is the response, `drain` boots before the work and answers 503 if it
 * cannot, and `chore-route` boots INSIDE the deferred half so that no I/O
 * happens before the 202 that has to fit in pg_net's timeout. A module that
 * booted for them would have to pick one of those, and any pick is wrong for
 * two of them.
 *
 * **Error handling around the body.** A throw out of `handle` propagates, which
 * is what a throw out of these handlers has always done. Each body catches what
 * it has an answer for — 503 for a boot, 500 with a reason for a drain pass —
 * and a `try` here would turn the ones it has no answer for into a silent 500
 * with no log line.
 *
 * **`vercel.ts` and `queues/ingest`.** Both take `bootOnce` and the logger from
 * here and neither takes the route factory, because neither is a
 * `CRON_SECRET`-gated route and pretending otherwise would be the interesting
 * kind of wrong. `vercel.ts` is the public Fastify surface: its auth is the
 * app's, and an entrypoint that grew a bearer check would be a second place to
 * look when production and Compose disagree. `vercel-queue.ts` is a push-mode
 * consumer with no public URL — reached only by the `queue/v2beta` trigger
 * `vercel.json` declares — so it has no auth code and none is missing, and it
 * is handed `(payload, metadata)` rather than `(request, response)` at all.
 * `cron-routes.test.ts` states both exemptions as assertions rather than as
 * prose, so the day either one gains a public path the test is what says so.
 */

/**
 * JSON lines to stdout, the shape `chores-cli.ts` logs in and the only shape a
 * platform log collector can do anything with. There is no Fastify instance in
 * any of these functions to borrow a logger from, and on Hobby these lines
 * survive an hour — the reason `chore_runs` exists on the chores route, and the
 * reason the others keep their own record short and structured.
 */
const emit = (level: string, fields: object, message: string): string =>
  JSON.stringify({ level, msg: message, ...fields });

/** The logger every entrypoint uses, and the default of every `logger` below. */
export const jsonLines: ServiceLogger = {
  info: (fields, message) => console.log(emit("info", fields, message)),
  warn: (fields, message) => console.warn(emit("warn", fields, message)),
};

/**
 * Build once per warm instance, and forget a failure so the next request tries
 * again.
 *
 * Both halves are load-bearing and they pull in opposite directions:
 *
 *   - **Once** is what makes the Postgres pool, the Redis client and the
 *     upstream client survive a warm invocation. Rebuilding per request would
 *     open a pool per request against a pooler sized for one or two
 *     connections per instance.
 *   - **Forgetting a failure** is what keeps a first failure from deciding the
 *     rest of an instance's life. What fails at boot here — Postgres
 *     reachable, Supabase awake, Redis shaking hands — is transient, and a
 *     Vercel instance is reused for hours.
 *
 * The `catch` clears the slot only if nothing has replaced it, so a retry that
 * is already in flight is not dropped by the rejection of the attempt before
 * it. Note the `catch` handler is attached to `pending` and its result
 * discarded: the caller gets the original promise, so a boot failure is still
 * reported to whoever asked for it rather than being swallowed here.
 *
 * Anything a failed attempt left open leaks, once per retry, for the life of an
 * instance that lives for hours — see `server.ts`'s note on `abandon`. That is
 * the boot's problem and not this function's, and both `drain.ts` and
 * `vercel-queue.ts` close their services on the failure path because of it.
 */
export function bootOnce<Ready>(boot: () => Promise<Ready>): () => Promise<Ready> {
  let booted: Promise<Ready> | null = null;
  return () => {
    if (booted) return booted;
    const pending = boot();
    booted = pending;
    pending.catch(() => {
      if (booted === pending) booted = null;
    });
    return pending;
  };
}

/**
 * `loadConfig`, with the refusal printed before it is rethrown.
 *
 * Called from inside a boot and never at module scope, in all five
 * entrypoints, so a bad deploy answers with a listed reason rather than being a
 * module that throws during import and reports whatever the platform makes of
 * that. The message is the one `index.ts` prints for the same reason: every
 * problem at once, not one 401 per missing variable.
 */
export function configOrExplain(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) console.error(error.message);
    throw error;
  }
}

/**
 * The secret alone, read WITHOUT building anything.
 *
 * Split from the boot so the bearer check can happen before a single
 * connection is opened. `loadConfig` is pure zod over `process.env` and does no
 * I/O, where a boot creates a Postgres pool, a Redis client and an upstream
 * client — so ordering the two this way is the difference between an
 * unauthenticated request costing nothing and it costing connections.
 *
 * That matters most in the configuration the docs call "disabled": with
 * `CRON_SECRET` unset these routes refuse every request, and they should refuse
 * them cheaply rather than booting the world to discover there is no secret to
 * compare against.
 *
 * Returns `undefined` when config itself will not load, which reads the same as
 * an unset secret at the callsite — refuse. The boot reports the real reason
 * for anyone holding the token.
 */
export function secretFromEnvironment(): string | undefined {
  try {
    return loadConfig().CRON_SECRET;
  } catch {
    return undefined;
  }
}

/**
 * Bearer-token check, constant-time-ish and fail-closed.
 *
 * **An unset secret disables the route rather than opening it**, and that is a
 * security property rather than a convenience: these routes are the only
 * surfaces in the system that spend upstream quota, rewrite the storyline graph
 * or open a database connection without a user having asked. `CRON_SECRET` is
 * optional in config precisely so that a deployment can switch them off, and
 * "off" has to mean off.
 *
 * The cost of that is worth stating where somebody will read it: **an unset
 * secret disables the pause guard too**, so a free Supabase project with no
 * `CRON_SECRET` is a project that will eventually pause. `keepalive.ts` says so
 * again at its own door.
 *
 * Unlike `vercel-queue.ts`, which needs no auth at all because a push-mode
 * consumer has no public URL.
 */
export function isAuthorized(header: string | undefined, secret: string | undefined): boolean {
  if (!secret) return false;
  if (!header) return false;
  const expected = `Bearer ${secret}`;
  if (header.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < header.length; i += 1) {
    mismatch |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * `waitUntil`, plus the check the SDK does not do.
 *
 * `@vercel/functions`' `waitUntil` is `getContext().waitUntil?.(promise)`, and
 * `getContext()` returns `{}` when the platform's request-context global is
 * absent — so **off-platform it is a silent no-op**. Combined with an
 * unconditional 202 that is the worst pairing available: the caller is told the
 * work was accepted, nothing keeps the instance alive to run it, and the record
 * is either never opened or opened and never closed — indistinguishable from a
 * platform kill.
 *
 * The promise still RUNS (it was started before it got here); what is missing
 * is anything holding the process open for it. So the fix is not to await —
 * that would break the 202 the whole shape exists for — it is to say so
 * loudly, once per invocation, in the only place a log survives.
 *
 * The symbol is read directly because `getContext` is not in the package's
 * public export map. It is the same symbol `waitUntil` itself reads.
 */
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

export function platformDefer(logger: ServiceLogger): (promise: Promise<unknown>) => void {
  return (promise) => {
    const context = (
      globalThis as Record<symbol, { get?: () => { waitUntil?: unknown } } | undefined>
    )[REQUEST_CONTEXT]?.get?.();
    if (typeof context?.waitUntil !== "function") {
      logger.warn(
        {},
        "no platform request context; background work is unsupervised and may be " +
          "killed with the response — the 202 does not mean the pass will finish",
      );
    }
    waitUntil(promise);
  };
}

/** What `createCronRoute` built, as the `handle` body receives it. */
export interface CronRequest<Ready> {
  /** The request itself, for the body that reads a header off it. */
  readonly request: IncomingMessage;
  /** The request URL, parsed. `http://localhost` because only the path matters. */
  readonly url: URL;
  /**
   * The spec's `boot`, wrapped in `bootOnce` — call it where this route wants
   * the boot to happen, which is a different place in all three routes.
   */
  ready(): Promise<Ready>;
  /** Status and a JSON body. The response is written once, by whoever calls this. */
  json(status: number, body: object): void;
  readonly logger: ServiceLogger;
  /**
   * `waitUntil` for the route that declared one.
   *
   * Reaching for it without a `defer` in the spec throws immediately rather
   * than silently running the work in the foreground — same rule as
   * `CommandContext.db`, and for a sharper reason here: the caller has been
   * told 202, and "it ran inline instead" and "it did not run" are different
   * enough that a `undefined` slipping through would be the wrong kind of
   * quiet.
   */
  defer(promise: Promise<unknown>): void;
}

export interface CronRouteSpec<Ready> {
  /** The path, as `vercel.json` and `deploy/vercel/supabase-cron.sql` spell it. */
  readonly name: string;
  /**
   * The methods this route answers. Anything else is 405, BEFORE the bearer
   * check — a wrong verb is not a secret.
   *
   * `null` means every method, which is what `keepalive.ts` has always done and
   * is preserved verbatim rather than tightened here. Explicit rather than
   * optional so that a route has to state its answer.
   */
  readonly methods: readonly string[] | null;
  /**
   * Everything this route needs, built once per warm instance. Wrapped in
   * `bootOnce`, and called by the `handle` body rather than by this module.
   */
  boot(): Promise<Ready>;
  /**
   * Whether this route defers work past its response, and how.
   *
   * `true` takes `platformDefer` over the resolved logger. A function is the
   * tests' injection point, so the deferred half can be awaited. **Absent is
   * the answer for four of the five entrypoints and must stay that way**:
   * switching a synchronous route onto `waitUntil` changes when its work runs
   * and whether it completes at all, which on a platform that kills the
   * instance with the response is not a refactor.
   */
  readonly defer?: true | ((promise: Promise<unknown>) => void);
  /** Injected by the tests. Reads `process.env` and nothing else in production. */
  readonly readSecret?: () => string | undefined;
  readonly logger?: ServiceLogger;
  /**
   * The route itself, reached only by an authorized caller using a method this
   * route answers.
   *
   * This is the half that is worth testing, and it is testable because
   * `createCronRoute` — not this — is what touches the environment, the socket
   * and `waitUntil`.
   */
  handle(context: CronRequest<Ready>): Promise<void>;
}

export type CronRouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

/**
 * One authenticated route: method, auth, body.
 *
 * The order is the security property. Auth happens before anything that costs
 * a connection, which is what makes "unset `CRON_SECRET` disables the route"
 * cheap as well as true — doing it the other way round let an unauthenticated
 * caller drive real connections on a route an operator had switched off, and,
 * because `bootOnce` forgets a FAILED boot so the next request can retry it,
 * let them drive a fresh one per request on any deployment where the boot does
 * not succeed.
 */
export function createCronRoute<Ready>(spec: CronRouteSpec<Ready>): CronRouteHandler {
  const logger = spec.logger ?? jsonLines;
  const readSecret = spec.readSecret ?? secretFromEnvironment;
  const ready = bootOnce(spec.boot);
  const defer =
    spec.defer === undefined
      ? undefined
      : spec.defer === true
        ? platformDefer(logger)
        : spec.defer;

  return async (request, response) => {
    const json = (status: number, body: object): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (spec.methods !== null && !spec.methods.includes(request.method ?? "")) {
      json(405, { error: "method not allowed" });
      return;
    }

    // A header arrives as `string | string[]` from `node:http`; the array form
    // is a repeated header, and the first is what any reasonable reader takes.
    const header = request.headers.authorization;
    if (!isAuthorized(Array.isArray(header) ? header[0] : header, readSecret())) {
      // No detail: an unauthorized caller learns nothing about whether the
      // secret is unset or merely wrong.
      json(401, { error: "unauthorized" });
      return;
    }

    await spec.handle({
      request,
      url: new URL(request.url ?? "/", "http://localhost"),
      ready,
      json,
      logger,
      defer: (promise) => {
        if (!defer) throw new Error(`${spec.name} did not declare a deferral`);
        defer(promise);
      },
    });
  };
}
