import { readLabelCandidates } from "@zammy/storage";
import type { CommandSpec } from "./operator-command.js";
import { needsLabel } from "./storyline-label.js";
import { nameStoryline, type LabelOutcome } from "./storyline-naming.js";

/**
 * `pnpm label:storylines [--limit=N] [--dry-run]` — the labeler's
 * operator command (ADR-0011, "Labels").
 *
 * Default mode labels real v2 storylines: everything promoted that has no label
 * or whose membership has drifted since it got one. This is what S5's backfill
 * pass and any later repair run does.
 *
 */
export const spec: CommandSpec = {
  name: "label:storylines",
  synopsis: "[--limit=N] [--dry-run]",
  flags: {
    limit: {
      kind: "value",
      placeholder: "N",
      describe: "promoted storylines to consider (default 200)",
    },
    "dry-run": { kind: "boolean", describe: "name what would be labelled, call no model" },
  },
  db: {},
  labeler: () => ({
    // An operator watching a CLI is the one caller that would rather wait
    // than take a bigram label, and `--limit` already bounds the run.
    maxRateWaitMs: 900_000,
  }),
  async run({ args, config, db, labeler }) {
    const dryRun = args.boolean("dry-run");
    const limit = Number(args.value("limit") ?? 200);

    console.log(
      `model: ${labeler.generator ? `${config.GEMINI_MODEL} (live, ${config.GEMINI_MAX_RPM}/min)` : "none — GEMINI_API_KEY unset, fallback only"}`,
    );

    const startedAt = Date.now();
    await runLabeller();
    console.log(`\nran in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

    /** The real thing: label promoted storylines that need it. */
    async function runLabeller(): Promise<void> {
      const candidates = await readLabelCandidates(db, { limit });
      console.log(`${candidates.length} promoted storylines\n`);

      const outcomes: LabelOutcome[] = [];
      for (const storyline of candidates) {
        if (
          !needsLabel(storyline, {
            groupCount: storyline.groupCount,
            trigger: "drift",
            driftFactor: config.STORYLINE_LABEL_DRIFT_FACTOR,
          })
        ) {
          continue;
        }
        if (dryRun) {
          console.log(`  would label ${storyline.id} (${storyline.groupCount} groups)`);
          continue;
        }
        const outcome = await nameStoryline(
          { db, ...labeler },
          { storylineId: storyline.id, trigger: "drift" },
        );
        outcomes.push(outcome);
        console.log(
          `  ${(outcome.label ?? "—").padEnd(28)} ${outcome.source.padEnd(7)} ` +
            `${String(outcome.groupCount).padStart(3)} groups${outcome.modelFailure ? `  (${outcome.modelFailure})` : ""}`,
        );
      }

      report(outcomes.map((outcome) => ({ label: outcome.label, source: outcome.source })));
    }
  },
};

function report(results: Array<{ label: string | null; source: string }>): void {
  const by = (source: string) => results.filter((result) => result.source === source).length;
  console.log(
    `\nlabelled ${results.filter((r) => r.label).length}/${results.length}: ` +
      `${by("model")} model, ${by("bigram")} bigram, ${by("none")} none`,
  );
}
