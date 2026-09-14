import type { Kysely } from "kysely";
import { readStorylinePage, refreshStorylineProfile, type Database } from "@zammy/storage";

/**
 * Re-derive `profile_tokens` for every live storyline, because the DERIVATION
 * RULE changed under them (ADR-0026).
 *
 * `refreshProfileTokens` runs on every membership change, so the column is
 * always current with respect to the rule that was in force when the membership
 * last moved. A rule change moves no membership: without this pass a storyline
 * that gains nothing keeps a profile computed the old way indefinitely, and
 * since `profile_tokens` is what candidate retrieval overlaps against, the arcs
 * ADR-0026 was written to stop would go on being found by the words it took
 * away. The fix has to be swept over the archive or it is not deployed.
 *
 * One storyline per statement rather than one statement over the table, and the
 * reason is that there is exactly one copy of the rule: `refreshProfileTokens`'
 * SQL. A set-based rewrite would be a second copy of a majority-with-a-floor
 * that has to agree with the first forever, to save a one-shot pass some
 * minutes. It is idempotent and interruptible — `--after` resumes an id-ordered
 * scan — so the slow version costs only time, and time is what a backfill has.
 *
 * `narrowed` counts the rows whose profile actually lost tokens, which is the
 * pass's own evidence that it did something: it should be dominated by
 * two-group storylines, where the old majority rule read as a union.
 *
 * `widened` and `swapped` are GUARDS rather than statistics, and under ADR-0026
 * both must read zero: the new support requirement is pointwise at or above the
 * old one, so the new profile is a SUBSET of the old — no row can gain a token,
 * and none can exchange one. A non-zero count in either means the two rules are
 * not what this pass thinks they are; read them before trusting the run.
 *
 * `swapped` is separate from `widened` rather than folded into it because the
 * comment below justifies comparing arrays by exactly the case that would land
 * there — a future rule that exchanges a token without changing the count. An
 * alarm that fires under a name that says "gained a token" would send whoever
 * reads it looking for the wrong thing.
 */
export async function backfillStorylineProfiles(
  deps: { db: Kysely<Database>; log?: (message: string) => void },
  options: { batch: number; after?: string | null },
): Promise<{
  scanned: number;
  narrowed: number;
  widened: number;
  swapped: number;
  unchanged: number;
}> {
  let after: string | null = options.after ?? null;
  let scanned = 0;
  let narrowed = 0;
  let widened = 0;
  let swapped = 0;
  let unchanged = 0;

  for (;;) {
    const page = await readStorylinePage(deps.db, { after, limit: options.batch });
    if (page.length === 0) break;

    for (const row of page) {
      // Read-compare-write rather than write-and-count: the difference is the
      // report, and a pass that cannot say what it changed is a pass nobody can
      // check afterwards.
      //
      // The comparison is over the ARRAYS, not their lengths, and the command
      // doc is why: it says to re-run this "after any change to the profile
      // rule", and ADR-0026's floor happens to be a rule that can only REMOVE
      // tokens. A future rule that swapped one token for another — a
      // rarity-weighted profile, say — would leave the length alone, and a
      // length test would report `unchanged` for every row while this pass
      // rewrote the whole retrieval index. `profile_tokens` is stored sorted on
      // both sides, so element-wise is the whole comparison.
      const before = await deps.db
        .selectFrom("storylines")
        .select("profile_tokens")
        .where("id", "=", row.id)
        .executeTakeFirst();
      await refreshStorylineProfile(deps.db, row.id);
      const after_ = await deps.db
        .selectFrom("storylines")
        .select("profile_tokens")
        .where("id", "=", row.id)
        .executeTakeFirst();

      const was = before?.profile_tokens ?? [];
      const now = after_?.profile_tokens ?? [];
      const same = was.length === now.length && was.every((token, i) => token === now[i]);
      if (same) unchanged += 1;
      else if (now.length < was.length) narrowed += 1;
      else if (now.length > was.length) widened += 1;
      else swapped += 1;
    }

    scanned += page.length;
    after = page[page.length - 1]!.id;
    deps.log?.(
      `scanned ${scanned}  narrowed ${narrowed}  widened ${widened}  ` +
        `swapped ${swapped}  unchanged ${unchanged}  last id ${after}`,
    );
  }

  return { scanned, narrowed, widened, swapped, unchanged };
}
