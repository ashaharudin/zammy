import type { Config } from "@zammy/config";
import { readChoreRuns } from "@zammy/storage";
import { CHORE_PASSES, runChorePass, type ChorePass } from "./chore-runner.js";
import type { StorylinePassDeps } from "./chores.js";
import {
  EXIT_CONFIG,
  EXIT_FAILED,
  POSITIVE_NUMBER,
  type Args,
  type CommandSpec,
} from "./operator-command.js";
import { choreDepsFromConfig } from "./wiring.js";

/**
 * `pnpm chores <pass> [--label-rate=N] [--max-labels=N] [--max-summaries=N]
 * [--summary-rate=N] [--late-candidates] [--changed-only|--full]`, and
 * `pnpm chores status [--pass=N] [--limit=N]` —
 * the nightly chores as a one-shot process (ARCHITECTURE 9.1).
 *
 * A chore, not a command: unlike `regroup` or `backfill:storylines` this is not
 * something an operator decides to do, it is what happens every night. What
 * makes it a CLI anyway is where the clock now lives — outside the app, in the
 * platform's scheduler (see `chores.ts`, "Where the schedule lives"). The
 * schedules this replaced were `0 3 * * *` for retention, `0 4 * * *` for
 * storylines and `0 5 * * *` for summaries, in UTC; whatever schedules this must
 * reproduce them, including the
 * timezone, or the day boundaries the passes bucket by shift under them. On the
 * Vercel deployment that scheduler is Supabase Cron against `api/chores.ts`
 * (VERCEL-ALL-IN-SCOPE §3.3), and this file and that route deliberately share
 * everything below the entrypoint — `chore-runner.ts` holds the lock, the pass
 * table and the `chore_runs` record, so a run from a laptop and a run from the
 * scheduler contend for the same lock and land in the same table.
 *
 * ── Contract with the scheduler ──────────────────────────────────────────────
 * It runs one pass and exits, holding nothing open — the requirement every cron
 * platform states and the reason this is not a long-lived worker. Exit codes:
 *
 *     0   the pass ran, or another run already held the lock
 *     1   the pass failed — the log line above it says which step
 *    64   usage (EX_USAGE): no pass named, or a name that is not a pass
 *    78   configuration (EX_CONFIG): the same refusal `index.ts` makes
 *
 * They are `operator-command.ts`'s vocabulary now, and they were this file's
 * first — the other eleven commands were brought up to them, not the reverse.
 *
 * A skipped run exits 0 deliberately. Overlap is the scheduler's own semantics
 * (Railway skips a cron whose previous run is still Active; a systemd timer will
 * not re-enter a running unit), so it is expected rather than exceptional, and
 * alerting on it would train an operator to ignore the alert. The warn line it
 * logs is what a stuck run shows up as — and since Phase 4 so is a `chore_runs`
 * row with `outcome: 'skipped'`, which outlives the log.
 *
 * ── Why this one builds its own database handle ──────────────────────────────
 * `operator-command.ts` will build one from a `db` on the spec, and this spec
 * deliberately has none. The handle comes from `choreDepsFromConfig`, which
 * pins the session-mode URL and the pool size TOGETHER with the linker bar and
 * the labeler pacing — `wiring.ts`'s header is about exactly that bundle, and
 * re-declaring `{ session: true, max: 4 }` here would be the second copy it
 * exists to prevent. So this `run` closes what it opened.
 */

const USAGE_DETAILS = `
  retention        the retention report, the trailing-corpus prune, and the
                   REINDEX CONCURRENTLY sweep
  storylines       dormancy, bridge sweep, labels, label merge, graph shape
  summaries        the historical preserve: one sentence per storyline-day
                   and per populated 6-hour UTC segment of it (ADR-0023)

  Any single step of the storyline pass is also addressable on its own, for
  a re-run that must not drag the whole night with it:
    dormancy, bridges, late-candidates, labels, label-merge, graph

  status           what recently ran, from chore_runs — the durable answer
                   to 'did last night's chores run?'
                   [--pass=NAME] [--limit=N]

  --late-candidates  the storyline pass also runs the late-candidate sweep. Off
                     by default: it percolates against the fixed candidate
                     retrieval until K is re-measured (docs/STORYLINE-LINKING.md).
                     Naming \`late-candidates\` as the pass runs it regardless —
                     that IS the deliberate act the gate protects.
  --changed-only     that sweep: offer only groups whose candidate set could
                     have changed. --full forces the unscoped pass.
  --max-labels       overrides CHORE_MAX_LABELS (default 50) for this run only.
  --max-summaries    overrides SUMMARY_MAX_PER_RUN (default 120) for this run.
                     It counts MODEL CALLS, not days: a day costs 1-5.
  --summary-rate     model calls per minute for the summary pass. Lower it when
                     the server is labelling — one key, two pacers.
  --label-budget     wall-clock ceiling for the label pass, in seconds. NOT
                     applied here by default: CHORE_LABEL_BUDGET_MS exists to
                     beat a serverless function's deadline, and this has none.`;

