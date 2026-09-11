import type { Config } from "@zammy/config";
import { countFormationRefusals, readStorylineStats } from "@zammy/storage";
import {
  EXIT_FAILED,
  POSITIVE_INTEGER,
  type CommandSpec,
} from "./operator-command.js";
import { backfillStorylines } from "./storyline-backfill.js";
import { runBridgeSweep, type LinkerConfig } from "./storyline-linker.js";
import { labelLinkedStorylines } from "./storyline-label-service.js";
import { storylineBar } from "./storyline-bar.js";
import { linkerBarFromEnv } from "./wiring.js";

/**
 * The bar a BACKFILL judges at: the configured one (`wiring.ts`), diverging on
 * `coherenceGate` always and on `honourRefusals` only when the operator asks.
 *
 * Everything else is the live path's by construction, and the reasons that used
 * to be written beside each copied field were all the same reason: a rebuild is
 * where the whole archive's evidence is written, so a backfill that retrieved or
 * bridged differently from the live path would leave an archive nothing has
 * measured and a graph whose standing pairs no arrival can reproduce. `enabled`
 * is not a divergence either — the flag gates the LIVE write path, and
 * `STORYLINE_BAR` ships it on, which is right for the process that has to run
 * first.
 *
 * A function at module scope rather than a literal inside `run`, because the
 * mapping from one flag to one field is the place a typo inverts the fix
 * silently: `honourRefusals: ignoreRefusals` type-checks, passes every linker
 * test, and rebuilds every pile a verdict ever refused.
 * `storyline-backfill-command.test.ts` pins both directions.
 *
 * **`coherenceGate` is false unconditionally**, and that is structural before it
 * is budget: the gate DEFERS a formation to a tail `backfillStorylines` does not
 * have, so a gated replay forms nothing (a rebuild) or silently drops every
 * formation from an ordinary-looking report (a resume).
 * `assertNoUnresolvableGate` refuses such a run rather than letting this line be
 * the only thing preventing it.
 *
 * **`honourRefusals` is true unless the operator says otherwise**, and nothing
 * about replaying a verdict is a budget decision: a refusal is keyed on GROUPS,
 * survives any amount of storyline churn, and costs one indexed read per
 * formation-shaped decision. It used to be unreachable — the linker read the
 * refusals table inside the gate's own `if` — and what that cost is recorded in
 * docs/STORYLINE-BACKFILL.md ("What a rebuild remembers"), along with the
 * arithmetic for why buying NEW verdicts here is still not worth it — measured
 * in docs/STORYLINE-LINKING.md ("The rerun the section above is owed").
 */
export function backfillBar(
  config: Config,
  options: { ignoreRefusals: boolean },
): LinkerConfig {
  return storylineBar({
    ...linkerBarFromEnv(config),
    coherenceGate: false,
    honourRefusals: !options.ignoreRefusals,
  });
}

