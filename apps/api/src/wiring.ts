import type { Config } from "@zammy/config";
import { createGeminiClient } from "./gemini.js";
import type { LabelerDeps } from "./storyline-label-service.js";
import type { LinkerConfig } from "./storyline-linker.js";

/**
 * The runtime objects built from `Config` by more than one entrypoint.
 *
 * Two processes now make storyline decisions: the server's live ingest tail, and
 * the nightly chore runner (`chores-cli.ts`). They must build these two objects
 * identically — not approximately — because both of them ARE decisions:
 *
 *   - `createLinkerConfig` fixes the bar a group is judged at. A sweep that
 *     builds its own copy with one field different judges Monday's group by
 *     rules the live path never used, and nothing in the rows records which
 *     bar was applied.
 *   - `createLabeler` fixes the model, the sample, the drift factor and the
 *     pacing. The pacing matters most: the ceiling being paced is on the KEY
 *     both processes share (STORYLINE-LABELS, "The rate limit").
 *
 * Neither is exported for the operator CLIs to use. `regroup` disables the
 * linker outright and `backfill:storylines` deliberately differs (no coherence
 * gate, its own `--label-rate`), so their divergence is a decision each one
 * documents — not the accidental kind this module exists to prevent.
 */

/** Everything a labelling call needs except the database handle. */
export type Labeler = Omit<LabelerDeps, "db">;

/**
 * The linker config the LIVE write path uses, and therefore the one the nightly
 * sweeps must use: they exist to offer the linker what it already declined or
 * never saw, at the bar it would have applied.
 */
export function createLinkerConfig(config: Config): LinkerConfig {
  return {
    // Structural, not optional: no storylines means no timeline rows.
    enabled: true,
    rules: {
      anchorMaxShare: config.STORYLINE_ANCHOR_MAX_SHARE,
      anchorDfFloor: config.STORYLINE_ANCHOR_DF_FLOOR,
      massThreshold: config.STORYLINE_MASS_THRESHOLD_V2,
      dormancyDays: config.STORYLINE_DORMANCY_DAYS,
      dormantStrictness: config.STORYLINE_DORMANT_STRICTNESS,
    },
    mergeBridges: config.STORYLINE_MERGE_BRIDGES,
    // No model, no verdict to wait for — deferring would only lose formations
    // to a tail that can never resolve them.
    coherenceGate: config.STORYLINE_COHERENCE_GATE && Boolean(config.GEMINI_API_KEY),
    storyDf: {
      windowDays: config.STORYLINE_DF_WINDOW_DAYS,
      timeZone: config.APP_TIMEZONE,
    },
    timeZone: config.APP_TIMEZONE,
  };
}

/**
 * The labeler (ADR-0011's Labels). No key is a supported configuration and not a
 * degraded one: the generator is null, the bigram extractor becomes the only
 * path, and it renders.
 *
 * One client per process is one pacer per process, and that is the most the
 * pacer can promise — it is a window inside a client, so it cannot see the
 * server's calls from the chore runner's process or the reverse. Two pacers each
 * admitting `GEMINI_MAX_RPM` is up to 2x the ceiling on the shared key, caught
 * by the 429 cooldown rather than by the window (STORYLINE-LABELS, "The pacer's
 * scope"). The chore runner's lever for staying under it is `--label-rate`.
 */
export function createLabeler(config: Config, logger?: Labeler["logger"]): Labeler {
  return {
    generator: config.GEMINI_API_KEY
      ? createGeminiClient({
          apiKey: config.GEMINI_API_KEY,
          model: config.GEMINI_MODEL,
          baseUrl: config.GEMINI_BASE_URL,
          thinkingLevel: config.GEMINI_THINKING_LEVEL,
          timeoutMs: config.GEMINI_TIMEOUT_MS,
          maxRequestsPerMinute: config.GEMINI_MAX_RPM,
          maxRateWaitMs: config.GEMINI_MAX_RATE_WAIT_MS,
        })
      : null,
    sampleSize: config.STORYLINE_LABEL_SAMPLE,
    driftFactor: config.STORYLINE_LABEL_DRIFT_FACTOR,
    logger,
  };
}
