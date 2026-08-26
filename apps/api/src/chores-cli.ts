import { ConfigError, loadConfig, type Config } from "@zammy/config";
import { readChoreRuns } from "@zammy/storage";
import { CHORE_PASSES, isChorePass, runChorePass, type ChorePass } from "./chore-runner.js";
import { choreDepsFromConfig } from "./wiring.js";

/**
 * `pnpm chores <pass> [--label-rate=N] [--max-labels=N] [--late-candidates]
 * [--changed-only|--full]`, and `pnpm chores status [--pass=N] [--limit=N]` —
 * the nightly chores as a one-shot process (ARCHITECTURE 9.1).
 *
 * A chore, not a command: unlike `regroup` or `backfill:storylines` this is not
 * something an operator decides to do, it is what happens every night. What
 * makes it a CLI anyway is where the clock now lives — outside the app, in the
 * platform's scheduler (see `chores.ts`, "Where the schedule lives"). The
 * schedules this replaced were `0 3 * * *` for retention and `0 4 * * *` for
 * storylines, in UTC; whatever schedules this must reproduce them, including the
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
 * A skipped run exits 0 deliberately. Overlap is the scheduler's own semantics
 * (Railway skips a cron whose previous run is still Active; a systemd timer will
 * not re-enter a running unit), so it is expected rather than exceptional, and
 * alerting on it would train an operator to ignore the alert. The warn line it
 * logs is what a stuck run shows up as — and since Phase 4 so is a `chore_runs`
 * row with `outcome: 'skipped'`, which outlives the log.
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const num = (name: string): number | undefined => {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`--${name} must be a positive number (got '${raw}')`);
    process.exit(64);
  }
  return value;
};

const named = args.filter((arg) => !arg.startsWith("--"));
const command = named[0];
const wantsStatus = command === "status";

if (named.length !== 1 || (!wantsStatus && !isChorePass(command ?? ""))) {
  console.error(
    `usage: chores <${CHORE_PASSES.join("|")}|status> [--label-rate=N] [--max-labels=N] ` +
      "[--late-candidates] [--changed-only|--full]",
  );
  console.error("");
  console.error("  retention        the retention report, the trailing-corpus prune, and the");
  console.error("                   REINDEX CONCURRENTLY sweep");
  console.error("  storylines       dormancy, bridge sweep, labels, label merge, graph shape");
  console.error("");
  console.error("  Any single step of the storyline pass is also addressable on its own, for");
  console.error("  a re-run that must not drag the whole night with it:");
  console.error("    dormancy, bridges, late-candidates, labels, label-merge, graph");
  console.error("");
  console.error("  status           what recently ran, from chore_runs — the durable answer");
  console.error("                   to 'did last night's chores run?'");
  console.error("                   [--pass=NAME] [--limit=N]");
  console.error("");
  console.error(
    "  --late-candidates  the storyline pass also runs the late-candidate sweep. Off",
  );
  console.error(
    "                     by default: it percolates against the fixed candidate",
  );
  console.error(
    "                     retrieval until K is re-measured (docs/STORYLINE-LINKING.md).",
  );
  console.error(
    "                     Naming `late-candidates` as the pass runs it regardless —",
  );
  console.error("                     that IS the deliberate act the gate protects.");
  console.error(
    "  --changed-only     that sweep: offer only groups whose candidate set could",
  );
  console.error(
    "                     have changed. --full forces the unscoped pass.",
  );
  console.error(
    "  --max-labels       overrides CHORE_MAX_LABELS (default 50) for this run only.",
  );
  process.exit(64);
}

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(78); // EX_CONFIG, as index.ts does
  }
  throw error;
}

/**
 * JSON lines, because the chores log through `log.info`/`log.warn` with a
 * structured object and this output is read by a log pipeline (`docker compose
 * logs`, or whatever the deploy target collects stdout with) rather than by a
 * person at a prompt — which is the
 * difference between this and the operator CLIs' human-readable printing.
 */
const passLabel = wantsStatus ? "status" : (command as ChorePass);
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
const connectionName = config.DATABASE_SESSION_URL ? "DATABASE_SESSION_URL" : "DATABASE_URL";

