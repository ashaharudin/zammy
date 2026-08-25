import type { IncomingMessage, ServerResponse } from "node:http";
import { ConfigError, loadConfig } from "@zammy/config";
import { INGEST_RETENTION_SECONDS } from "./ingest-queue-vercel.js";
import {
  PendingSet,
  parseIngestJobId,
  type IngestHandler,
  type IngestJob,
  type IngestQueue,
  type PendingEntry,
} from "./ingest-queue.js";
import { buildServices, ingestDispatch, type ServiceLogger } from "./server.js";

/**
 * The manual ingest drain (VERCEL-ALL-IN-SCOPE §3.2's named fallback), as a
 * route beside the chores rather than a pass inside them.
 *
 * **Why it is not a chore pass.** [chores.ts](./chores.ts) states as a property
 * that no pass touches Redis — "the runner needs no cache, no queue, and no
 * `REDIS_URL` that resolves to anything" — and `ChoreDeps` has no Redis client
 * to give one. The drain is nothing but a Redis read followed by upstream fills,
 * so making it a pass would mean widening `ChoreDeps` for a single member and
 * giving `chores-cli.ts` a hard Redis dependency it currently does without. It
 * shares the chores' shape (one authenticated route, addressable, structured
 * tally in the log) and not their dependencies.
 *
 * **What it is for.** A failed ingest delivery is retried by the platform three
 * times over ~610 s and then given up on, and until 2026-08-25 it was not
 * retried at all (§10 question 0). Either way the recovery of last resort is
 * incidental: the pending entry is left unsettled, `meta.ingest` reports the
 * work owed, and the next reader of that topic re-plans the gap. That works
 * beautifully for a topic somebody reads again soon and not at all for one
 * nobody does. This route is the deliberate version of it.
 *
 * **What it deliberately does NOT do:** re-enqueue. It performs the fills
 * inline, because handing the work back to the queue is what already failed —
 * and because a drain that publishes is a drain that can loop.
 */

/**
 * How long an entry must have been outstanding before the drain will touch it.
 *
 * `INGEST_RETENTION_SECONDS` exactly, and not a fresh number: that is the TTL
 * every message is published with, so an entry older than it names work whose
 * message has certainly expired from the topic. Below that line the platform
 * may still be retrying, and a drain that fills there would spend upstream
 * quota on a segment the queue is about to deliver anyway — the one failure
 * mode that would make this route worse than not having it.
 *
 * `STALE_PENDING_MS` was raised to this same fifteen minutes on 2026-08-25, so
 * the floor and the stale prune now coincide. That does not weaken the argument
 * above — it is a floor against the TTL, and the TTL has not moved — but it does
 * fix a second-order oddity: while the prune fired at five minutes it erased
 * every entry on a read topic long BEFORE the drain was allowed to look at it,
 * so this route could only ever have helped topics nobody reads. The prune must
 * therefore stay at or above this floor, which `drain.test.ts` pins.
 */
export const DRAIN_MIN_AGE_MS = INGEST_RETENTION_SECONDS * 1000;

/**
 * Wall-clock budget for the fills, well inside the function's 300 s ceiling.
 *
 * The bound is checked BETWEEN jobs, never inside one: a segment fetch that
 * starts is allowed to finish, so a slow fill overruns this by its own duration
 * rather than being abandoned half-done. 240 s therefore leaves room for one
 * long fill plus the response, and what a truncated pass leaves behind is
 * simply picked up by the next one.
 */
export const DRAIN_DEADLINE_MS = 240_000;

/** Most jobs one pass will fill, whatever the clock says. */
export const DRAIN_MAX_JOBS = 50;

const emit = (level: string, fields: object, message: string): string =>
  JSON.stringify({ level, msg: message, ...fields });
const log: ServiceLogger = {
  info: (fields, message) => console.log(emit("info", fields, message)),
  warn: (fields, message) => console.warn(emit("warn", fields, message)),
};

/** What one pass did, and the response body. */
export interface DrainReport {
  scanned: number;
  filled: number;
  failed: number;
  unreadable: number;
  /** True when a bound stopped the pass with work still outstanding. */
  truncated: boolean;
}

/** The narrow surface a drain needs, so the tests need no platform. */
export interface Drainable {
  listOutstanding: (olderThanMs: number) => Promise<PendingEntry[]>;
  settle: IngestQueue["settle"];
  /** Remove an entry whose job cannot be rebuilt; see `PendingSet.forget`. */
  forget: (pendingId: string, jobId: string) => Promise<void>;
  dispatch: IngestHandler;
}

export interface DrainOptions {
  now?: () => Date;
  limit?: number;
  deadlineMs?: number;
}

