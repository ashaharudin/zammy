import { backfillStorylineProfiles } from "./storyline-profiles-backfill.js";
import { POSITIVE_INTEGER, type CommandSpec } from "./operator-command.js";

/**
 * `pnpm backfill:storyline-profiles [--batch=N] [--after=UUID]` — re-derive
 * every live storyline's `profile_tokens` under ADR-0026's support floor.
 *
 * Run ONCE after the floor ships, and again after any change to the profile
 * rule. Until it runs, the rule applies only to storylines whose membership
 * happens to move, which is the minority of them.
 *
 * A command and not a chore, for the reason `regroup` and `backfill:label-words`
 * are: it rewrites stored derived state across the whole table, and who runs it
 * and when is a decision a person makes (ADR-0003). It is also the write that
 * changes what the live retrieval finds, so it wants a person watching.
 */
export const spec: CommandSpec = {
  name: "backfill:storyline-profiles",
  synopsis: "[--batch=N] [--after=UUID]",
  flags: {
    batch: { kind: "value", placeholder: "N", describe: "storylines per page (default 500)" },
    after: { kind: "value", placeholder: "UUID", describe: "resume an id-ordered scan" },
  },
  db: {},
  async run({ args, db }) {
    const batch = args.number("batch", POSITIVE_INTEGER, {
      fallback: 500,
      note: "(default 500)",
    });
    const result = await backfillStorylineProfiles(
      { db, log: (message) => console.log(message) },
      { batch, after: args.value("after") ?? null },
    );
    console.log(
      `scanned: ${result.scanned}  narrowed: ${result.narrowed}  ` +
        `widened: ${result.widened}  unchanged: ${result.unchanged}`,
    );
  },
};
