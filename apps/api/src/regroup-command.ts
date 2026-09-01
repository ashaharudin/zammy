import { POSITIVE_INTEGER, type CommandSpec } from "./operator-command.js";
import { regroup } from "./regroup.js";
import { maxBridgingQualifiers } from "./wiring.js";

/**
 * `pnpm regroup [--days=N] [--tokens-only]` — re-derive stored grouping state
 * under the current rules (ADR-0005).
 *
 * A command, not a chore. Its second pass moves rows under live cursors, so
 * who runs it and over how much is a decision a person makes, the same posture
 * migrations take (ADR-0003). `--tokens-only` is the safe half: it re-derives
 * headline tokens and changes no groupings at all.
 */
export const spec: CommandSpec = {
  name: "regroup",
  synopsis: "[--days=N] [--tokens-only]",
  flags: {
    days: { kind: "value", placeholder: "N", describe: "how far back to re-derive (default 1: today)" },
    "tokens-only": {
      kind: "boolean",
      describe: "re-derive headline tokens only — changes no groupings",
    },
  },
  db: {},
  async run({ args, config, db }) {
    const days = args.number("days", POSITIVE_INTEGER, {
      fallback: 1,
      note: "(default 1: today)",
    });

    const result = await regroup(
      {
        db,
        config: {
          enabled: config.GROUPING_ENABLED,
          threshold: config.GROUPING_SIMILARITY_THRESHOLD,
          timeZone: config.APP_TIMEZONE,
          // Regroup does not re-run the linker: rebuilding storyline state is
          // the backfill's job, which replays chronologically from scratch
          // rather than repairing in place. Disabled explicitly so the CLI
          // cannot half-link a window as a side effect of re-tokenizing it.
          linker: {
            enabled: false,
            rules: {
              anchorMaxShare: config.STORYLINE_ANCHOR_MAX_SHARE,
              anchorDfFloor: config.STORYLINE_ANCHOR_DF_FLOOR,
              massThreshold: config.STORYLINE_MASS_THRESHOLD_V2,
              dormancyDays: config.STORYLINE_DORMANCY_DAYS,
              dormantStrictness: config.STORYLINE_DORMANT_STRICTNESS,
            },
            mergeBridges: config.STORYLINE_MERGE_BRIDGES,
            // Linking is off in this CLI (`enabled: false`); the gate has nothing
            // to gate.
            coherenceGate: false,
            narrowRetrieval: config.STORYLINE_NARROW_RETRIEVAL,
            // Nothing bridges here either, for the same reason. Configured anyway
            // so this literal never becomes the one place a bound is missing.
            maxBridgingQualifiers: maxBridgingQualifiers(config),
            storyDf: {
              windowDays: config.STORYLINE_DF_WINDOW_DAYS,
              timeZone: config.APP_TIMEZONE,
            },
            timeZone: config.APP_TIMEZONE,
          },
        },
        log: { warn: (obj, msg) => console.log(msg, JSON.stringify(obj)) },
      },
      { days, tokensOnly: args.boolean("tokens-only") },
    );

    console.log(
      `stale: ${result.stale}  re-tokenized: ${result.retokenized}  ` +
        `profiles refreshed: ${result.refreshed}  regrouped: ${result.regrouped}  ` +
        `merged: ${result.merged}`,
    );
  },
};
