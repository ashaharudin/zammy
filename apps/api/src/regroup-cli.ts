import { loadConfig } from "@zammy/config";
import { createDb } from "@zammy/storage";
import { regroup } from "./regroup.js";

/**
 * `pnpm regroup [--days=N] [--tokens-only]` — re-derive stored grouping state
 * under the current rules (ADR-0005).
 *
 * A command, not a chore. Its second pass moves rows under live cursors, so
 * who runs it and over how much is a decision a person makes, the same posture
 * migrations take (ADR-0003). `--tokens-only` is the safe half: it re-derives
 * headline tokens and changes no groupings at all.
 */

const args = new Set(process.argv.slice(2));
const daysArg = [...args].find((arg) => arg.startsWith("--days="));
const days = daysArg ? Number(daysArg.slice("--days=".length)) : 1;

if (!Number.isInteger(days) || days < 1) {
  console.error("--days must be a positive integer (default 1: today)");
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

try {
  const result = await regroup(
    {
      db,
      config: {
        enabled: config.GROUPING_ENABLED,
        threshold: config.GROUPING_SIMILARITY_THRESHOLD,
        timeZone: config.APP_TIMEZONE,
        storyline: {
          enabled: config.STORYLINE_ENABLED,
          anchorMaxShare: config.STORYLINE_ANCHOR_SHARE,
          massThreshold: config.STORYLINE_MASS_THRESHOLD,
        },
      },
      log: { warn: (obj, msg) => console.log(msg, JSON.stringify(obj)) },
    },
    { days, tokensOnly: args.has("--tokens-only") },
  );

  console.log(
    `stale: ${result.stale}  re-tokenized: ${result.retokenized}  regrouped: ${result.regrouped}  ` +
      `merged: ${result.merged}  reclustered: ${result.reclustered}`,
  );
} finally {
  await db.destroy();
}