/**
 * One pass, given something drainable. Parameterized for the tests: the age
 * floor, the settle-regardless rule and the bounds are the behaviour worth
 * pinning, and none of it should need Redis or an upstream.
 */
export async function runDrain(
  drainable: Drainable,
  options: DrainOptions = {},
  logger: ServiceLogger = log,
): Promise<DrainReport> {
  const now = options.now ?? (() => new Date());
  const limit = options.limit ?? DRAIN_MAX_JOBS;
  const deadlineMs = options.deadlineMs ?? DRAIN_DEADLINE_MS;
  const startedAt = now().getTime();

  const outstanding = await drainable.listOutstanding(DRAIN_MIN_AGE_MS);
  const report: DrainReport = {
    scanned: outstanding.length,
    filled: 0,
    failed: 0,
    unreadable: 0,
    truncated: false,
  };

  for (const entry of outstanding) {
    if (report.filled + report.failed + report.unreadable >= limit) {
      report.truncated = true;
      break;
    }
    // Between jobs, never inside one — a fill that has started has already
    // spent the quota, and abandoning it would lose the work it paid for.
    if (now().getTime() - startedAt >= deadlineMs) {
      report.truncated = true;
      break;
    }

    const job = parseIngestJobId(entry.jobId, now());
    if (!job) {
      // Written by a different version of `ingestJobId`. It will not become
      // readable, so it is removed by its raw coordinates rather than settled —
      // `settle` derives both the key and the member FROM a job, which is
      // exactly what this entry cannot give us.
      //
      // Dropping it is not optional bookkeeping. The stale prune that collects
      // this kind of residue lives in `PendingSet.count`, which only runs on a
      // `meta.ingest` read, and a cold topic never has one — which is the whole
      // reason this route exists. An entry left here would be re-scanned,
      // re-warned and re-counted against `limit` by every future pass, forever,
      // and enough of them would starve the pass of its budget before it
      // reached any fillable work.
      report.unreadable += 1;
      logger.warn(
        { pendingId: entry.pendingId, jobId: entry.jobId },
        "unreadable pending entry; dropping",
      );
      await forgetQuietly(drainable, entry, logger);
      continue;
    }

    try {
      await drainable.dispatch(job);
      report.filled += 1;
    } catch (error) {
      report.failed += 1;
      logger.warn(
        {
          pendingId: entry.pendingId,
          jobId: entry.jobId,
          ageMs: now().getTime() - entry.enqueuedAt.getTime(),
          err: error instanceof Error ? error.message : String(error),
        },
        "drain fill failed",
      );
    }
    // **Settled either way, and that is the design.** A drain that left failures
    // in the ledger would retry the same poisoned segment on every pass forever,
    // spending upstream quota each time — the dead-letter problem §3.2 says we
    // do not have a queue feature for. One attempt per entry keeps the cost
    // bounded, and it costs nothing observable: the entry is already past
    // `INGEST_RETENTION_SECONDS`, so the next `meta.ingest` read would have
    // pruned it as stale residue regardless. The gap it named is still re-planned
    // by the next reader who finds it unfilled.
    await settleQuietly(drainable, entry, logger, job);
  }

  logger.info({ ...report }, "ingest drain complete");
  return report;
}

/**
 * Settling must not fail the pass. The ledger is a progress hint and the fill
 * has already happened; a Redis blip here should cost a repeated attempt next
 * pass, not the rest of this one.
 */
async function settleQuietly(
  drainable: Drainable,
  entry: PendingEntry,
  logger: ServiceLogger,
  job: IngestJob,
): Promise<void> {
  try {
    await drainable.settle(job);
  } catch (error) {
    logger.warn(
      {
        pendingId: entry.pendingId,
        jobId: entry.jobId,
        err: error instanceof Error ? error.message : String(error),
      },
      "drain could not settle entry",
    );
  }
}

/** The same tolerance, for the entry that has no job to settle by. */
async function forgetQuietly(
  drainable: Drainable,
  entry: PendingEntry,
  logger: ServiceLogger,
): Promise<void> {
  try {
    await drainable.forget(entry.pendingId, entry.jobId);
  } catch (error) {
    logger.warn(
      {
        pendingId: entry.pendingId,
        jobId: entry.jobId,
        err: error instanceof Error ? error.message : String(error),
      },
      "drain could not forget unreadable entry",
    );
  }
}

