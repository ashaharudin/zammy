import { ConfigError, loadConfig } from "@zammy/config";
import { createDb } from "@zammy/storage";
import { sql } from "kysely";
import {
  runRetentionChore,
  runStorylinePass,
  type ChoreDeps,
  type StorylinePassDeps,
} from "./chores.js";
import { createLabeler, createLinkerConfig } from "./wiring.js";

/**
 * `pnpm chores <retention|storylines> [--label-rate=N] [--max-labels=N]` — the
 * nightly chores as a one-shot process (ARCHITECTURE 9.1).
 *
 * A chore, not a command: unlike `regroup` or `backfill:storylines` this is not
 * something an operator decides to do, it is what happens every night. What
 * makes it a CLI anyway is where the clock now lives — outside the app, in the
 * platform's scheduler (see `chores.ts`, "Where the schedule lives"). The
 * schedules this replaced were `0 3 * * *` for retention and `0 4 * * *` for
 * storylines, in UTC; whatever schedules this must reproduce them, including the
 * timezone, or the day boundaries the passes bucket by shift under them.
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
 * logs is what a stuck run shows up as.
 */

const PASSES = ["retention", "storylines"] as const;
type Pass = (typeof PASSES)[number];

/**
 * Session-scoped advisory lock keys, one per pass so the two never block each
 * other — they are scheduled an hour apart, but a retention run that overruns
 * must not eat the storyline pass's night.
 *
 * Arbitrary but stable, and deliberately adjacent to (never equal to) the
 * migrator's 7226461501: a chore that blocked on the migration lock, or worse
 * took it, would be a deploy hanging behind a label pass.
 */
const LOCK_KEYS: Record<Pass, number> = {
  retention: 7_226_461_502,
  storylines: 7_226_461_503,
};

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
if (named.length !== 1 || !PASSES.includes(named[0] as Pass)) {
  console.error(`usage: chores <${PASSES.join("|")}> [--label-rate=N] [--max-labels=N]`);
  console.error("");
  console.error("  retention   the retention report, and the trailing-corpus prune");
  console.error("  storylines  dormancy, bridge sweep, late candidates, labels, label merge");
  process.exit(64);
}
const pass = named[0] as Pass;

let config;
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
const emit = (level: string, obj: object, msg: string): void => {
  console.log(JSON.stringify({ level, pass, msg, ...obj }));
};
const log = {
  info: (obj: object, msg: string) => emit("info", obj, msg),
  warn: (obj: object, msg: string) => emit("warn", obj, msg),
};

// max: 4 — one connection is pinned for the advisory lock below and the passes
// borrow the rest. Sequential work, so this is slack rather than parallelism;
// what it must not be is 1, which would deadlock against the pinned connection.
const db = createDb(config.DATABASE_URL, { max: 4 });

const choreDeps: ChoreDeps = {
  db,
  config: {
    retentionDays: config.RETENTION_DAYS,
    storyDfWindowDays: config.STORYLINE_DF_WINDOW_DAYS,
    storylineDormancyDays: config.STORYLINE_DORMANCY_DAYS,
    timeZone: config.APP_TIMEZONE,
  },
  now: () => new Date(),
  log,
};

const startedAt = Date.now();
let failure: unknown;

try {
  // pg_TRY_advisory_lock, not pg_advisory_lock: a second run must skip, not
  // queue behind the first and then start the same night's work an hour late.
  // The lock is what replaces BullMQ's exactly-once — with the clock outside the
  // app, two schedulers pointed at one database is a configuration mistake
  // nothing else would catch, and the label pass spends real money per call.
  const ran = await db.connection().execute(async (connection) => {
    const locked = await sql<{
      locked: boolean;
    }>`select pg_try_advisory_lock(${sql.lit(LOCK_KEYS[pass])}) as locked`.execute(connection);
    if (locked.rows[0]?.locked !== true) return false;

    try {
      if (pass === "retention") {
        await runRetentionChore(choreDeps);
      } else {
        const storylineDeps: StorylinePassDeps = {
          ...choreDeps,
          linker: createLinkerConfig(config),
          labeler: createLabeler(config, log),
          rules: {
            graceDays: config.STORYLINE_LABEL_MERGE_GRACE_DAYS,
            maxComponent: config.STORYLINE_LABEL_MERGE_MAX_COMPONENT,
          },
          // Defaults to the configured ceiling, so the pass paces itself rather
          // than piling into the client's pacer and waiting there.
          // `--label-rate` can only usefully go SLOWER: the client enforces the
          // ceiling regardless. Lower it when the server is labelling too — the
          // two processes have separate pacers on one shared key.
          labelRatePerMinute: num("label-rate") ?? config.GEMINI_MAX_RPM,
          ...(num("max-labels") !== undefined ? { maxLabels: num("max-labels") } : {}),
        };
        const report = await runStorylinePass(storylineDeps);
        log.info({ report }, "storyline pass complete");
      }
      return true;
    } finally {
      await sql`select pg_advisory_unlock(${sql.lit(LOCK_KEYS[pass])})`.execute(connection);
    }
  });

  if (ran) {
    log.info({ seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)) }, "chore pass ran");
  } else {
    log.warn(
      {},
      "another run holds this pass's lock — skipping. Expected when a run overlaps " +
        "the next schedule; a run that never finishes looks like this every night.",
    );
  }
} catch (error) {
  failure = error;
  log.warn({ err: error instanceof Error ? error.message : String(error) }, "chore pass FAILED");
} finally {
  // Ends the pool this CLI created, which is what lets the process exit rather
  // than being held open by an idle connection — the cron contract.
  await db.destroy();
}

if (failure !== undefined) {
  // Rethrow rather than swallow: the stack is the whole diagnostic, and it goes
  // to stderr where a scheduler's failure notification will quote it.
  console.error(failure);
  process.exit(1);
}
