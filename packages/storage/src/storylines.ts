import { sql, type Kysely } from "kysely";
import type { Database, StorylineStatus } from "./database.js";
import { markStorylinesLinkDirty } from "./storyline-link-dirty.js";

/**
 * Storylines v2, storage side (ADR-0011).
 *
 * Same division of labour as `grouping.ts`, one level up: everything judgemental
 * — does this group belong to this storyline, are these two storylines the same
 * event — belongs to the API layer, and everything *derived* belongs here. The
 * two derivations are the ones the read path and the linker cannot afford to
 * recompute:
 *
 *  - **profile tokens**: the tokens at least half the member groups carry.
 *    Re-derived on every membership change, because it is what candidate
 *    retrieval overlaps against, and a profile that lagged its membership would
 *    quietly change which storylines a group can even be compared to.
 *  - **day slots**: one `storyline_days` row per day the storyline has coverage,
 *    positioned at that day's earliest article. Maintained at write time for the
 *    reason `storyline_published` was (ADR-0002): the timeline's first step is an
 *    index scan, and a storyline unbounded in time cannot afford to compute its
 *    days at read time.
 *
 * Nothing here decides anything. Attaching a group is a write, not a verdict;
 * merging is a write, not a bridge count; promotion is a status change, not the
 * observation that a second group arrived. Those live in the linker (S3), which
 * is what makes them measurable and replayable.
 */

/** A storyline row, as the layers above it read one. */
export interface Storyline {
  id: string;
  label: string | null;
  labelAt: Date | null;
  /** Member groups when the label was made; the drift trigger's baseline. */
  labelGroupCount: number | null;
  /** What produced it: a model id, `bigram`, or null for unknown provenance. */
  labelSource: string | null;
  profileTokens: string[];
  status: StorylineStatus;
  /** Non-null means this row is an ALIAS, not a storyline. Resolve before use. */
  mergedInto: string | null;
  createdAt: Date;
}

/** One storyline-day: the timeline's paginated unit. */
export interface StorylineDay {
  storylineId: string;
  /** YYYY-MM-DD in `APP_TIMEZONE`. */
  dayKey: string;
  /** That day's earliest article's `published` — the keyset axis. */
  daySlotPublished: Date;
  /** That day's earliest article: the slot's hero. */
  leadArticleId: string;
}

/**
 * The timezone whose calendar days bucket a storyline's coverage — `APP_TIMEZONE`,
 * passed in rather than read here, exactly as `grouping.ts` takes its day bounds
 * from the caller (§10.1). Day bucketing happens in SQL because the alternative
 * is reading every member article into the process to bucket it in JS, which is
 * the whole-day-in-memory read ADR-0011 was written to kill.
 */
export interface Zoned {
  timeZone: string;
}

/**
 * Birth a provisional storyline holding one group — the seed-own-identity
 * discipline the old insert trigger enforced, generalized to the group layer
 * (ADR-0011's Lifecycle). Every new group gets one; most never become more than
 * this, and that is the normal case, not an error: a provisional storyline-of-one
 * IS the ordinary timeline slot.
 */
export async function createProvisionalStoryline(
  db: Kysely<Database>,
  input: { groupId: string } & Zoned,
): Promise<Storyline> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto("storylines")
      .values({ label: null, merged_into: null })
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .insertInto("storyline_groups")
      .values({ storyline_id: row.id, group_id: input.groupId })
      .execute();

    await refreshProfileTokens(trx, row.id);
    await refreshDaySlots(trx, row.id, input.timeZone);

    return toStoryline({ ...row, profile_tokens: await readProfileTokens(trx, row.id) });
  });
}

/**
 * Attach a group to a storyline: the linker's write half.
 *
 * Idempotent in membership — a replayed attach re-derives rather than joining
 * twice, and reports `attached: false` — and it does NOT promote. Promotion is
 * a separate call because "a second group attached"
 * is a fact the linker observes and this layer must not infer: a backfill
 * replaying history attaches groups in an order where the promoting arrival is
 * not always the second row written.
 *
 * A group may be attached to several storylines. That is the point: duplication
 * across slots is accepted (ADR-0011), and "primary storyline" is a concept with
 * no principled definition.
 */
export async function attachGroup(
  db: Kysely<Database>,
  input: { storylineId: string; groupId: string } & Zoned,
): Promise<{ attached: boolean }> {
  return db.transaction().execute(async (trx) => {
    const target = await resolveIn(trx, input.storylineId);
    if (target === null) return { attached: false };

    const inserted = await trx
      .insertInto("storyline_groups")
      .values({ storyline_id: target, group_id: input.groupId })
      .onConflict((conflict) => conflict.doNothing())
      .executeTakeFirst();

    // Re-derive even on a replay: the group may have gained articles since, and
    // both derivations are over membership as it stands, not as it arrived.
    await refreshProfileTokens(trx, target);
    await refreshDaySlots(trx, target, input.timeZone);
    // The arc's profile may have widened and its last coverage may have moved,
    // and both are inputs the linker reads — so old groups judged against the
    // previous version of this arc have a decision to make again (migration
    // 0017). Marked even when the insert was a no-op: the re-derivation above
    // runs either way, and a replay that widened the profile still widened it.
    await markStorylinesLinkDirty(trx, [target]);

    const attached = Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0;
    if (attached) await wake(trx, target);
    return { attached };
  });
}

/**
 * Membership changed underneath a storyline without its group set changing —
 * a new article landed in a member group. Both derivations are over member
 * ARTICLES, so both go stale, and nothing keyed on `storyline_groups` can see
 * it: no attach, no merge, no formation.
 *
 * `groupArticle` in the api calls this for every storyline holding the group an
 * arrival JOINED, which is the whole of its wiring. It said "the ingest and
 * grouping paths call this" for months while having no caller at all, and the
 * day slots it was written to keep honest were led by the wrong article
 * whenever a piece published earlier than the day's lead joined the group.
 *
 * The ingest path's sibling case — a fold dragging an article's `published`
 * earlier, onto a day the storyline may have no slot for — is covered by
 * `ingestSightings` calling `refreshStorylineDerivations` directly: it is
 * already inside a transaction, and this opens its own.
 *
 * One neighbouring case is NOT covered, and is not a refresh: a singleton
 * MOVING out of its own group (regroup's pass 2) leaves any storyline holding
 * that now-empty group with no articles behind it, and re-deriving it to zero
 * slots is not obviously better than dissolving it.
 */
export async function refreshStoryline(
  db: Kysely<Database>,
  input: { storylineId: string } & Zoned,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const target = await resolveIn(trx, input.storylineId);
    if (target === null) return;
    await refreshProfileTokens(trx, target);
    await refreshDaySlots(trx, target, input.timeZone);
    // Whatever moved the member articles moved the linker's inputs too.
    await markStorylinesLinkDirty(trx, [target]);
  });
}

/**
 * Promote: the storyline becomes real and gets labelled (ADR-0011). Separate
 * from the label write, because a label may fail to generate and a promoted
 * storyline with no label is a valid state — it renders label-less.
 */
export async function promoteStoryline(
  db: Kysely<Database>,
  input: { storylineId: string },
): Promise<void> {
  await setStorylineStatus(db, { storylineId: input.storylineId, status: "active" });
}

/**
 * Dormant after ~90 days without coverage, active again when it earns coverage
 * (ADR-0011). Nothing ends a storyline; dormancy only takes it out of the normal
 * candidate set, where it stays matchable at a high-confidence bar.
 *
 * Aliases are skipped: a merged UUID is a pointer with no lifecycle of its own,
 * and a status written to one would describe nothing.
 */
export async function setStorylineStatus(
  db: Kysely<Database>,
  input: { storylineId: string; status: StorylineStatus },
): Promise<void> {
  await db
    .updateTable("storylines")
    .set({ status: input.status })
    .where("id", "=", input.storylineId)
    .where("merged_into", "is", null)
    .execute();
}

/**
 * Mark every active storyline whose latest coverage is older than `before`
 * dormant, and report how many. The read side's half of ADR-0011's dormancy.
 *
 * Derived, not judged: the caller supplies the cutoff — the linker's own
 * `STORYLINE_DORMANCY_DAYS`, so the column and the gate that reads it agree —
 * and this only asks the day slots what they say. Measured from the LATEST
 * covered day, because that is what dormancy means: an arc that began in March
 * and ran until yesterday is not quiet, it is long.
 *
 * Aliases and provisionals are skipped for the reason `setStorylineStatus`
 * skips them — a pointer has no lifecycle, and a storyline-of-one is a timeline
 * slot rather than a story that can fall quiet. A storyline with no day slots at
 * all is skipped too: there is no coverage to measure its silence from.
 */
