import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import { ConfigError, loadConfig } from "@zammy/config";
import { isChorePass, runChorePass, CHORE_PASSES, type ChorePass } from "./chore-runner.js";
import type { StorylinePassDeps } from "./chores.js";
import { isAuthorized } from "./drain.js";
import type { ServiceLogger } from "./server.js";
import { choreDepsFromConfig } from "./wiring.js";

/**
 * The nightly chores as an HTTP route (VERCEL-ALL-IN-SCOPE §3.3).
 *
 * The passes were already one-shot functions with the clock outside them
 * (`chores.ts`, "Where the schedule lives"), so this is a wrapper and not a
 * reimplementation: what it adds is a way for a scheduler that speaks HTTP to
 * start one, and a way for an operator to re-run any single pass without an SSH
 * that this deployment does not have.
 *
 * ## The shape, and the one thing it turns on
 *
 * **202 first, work in `waitUntil`.** The scheduler is `pg_net` inside Supabase,
 * which is asynchronous and has its OWN timeout — 2 seconds by default,
 * plausibly shorter than a cold Node boot plus TLS. Returning before the work
 * starts is what makes the scheduler's timeout a question about the *request*
 * rather than about the *pass*: `maxDuration` (300 s on Hobby) then bounds the
 * background half, and the 202 has only to beat `timeout_milliseconds`, which
 * the cron job sets to 15 s explicitly (`deploy/vercel/supabase-cron.sql`).
 *
 * That inverts the usual error handling and it is worth saying out loud: **the
 * response cannot report whether the pass worked**, because it is sent before
 * the pass starts. Nothing downstream of the 202 is visible to the scheduler at
 * all. That is precisely why `chore_runs` exists and why it is not optional here
 * — see `chore-runner.ts`.
 *
 * ## What is deliberately NOT here
 *
 * No pass logic, no lock, no record: all three are `chore-runner.ts`, shared
 * with `chores-cli.ts` so a laptop run and a scheduled run take the same lock and
 * write the same row. This file is HTTP — auth, pass selection, the 202 — and
 * nothing else.
 *
 * And no keep-alive. The Supabase free-tier pause guard is its own route on its
 * own schedule (`keepalive.ts`), because "the database stays awake" must not
 * share a failure mode with the most complex nightly job in the system.
 */

const emit = (level: string, fields: object, message: string): string =>
  JSON.stringify({ level, msg: message, ...fields });
const log: ServiceLogger = {
  info: (fields, message) => console.log(emit("info", fields, message)),
  warn: (fields, message) => console.warn(emit("warn", fields, message)),
};

/**
 * The nightly schedules, as the header a cron platform stamps a request with.
 *
 * §3.3 asks for the pass to come "from the query or from the
 * `x-vercel-cron-schedule` header", and the query is what every scheduler we
 * actually configure uses — Supabase Cron posts to a URL we wrote, and Vercel's
 * own `crons` entries carry their query string. The header path exists for the
 * scheduler that stamps a request without one, and the two expressions here are
 * the schedules this system has always run: `0 3 * * *` for retention and
 * `0 4 * * *` for storylines, both UTC (`chores-cli.ts`).
 *
 * Note this map is for SELECTION only. The header is client-settable and is
 * therefore never an authenticator — Vercel's own scheduler sends
 * `Authorization: Bearer $CRON_SECRET` for that, which is the check below.
 */
export const SCHEDULE_PASSES: Record<string, ChorePass> = {
  "0 3 * * *": "retention",
  "0 4 * * *": "storylines",
};

/** Per-request overrides of the configured defaults. */
export interface ChoreOverrides {
  maxLabels?: number;
  lateCandidatesChangedOnly?: boolean;
}

export interface ChoreRequest {
  pass: ChorePass;
  overrides: ChoreOverrides;
}

/**
 * Which pass, and with what deviation from the configured night.
 *
 * Returns null when nothing names a pass, which the caller answers 400 to. A
 * default would be worse than a refusal here: the two composites cost hours and
 * money respectively, and "the cron entry lost its query string" must not
 * silently become "run the expensive one".
 */
export function parseChoreRequest(
  url: URL,
  headers: NodeJS.Dict<string | string[]>,
): ChoreRequest | null {
  const requested = url.searchParams.get("pass");
  const schedule = headers["x-vercel-cron-schedule"];
  const fromSchedule =
    typeof schedule === "string" ? SCHEDULE_PASSES[schedule.trim()] : undefined;
  const pass = requested ?? fromSchedule;
  if (!pass || !isChorePass(pass)) return null;

  const overrides: ChoreOverrides = {};
  // `--max-labels` as a query parameter: the same override the CLI has, for the
  // same reason — a backlog drained against a clone wants a different bound from
  // the one the nightly schedule is sized for. Anything unparseable is ignored
  // rather than refused; the configured default is never a wrong answer.
  const maxLabels = Number(url.searchParams.get("max-labels"));
  if (Number.isInteger(maxLabels) && maxLabels > 0) overrides.maxLabels = maxLabels;
  // `--changed-only` / `--full`. Only the late-candidate sweep reads it.
  const changedOnly = url.searchParams.get("changed-only");
  if (changedOnly === "true" || changedOnly === "1") {
    overrides.lateCandidatesChangedOnly = true;
  } else if (changedOnly === "false" || changedOnly === "0") {
    overrides.lateCandidatesChangedOnly = false;
  }

  return { pass, overrides };
}

