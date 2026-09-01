import { backfillLabelWords } from "./label-words-backfill.js";
import { POSITIVE_INTEGER, type CommandSpec } from "./operator-command.js";

/**
 * `pnpm backfill:label-words [--batch=N]` — write `label_words` for every
 * labelled storyline (ADR-0011, as amended; migration 0016).
 *
 * Run once after 0016 lands, and again after any change to `normalizeLabel`.
 * Idempotent and cheap: it reads the label already stored and folds it locally,
 * so there is no upstream call and no model to spend. Until it runs, surfacing
 * simply does not match on the label side for un-backfilled rows.
 *
 * A command and not a chore, for the reason `regroup` is: it rewrites stored
 * derived state across the whole table, and who runs it and when is a decision a
 * person makes (ADR-0003).
 */
export const spec: CommandSpec = {
  name: "backfill:label-words",
  synopsis: "[--batch=N]",
  flags: {
    batch: { kind: "value", placeholder: "N", describe: "storylines per page (default 500)" },
  },
  db: {},
  async run({ args, db }) {
    const batch = args.number("batch", POSITIVE_INTEGER, {
      fallback: 500,
      note: "(default 500)",
    });
    const result = await backfillLabelWords(
      { db, log: (message) => console.log(message) },
      { batch },
    );
    console.log(`scanned: ${result.scanned}  written: ${result.written}`);
  },
};