export const spec: CommandSpec = {
  name: "chores",
  synopsis:
    `<${CHORE_PASSES.join("|")}|status> [--label-rate=N] [--max-labels=N] ` +
    "[--max-summaries=N] [--summary-rate=N] [--late-candidates] [--changed-only|--full]",
  details: USAGE_DETAILS,
  positional: {
    placeholder: `<${CHORE_PASSES.join("|")}|status>`,
    values: [...CHORE_PASSES, "status"],
  },
  flags: {
    "label-rate": { kind: "value", placeholder: "N", describe: "model calls per minute" },
    "max-labels": { kind: "value", placeholder: "N", describe: "overrides CHORE_MAX_LABELS" },
    "max-summaries": { kind: "value", placeholder: "N", describe: "overrides SUMMARY_MAX_PER_RUN" },
    "summary-rate": { kind: "value", placeholder: "N", describe: "summary calls per minute" },
    "label-budget": { kind: "value", placeholder: "N", describe: "label-pass ceiling, in seconds" },
    "late-candidates": { kind: "boolean", describe: "also run the late-candidate sweep" },
    "changed-only": { kind: "boolean", describe: "narrow that sweep to changed candidate sets" },
    full: { kind: "boolean", describe: "force the unscoped late-candidate pass" },
    pass: { kind: "value", placeholder: "NAME", describe: "status: one pass only" },
    limit: { kind: "value", placeholder: "N", describe: "status: how many rows" },
  },
  async run({ args, config }) {
    const command = args.positionals[0] as ChorePass | "status";
    const wantsStatus = command === "status";

    /**
     * JSON lines, because the chores log through `log.info`/`log.warn` with a
     * structured object and this output is read by a log pipeline (`docker compose
     * logs`, or whatever the deploy target collects stdout with) rather than by a
     * person at a prompt — which is the
     * difference between this and the operator CLIs' human-readable printing.
     */
    const passLabel = wantsStatus ? "status" : command;
    const emit = (level: string, obj: object, msg: string): void => {
      console.log(JSON.stringify({ level, pass: passLabel, msg, ...obj }));
    };
    const log = {
      info: (obj: object, msg: string) => emit("info", obj, msg),
      warn: (obj: object, msg: string) => emit("warn", obj, msg),
    };

    // Built exactly as the route builds it — same wiring, same linker bar, same
    // labeler pacing, same session-mode connection and pool size. `wiring.ts` owns
    // that construction so the two entrypoints cannot drift; the flags below are
    // this entrypoint's own, and they are overrides applied to it rather than a
    // second configuration.
    const deps = choreDepsFromConfig(config, log);

    try {
      return wantsStatus
        ? await printStatus(deps, args)
        : await runPass(command, deps, config, args, log);
    } finally {
      // Ends the pool this CLI created, which is what lets the process exit rather
      // than being held open by an idle connection — the cron contract.
      await deps.db.destroy();
    }
  },
};

/**
 * `status`: a read, not a pass — no lock, no record of its own, which is why it
 * does not live in `chore-runner.ts`. It is here because Phase 5's exit
 * criterion — "did last night's chores run?" is answered by a `chore_runs`
 * query — should not need anybody to write that query by hand against a session
 * pooler.
 */
async function printStatus(deps: StorylinePassDeps, args: Args): Promise<number> {
  const limit = args.number("limit", POSITIVE_NUMBER);
  let runs;
  try {
    runs = await readChoreRuns(deps.db, {
      pass: args.value("pass"),
      ...(limit !== undefined ? { limit } : {}),
    });
  } catch (error) {
    // 42P01, the one failure worth translating: this is the first command
    // anybody runs after pulling the branch that added the table, and a raw
    // `relation "chore_runs" does not exist` sends them looking at the wrong
    // thing. Every other error is rethrown — hiding those is how a real
    // connection problem gets read as "nothing has run yet".
    if ((error as { code?: string }).code !== "42P01") throw error;
    console.error("chore_runs does not exist — run `pnpm db:migrate` (migration 0018)");
    return EXIT_CONFIG; // EX_CONFIG: the database is not the shape this needs
  }

  if (runs.length === 0) console.error("no chore runs recorded");
  for (const run of runs) {
    console.log(
      JSON.stringify({
        pass: run.pass,
        source: run.source,
        startedAt: run.startedAt.toISOString(),
        // Null here on a row whose pass never came back — the function was
        // killed at `maxDuration`, or the process died. That is the state the
        // row exists to make visible, so it is printed rather than hidden.
        finishedAt: run.finishedAt?.toISOString() ?? null,
        outcome: run.outcome,
        modelCalls: run.modelCalls,
        error: run.error,
        report: run.report,
      }),
    );
  }
  return 0;
}