async function bootFromEnvironment(): Promise<StorylinePassDeps> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) console.error(error.message);
    throw error;
  }
  const deps = choreDepsFromConfig(config, log);
  log.info(
    {
      connection: config.DATABASE_SESSION_URL ? "DATABASE_SESSION_URL" : "DATABASE_URL",
      tls: config.DATABASE_SSL,
      maxLabels: config.CHORE_MAX_LABELS,
      lateCandidateSweep: config.STORYLINE_LATE_CANDIDATE_SWEEP,
    },
    "chore route booted",
  );
  return deps;
}

/**
 * The secret alone, read WITHOUT building anything — the same split
 * `drain.ts` makes, for the same reason: `loadConfig` is pure zod over
 * `process.env` and does no I/O, so an unauthenticated request costs nothing
 * rather than costing a connection pool.
 */
function secretFromEnvironment(): string | undefined {
  try {
    return loadConfig().CRON_SECRET;
  } catch {
    return undefined;
  }
}

function bootOnce(
  boot: () => Promise<StorylinePassDeps>,
): () => Promise<StorylinePassDeps> {
  let booted: Promise<StorylinePassDeps> | null = null;
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

export interface ChoreHandlerOptions {
  readSecret?: () => string | undefined;
  /**
   * The runner, injected so this file's own behaviour — auth, pass selection,
   * and the fact that the 202 goes out BEFORE the pass starts — can be asserted
   * without a Postgres. `chore-runner.test.ts` covers the pass side against a
   * real one.
   */
  runPass?: typeof runChorePass;
  /**
   * Injected so the tests can await the background half. On the platform this is
   * `@vercel/functions`' `waitUntil`, which is what keeps the instance alive
   * past the response — measured on the spike (findings §8).
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  logger?: ServiceLogger;
}

/**
 * The route.
 *
 * **GET and POST both, unlike the drain's POST-only.** The drain refuses GET
 * because a link preview or crawler follows one by accident; this route is
 * behind the same bearer check, so that argument is already covered — and
 * Vercel's own cron sends GET and nothing else, so POST-only would rule out the
 * documented Pro-tier scheduler for no gain. Supabase Cron posts.
 */
export function createHandler(
  boot: () => Promise<StorylinePassDeps>,
  options: ChoreHandlerOptions = {},
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const readSecret = options.readSecret ?? secretFromEnvironment;
  const defer = options.waitUntil ?? waitUntil;
  const runPass = options.runPass ?? runChorePass;
  const logger = options.logger ?? log;

  return async (request, response) => {
    const json = (status: number, body: object): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (request.method !== "POST" && request.method !== "GET") {
      json(405, { error: "method not allowed" });
      return;
    }

    // Auth before anything that costs a connection, exactly as the drain does.
    // An unset `CRON_SECRET` disables this route rather than opening it: a pass
    // spends Gemini quota and rewrites the storyline graph, which is not
    // something an anonymous caller gets to start.
    const header = request.headers.authorization;
    if (!isAuthorized(Array.isArray(header) ? header[0] : header, readSecret())) {
      json(401, { error: "unauthorized" });
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const requested = parseChoreRequest(url, request.headers);
    if (!requested) {
      // The one case that answers something other than 202, and it has to: an
      // unrecognised pass name is a configuration mistake in the scheduler, and
      // the 202 contract would swallow it forever.
      json(400, { error: "unknown pass", passes: CHORE_PASSES });
      return;
    }

    const schedule = request.headers["x-vercel-cron-schedule"];
    logger.info(
      {
        pass: requested.pass,
        ...requested.overrides,
        schedule: typeof schedule === "string" ? schedule : null,
      },
      "chore pass accepted",
    );

    // **The work is deferred, INCLUDING the boot.** Building the pool inside
    // `waitUntil` is what keeps the 202's latency down to config parsing on a
    // cold instance, which is the number that has to fit inside pg_net's
    // timeout. A boot failure therefore cannot be reported in the response —
    // it is a log line and a missing `chore_runs` row, which is the same
    // trade every other failure here makes.
    defer(
      (async () => {
        let deps: StorylinePassDeps;
        try {
          deps = await boot();
        } catch (error) {
          logger.warn(
            {
              pass: requested.pass,
              err: error instanceof Error ? error.message : String(error),
            },
            "chore boot failed; pass did not run",
          );
          return;
        }

        const result = await runPass(
          requested.pass,
          { ...deps, ...requested.overrides },
          { source: "route" },
        );
        if (result.outcome === "failed") {
          logger.warn(
            {
              pass: result.pass,
              runId: result.runId,
              ms: result.ms,
              err:
                result.error instanceof Error
                  ? result.error.message
                  : String(result.error),
            },
            "chore pass FAILED",
          );
          // The stack is the whole diagnostic and there is no response left to
          // put it in.
          console.error(result.error);
          return;
        }
        logger.info(
          { pass: result.pass, runId: result.runId, outcome: result.outcome, ms: result.ms },
          "chore pass complete",
        );
      })(),
    );

    // 202 and not 200: the pass has been accepted, and nothing about whether it
    // worked is knowable yet. `runId` is deliberately absent — it does not exist
    // until the background half opens the row.
    json(202, { accepted: requested.pass, ...requested.overrides });
  };
}

export default createHandler(booted);