export async function markDormantStorylines(
  db: Kysely<Database>,
  input: { before: Date },
): Promise<number> {
  const result = await sql<{ id: string }>`
    update storylines s
       set status = 'dormant'
     where s.status = 'active'
       and s.merged_into is null
       and (
         select max(d.day_slot_published) from storyline_days d
          where d.storyline_id = s.id
       ) < ${input.before}
    returning s.id
  `.execute(db);
  return result.rows.length;
}

/**
 * Store a generated label. `labelAt` is the drift clock — the labeler regenerates
 * when membership has doubled since it was written — so it is stamped by the
 * caller, which is the thing that knows whether this was a real generation or a
 * fallback (ADR-0011, Labels).
 *
 * Five fields that mean nothing apart, and exactly one caller in `apps/api`:
 * `storyline-naming.ts`. That is a rule rather than an observation — two callers
 * is how the label columns previously drifted apart on the invariant
 * `labelGroupCount` states below — so a second one is a change to be argued for,
 * not a convenience.
 */
export async function setStorylineLabel(
  db: Kysely<Database>,
  input: {
    storylineId: string;
    label: string | null;
    /**
     * The label's words, folded by `normalizeLabel` — the label side of
     * surfacing (ADR-0011, as amended). Passed in rather than derived here
     * because the fold is the corpus tokenizer's own (`trimWordPunctuation`,
     * then `singular`) and lives with it in `apps/api`; storage carries it and
     * indexes it. Empty when `label` is null, which the caller owes us.
     */
    labelWords: readonly string[];
    labelAt: Date;
    /**
     * Member groups this label describes — the drift baseline. Stamped even
     * when the label came out null: a storyline the model refused to name is
     * not owed another attempt until its coverage has doubled either.
     *
     * A REFUSAL, note, and not merely an absence. A storyline whose member
     * articles have been retained away has no coverage for anyone to judge, so
     * the naming module does not reach this function at all for one rather than
     * stamping a baseline on a verdict nobody gave — see the empty-coverage case
     * in `storyline-naming.ts`, which is where the two former writers of these
     * columns disagreed.
     */
    labelGroupCount: number;
    /**
     * What produced it — a model id, `bigram`, or null. This is what makes a
     * relabel campaign resumable: without it, "has this already been upgraded"
     * is unanswerable and `--relabel` has to redo everything on every run.
     */
    labelSource: string | null;
  },
): Promise<void> {
  await db
    .updateTable("storylines")
    .set({
      label: input.label,
      label_words: [...input.labelWords],
      label_at: input.labelAt,
      label_group_count: input.labelGroupCount,
      label_source: input.labelSource,
    })
    .where("id", "=", input.storylineId)
    .where("merged_into", "is", null)
    .execute();
}

/**
 * Labelled storylines in id order, for the `label_words` backfill — one page at
 * a time, resumable from the last id seen.
 *
 * Keyset over `id` rather than a `where label_words = '{}'` filter, which would
 * look like the tighter query and does not terminate: a label whose words fold
 * to nothing at all (punctuation, a stray identifier) stays empty after a
 * correct write, and the filter would hand it back forever. Walking every
 * labelled row is also the more useful pass — it repairs a row whose words were
 * written under an older fold, not just one that has none.
 */
export async function readLabelledStorylinePage(
  db: Kysely<Database>,
  input: { after: string | null; limit: number },
): Promise<{ id: string; label: string }[]> {
  let query = db
    .selectFrom("storylines")
    .select(["id", "label"])
    .where("label", "is not", null)
    .where("merged_into", "is", null)
    .orderBy("id")
    .limit(input.limit);
  if (input.after !== null) query = query.where("id", ">", input.after);
  const rows = await query.execute();
  return rows.map((row) => ({ id: row.id, label: row.label! }));
}

/**
 * A page of LIVE storylines, id-ordered — every storyline, labelled or not,
 * because a profile is a fact about membership rather than about naming and a
 * provisional storyline-of-one has one too.
 *
 * Aliases are excluded: `merged_into` rows keep an emptied profile on purpose
 * (`mergeStorylines`), and re-deriving one would put a dead arc's vocabulary
 * back into the retrieval index.
 */
export async function readStorylinePage(
  db: Kysely<Database>,
  input: { after: string | null; limit: number },
): Promise<{ id: string }[]> {
  let query = db
    .selectFrom("storylines")
    .select(["id"])
    .where("merged_into", "is", null)
    .orderBy("id")
    .limit(input.limit);
  if (input.after !== null) query = query.where("id", ">", input.after);
  return query.execute();
}

/**
 * Re-derive one storyline's `profile_tokens` and nothing else.
 *
 * The public door onto `refreshProfileTokens`, for the backfill that has to run
 * when the derivation RULE changes rather than when a membership does —
 * ADR-0026 is the first of those. Deliberately not `refreshStorylineDerivations`:
 * the day slots are a function of membership, which a rule change does not move,
 * and re-deriving 17,000 of them to fix a column they do not touch is work whose
 * only possible outcome is a mistake.
 */
export async function refreshStorylineProfile(
  db: Kysely<Database>,
  storylineId: string,
): Promise<void> {
  await refreshProfileTokens(db, storylineId);
}

/**
 * Write a storyline's label words and nothing else.
 *
 * Separate from `setStorylineLabel` because the backfill is not labelling: it
 * must not touch `label_at`, `label_group_count` or `label_source`, all of
 * which are the drift clock and would tell the labeler this row had just been
 * regenerated (ADR-0011, Labels).
 */
export async function setStorylineLabelWords(
  db: Kysely<Database>,
  input: { storylineId: string; labelWords: readonly string[] },
): Promise<void> {
  await db
    .updateTable("storylines")
    .set({ label_words: [...input.labelWords] })
    .where("id", "=", input.storylineId)
    .execute();
}

/** What a merge did, and what it left for the caller to re-examine. */
export interface MergeResult {
  merged: boolean;
  /** The survivor, alias-resolved. Null only when the id names nothing. */
  winnerId: string | null;
  /**
   * Storylines whose bridge evidence just moved onto the winner — the pairs
   * `(winnerId, other)` whose independent-bridge count may have crossed K
   * without any bridge being recorded. Empty when nothing merged.
   *
   * This exists because a merge is the one way a pair's evidence grows silently,
   * and the K check is on the INSERT. The caller owns K, so the caller re-checks;
   * see `cascadeMerge` in `storyline-linker.ts`.
   */
  repointed: string[];
}

/**
 * Merge the loser into the winner, leaving the loser's UUID as an alias.
 *
 * Merges are how err-narrow formation heals itself: two storylines that should
 * have been one are joined later, and the operation has no inverse (split is
 * deliberately not built). What makes the alias necessary is everything holding
 * a storyline UUID outside this table — a reader's open URL, a bookmarked
 * storyline view — none of which may dangle.
 *
 * The loser's joins move to the winner, its day slots go (the winner recomputes
 * its own from the enlarged membership), and its profile tokens are cleared: an
 * alias must never surface as a retrieval candidate, and emptying its GIN row is
 * a second lock on the door the partial index already closes.
 *
 * Idempotent and cycle-proof: both ids are alias-resolved first, so merging a
 * pair that already merged — in either direction — is a no-op rather than a
 * self-reference.
 */