/**
 * Bearer-token check, constant-time-ish and fail-closed.
 *
 * Unlike `vercel-queue.ts` — which needs no auth because a push-mode consumer
 * has no public URL — this route HAS one, and it is the only surface in the
 * system that spends upstream quota without a user having asked. So an unset
 * secret disables it rather than opening it.
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
 * Config is loaded inside the boot, as in `vercel.ts` and `vercel-queue.ts`, so
 * a bad deploy answers with a listed reason rather than a module that throws
 * during import.
 */
async function bootFromEnvironment(): Promise<Drainable> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) console.error(error.message);
    throw error;
  }
  if (config.INGEST_QUEUE_DRIVER !== "vercel") {
    // Refuse rather than drain, and the reason is not symmetry with the
    // consumer — it is that `DRAIN_MIN_AGE_MS` is derived from the HOSTED
    // driver's retry budget. Under BullMQ the budget is three attempts of
    // exponential backoff from 200 ms, so it completes in under a second, and
    // an age floor of 900 s would describe nothing that driver does. A drain
    // there would also be redundant: Redis IS the queue, and its retries work.
    throw new Error(
      `INGEST_QUEUE_DRIVER is "${config.INGEST_QUEUE_DRIVER}"; the manual drain requires "vercel"`,
    );
  }

  const services = await buildServices(config, log);
  // Its own PendingSet view over the services' Redis client, rather than an
  // enumerate member on `IngestQueue`. The interface is a contract two drivers
  // implement, and BullMQ would have to grow a method it has no use for to let
  // this one route read a registry whose key format `PendingSet` already owns.
  const pending = new PendingSet(services.redis, services.queue.name);
  return {
    listOutstanding: (olderThanMs) => pending.listOutstanding(olderThanMs),
    settle: (job) => services.queue.settle(job),
    forget: (pendingId, jobId) => pending.forget(pendingId, jobId),
    dispatch: ingestDispatch(services),
  };
}

/**
 * The secret alone, read WITHOUT building any services.
 *
 * Split out from the boot so the bearer check can happen before a single
 * connection is opened. `loadConfig` is pure zod over `process.env` and does no
 * I/O, where `buildServices` creates a Postgres pool, a Redis client and an
 * upstream client — so ordering the two this way is the difference between an
 * unauthenticated POST costing nothing and it costing connections.
 *
 * That matters most in the configuration the docs call "disabled": with
 * `CRON_SECRET` unset this route refuses every request, and it should refuse
 * them cheaply rather than booting the world to discover it has no secret to
 * compare against.
 *
 * Returns `undefined` when config itself will not load, which reads the same as
 * an unset secret at the callsite — refuse. The boot below reports the real
 * reason for anyone holding the token.
 */
function secretFromEnvironment(): string | undefined {
  try {
    return loadConfig().CRON_SECRET;
  } catch {
    return undefined;
  }
}

function bootOnce(boot: () => Promise<Drainable>): () => Promise<Drainable> {
  let booted: Promise<Drainable> | null = null;
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

const booted = bootOnce(bootFromEnvironment);

/**
 * The route. `POST` only, because a pass spends quota and changes state, and a
 * `GET` is the shape a link preview or a crawler follows by accident.
 */
export function createHandler(
  boot: () => Promise<Drainable>,
  readSecret: () => string | undefined = secretFromEnvironment,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const json = (status: number, body: object): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (request.method !== "POST") {
      json(405, { error: "method not allowed" });
      return;
    }

    // **Auth first, and before the boot rather than after it.** The boot opens a
    // Postgres pool and a Redis client; the check needs only `process.env`. Doing
    // it the other way round let an unauthenticated caller drive real connections
    // on a route an operator has switched off by leaving `CRON_SECRET` unset —
    // and, because `bootOnce` forgets a FAILED boot so the next request can retry
    // it, let them drive a fresh one per request on any deployment where the boot
    // does not succeed.
    const header = request.headers.authorization;
    if (!isAuthorized(Array.isArray(header) ? header[0] : header, readSecret())) {
      // No detail: an unauthorized caller learns nothing about whether the
      // secret is unset or merely wrong.
      json(401, { error: "unauthorized" });
      return;
    }

    let ready: Drainable;
    try {
      ready = await boot();
    } catch (error) {
      console.error("drain boot failed:", error instanceof Error ? error.message : String(error));
      json(503, { status: "unavailable" });
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const requested = Number(url.searchParams.get("limit"));
    const limit =
      Number.isInteger(requested) && requested > 0
        ? Math.min(requested, DRAIN_MAX_JOBS)
        : DRAIN_MAX_JOBS;

    try {
      const report = await runDrain(ready, { limit });
      json(200, report);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("drain failed:", message);
      json(500, { error: "drain failed" });
    }
  };
}

export default createHandler(booted);
