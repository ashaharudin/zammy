import { loadConfig } from "@zammy/config";
import { createDb } from "@zammy/storage";
import { backfillLabelWords } from "./label-words-backfill.js";

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

const args = new Set(process.argv.slice(2));
const batchArg = [...args].find((arg) => arg.startsWith("--batch="));
const batch = batchArg ? Number(batchArg.slice("--batch=".length)) : 500;

if (!Number.isInteger(batch) || batch < 1) {
  console.error("--batch must be a positive integer (default 500)");
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

try {
  const result = await backfillLabelWords(
    { db, log: (message) => console.log(message) },
    { batch },
  );
  console.log(`scanned: ${result.scanned}  written: ${result.written}`);
} finally {
  await db.destroy();
}