/**
 * `pnpm backfill:storylines [--restart] [--labels-only] [--no-labels]
 *  [--relabel] [--relabel-all] [--ignore-refusals] [--max-groups=N] [--max-labels=N]
 *  [--label-rate=N] [--batch=N]`
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
export const spec: CommandSpec = {
  name: "backfill:storylines",
  synopsis:
    "[--restart] [--groups=1,2,3] [--labels-only] [--no-labels] [--relabel] " +
    "[--relabel-all] [--ignore-refusals] [--max-groups=N] [--max-labels=N] " +
    "[--label-rate=N] [--batch=N]",
  flags: {
    restart: { kind: "boolean", describe: "discard storyline state and rebuild from scratch" },
    groups: {
      kind: "value",
      placeholder: "1,2,3",
      describe: "link exactly these groups, cursor ignored, no bridge sweep",
    },
    "labels-only": { kind: "boolean", describe: "label what is already linked; link nothing" },
    "no-labels": { kind: "boolean", describe: "link only; promise no model calls" },
    relabel: {
      kind: "boolean",
      describe: "re-label everything the configured model has not named yet",
    },
    "relabel-all": { kind: "boolean", describe: "re-name everything — a prompt change" },
    "ignore-refusals": {
      kind: "boolean",
      describe: "rebuild refused formations too — pure token evidence, no verdicts",
    },
    "max-groups": { kind: "value", placeholder: "N", describe: "stop after linking N groups" },
    "max-labels": { kind: "value", placeholder: "N", describe: "stop after N model calls" },
    "label-rate": {
      kind: "value",
      placeholder: "N",
      describe: "model calls per minute (default GEMINI_MAX_RPM); lower only",
    },
    batch: { kind: "value", placeholder: "N", describe: "groups read per page (default 500)" },
  },
  db: {},
  labeler: () => ({
    // A backfill has no deadline and thousands of labels to place; falling
    // back to a bigram because the queue was busy would be the worst trade
    // available. It waits.
    maxRateWaitMs: 900_000,
  }),
  async run({ args, config, db, labeler }) {
    const restart = args.boolean("restart");
    /**
     * `--groups=1,2,3` — link exactly these and nothing else, cursor ignored.
     *
     * For a group stranded BEHIND the resume cursor with no storyline at all,
     * which a plain resume never revisits and `--restart` would fix only by
     * rewriting the whole database. Skips the bridge sweep: a seven-group
     * repair has no business triggering archive-wide merges, and the nightly
     * chore runs that invariant anyway.
     */
    const onlyGroups = (args.value("groups") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^\d+$/.test(id));
    const labelsOnly = args.boolean("labels-only");
    const skipLabels = args.boolean("no-labels");
    const relabel = args.boolean("relabel");
    const relabelAll = args.boolean("relabel-all");
    const ignoreRefusals = args.boolean("ignore-refusals");

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
        `labels: ${skipLabels ? "skipped" : labeler.generator ? config.GEMINI_MODEL : "fallback only (no GEMINI_API_KEY)"}`,
    );

    const linkerConfig = backfillBar(config, { ignoreRefusals });
    const log = { warn: (obj: object, msg: string) => console.warn(msg, JSON.stringify(obj)) };

    // Said out loud, because the run reports identically either way and the
    // difference is 66 hand-verified subjects. A rebuild that ignores refusals
    // re-mints every pile a verdict has ever refused; that it is doing so should
    // not have to be inferred from a flag the operator typed minutes ago.
    if (!labelsOnly) {
      const refusals = await countFormationRefusals(db);
      console.log(
        ignoreRefusals
          ? `IGNORING ${refusals} recorded formation refusals — ` +
              `piles a verdict already refused will be rebuilt`
          : `honouring ${refusals} recorded formation refusals`,
      );
    }

    const batch = args.number("batch", POSITIVE_INTEGER);
    const maxGroups = args.number("max-groups", POSITIVE_INTEGER);
    const maxLabels = args.number("max-labels", POSITIVE_INTEGER);

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
          ...(batch !== undefined ? { batchSize: batch } : {}),
          ...(maxGroups !== undefined ? { maxGroups } : {}),
          ...(maxLabels !== undefined ? { maxLabels } : {}),
          // Defaults to the configured ceiling, so the pass paces itself instead of
          // piling into the client's pacer and waiting there. `--label-rate` can
          // only go SLOWER usefully: the client enforces the ceiling regardless.
          ...(onlyGroups.length > 0 ? { onlyGroups } : {}),
          labelRatePerMinute: args.number("label-rate", POSITIVE_INTEGER, {
            fallback: config.GEMINI_MAX_RPM,
          }),
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
      // for `--labels-only`, which links nothing and gives the sweep nothing to
      // find — and skipped on Ctrl-C: the operator asked to stop, and a multi-pass
      // sweep plus relabels is not "the next group boundary". The nightly chore
      // catches up on whatever a stopped run left.
      let bridgeReport: Awaited<ReturnType<typeof runBridgeSweep>> | null = null;
      if (!labelsOnly && !stopping && onlyGroups.length === 0) {
        bridgeReport = await runBridgeSweep({ db, config: linkerConfig, log });
        // `!skipLabels`: --no-labels promises no model calls, and the post-sweep
        // relabel is a model call per survivor — the sweep's merges still happen,
        // their labels wait for the nightly drift pass or a --labels-only run.
        if (labeler.generator && !skipLabels && bridgeReport.survivors.length > 0) {
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

      if (report.incomplete) return EXIT_FAILED;
      return;
    } catch (error) {
      // The refusals `backfillStorylines` makes before it does anything — a
      // `--restart` against a live archive, an unusable resume cursor. They are
      // a sentence, not a stack, so this catch is narrower than the one
      // `runCommand` provides and prints what an operator can act on.
      console.error(`\nbackfill refused to run:\n${(error as Error).message}`);
      return EXIT_FAILED;
    }
  },
};
