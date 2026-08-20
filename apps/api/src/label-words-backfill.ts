import type { Kysely } from "kysely";
import {
  readLabelledStorylinePage,
  setStorylineLabelWords,
  type Database,
} from "@zammy/storage";
import { labelWords } from "./storyline-label-merge.js";

/**
 * Fill in `label_words` for storylines labelled before migration 0016 added the
 * column (ADR-0011, as amended).
 *
 * The column is the label side of search surfacing, and it is written by the one
 * writer of a label (`setStorylineLabel`) — which means rows labelled before the
 * migration have none, and surfacing degrades to the profile-only behaviour it
 * had before for exactly those rows. That is the property that lets the
 * migration run ahead of the API rather than in lockstep with it; this pass is
 * what ends it.
 *
 * Pure local computation: `labelWords` reads the label already on the row. No
 * upstream call, no model, nothing to rate-limit, and safe to re-run — writing
 * the same words twice is a no-op, and re-running under a CHANGED fold is the
 * repair pass for it.
 */
export async function backfillLabelWords(
  deps: { db: Kysely<Database>; log?: (message: string) => void },
  options: { batch: number },
): Promise<{ scanned: number; written: number }> {
  let after: string | null = null;
  let scanned = 0;
  let written = 0;

  for (;;) {
    const page = await readLabelledStorylinePage(deps.db, { after, limit: options.batch });
    if (page.length === 0) break;

    for (const row of page) {
      const words = labelWords(row.label);
      await setStorylineLabelWords(deps.db, { storylineId: row.id, labelWords: words });
      written += 1;
    }
    scanned += page.length;
    after = page[page.length - 1]!.id;
    deps.log?.(`scanned ${scanned}, last id ${after}`);
  }

  return { scanned, written };
}
