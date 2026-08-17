import { loadConfig } from "@zammy/config";
import { createDb, readLabelCandidates } from "@zammy/storage";
import { sql } from "kysely";
import { createGeminiClient, type TextGenerator } from "./gemini.js";
import {
  buildLabelPrompt,
  fallbackLabel,
  needsLabel,
  selectLabelMembers,
  validateLabel,
  type LabelMember,
} from "./storyline-label.js";
import { labelStoryline, type LabelOutcome } from "./storyline-label-service.js";

/**
 * `pnpm label:storylines [--limit=N] [--dry-run]` — the labeler's
 * operator command (ADR-0011, "Labels").
 *
 * Default mode labels real v2 storylines: everything promoted that has no label
 * or whose membership has drifted since it got one. This is what S5's backfill
 * pass and any later repair run does.
 *
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const dryRun = args.includes("--dry-run");
const limit = Number(flag("limit") ?? 200);

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
      // An operator watching a CLI is the one caller that would rather wait
      // than take a bigram label, and `--limit` already bounds the run.
      maxRateWaitMs: 900_000,
    })
  : null;

console.log(
  `model: ${generator ? `${config.GEMINI_MODEL} (live, ${config.GEMINI_MAX_RPM}/min)` : "none — GEMINI_API_KEY unset, fallback only"}`,
);

try {
  const startedAt = Date.now();
  await runLabeller();
  console.log(`\nran in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
} finally {
  await db.destroy();
}

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
    const outcome = await labelStoryline(
      {
        db,
        generator,
        sampleSize: config.STORYLINE_LABEL_SAMPLE,
        driftFactor: config.STORYLINE_LABEL_DRIFT_FACTOR,
      },
      { storyline, trigger: "drift" },
    );
    outcomes.push(outcome);
    console.log(
      `  ${(outcome.label ?? "—").padEnd(28)} ${outcome.source.padEnd(7)} ` +
        `${String(outcome.groupCount).padStart(3)} groups${outcome.modelFailure ? `  (${outcome.modelFailure})` : ""}`,
    );
  }

  report(outcomes.map((outcome) => ({ label: outcome.label, source: outcome.source })));
}

function report(results: Array<{ label: string | null; source: string }>): void {
  const by = (source: string) => results.filter((result) => result.source === source).length;
  console.log(
    `\nlabelled ${results.filter((r) => r.label).length}/${results.length}: ` +
      `${by("model")} model, ${by("bigram")} bigram, ${by("none")} none`,
  );
}