export async function mergeStorylines(
  db: Kysely<Database>,
  input: { winnerId: string; loserId: string } & Zoned,
): Promise<MergeResult> {
  return db.transaction().execute(async (trx) => {
    // One merge at a time, globally. Alias resolution is a plain read and the
    // two UPDATEs land on different rows, so under READ COMMITTED two
    // overlapping merges both resolve against pre-merge state and both commit:
    // A→B racing B→A writes merged_into on BOTH rows — a cycle that every
    // `merged_into is null` read excludes, vanishing a live storyline. Merges
    // are rare (ingest cascade, nightly sweeps), so serializing them is free;
    // resolving AFTER the lock is what makes the second merge see the first.
    await sql`select pg_advisory_xact_lock(hashtext('zammy.storyline-merge'))`.execute(trx);
    const winner = await resolveIn(trx, input.winnerId);
    const loser = await resolveIn(trx, input.loserId);
    if (winner === null || loser === null) {
      return { merged: false, winnerId: winner, repointed: [] };
    }
    if (winner === loser) return { merged: false, winnerId: winner, repointed: [] };

    // The third storylines the loser was bridged to, read BEFORE the move below
    // re-points them. Each becomes a pair whose evidence has just grown without
    // a single bridge being recorded, and the K check the linker runs fires only
    // on a fresh INSERT — so without this list those pairs reach K and no one
    // ever looks. Measured: 31 pairs sat at or above K=2 in the dev archive,
    // every one of them involving a storyline that had absorbed merges, and the
    // bridge merge had never fired at all. Returning them is what lets the
    // caller close the loop; storage does not know what K is.
    const { rows: counterparts } = await sql<{ other: string }>`
      select distinct
             case when storyline_lo = ${loser}::uuid then storyline_hi else storyline_lo end
               as other
      from storyline_bridges
      where (storyline_lo = ${loser}::uuid or storyline_hi = ${loser}::uuid)
    `.execute(trx);
    const repointed = counterparts
      .map((row) => row.other)
      .filter((other) => other !== winner);

    // Read before the mutation below erases it: whether the loser was dormant
    // decides whether this merge wakes the winner (see the wake at the end).
    const loserStatus = (
      await trx
        .selectFrom("storylines")
        .select("status")
        .where("id", "=", loser)
        .executeTakeFirst()
    )?.status;

    // The loser's groups keep their original `attached_at`: when a group joined
    // the story is a fact about the group, not about which of two UUIDs won.
    await sql`
      insert into storyline_groups (storyline_id, group_id, attached_at)
      select ${winner}::uuid, group_id, attached_at
      from storyline_groups where storyline_id = ${loser}::uuid
      on conflict (storyline_id, group_id) do nothing
    `.execute(trx);

    await trx.deleteFrom("storyline_groups").where("storyline_id", "=", loser).execute();
    await trx.deleteFrom("storyline_days").where("storyline_id", "=", loser).execute();

    // Bridge evidence follows the surviving pair. A bridge the loser had with
    // a third storyline is still evidence — the group qualified for both, and
    // which UUID won says nothing about that — so it re-points rather than
    // dying with the alias. The loser's bridges to the WINNER go: a pair that
    // is now one storyline has nothing left to bridge, and keeping them would
    // let a healed merge count toward the next one.
    await sql`
      insert into storyline_bridges (storyline_lo, storyline_hi, group_id, observed_at)
      select least(${winner}::uuid, other), greatest(${winner}::uuid, other), group_id, observed_at
      from (
        select case when storyline_lo = ${loser}::uuid then storyline_hi else storyline_lo end as other,
               group_id, observed_at
        from storyline_bridges
        where storyline_lo = ${loser}::uuid or storyline_hi = ${loser}::uuid
      ) moved
      where other <> ${winner}::uuid
      on conflict (storyline_lo, storyline_hi, group_id) do nothing
    `.execute(trx);
    await trx
      .deleteFrom("storyline_bridges")
      .where((eb) =>
        eb.or([eb("storyline_lo", "=", loser), eb("storyline_hi", "=", loser)]),
      )
      .execute();

    // Flatten: every alias that pointed at the loser now points at the winner,
    // so resolution stays one hop for everything but a concurrent writer's
    // chain. `resolveStoryline` walks the chain anyway — flattening is for the
    // read cost, not for correctness.
    await trx
      .updateTable("storylines")
      .set({ merged_into: winner })
      .where("merged_into", "=", loser)
      .execute();

    // `link_dirty_at` goes with the profile: an alias has no linking decision
    // left to make, so a marker on one would hand the sweep an arc that cannot
    // take a group (migration 0017).
    await trx
      .updateTable("storylines")
      .set({ merged_into: winner, profile_tokens: [], link_dirty_at: null })
      .where("id", "=", loser)
      .execute();

    await refreshProfileTokens(trx, winner);
    await refreshDaySlots(trx, winner, input.timeZone);
    // The winner's profile is now derived over BOTH memberships and its coverage
    // spans both — the strongest form of "this arc changed", and the one the
    // loser's `attached_at` rows deliberately cannot express, since they keep the
    // timestamps they arrived with.
    await markStorylinesLinkDirty(trx, [winner]);
    // "Active again when it EARNS coverage" (ADR-0011) — and a merge only
    // earns what the loser brings. A live loser (a provisional birth carrying
    // today's group, or an active arc) is fresh standing; a DORMANT loser is
    // not: two quiet March storylines healed by K bridges are still one quiet
    // March storyline, and waking it would hide the dormant marker for a day
    // on exactly the stale story the marker exists to explain.
    if (loserStatus !== "dormant") await wake(trx, winner);

    return { merged: true, winnerId: winner, repointed };
  });
}

/**
 * Follow the alias chain to the storyline a UUID actually names. Returns null
 * for a UUID this database has never held — a stale link, which the read path
 * must be able to tell apart from a merged one.
 */
export async function resolveStoryline(
  db: Kysely<Database>,
  storylineId: string,
): Promise<string | null> {
  return resolveIn(db, storylineId);
}

/**
 * Articles in a storyline, over its whole life — the same count
 * `findSurfacedStorylines` reports beside a search, for the one caller that
 * knows a single storyline rather than a matched set.
 *
 * Whole-life rather than per-page, because that is what the wire contract says a
 * size IS: the storyline view pages by day, and a storyline longer than one page
 * would otherwise report a different size at every scroll position. Member
 * ARTICLES, not groups, and not scoped to any topic: a storyline's size is a
 * fact about the story rather than about the words that found it.
 */
export async function readStorylineArticleCount(
  db: Kysely<Database>,
  storylineId: string,
): Promise<number> {
  const row = await db
    .selectFrom("storyline_groups as sg")
    .innerJoin("articles as a", "a.group_id", "sg.group_id")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("sg.storyline_id", "=", storylineId)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** Read a storyline by id, WITHOUT resolving aliases — callers see the raw row. */
export async function readStoryline(
  db: Kysely<Database>,
  storylineId: string,
): Promise<Storyline | undefined> {
  const row = await db
    .selectFrom("storylines")
    .selectAll()
    .where("id", "=", storylineId)
    .executeTakeFirst();
  return row ? toStoryline(row) : undefined;
}

/** One member group, as the labeler is shown it: the group's own hero article. */
export interface StorylineMember {
  groupId: string;
  title: string;
  description: string | null;
  published: Date;
}

/** Everything the labeler reads about a storyline before it writes one word. */
export interface StorylineLabelInput {
  /** Member groups NOW — the numerator of the drift trigger. */
  groupCount: number;
  /**
   * One article per member group, most recent group first. One per group is the
   * whole point: a wire story syndicated forty times would otherwise fill every
   * slot in the prompt with the same headline and the model would name the
   * syndication rather than the story.
   */
  members: StorylineMember[];
}

/**
 * Read the labeler's input: the member count, and up to `limit` member groups
 * represented by the article the timeline would show for them — the group's
 * earliest, its hero.
 *
 * `limit` bounds the PROMPT, not the scan: DISTINCT ON has to see the member
 * groups' articles to pick one per group. That is a storyline-sized read, run
 * at storyline events (promotion, merge, drift), never per article.
 */
export async function readStorylineLabelInput(
  db: Kysely<Database>,
  input: { storylineId: string; limit: number },
): Promise<StorylineLabelInput> {
  const target = await resolveIn(db, input.storylineId);
  if (target === null) return { groupCount: 0, members: [] };

  const counted = await db
    .selectFrom("storyline_groups")
    .select(({ fn }) => fn.countAll<string>().as("n"))
    .where("storyline_id", "=", target)
    .executeTakeFirstOrThrow();

  const { rows } = await sql<{
    group_id: string;
    title: string;
    description: string | null;
    published: Date;
  }>`
    select * from (
      select distinct on (sg.group_id)
             sg.group_id, a.title, a.description, a.published
      from storyline_groups sg
      join articles a on a.group_id = sg.group_id
      where sg.storyline_id = ${target}::uuid
      order by sg.group_id, a.published asc, a.id asc
    ) hero
    order by hero.published desc, hero.group_id desc
    limit ${input.limit}
  `.execute(db);

  return {
    groupCount: Number(counted.n),
    members: rows.map((row) => ({
      groupId: row.group_id,
      title: row.title,
      description: row.description,
      published: row.published,
    })),
  };
}

/** A storyline as the label-agreement merge reads one: a name and a span. */
export interface LabelMergeRow {
  id: string;
  label: string;
  /** Its earliest day slot. */
  spanFrom: Date;
  /** Its latest day slot. */
  spanTo: Date;
  groupCount: number;
}

/**
 * Live, promoted, MODEL-labelled storylines with their coverage spans — the
 * candidate set for the label-agreement merge (`storyline-label-merge.ts`).
 *
 * Three filters, and each one is a fact about the lifecycle rather than a rule
 * the decision should own:
 *
 *  - `merged_into is null` — an alias is not a storyline.
 *  - `status <> 'provisional'` — a storyline of one is invisible, and merging
 *    two invisible things produces one invisible thing.
 *  - `label_source` present and not `bigram` — the fallback extractor names
 *    places and entities ("Strait Hormuz" for sixteen unrelated arcs), so its
 *    labels agree on vocabulary rather than on events. Spelled as "not bigram"
 *    instead of "equals the configured model" deliberately: a storyline named by
 *    LAST month's model is still a storyline a model named, and an operator
 *    switching models must not silently lose the whole candidate set.
 *
 * The span comes from `storyline_days`, which is the same precomputed coverage
 * the timeline pages on — so this is an aggregate over a small table, not a walk
 * over articles. Storylines with no day slots are excluded by the inner join:
 * no coverage is no span, and a span is half of what makes this decision safe.
 */
export async function readLabelMergeCandidates(
  db: Kysely<Database>,
): Promise<LabelMergeRow[]> {
  const { rows } = await sql<{
    id: string;
    label: string;
    span_from: Date;
    span_to: Date;
    group_count: string;
  }>`
    select s.id,
           s.label,
           min(d.day_slot_published) as span_from,
           max(d.day_slot_published) as span_to,
           (select count(*) from storyline_groups g where g.storyline_id = s.id)
             as group_count
    from storylines s
    join storyline_days d on d.storyline_id = s.id
    where s.merged_into is null
      and s.status <> 'provisional'
      and s.label is not null
      and s.label_source is not null
      and s.label_source <> 'bigram'
    group by s.id, s.label
    order by s.id
  `.execute(db);

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    spanFrom: row.span_from,
    spanTo: row.span_to,
    groupCount: Number(row.group_count),
  }));
}

