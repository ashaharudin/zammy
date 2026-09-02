import { isChorePass, runChorePass, CHORE_PASSES, type ChorePass } from "./chore-runner.js";
import type { StorylinePassDeps } from "./chores.js";
import {
  configOrExplain,
  createCronRoute,
  jsonLines,
  secretFromEnvironment,
  type CronRequest,
  type CronRouteHandler,
} from "./cron-route.js";
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
 *
 * And no auth, no boot-once, no `waitUntil` check: all three are
 * `cron-route.ts`, shared with the drain and the pause guard. This route is the
 * only one of the three that declares a `defer`, and `platformDefer` lives in
 * that module rather than here because it is what a fourth route adopting the
 * 202 shape would need and would otherwise not find.
 */

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
  // The preserve, an hour after the storyline night (ADR-0023). Its own
  // schedule rather than a step of the 04:00 pass: that one is already the
  // expensive one and they spend the same model key.
  "0 5 * * *": "summaries",
};

/** Per-request overrides of the configured defaults. */
export interface ChoreOverrides {
  maxLabels?: number;
  maxSummaries?: number;
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
  // Its twin for the summary pass. A count of MODEL CALLS, not of days — a day
  // costs between one and five of them.
  const maxSummaries = Number(url.searchParams.get("max-summaries"));
  if (Number.isInteger(maxSummaries) && maxSummaries > 0) {
    overrides.maxSummaries = maxSummaries;
  }
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
  const config = configOrExplain();
  const deps = choreDepsFromConfig(config, jsonLines);
  jsonLines.info(
    {
      connection: config.DATABASE_SESSION_URL ? "DATABASE_SESSION_URL" : "DATABASE_URL",
      tls: config.DATABASE_SSL,
      maxLabels: config.CHORE_MAX_LABELS,
      labelBudgetMs: config.CHORE_LABEL_BUDGET_MS,
      lateCandidateSweep: config.STORYLINE_LATE_CANDIDATE_SWEEP,
      // The two flags that decide whether a pass DOES anything belong on the
      // one line that says what this deployment is configured to do. Without
      // `summariesEnabled` here, "is the preserve on in production?" had no
      // answer short of a redeploy and a dig through `configuration loaded` —
      // and the honest answer that time was "the flag is on and nothing has
      // ever called the pass", which this line would not have caught either.
      // What it does catch is the other half: a flag that never reached the
      // running function because the variable was added after the deployment.
      summariesEnabled: config.SUMMARIES_ENABLED,
      summaryBudgetMs: config.SUMMARY_BUDGET_MS,
      maxSummaries: config.SUMMARY_MAX_PER_RUN,
    },
    "chore route booted",
  );
  if (!config.DATABASE_SESSION_URL) {
    // **A warning and not a refusal**, and the asymmetry is the point.
    // `DATABASE_SESSION_URL` is optional because Compose and local dev connect
    // directly, where every connection is already session-scoped and the lock
    // works. On a deployment it is not optional at all: through a
    // transaction-mode pooler a session lock is taken on one backend and looked
    // for on another, so `pg_try_advisory_lock` returns true every time, two
    // schedulers both run the night, and both log an ordinary success. Nothing
    // downstream can detect it.
    //
    // Refusing would break the two configurations where the fallback is
    // correct. So this is the loudest thing available instead — and it is a
    // `warn` rather than the boot line's `info` because on Hobby the log is an
    // hour long and the level is the only thing that makes a line findable.
    jsonLines.warn(
      {},
      "DATABASE_SESSION_URL is unset; the pass lock is only real if DATABASE_URL " +
        "is a DIRECT or session-mode connection. Through a transaction pooler every " +
        "pg_try_advisory_lock succeeds and two schedulers run the same night.",
    );
  }
  return deps;
}

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
 * The route body: pick the pass, log it, hand the work to `waitUntil`, 202.
 *
 * Importable and callable with a fake `CronRequest`, which is the whole point
 * of the split — the auth, the method check and the socket are
 * `createCronRoute`'s, and this is the half with the 202 contract in it.
 */
export async function handleChorePass(
  { request, url, ready, json, logger, defer }: CronRequest<StorylinePassDeps>,
  runPass: typeof runChorePass = runChorePass,
): Promise<void> {
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

  // **The work is deferred, INCLUDING the boot**, so that no I/O happens
  // before the 202 — which is the number that has to fit inside pg_net's
  // timeout on a cold instance. Note what this does NOT do: the async IIFE
  // runs synchronously to its first `await`, and `bootFromEnvironment` is
  // synchronous until then, so `loadConfig()` and the `pg.Pool` object are
  // built BEFORE the response goes out. That is fine and deliberate — neither
  // touches the network, `pg.Pool` connects lazily — but it is why this
  // comment does not claim the 202 costs nothing but config parsing.
  //
  // A boot failure cannot be reported in the response either way: it is a log
  // line and a missing `chore_runs` row, the same trade every other failure
  // here makes.
  defer(
    (async () => {
      let deps: StorylinePassDeps;
      try {
        deps = await ready();
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
}

/**
 * The route.
 *
 * **GET and POST both, unlike the drain's POST-only.** The drain refuses GET
 * because a link preview or crawler follows one by accident; this route is
 * behind the same bearer check, so that argument is already covered — and
 * Vercel's own cron sends GET and nothing else, so POST-only would rule out the
 * documented Pro-tier scheduler for no gain. Supabase Cron posts.
 *
 * **The only one of the five entrypoints that declares a `defer`**, and that is
 * not an accident of who got there first. The 202 shape is what makes pg_net's
 * timeout a question about the request rather than about the night, and it is
 * only correct where the response has nothing true to say about the outcome.
 * The pause guard's answer IS its outcome and the drain's answer is its tally,
 * so deferring either would replace a real result with an empty promise.
 */
export function createHandler(
  boot: () => Promise<StorylinePassDeps>,
  options: ChoreHandlerOptions = {},
): CronRouteHandler {
  const runPass = options.runPass ?? runChorePass;
  return createCronRoute<StorylinePassDeps>({
    name: "/api/chores",
    methods: ["GET", "POST"],
    boot,
    // `true` is `platformDefer` over the resolved logger. The tests pass their
    // own, so the deferred half can be awaited.
    defer: options.waitUntil ?? true,
    readSecret: options.readSecret,
    logger: options.logger,
    handle: (context) => handleChorePass(context, runPass),
  });
}

export default createHandler(bootFromEnvironment);