/**
 * `status`: a read, not a pass — no lock, no record of its own, which is why it
 * does not live in `chore-runner.ts`. It is here because Phase 5's exit
 * criterion — "did last night's chores run?" is answered by a `chore_runs`
 * query — should not need anybody to write that query by hand against a session
 * pooler.
 */
async function printStatus(): Promise<number> {
  try {
    return await readAndPrint();
  } finally {
    // The pool, like the pass half's — held open it would keep the process
    // alive past the last line of output.
    await deps.db.destroy();
  }
}

async function readAndPrint(): Promise<number> {
  let runs;
  try {
    runs = await readChoreRuns(deps.db, {
      pass: flag("pass"),
      ...(num("limit") !== undefined ? { limit: num("limit") as number } : {}),
    });
  } catch (error) {
    // 42P01, the one failure worth translating: this is the first command
    // anybody runs after pulling the branch that added the table, and a raw
    // `relation "chore_runs" does not exist` sends them looking at the wrong
    // thing. Every other error is rethrown — hiding those is how a real
    // connection problem gets read as "nothing has run yet".
    if ((error as { code?: string }).code !== "42P01") throw error;
    console.error("chore_runs does not exist — run `pnpm db:migrate` (migration 0018)");
    return 78; // EX_CONFIG: the database is not the shape this needs
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
async function runPass(pass: ChorePass): Promise<number> {
  // `--label-rate` can only usefully go SLOWER: the client enforces the ceiling
  // regardless. Lower it when the server is labelling too — the two processes
  // have separate pacers on one shared key.
  const labelRate = num("label-rate");
  if (labelRate !== undefined) deps.labelRatePerMinute = labelRate;
  const maxLabels = num("max-labels");
  if (maxLabels !== undefined) deps.maxLabels = maxLabels;
  // `--late-candidates` runs the sweep inside the storyline pass for one night
  // without editing the environment, because the honest way to drain the backlog
  // fixing candidate retrieval exposed is an operator watching the graph shape,
  // not a flag flipped once and forgotten. The config default is off.
  if (args.includes("--late-candidates")) deps.lateCandidateSweep = true;
  // That sweep's scope. `--full` is the flag that matters: the narrow pass gives
  // up "every group in the window, every night" (docs/ARCHITECTURE.md §9.1 lists
  // what that costs), so an operator needs a way to run the unscoped pass
  // without changing the environment the scheduler reads.
  if (args.includes("--full")) deps.lateCandidatesChangedOnly = false;
  else if (args.includes("--changed-only")) deps.lateCandidatesChangedOnly = true;

  // Which connection and which TLS, before any work: the lock cannot tell an
  // operator that it was session-scoped, and a pass that silently ran twice
  // looks exactly like a pass that ran once.
  log.info({ connection: connectionName, tls: config.DATABASE_SSL }, "chore pass starting");

  let failure: unknown;
  try {
    const result = await runChorePass(pass, deps, { source: "cli" });
    if (result.outcome === "failed") {
      failure = result.error;
      log.warn(
        {
          runId: result.runId,
          err: result.error instanceof Error ? result.error.message : String(result.error),
        },
        "chore pass FAILED",
      );
    } else if (result.outcome === "ok") {
      log.info(
        { runId: result.runId, seconds: Number((result.ms / 1000).toFixed(1)) },
        "chore pass ran",
      );
    }
    // A skip already logged its own warn line inside the runner, and its
    // `chore_runs` row says so durably.
  } finally {
    // Ends the pool this CLI created, which is what lets the process exit rather
    // than being held open by an idle connection — the cron contract.
    await deps.db.destroy();
  }

  if (failure !== undefined) {
    // Printed rather than swallowed: the stack is the whole diagnostic, and it
    // goes to stderr where a scheduler's failure notification will quote it.
    console.error(failure);
    return 1;
  }
  return 0;
}

// `process.exitCode`, never `process.exit()`. `console.log` to a pipe is
// asynchronous in Node and `process.exit` does not flush what is queued, so
// `pnpm chores status --limit=200 | jq` would silently lose its tail — and these
// rows are not small. Setting the code lets the process end on its own once
// stdout has drained, which it now can: both halves close the pool themselves.
process.exitCode = wantsStatus
  ? await printStatus()
  : await runPass(command as ChorePass);