/**
 * How many live, promoted, model-labelled storylines carry the given label
 * words — the cheap pre-check the ingest tail's collision trigger runs on every
 * label it writes, so the full candidate read (a spans aggregate over every
 * labelled storyline) is paid only when a label is actually shared.
 *
 * The lifecycle filters are `readLabelMergeCandidates`' own, minus the
 * `storyline_days` join: a storyline with no day slots is counted here and then
 * excluded there, which over-fires the trigger into a planner that refuses.
 * Same shape for the comparison itself: `@>` and `<@` are SET operators, so a
 * label with a repeated word matches its deduplicated twin here and is told
 * apart by `labelKey`'s multiset in the planner. Both containments, so the
 * partial GIN index on `label_words` carries the scan.
 *
 * It can UNDER-fire in exactly one way, and it is worth stating rather than
 * claiming a safety this does not have: this counts `label_words`, while the
 * planner reads `label` and folds it in JS. `label_words` is written by
 * `setStorylineLabel` and defaults to `'{}'` (migration 0016), so a labelled
 * row that predates that column and never had `backfill:label-words` run
 * against it is invisible HERE and visible THERE — the trigger misses a
 * collision the nightly pass then catches. Measured on the dev archive
 * 2026-08-21: 0 of 298 eligible labelled storylines carry empty `label_words`,
 * so the gap is closed on this data by the backfill having been run, not by
 * construction. The nightly pass is what makes that acceptable rather than a
 * hole; it is also why this must not become the only repair.
 */