/** One pass, with the flags applied as overrides on the configured night. */
async function runPass(
  pass: ChorePass,
  deps: StorylinePassDeps,
  config: Config,
  args: Args,
  log: StorylinePassDeps["log"],
): Promise<number> {
  // `--label-rate` can only usefully go SLOWER: the client enforces the ceiling
  // regardless. Lower it when the server is labelling too — the two processes
  // have separate pacers on one shared key.
  const labelRate = args.number("label-rate", POSITIVE_NUMBER);
  if (labelRate !== undefined) deps.labelRatePerMinute = labelRate;
  const maxLabels = args.number("max-labels", POSITIVE_NUMBER);
  if (maxLabels !== undefined) deps.maxLabels = maxLabels;
  // The summary pass's twin of both. `--summary-rate` can only usefully go
  // SLOWER for the same reason `--label-rate` can: the client enforces the
  // ceiling regardless, and what this buys is not competing with a server that
  // is labelling on the same key.
  const maxSummaries = args.number("max-summaries", POSITIVE_NUMBER);
  if (maxSummaries !== undefined) deps.maxSummaries = maxSummaries;
  const summaryRate = args.number("summary-rate", POSITIVE_NUMBER);
  if (summaryRate !== undefined) deps.summaryRatePerMinute = summaryRate;
  // The budget is a ROUTE concern and is dropped here unless asked for.
  // `CHORE_LABEL_BUDGET_MS` exists because `api/chores.ts` is killed at 300 s;
  // a terminal has no such deadline, and inheriting the configured night's
  // budget would silently truncate the one run whose whole purpose is to drain
  // a backlog in a single sitting. `--max-labels` is deliberately NOT treated
  // this way: a spend ceiling means the same thing wherever the pass runs.
  const labelBudget = args.number("label-budget", POSITIVE_NUMBER);
  if (labelBudget !== undefined) deps.labelBudgetMs = labelBudget * 1000;
  else delete deps.labelBudgetMs;
  // And the summary pass's, dropped here for the identical reason: the budget
  // exists to beat a serverless function's deadline, and a terminal has none.
  // Inheriting it would truncate the one run whose purpose is to drain a
  // backlog in a single sitting.
  delete deps.summaryBudgetMs;
  // `--late-candidates` runs the sweep inside the storyline pass for one night
  // without editing the environment, because the honest way to drain the backlog
  // fixing candidate retrieval exposed is an operator watching the graph shape,
  // not a flag flipped once and forgotten. The config default is off.
  if (args.boolean("late-candidates")) deps.lateCandidateSweep = true;
  // That sweep's scope. `--full` is the flag that matters: the narrow pass gives
  // up "every group in the window, every night" (docs/ARCHITECTURE.md §9.1 lists
  // what that costs), so an operator needs a way to run the unscoped pass
  // without changing the environment the scheduler reads.
  if (args.boolean("full")) deps.lateCandidatesChangedOnly = false;
  else if (args.boolean("changed-only")) deps.lateCandidatesChangedOnly = true;

  // Which connection and which TLS, before any work: the lock cannot tell an
  // operator that it was session-scoped, and a pass that silently ran twice
  // looks exactly like a pass that ran once.
  const connectionName = config.DATABASE_SESSION_URL ? "DATABASE_SESSION_URL" : "DATABASE_URL";
  log.info({ connection: connectionName, tls: config.DATABASE_SSL }, "chore pass starting");

  const result = await runChorePass(pass, deps, { source: "cli" });
  if (result.outcome === "failed") {
    log.warn(
      {
        runId: result.runId,
        err: result.error instanceof Error ? result.error.message : String(result.error),
      },
      "chore pass FAILED",
    );
    // Printed rather than swallowed: the stack is the whole diagnostic, and it
    // goes to stderr where a scheduler's failure notification will quote it.
    console.error(result.error);
    return EXIT_FAILED;
  }
  if (result.outcome === "ok") {
    log.info(
      { runId: result.runId, seconds: Number((result.ms / 1000).toFixed(1)) },
      "chore pass ran",
    );
  }
  // A skip already logged its own warn line inside the runner, and its
  // `chore_runs` row says so durably.
  return 0;
}
