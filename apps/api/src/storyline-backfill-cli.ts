import { loadConfig } from "@zammy/config";
import { createDb, readStorylineStats } from "@zammy/storage";
import { createGeminiClient, type TextGenerator } from "./gemini.js";
import { backfillStorylines } from "./storyline-backfill.js";
import { runBridgeSweep, type LinkerConfig } from "./storyline-linker.js";
import { labelLinkedStorylines } from "./storyline-label-service.js";

/**
 * `pnpm backfill:storylines [--restart] [--labels-only] [--no-labels]
 *  [--relabel] [--relabel-all] [--max-groups=N] [--max-labels=N] [--label-rate=N] [--batch=N]`
 *
 * The ADR-0011 rollout command (S5): replay the linker over the whole archive
 * chronologically, then label what got promoted.
 *
 * A command, never a chore — the same posture as `regroup` and for a stronger
 * reason. This rewrites every storyline in the database, which moves what every
 * live cursor is paging over, and it spends money on the label pass. Who runs
 * it, and over what, is a person's decision.
 *
 * Interrupt it freely. Ctrl-C stops at the next group boundary and prints the
 * report for what it did; re-running resumes from where it stopped, because
 * progress is derived from `storyline_groups` rather than recorded in a
 * checkpoint that could fall out of step with the work. `--restart` is the
 * only thing that discards state, and it says so.
 *
 * Runs the bridge sweep (`runBridgeSweep`) once linking finishes, the same
 * backstop the nightly chore runs (docs/STORYLINE-LINKING.md's "the merge that
 * never fired"): a chronological replay merges pairs one at a time exactly as
 * live ingest does, so a merge can re-point a third storyline's bridges onto
 * the survivor with nothing left looking once the loop moves on. Skipped for
 * `--labels-only`, which does no linking and has nothing for the sweep to find.
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const num = (name: string, fallback?: number): number | undefined => {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`--${name} must be a positive integer`);
    process.exit(1);
  }
  return value;
};

const restart = args.includes("--restart");
const labelsOnly = args.includes("--labels-only");
const skipLabels = args.includes("--no-labels");
const relabel = args.includes("--relabel");
const relabelAll = args.includes("--relabel-all");

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

const generator: TextGenerator | null = config.GEMINI_API_KEY
  ? createGeminiClient({
      apiKey: config.GEMINI_API_KEY,
      model: config.GEMINI_MODEL,
      baseUrl: config.GEMINI_BASE_URL,
      thinkingLevel: config.GEMINI_THINKING_LEVEL,
      timeoutMs: config.GEMINI_TIMEOUT_MS,
      maxRequestsPerMinute: config.GEMINI_MAX_RPM,
      // A backfill has no deadline and thousands of labels to place; falling
      // back to a bigram because the queue was busy would be the worst trade
      // available. It waits.
      maxRateWaitMs: 900_000,
    })
  : null;

// Ctrl-C stops at the next group boundary rather than mid-write. A backfill
// killed between a storyline's birth and its bridges is exactly what the
// resume logic handles, but stopping cleanly means the report is honest about
// where it got to.
const controller = new AbortController();
let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  controller.abort();
  console.log("\nstopping at the next group boundary — re-run to resume, Ctrl-C again to force");
});

console.log(
  `${restart ? "REBUILDING FROM SCRATCH" : "resuming"} · ` +
    `anchor ${config.STORYLINE_ANCHOR_MAX_SHARE} · mass ${config.STORYLINE_MASS_THRESHOLD_V2} · ` +
    `K=${config.STORYLINE_MERGE_BRIDGES} · ` +
    `labels: ${skipLabels ? "skipped" : generator ? config.GEMINI_MODEL : "fallback only (no GEMINI_API_KEY)"}`,
);

const linkerConfig: LinkerConfig = {
  // Explicitly on: the flag gates the LIVE write path, and refusing to
  // run the backfill because the live path is still dark would be
  // exactly backwards — the backfill is what has to happen first.
  enabled: true,
  rules: {
    anchorMaxShare: config.STORYLINE_ANCHOR_MAX_SHARE,
    anchorDfFloor: config.STORYLINE_ANCHOR_DF_FLOOR,
    massThreshold: config.STORYLINE_MASS_THRESHOLD_V2,
    dormancyDays: config.STORYLINE_DORMANCY_DAYS,
    dormantStrictness: config.STORYLINE_DORMANT_STRICTNESS,
  },
  mergeBridges: config.STORYLINE_MERGE_BRIDGES,
  storyDf: {
    windowDays: config.STORYLINE_DF_WINDOW_DAYS,
    timeZone: config.APP_TIMEZONE,
  },
  timeZone: config.APP_TIMEZONE,
};
const log = { warn: (obj: object, msg: string) => console.warn(msg, JSON.stringify(obj)) };
const labeler = {
  generator,
  // Recorded on every model-produced label, so a relabel campaign can
  // tell "already upgraded" from "still on the fallback" and resume.
  modelId: config.GEMINI_MODEL,
  sampleSize: config.STORYLINE_LABEL_SAMPLE,
  driftFactor: config.STORYLINE_LABEL_DRIFT_FACTOR,
};

try {
  const startedAt = Date.now();
  let lastPrinted = 0;

  const report = await backfillStorylines(
    {
      db,
      config: linkerConfig,
      log,
      labeler,
    },
    {
      restart,
      labelsOnly,
      skipLabels,
      relabel: relabel || relabelAll,
      relabelAll,
      signal: controller.signal,
      ...(num("batch") !== undefined ? { batchSize: num("batch")! } : {}),
      ...(num("max-groups") !== undefined ? { maxGroups: num("max-groups")! } : {}),
      ...(num("max-labels") !== undefined ? { maxLabels: num("max-labels")! } : {}),
      // Defaults to the configured ceiling, so the pass paces itself instead of
      // piling into the client's pacer and waiting there. `--label-rate` can
      // only go SLOWER usefully: the client enforces the ceiling regardless.
      labelRatePerMinute: num("label-rate", config.GEMINI_MAX_RPM)!,
      onProgress: (progress) => {
        // One line per 2s at most: a backfill is long enough that progress
        // matters and long enough that a line per batch is a wall of text.
        if (Date.now() - lastPrinted < 2000) return;
        lastPrinted = Date.now();
        const elapsed = (Date.now() - startedAt) / 1000;
        if (progress.phase === "link") {
          const rate = progress.done / Math.max(elapsed, 0.001);
          const left = Math.max(0, (progress.total ?? 0) - progress.done) / Math.max(rate, 0.001);
          console.log(
            `  linking ${progress.done}/${progress.total} groups ` +
              `(${rate.toFixed(0)}/s, ~${(left / 60).toFixed(0)}m left)` +
              `${progress.at ? `  at ${progress.at.toISOString().slice(0, 10)}` : ""}`,
          );
        } else {
          console.log(`  labelling ${progress.done}`);
        }
      },
    },
  );

  let { stats } = report;

  // The bridge sweep, same backstop the nightly chore runs: a chronological
  // replay merges pairs one at a time exactly as live ingest does, so a merge
  // can re-point a third storyline's bridges onto the survivor with nothing
  // left looking once the loop moves on (docs/STORYLINE-LINKING.md). Skipped
  // for `--labels-only`, which links nothing and gives the sweep nothing to find.
  let bridgeReport: Awaited<ReturnType<typeof runBridgeSweep>> | null = null;
  if (!labelsOnly) {
    bridgeReport = await runBridgeSweep({ db, config: linkerConfig, log });
    if (generator && bridgeReport.survivors.length > 0) {
      await labelLinkedStorylines(
        { db, labeler, log },
        bridgeReport.survivors.map((winnerId) => ({
          groupId: "",
          storylineId: winnerId,
          attached: false,
          attachedTo: [],
          promoted: [],
          bridged: [],
          merged: [{ winnerId, loserId: winnerId }],
        })),
      );
    }
    // Stats printed below must reflect what the sweep just merged, not the
    // snapshot backfillStorylines took before it ran.
    stats = await readStorylineStats(db);
  }

  const pct = (part: number, whole: number): string =>
    whole > 0 ? `${((part / whole) * 100).toFixed(2)}%` : "—";

  console.log(`\n${report.incomplete ? "STOPPED EARLY — re-run to resume" : "complete"}`);
  console.log(`  linked this run   ${report.linked} groups` +
    `${report.failures ? `  (${report.failures} failed)` : ""}`);
  console.log(`  attached          ${report.attached}   merges ${report.merges}`);
  if (bridgeReport) {
    console.log(
      `  bridge sweep      found ${bridgeReport.found}   merged ${bridgeReport.merged}` +
        `${bridgeReport.failures ? `  (${bridgeReport.failures} failed)` : ""}` +
        `${bridgeReport.incomplete ? "  INCOMPLETE — re-run to finish" : ""}`,
    );
  }
  console.log(`\n  storylines        ${stats.storylines}   (+${stats.aliases} aliases)`);
  console.log(
    `  promoted          ${stats.promoted}  ${pct(stats.promoted, stats.storylines)} of storylines`,
  );
  console.log(`  groups linked     ${stats.linkedGroups}`);
  // The percolation alarm (ADR-0011). ADR-0009's swallow was 1,179 of 1,190 —
  // a 99% share — and the sweep pinned the current thresholds at 0.18%.
  console.log(
    `  largest storyline ${stats.largestStoryline} groups  ${pct(stats.largestStoryline, stats.linkedGroups)} of the corpus`,
  );
  console.log(`  day slots         ${stats.daySlots}`);
  // A replay of old history builds storylines that are already quiet; the run
  // stamps them so nothing reads five months of silence as live (ADR-0011).
  console.log(`  marked dormant    ${report.dormant}`);
  console.log(
    `\n  labels            ${stats.labelled} of ${stats.promoted} promoted ` +
      `(${pct(stats.labelled, stats.promoted)})` +
      `${stats.unlabelled ? `, ${stats.unlabelled} asked and unnameable` : ""}`,
  );
  console.log(
    `  this run          ${report.labelled.model} model, ${report.labelled.bigram} bigram, ` +
      `${report.labelled.none} none, ${report.labelled.skipped} already current`,
  );
  console.log(
    `\n  runtime           link ${(report.linkMs / 1000).toFixed(0)}s, ` +
      `label ${(report.labelMs / 1000).toFixed(0)}s`,
  );

  if (report.incomplete) process.exitCode = 1;
} catch (error) {
  console.error(`\nbackfill refused to run:\n${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