export async function countStorylinesSharingLabelWords(
  db: Kysely<Database>,
  words: readonly string[],
): Promise<number> {
  if (words.length === 0) return 0;
  const { rows } = await sql<{ n: string }>`
    select count(*) as n
    from storylines s
    where s.merged_into is null
      and s.status <> 'provisional'
      and s.label is not null
      and s.label_source is not null
      and s.label_source <> 'bigram'
      and s.label_words @> ${[...words]}::text[]
      and s.label_words <@ ${[...words]}::text[]
  `.execute(db);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Every member article's title and description for a set of storylines — the
 * corpus the label-agreement merge derives its proper-noun evidence from.
 *
 * Whole coverage, not one hero per group like the labeler's own input: the test
 * this feeds (`properNounEvidence`) asks whether a word is EVER seen lowercase,
 * so every sentence of prose is evidence and sampling one article per group
 * would throw away most of it. Bounded by being asked only for the storylines
 * that already agreed on a label — two components in the dev archive, not 258.
 */
export async function readStorylineCoverageText(
  db: Kysely<Database>,
  storylineIds: readonly string[],
): Promise<Array<{ title: string; description: string | null }>> {
  if (storylineIds.length === 0) return [];
  const { rows } = await sql<{ title: string; description: string | null }>`
    select a.title, a.description
    from storyline_groups sg
    join articles a on a.group_id = sg.group_id
    where sg.storyline_id = any(${[...storylineIds]}::uuid[])
  `.execute(db);
  return rows;
}

/** Where a paged label pass has reached. Both halves, because `created_at`
 * alone does not identify a row: a backfill creates thousands of storylines
 * inside one transaction and Postgres stamps them all with its start time. */
export interface LabelCursor {
  createdAt: Date;
  id: string;
}

/**
 * Storylines the labeler may have work for, newest first, with the group count
 * each label decision needs.
 *
 * Deliberately NOT filtered by "needs a label": whether a stale label has
 * drifted is a rule, and a rule in a WHERE clause is a rule with no test and no
 * second reader. Storage says which storylines exist and how big they are; the
 * labeler decides. The candidate set is bounded to promoted storylines, which
 * is a fact about the lifecycle rather than a judgement — a provisional
 * storyline of one is invisible and has nothing to name. Promoted means active
 * OR dormant: a dormant storyline still surfaces (marked), and surfacing
 * requires a label, so going quiet must never put a storyline beyond the
 * labeler's reach — the dormancy sweep runs before the label pass, and an
 * active-only filter here would let one night's ordering strand an unlabelled
 * storyline permanently.
 *
 * Ordered by `(created_at, id)`, which is exactly what `after` pages on. That
 * agreement is the point: a pass over these MUTATES what it reads — a labelled
 * storyline stops needing a label — so a cursor that disagreed with the sort
 * would skip rows and repeat others, and the pass would neither terminate nor
 * cover. Creation order rather than recent-coverage order for the same reason:
 * coverage moves while the pass runs, and a cursor over a moving key is not a
 * cursor.
 */
export async function readLabelCandidates(
  db: Kysely<Database>,
  query: { limit: number; after?: LabelCursor },
): Promise<Array<Storyline & { groupCount: number; latestCoverage: Date | null }>> {
  let statement = db
    .selectFrom("storylines as s")
    .selectAll("s")
    .select((eb) => [
      eb
        .selectFrom("storyline_groups as sg")
        .select(({ fn }) => fn.countAll<string>().as("n"))
        .whereRef("sg.storyline_id", "=", "s.id")
        .as("group_count"),
      eb
        .selectFrom("storyline_days as sd")
        .select(({ fn }) => fn.max<Date>("sd.day_slot_published").as("at"))
        .whereRef("sd.storyline_id", "=", "s.id")
        .as("latest_coverage"),
    ])
    .where("s.status", "!=", "provisional")
    .where("s.merged_into", "is", null)
    .orderBy("s.created_at", "desc")
    .orderBy("s.id", "desc")
    .limit(query.limit);

  if (query.after) {
    const cursor = query.after;
    statement = statement.where(
      sql<boolean>`(s.created_at, s.id) < (${cursor.createdAt}, ${cursor.id}::uuid)`,
    );
  }

  const rows = await statement.execute();
  return rows.map((row) => ({
    ...toStoryline(row),
    groupCount: Number(row.group_count ?? 0),
    latestCoverage: row.latest_coverage ?? null,
  }));
}

/**
 * The last group the linker got to, in the order the backfill walks (S5).
 *
 * The resume cursor, and it is DERIVED rather than recorded — no checkpoint
 * table, no progress row to fall out of step with the work. Every group the
 * linker has touched has a `storyline_groups` row, because birth is the first
 * thing that happens to it and the seed-own-identity discipline guarantees it;
 * so "how far did we get" is a question the join table already answers.
 *
 * Returns the last such group rather than the first unlinked one, so the caller
 * resumes AT it and re-runs it. A crash between a group's birth and its bridges
 * leaves work half-done that only re-running that group completes, and
 * `linkGroup` is idempotent by design for exactly this.
 */
export async function readLastLinkedGroup(
  db: Kysely<Database>,
): Promise<{ published: Date; groupId: string } | null> {
  const { rows } = await sql<{ group_id: string; published: Date }>`
    select a.group_id, a.group_published as published
    from storyline_groups sg
    join lateral (
      select group_id, group_published from articles
      where group_id = sg.group_id limit 1
    ) a on true
    order by a.group_published desc, a.group_id desc
    limit 1
  `.execute(db);

  const row = rows[0];
  return row ? { published: row.published, groupId: row.group_id } : null;
}

/**
 * Delete every v2 storyline row: storylines, their joins, their day slots,
 * their bridges and the arc coverage recorded against them. The `--restart`
 * half of the backfill.
 *
 * TRUNCATE with CASCADE down the FK chain rather than DELETE — this is "build
 * from scratch", and a full-archive rebuild is the one operation where the
 * table's whole contents are the thing being replaced. It touches NOTHING on
 * `articles`: the old `storyline_id` columns are a different model's state,
 * ignored entirely by v2 (ADR-0011's Rollout) and dropped in S9.
 *
 * Every table with a foreign key into `storylines` must be NAMED here — the
 * statement carries no `CASCADE`, so Postgres refuses outright rather than
 * quietly leaving orphans, which is why `storyline_coverage` (migration 0021)
 * joins the list. Dropping arc coverage on a rebuild is also the correct
 * behaviour and not merely the permitted one: the storyline UUIDs it is keyed on
 * do not survive a rebuild, so a row kept would claim coverage for an arc that
 * no longer exists.
 */
export async function resetStorylines(db: Kysely<Database>): Promise<void> {
  await sql`
    truncate storylines, storyline_groups, storyline_days, storyline_bridges,
             storyline_coverage
  `.execute(db);
}

/** What a backfill run reports, and what a later audit re-reads. */
export interface StorylineStats {
  storylines: number;
  /** Holding more than one group: the ones that are REAL (ADR-0011). */
  promoted: number;
  /** Merged-away UUIDs still resolving to a survivor. */
  aliases: number;
  /** Groups the linker has reached — the backfill's progress. */
  linkedGroups: number;
  /** Groups in the biggest storyline: the percolation alarm. */
  largestStoryline: number;
  /**
   * The same alarm's denominator — the size distribution the largest arc sits
   * at the top of, bucketed. It travels WITH `largestStoryline` because the
   * maximum on its own is not evidence of anything: through the whole
   * late-candidate runaway (VERCEL-PHASE-0-FINDINGS §2.6) the largest arc held
   * at 124 for four bounded passes while the population underneath it was
   * collapsing, and the one metric that looked calm is the reason that took
   * four sessions to find.
   *
   * The edges are 1 / 2–4 / 5–19 / 20–99 / 100+, and they are NOT chosen here:
   * they are the buckets docs/STORYLINE-LINKING.md's "Graph shape, before and
   * after" table already reports, so a night's numbers and that document's
   * measurements can be read against each other directly. Two of the edges have
   * independent meaning as well — 2 is ADR-0011's promotion line ("holding more
   * than one group"), and 20 is the size at which that ADR hand-reads arcs for
   * coherence ("the 21 named arcs at ≥20 groups"), so the 20–99 bucket is the
   * population a human has actually inspected.
   *
   * What they are for: percolation moves the TOP bucket while the middle
   * thins — a swallow is arcs disappearing into one arc. A backlog draining
   * correctly moves the middle and leaves the top alone, which is exactly what
   * the retrieval fix measured (20–99 went 15 → 22, 100+ stayed at 1).
   */
  singletons: number;
  arcs2To4: number;
  arcs5To19: number;
  arcs20To99: number;
  arcs100Plus: number;
  /**
   * Standing rows in `storyline_bridges` — the same fact from the evidence
   * side, and the LEADING one: K bridges are what merge a pair, so bridge
   * accumulation precedes the merges that move the buckets above. §2.6's
   * runaway showed 1,913 → 10,282 bridges over the passes that grew the arc.
   */
  bridges: number;
  daySlots: number;
  labelled: number;
  /** Promoted storylines that were asked and produced no label at all. */
  unlabelled: number;
}

/**
 * The report (S5). One round trip, because every number here is a count over a
 * table the backfill just wrote and an operator reads them together or not at
 * all — `largest` above all, which is ADR-0009's 1,179-group swallow expressed
 * as a number that can be watched. Read nightly as well as after a backfill
 * (`runStorylineGraphChore`), which is what makes it a series rather than a
 * number somebody once saw.
 *
 * The arc-size numbers all come out of ONE aggregate over `storyline_groups`,
 * and that is why adding the distribution cost nothing: it replaced the two
 * separate passes `largest` and `promoted` used to each make. Measured on the
 * dev corpus (27,083 `storyline_groups` rows, 17,008 live storylines): the
 * seven shape numbers together are **6.6–9.4 ms**, against **12.3–16.0 ms** for
 * just the two aggregates they replace, and the whole function is **16–21 ms**
 * (measured both in `psql` and through the driver) where it was 23–39 ms. The
 * rest is the six scalar subqueries over `storylines` / `storyline_days`,
 * unchanged. Against the 300-second function ceiling this is noise.
 *
 * The numbers it returns on that corpus reproduce docs/STORYLINE-LINKING.md's
 * "Graph shape" baseline row exactly — 17,008 live, 13,074 / 3,241 / 677 / 15 /
 * 1, largest 124, 1,913 bridges — which is the check that the buckets here mean
 * what that table means.
 *
 * `sizes` covers exactly the live storylines: `mergeStorylines` DELETES the
 * loser's `storyline_groups` rows rather than leaving them pointing at an
 * alias, so there is nothing here to filter on `merged_into` and the buckets
 * sum to `storylines`.
 */
export async function readStorylineStats(db: Kysely<Database>): Promise<StorylineStats> {
  const { rows } = await sql<Record<string, string>>`
    with sizes as (
      select count(*) as n from storyline_groups group by storyline_id
    ), shape as (
      select
        coalesce(max(n), 0)                         as largest,
        count(*) filter (where n > 1)               as promoted,
        count(*) filter (where n = 1)               as singletons,
        count(*) filter (where n between 2 and 4)   as arcs_2_4,
        count(*) filter (where n between 5 and 19)  as arcs_5_19,
        count(*) filter (where n between 20 and 99) as arcs_20_99,
        count(*) filter (where n >= 100)            as arcs_100_plus
      from sizes
    )
    select
      (select count(*) from storylines where merged_into is null)          as storylines,
      (select count(*) from storylines where merged_into is not null)      as aliases,
      (select count(*) from storyline_days)                                as day_slots,
      (select count(distinct group_id) from storyline_groups)              as linked_groups,
      (select count(*) from storylines
        where merged_into is null and label is not null)                   as labelled,
      (select count(*) from storylines
        where merged_into is null and label is null and label_at is not null) as unlabelled,
      (select count(*) from storyline_bridges)                             as bridges,
      shape.largest, shape.promoted, shape.singletons,
      shape.arcs_2_4, shape.arcs_5_19, shape.arcs_20_99, shape.arcs_100_plus
    from shape
  `.execute(db);

  const row = rows[0] ?? {};
  const n = (key: string): number => Number(row[key] ?? 0);
  return {
    storylines: n("storylines"),
    promoted: n("promoted"),
    aliases: n("aliases"),
    linkedGroups: n("linked_groups"),
    largestStoryline: n("largest"),
    singletons: n("singletons"),
    arcs2To4: n("arcs_2_4"),
    arcs5To19: n("arcs_5_19"),
    arcs20To99: n("arcs_20_99"),
    arcs100Plus: n("arcs_100_plus"),
    bridges: n("bridges"),
    daySlots: n("day_slots"),
    labelled: n("labelled"),
    unlabelled: n("unlabelled"),
  };
}

/** Which storylines a group belongs to. A group in two is normal, not an error. */
export async function readGroupStorylines(
  db: Kysely<Database>,
  groupId: string,
): Promise<string[]> {
  const rows = await db
    .selectFrom("storyline_groups")
    .select("storyline_id")
    .where("group_id", "=", groupId)
    .orderBy("attached_at", "asc")
    .orderBy("storyline_id", "asc")
    .execute();
  return rows.map((row) => row.storyline_id);
}

/**
 * The language a storyline is actually written in: the commonest `language` its
 * member articles carry, or null when none of them carries one.
 *
 * Read for the same reason `profile_tokens` are read — a background refresh
 * (ADR-0017) asks upstream for what the arc's own coverage says, and a language
 * is part of that ask. Deriving it from the reader's language CHIP instead is
 * the version that quietly wastes the call: an English arc clicked out of the
 * English-only cloud (§10.1) by a reader whose chip says Malay would mint a
 * Malay topic that can never match it, and the whole point of the refresh is to
 * find relevant articles.
 *
 * Modal rather than the earliest article's, because one mislabelled sighting
 * should not decide it, and tie-broken alphabetically so a bilingual arc answers
 * the same thing every time — a fingerprint that moved between two calls would
 * mint a second topic rather than deepen the first.
 *
 * Nulls are excluded rather than counted as a language: upstream leaves the
 * field empty often enough that a "no language" majority is a fact about
 * upstream's metadata, not about the story, and the caller's own default is a
 * better answer than none.
 */
export async function readStorylineLanguage(
  db: Kysely<Database>,
  storylineId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("storyline_groups as sg")
    .innerJoin("articles as a", "a.group_id", "sg.group_id")
    .select((eb) => ["a.language", eb.fn.countAll<string>().as("n")])
    .where("sg.storyline_id", "=", storylineId)
    .where("a.language", "is not", null)
    .groupBy("a.language")
    .orderBy("n", "desc")
    .orderBy("a.language", "asc")
    .executeTakeFirst();
  return row?.language ?? null;
}

/** A storyline's day slots, newest first — the shape the storyline view pages. */
export async function readStorylineDays(
  db: Kysely<Database>,
  storylineId: string,
): Promise<StorylineDay[]> {
  const rows = await db
    .selectFrom("storyline_days")
    .selectAll()
    .where("storyline_id", "=", storylineId)
    .orderBy("day_slot_published", "desc")
    .execute();
  return rows.map((row) => ({
    storylineId: row.storyline_id,
    dayKey: row.day_key,
    daySlotPublished: row.day_slot_published,
    leadArticleId: row.lead_article_id,
  }));
}

/**
 * A retrieval candidate: the facts the linker's decision reads, nothing else.
 *
 * `status` is deliberately NOT here, though the column exists and matters
 * elsewhere (`timeline-read` renders the dormant pill from it, and
 * `mergeStorylines` reads a loser's before the merge erases it). The linker's
 * decision never reads it: `barFor` derives dormancy from `lastCoverageMs` at
 * decision time, so the column could only disagree with the bar. It was
 * selected and dropped on the floor by the one caller for as long as this
 * function has existed.
 */
export interface StorylineCandidate {
  id: string;
  profileTokens: string[];
  /** Its most recent day slot — what dormancy is measured from. */
  lastCoverage: Date;
  groupCount: number;
}

/**
 * Candidate retrieval (ADR-0011's Linking section): the storylines whose
 * profile overlaps the arriving group's tokens, by GIN index.
 *
 * One index scan over a small table, and the reason the whole-day-in-memory
 * read dies with the day bound. Aliases are excluded twice over — the partial
 * index does not contain them and their profiles are emptied on merge —
 * because attaching to a pointer would strand the group.
 *
 * `tokens` is whatever array the caller has proved sufficient to retrieve on,
 * NOT necessarily the group's whole profile — the linker passes the
 * anchor-eligible subset, because a storyline sharing no anchor-eligible token
 * cannot clear the anchor bar and so cannot qualify (`anchorEligibleTokens`).
 * This function does not know or check that; it overlaps what it is given.
 *
 * `limit` is a safety valve, and the ordering is a last resort rather than a
 * graceful degradation. Earlier comments here claimed the `last_coverage desc`
 * cut "keeps the storylines a group is most likely to belong to", and the
 * measurement says otherwise: at `limit` 200 against a whole-profile probe the
 * cut bound on 99% of groups and discarded ~10% of the storylines that would
 * have qualified at the pinned thresholds, because coverage recency is not what
 * the decision reads — mass and anchor df are. The ordering is deterministic
 * (`s.id` breaks ties) so a replay cuts the same rows, and that is all it is
 * for. **When this limit binds, real links are being lost**; the caller's job is
 * to pass an array narrow enough that it does not. `candidateRetrieval`
 * (`apps/api/src/storyline-link.ts`) is the one place that pairs an array with a
 * limit, and it carries the census behind each value — 200 with the whole
 * profile, 4,000 with the anchor-eligible subset, never a mix.
 */
export async function readCandidateStorylines(
  db: Kysely<Database>,
  input: { tokens: readonly string[]; limit: number },
): Promise<StorylineCandidate[]> {
  if (input.tokens.length === 0) return [];

  const { rows } = await sql<{
    id: string;
    profile_tokens: string[];
    last_coverage: Date | null;
    group_count: string;
  }>`
    select s.id,
           s.profile_tokens,
           (select max(d.day_slot_published) from storyline_days d
             where d.storyline_id = s.id) as last_coverage,
           (select count(*) from storyline_groups g
             where g.storyline_id = s.id) as group_count
    from storylines s
    where s.merged_into is null
      and s.profile_tokens && ${[...input.tokens]}::text[]
    order by last_coverage desc nulls last, s.id
    limit ${input.limit}
  `.execute(db);

  return rows.map((row) => ({
    id: row.id,
    profileTokens: row.profile_tokens,
    // A storyline with no day slots has no member articles yet — brand new,
    // and `created_at` is not coverage. Treated as covered now, which is what
    // it is: the arrival that seeded it is what put it here.
    lastCoverage: row.last_coverage ?? new Date(),
    groupCount: Number(row.group_count),
  }));
}

/**
 * Record that one group qualified for both storylines of a pair.
 *
 * Idempotent by primary key, and that IS the independence rule (ADR-0011): the
 * same group re-evaluated — by a retry, by the backfill, by a regroup pass —
 * is one observation however many times it is seen, so `countBridges` counts
 * distinct groups without having to say so.
 *
 * Both ids are alias-resolved first: a bridge to a merged-away UUID describes a
 * pair that no longer exists, and recording it would keep evidence alive for a
 * merge that already happened.
 */
export async function recordBridge(
  db: Kysely<Database>,
  input: { storylineA: string; storylineB: string; groupId: string },
): Promise<{ recorded: boolean; pair: [lo: string, hi: string] | null }> {
  return db.transaction().execute(async (trx) => {
    const a = await resolveIn(trx, input.storylineA);
    const b = await resolveIn(trx, input.storylineB);
    if (a === null || b === null || a === b) return { recorded: false, pair: null };

    const [lo, hi] = a < b ? [a, b] : [b, a];
    const inserted = await trx
      .insertInto("storyline_bridges")
      .values({ storyline_lo: lo, storyline_hi: hi, group_id: input.groupId })
      .onConflict((conflict) => conflict.doNothing())
      .executeTakeFirst();

    // The RESOLVED pair, returned rather than left for the caller to re-derive.
    // The caller holds the ids it retrieved candidates under, and a merge
    // earlier in its own loop can have turned one of them into an alias — so
    // counting under those ids asks about a pair this row was not written to,
    // gets zero, and skips a merge that was due. One resolve, one answer.
    return {
      recorded: Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0,
      pair: [lo, hi],
    };
  });
}

/**
 * Live pairs already holding K or more independent bridges — the invariant
 * "no two live storylines carry K bridges" stated as a query.
 *
 * The linker checks K when a bridge is INSERTED, which is the only moment it
 * knows about. A pair can reach K without one: a merge re-points the loser's
 * evidence onto the winner (`MergeResult.repointed`), and before that was
 * returned nothing looked again. This is the sweep that finds whatever the live
 * path still misses, and the repair for what it already missed — 31 stranded
 * pairs in the dev archive, none of which any future insert would have revisited.
 *
 * Ordered by evidence first so a bounded run merges the best-attested pairs, and
 * by the ids after it so two runs over the same data do the same thing.
 */
export async function readBridgedPairs(
  db: Kysely<Database>,
  input: { minBridges: number; limit: number },
): Promise<Array<{ lo: string; hi: string; bridges: number }>> {
  const { rows } = await sql<{ lo: string; hi: string; n: string }>`
    select b.storyline_lo as lo, b.storyline_hi as hi, count(*) as n
    from storyline_bridges b
    join storylines l on l.id = b.storyline_lo and l.merged_into is null
    join storylines h on h.id = b.storyline_hi and h.merged_into is null
    group by b.storyline_lo, b.storyline_hi
    having count(*) >= ${input.minBridges}
    order by count(*) desc, b.storyline_lo, b.storyline_hi
    limit ${input.limit}
  `.execute(db);
  return rows.map((row) => ({ lo: row.lo, hi: row.hi, bridges: Number(row.n) }));
}

/** How many INDEPENDENT groups bridge this pair — the K in "K bridges merge". */
export async function countBridges(
  db: Kysely<Database>,
  input: { storylineA: string; storylineB: string },
): Promise<number> {
  const [lo, hi] =
    input.storylineA < input.storylineB
      ? [input.storylineA, input.storylineB]
      : [input.storylineB, input.storylineA];
  const row = await db
    .selectFrom("storyline_bridges")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("storyline_lo", "=", lo)
    .where("storyline_hi", "=", hi)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/**
 * The alias walk, as one recursive query: a round trip per hop would be a
 * transaction-length race with a concurrent merge. The depth cap is a backstop
 * for a cycle no writer here can create — merge resolves both sides first — and
 * bounds a corrupted chain to a bad answer instead of a hanging query.
 */
async function resolveIn(db: Kysely<Database>, storylineId: string): Promise<string | null> {
  const { rows } = await sql<{ id: string }>`
    with recursive chain(id, merged_into, depth) as (
      select id, merged_into, 0 from storylines where id = ${storylineId}::uuid
      union all
      select next.id, next.merged_into, chain.depth + 1
      from storylines next join chain on next.id = chain.merged_into
      where chain.depth < 32
    )
    select id from chain order by depth desc limit 1
  `.execute(db);
  return rows[0]?.id ?? null;
}

/**
 * A dormant storyline has earned coverage: mark it active again (ADR-0011,
 * "active again when it earns coverage").
 *
 * On the write that added the coverage rather than on the nightly sweep, because
 * the sweep runs at 3am and a reader arriving at noon would otherwise be told a
 * story that grew an hour ago is five months quiet. Only `dormant` rows move: a
 * provisional storyline is promoted by the LINKER, which is where the group count
 * that justifies it was read, and inferring promotion here is exactly what
 * `attachGroup` refuses to do.
 */
async function wake(db: Kysely<Database>, storylineId: string): Promise<void> {
  await db
    .updateTable("storylines")
    .set({ status: "active" })
    .where("id", "=", storylineId)
    .where("status", "=", "dormant")
    .execute();
}

/**
 * Follow a GROUP merge into the storyline layer: the loser group ceases to
 * exist, so every storyline naming it names the winner instead.
 *
 * Runs inside the caller's transaction, and is not a decision — no judgement is
 * made about what belongs with what. The winner simply IS the loser now.
 *
 * The dedup at the end is the part that is easy to miss. Two groups each had
 * their own provisional storyline-of-one; after the re-point both hold the same
 * single group, which is two slots for one piece of coverage. A storyline whose
 * only group is already held elsewhere holds nothing of its own, so it becomes
 * an ALIAS of the storyline that does — the same treatment a bridged merge
 * gives a loser, and for the same reason: a UUID someone is holding must keep
 * resolving.
 */
export async function absorbMergedGroup(
  db: Kysely<Database>,
  input: { winnerGroupId: string; loserGroupId: string; timeZone: string },
): Promise<void> {
  const affected = await db
    .selectFrom("storyline_groups")
    .select("storyline_id")
    .where("group_id", "=", input.loserGroupId)
    .execute();
  if (affected.length === 0) return;

  await sql`
    insert into storyline_groups (storyline_id, group_id, attached_at)
    select storyline_id, ${input.winnerGroupId}::bigint, attached_at
    from storyline_groups where group_id = ${input.loserGroupId}::bigint
    on conflict (storyline_id, group_id) do nothing
  `.execute(db);
  await db.deleteFrom("storyline_groups").where("group_id", "=", input.loserGroupId).execute();

  for (const { storyline_id } of affected) {
    // Redundant? Its only group is the winner, and some other live storyline
    // already holds the winner. Prefer the one with more groups as survivor,
    // then the older id, so a replay resolves the same way.
    const { rows: survivors } = await sql<{ id: string }>`
      with mine as (
        select group_id from storyline_groups where storyline_id = ${storyline_id}::uuid
      )
      select s.id
      from storylines s
      join storyline_groups g on g.storyline_id = s.id
      where s.id <> ${storyline_id}::uuid
        and s.merged_into is null
        and g.group_id = ${input.winnerGroupId}::bigint
        and (select count(*) from mine) = 1
        and (select min(group_id) from mine) = ${input.winnerGroupId}::bigint
      group by s.id
      order by count(*) desc, s.id asc
      limit 1
    `.execute(db);

    const survivor = survivors[0]?.id;
    if (survivor === undefined) {
      // The storyline kept its own identity and swapped one member group for
      // another: its derivations are re-computed over different articles, which
      // is a change to what the linker reads (migration 0017).
      await refreshStorylineDerivations(db, storyline_id, input.timeZone);
      await markStorylinesLinkDirty(db, [storyline_id]);
      continue;
    }

    await db.deleteFrom("storyline_groups").where("storyline_id", "=", storyline_id).execute();
    await db.deleteFrom("storyline_days").where("storyline_id", "=", storyline_id).execute();
    await db
      .updateTable("storylines")
      .set({ merged_into: survivor, profile_tokens: [], link_dirty_at: null })
      .where("id", "=", storyline_id)
      .execute();
    await db
      .updateTable("storylines")
      .set({ merged_into: survivor })
      .where("merged_into", "=", storyline_id)
      .execute();
    await refreshStorylineDerivations(db, survivor, input.timeZone);
    await markStorylinesLinkDirty(db, [survivor]);
  }
}

/**
 * Both derivations, for one storyline.
 *
 * Exported for `ingestSightings`, its one caller outside this module: both
 * derivations are computed over the member groups' ARTICLES, so a fold moving
 * one of those articles invalidates them exactly as changing which groups are
 * members would. It calls this rather than `refreshStoryline` because it is
 * already inside a transaction and that one opens its own.
 *
 * `mergeGroups` above calls it for the third form of the same invalidation — a
 * merge re-points membership, so a change to which groups EXIST invalidates
 * them too — but that is a same-module caller and not what the export is for.
 * This comment previously said it was, which is worth remembering the next time
 * an export looks unused: the reason had moved and the comment had not.
 */
export async function refreshStorylineDerivations(
  db: Kysely<Database>,
  storylineId: string,
  timeZone: string,
): Promise<void> {
  await refreshProfileTokens(db, storylineId);
  await refreshDaySlots(db, storylineId, timeZone);
}

/**
 * Re-derive the profile: every token carried by at least half the member groups,
 * and by no fewer than TWO of them wherever the storyline has two to give.
 *
 * Group-level support, not article-level, and that is the whole point — it is the
 * majority-support rule that silenced AP live-blog vocabulary at the group layer,
 * promoted one level (ADR-0011). Counted over DISTINCT (group, token) pairs, so a
 * story syndicated forty times has one vote like everything else.
 *
 * The floor of two is ADR-0026, and it exists because the majority alone
 * degenerates exactly once: at n = 2, `half` is 1, so this column used to be the
 * UNION of two groups' vocabularies rather than their consensus — the second
 * group donated everything it said to the arc's identity, and since
 * `profile_tokens` is what candidate retrieval overlaps against, the third group
 * was then FOUND BY words no two members had agreed on. `least(2, n)` is what
 * keeps a storyline-of-one whole: its own vocabulary is all it has, and an empty
 * profile there is not a stricter storyline but one no group can ever find.
 *
 * `storylineProfile` in the api applies the same floor in memory, and the two
 * must move together — it is the function the sweep replays, and a floor on one
 * side only is how a threshold gets pinned against a decision nothing runs.
 */
async function refreshProfileTokens(db: Kysely<Database>, storylineId: string): Promise<void> {
  await sql`
    with member_group as (
      select group_id from storyline_groups where storyline_id = ${storylineId}::uuid
    ),
    group_token as (
      select distinct mg.group_id, tok
      from member_group mg
      join articles a on a.group_id = mg.group_id
      cross join lateral unnest(a.story_tokens) as tok
    ),
    support as (
      select tok, count(*) as groups_with from group_token group by tok
    ),
    total as (select count(*) as n from member_group)
    update storylines
    set profile_tokens = coalesce(
      (select array_agg(support.tok order by support.tok)
        from support, total
        -- ceil(n/2) by integer division, floored at 2 and clamped to n.
        where support.groups_with >= greatest((total.n + 1) / 2, least(2, total.n))),
      '{}'
    )
    where id = ${storylineId}::uuid
  `.execute(db);
}

/**
 * Re-derive the day slots: one row per `APP_TIMEZONE` day the storyline's member
 * groups have an article on, positioned and led by that day's earliest.
 *
 * A full re-derivation for the storyline rather than a targeted upsert of the
 * days that moved. A storyline's day count is its lifespan in days — small, and
 * bounded by something a reader can hold in their head — while "which days did
 * this membership change touch" is a question with a wrong answer in every
 * direction: an attached group can lower a slot's position, raise nothing, and
 * a merge can do both across a span neither storyline covered alone. Upsert and
 * prune rather than delete-and-insert, so unchanged slots keep their rows and
 * the keyset index is not churned on every attach.
 */
async function refreshDaySlots(
  db: Kysely<Database>,
  storylineId: string,
  timeZone: string,
): Promise<void> {
  await sql`
    with covered as (
      select to_char(a.published at time zone ${timeZone}, 'YYYY-MM-DD') as day_key,
             a.published as day_slot_published,
             a.id as lead_article_id
      from storyline_groups sg
      join articles a on a.group_id = sg.group_id
      where sg.storyline_id = ${storylineId}::uuid
    ),
    slot as (
      select distinct on (day_key) day_key, day_slot_published, lead_article_id
      from covered
      order by day_key, day_slot_published asc, lead_article_id asc
    ),
    pruned as (
      delete from storyline_days d
      where d.storyline_id = ${storylineId}::uuid
        and not exists (select 1 from slot where slot.day_key = d.day_key)
    )
    insert into storyline_days (storyline_id, day_key, day_slot_published, lead_article_id)
    select ${storylineId}::uuid, day_key, day_slot_published, lead_article_id from slot
    on conflict (storyline_id, day_key) do update
      set day_slot_published = excluded.day_slot_published,
          lead_article_id    = excluded.lead_article_id
  `.execute(db);
}

async function readProfileTokens(db: Kysely<Database>, storylineId: string): Promise<string[]> {
  const row = await db
    .selectFrom("storylines")
    .select("profile_tokens")
    .where("id", "=", storylineId)
    .executeTakeFirstOrThrow();
  return row.profile_tokens;
}

function toStoryline(row: {
  id: string;
  label: string | null;
  label_at: Date | null;
  label_group_count: number | null;
  label_source: string | null;
  profile_tokens: string[];
  status: StorylineStatus;
  merged_into: string | null;
  created_at: Date;
}): Storyline {
  return {
    id: row.id,
    label: row.label,
    labelAt: row.label_at,
    labelGroupCount: row.label_group_count,
    labelSource: row.label_source,
    profileTokens: row.profile_tokens,
    status: row.status,
    mergedInto: row.merged_into,
    createdAt: row.created_at,
  };
}

/**
 * Record that a coherence verdict refused to form a storyline out of these two
 * groups (migration 0015).
 *
 * Idempotent by primary key: the backfill replays every formation from scratch,
 * and a second refusal of the same pair is the same fact, not a new one.
 *
 * Canonically ordered here rather than by the caller, so there is one place that
 * decides which id is `lo` — the lesson `recordBridge` learned, where counting
 * under an unordered pair silently returned zero.
 */
export async function recordFormationRefusal(
  db: Kysely<Database>,
  input: { groupA: string; groupB: string },
): Promise<void> {
  if (input.groupA === input.groupB) return;
  const [lo, hi] =
    BigInt(input.groupA) < BigInt(input.groupB)
      ? [input.groupA, input.groupB]
      : [input.groupB, input.groupA];
  await db
    .insertInto("storyline_formation_refusals")
    .values({ group_lo: lo, group_hi: hi })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
}

/**
 * How many formations a verdict has refused, archive-wide.
 *
 * One number, for one job: saying out loud what a rebuild is honouring. A
 * backfill that replays refusals and a backfill that ignores them produce the
 * same report otherwise, and the difference between them is 66 hand-verified
 * subjects — which is exactly how the 2026-08-21 rebuild erased them without a
 * line of output to notice.
 */
export async function countFormationRefusals(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom("storyline_formation_refusals")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/**
 * Every group this one has been refused a formation with — either side of the
 * pair.
 *
 * Read once per linking decision that is about to FORM something, and never for
 * a join to an established arc: a refusal is about two singletons, and the gate
 * that produced it is measurably wrong about mature coverage
 * (docs/STORYLINE-LINKING.md, "…and on mature arcs it must never run").
 */
export async function readFormationRefusals(
  db: Kysely<Database>,
  groupId: string,
): Promise<Set<string>> {
  const rows = await db
    .selectFrom("storyline_formation_refusals")
    .select(["group_lo", "group_hi"])
    .where((eb) => eb.or([eb("group_lo", "=", groupId), eb("group_hi", "=", groupId)]))
    .execute();
  const partners = new Set<string>();
  for (const row of rows) {
    partners.add(row.group_lo === groupId ? row.group_hi : row.group_lo);
  }
  return partners;
}

/**
 * The single member of a storyline that has exactly one — the group a
 * provisional-of-one is wearing an identity for. Null when it holds none or
 * several.
 *
 * The gate needs this to ask its question in the durable currency: "have these
 * two GROUPS already been refused?". Returning null for a storyline of two or
 * more is not a failure but the answer — there is no formation to refuse,
 * because the storyline is already real.
 */
export async function readSoleGroup(
  db: Kysely<Database>,
  storylineId: string,
): Promise<string | null> {
  const rows = await db
    .selectFrom("storyline_groups")
    .select("group_id")
    .where("storyline_id", "=", storylineId)
    .limit(2)
    .execute();
  return rows.length === 1 ? rows[0]!.group_id : null;
}

export interface DissolveResult {
  dissolved: boolean;
  /** The storyline the departing group now leads — a revived alias, or a new row. */
  freedStorylineId: string | null;
  /** True when the departing group's ORIGINAL UUID was revived rather than replaced. */
  revivedAlias: boolean;
  /** Why nothing happened. Null on success. */
  refusedBecause: string | null;
}

/**
 * Undo ONE formation: a two-group storyline becomes the two singletons it was
 * made of (docs/STORYLINE-LINKING.md, "The verdict, measured").
 *
 * This is not the split ADR-0011 refuses to build, and the difference is the
 * whole reason it can exist. A split asks which of N groups belong together,
 * which nothing in this system can answer. This asks nothing: a storyline of
 * exactly two groups was one `mergeStorylines` call, the losing UUID is still
 * sitting there as an alias, and reversing a single known merge is arithmetic.
 * The guard below is what keeps it honest — anything other than exactly two
 * groups is refused rather than guessed at.
 *
 * ## What it restores
 *
 * The departing group's ORIGINAL storyline UUID, by reviving the alias. A reader
 * holding that link followed it to the pile while the pile existed and now
 * follows it to the one story it really names; ADR-0011's requirement is that a
 * held UUID never dangle, and reviving satisfies it more completely than minting
 * a fresh row would. Only where no alias exists — a formation built by
 * `attachGroup` on the retroactive path rather than by a merge — is a new
 * provisional storyline created instead.
 *
 * ## What it deliberately leaves alone
 *
 * **Bridges.** A bridge is `(pair, group)` and K counts DISTINCT groups, so a
 * shrunken storyline still cannot reach K without two independent groups
 * qualifying for it. Deleting them would throw away evidence a later, better
 * merge is entitled to; keeping them cannot manufacture a merge on its own.
 * Recorded here because it is a judgement, not an oversight.
 *
 * The caller records the formation refusal. Storage does not know that a verdict
 * happened — it may be a person running a cleanup — and a dissolve with no
 * refusal written is exactly how the next backfill rebuilds the pile.
 */
export async function dissolveFormation(
  db: Kysely<Database>,
  input: { storylineId: string; groupId: string } & Zoned,
): Promise<DissolveResult> {
  return db.transaction().execute(async (trx) => {
    // The same lock merge takes, for the same reason and more sharply: a
    // dissolve racing the merge that would grow this storyline past two groups
    // must not both decide it is a formation.
    await sql`select pg_advisory_xact_lock(hashtext('zammy.storyline-merge'))`.execute(trx);

    const target = await resolveIn(trx, input.storylineId);
    const refuse = (why: string): DissolveResult => ({
      dissolved: false,
      freedStorylineId: null,
      revivedAlias: false,
      refusedBecause: why,
    });
    if (target === null) return refuse("no such storyline");

    const members = await trx
      .selectFrom("storyline_groups")
      .select("group_id")
      .where("storyline_id", "=", target)
      .execute();
    // EXACTLY two. Three or more is the split this refuses to be, and one means
    // the formation is already undone.
    if (members.length !== 2) return refuse(`holds ${members.length} groups, not 2`);
    if (!members.some((row) => row.group_id === input.groupId)) {
      return refuse("group is not a member");
    }

    // The departing group's own identity, if it still exists as an alias. A
    // two-group storyline is one merge, so there is at most one candidate — but
    // it is matched on having held THIS group, never assumed to be the only
    // alias present, because a caller may hand us a storyline that also absorbed
    // something else long ago.
    const revivable = await sql<{ id: string }>`
      select a.id from storylines a
      where a.merged_into = ${target}::uuid
      order by a.created_at desc, a.id
    `.execute(trx);

    let freed: string | null = null;
    let revivedAlias = false;
    if (revivable.rows.length === 1) {
      freed = revivable.rows[0]!.id;
      revivedAlias = true;
      await trx
        .updateTable("storylines")
        .set({ merged_into: null, status: "provisional", label: null, label_words: [],
               label_at: null, label_group_count: null, label_source: null })
        .where("id", "=", freed)
        .execute();
    } else {
      // No alias (an `attachGroup` formation), or several (history this cannot
      // read). Mint a fresh identity rather than guess which alias was whose.
      const row = await trx
        .insertInto("storylines")
        .values({ label: null, merged_into: null })
        .returning("id")
        .executeTakeFirstOrThrow();
      freed = row.id;
    }

    await trx
      .deleteFrom("storyline_groups")
      .where("storyline_id", "=", target)
      .where("group_id", "=", input.groupId)
      .execute();
    await trx
      .insertInto("storyline_groups")
      .values({ storyline_id: freed, group_id: input.groupId })
      .onConflict((conflict) => conflict.doNothing())
      .execute();

    // Both sides are storylines-of-one now: provisional, unlabelled, invisible
    // as storylines. The remaining one keeps its UUID and loses its name,
    // because the name described coverage half of which has just left.
    await trx
      .updateTable("storylines")
      .set({ status: "provisional", label: null, label_words: [], label_at: null,
             label_group_count: null, label_source: null })
      .where("id", "=", target)
      .execute();

    for (const id of [target, freed]) {
      await refreshProfileTokens(trx, id);
      await refreshDaySlots(trx, id, input.timeZone);
    }

    return { dissolved: true, freedStorylineId: freed, revivedAlias, refusedBecause: null };
  });
}
