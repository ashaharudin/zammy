import { sql, type Kysely } from "kysely";
import type { Database, StorylineStatus } from "./database.js";

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

    const attached = Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0;
    if (attached) await wake(trx, target);
    return { attached };
  });
}

/**
 * Membership changed underneath a storyline without its group set changing —
 * a new article landed in a member group, or grouping moved one. Both
 * derivations are over member ARTICLES, so both go stale; the ingest and
 * grouping paths call this to keep the day slots and the profile honest.
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
 */
export async function setStorylineLabel(
  db: Kysely<Database>,
  input: {
    storylineId: string;
    label: string | null;
    labelAt: Date;
    /**
     * Member groups this label describes — the drift baseline. Stamped even
     * when the label came out null: a storyline the model refused to name is
     * not owed another attempt until its coverage has doubled either.
     */
    labelGroupCount: number;
  },
): Promise<void> {
  await db
    .updateTable("storylines")
    .set({
      label: input.label,
      label_at: input.labelAt,
      label_group_count: input.labelGroupCount,
    })
    .where("id", "=", input.storylineId)
    .where("merged_into", "is", null)
    .execute();
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
): Promise<{ merged: boolean; winnerId: string | null }> {
  return db.transaction().execute(async (trx) => {
    const winner = await resolveIn(trx, input.winnerId);
    const loser = await resolveIn(trx, input.loserId);
    if (winner === null || loser === null) return { merged: false, winnerId: winner };
    if (winner === loser) return { merged: false, winnerId: winner };

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

    await trx
      .updateTable("storylines")
      .set({ merged_into: winner, profile_tokens: [] })
      .where("id", "=", loser)
      .execute();

    await refreshProfileTokens(trx, winner);
    await refreshDaySlots(trx, winner, input.timeZone);
    // "Active again when it EARNS coverage" (ADR-0011) — and a merge only
    // earns what the loser brings. A live loser (a provisional birth carrying
    // today's group, or an active arc) is fresh standing; a DORMANT loser is
    // not: two quiet March storylines healed by K bridges are still one quiet
    // March storyline, and waking it would hide the dormant marker for a day
    // on exactly the stale story the marker exists to explain.
    if (loserStatus !== "dormant") await wake(trx, winner);

    return { merged: true, winnerId: winner };
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
 * Delete every v2 storyline row: storylines, their joins, their day slots and
 * their bridges. The `--restart` half of the backfill.
 *
 * TRUNCATE with CASCADE down the FK chain rather than DELETE — this is "build
 * from scratch", and a full-archive rebuild is the one operation where the
 * table's whole contents are the thing being replaced. It touches NOTHING on
 * `articles`: the old `storyline_id` columns are a different model's state,
 * ignored entirely by v2 (ADR-0011's Rollout) and dropped in S9.
 */
export async function resetStorylines(db: Kysely<Database>): Promise<void> {
  await sql`
    truncate storylines, storyline_groups, storyline_days, storyline_bridges
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
  daySlots: number;
  labelled: number;
  /** Promoted storylines that were asked and produced no label at all. */
  unlabelled: number;
}

/**
 * The report (S5). One round trip, because every number here is a count over a
 * table the backfill just wrote and an operator reads them together or not at
 * all — `largest` above all, which is ADR-0009's 1,179-group swallow expressed
 * as a number that can be watched.
 */
export async function readStorylineStats(db: Kysely<Database>): Promise<StorylineStats> {
  const { rows } = await sql<Record<string, string>>`
    select
      (select count(*) from storylines where merged_into is null)          as storylines,
      (select count(*) from storylines where merged_into is not null)      as aliases,
      (select count(*) from storyline_days)                                as day_slots,
      (select count(distinct group_id) from storyline_groups)              as linked_groups,
      (select count(*) from storylines
        where merged_into is null and label is not null)                   as labelled,
      (select count(*) from storylines
        where merged_into is null and label is null and label_at is not null) as unlabelled,
      coalesce((select max(n) from (
        select count(*) as n from storyline_groups group by storyline_id
      ) sizes), 0)                                                         as largest,
      (select count(*) from (
        select storyline_id from storyline_groups
        group by storyline_id having count(*) > 1
      ) promoted)                                                          as promoted
  `.execute(db);

  const row = rows[0] ?? {};
  const n = (key: string): number => Number(row[key] ?? 0);
  return {
    storylines: n("storylines"),
    promoted: n("promoted"),
    aliases: n("aliases"),
    linkedGroups: n("linked_groups"),
    largestStoryline: n("largest"),
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

/** A retrieval candidate: the facts the linker's decision reads, nothing else. */
export interface StorylineCandidate {
  id: string;
  profileTokens: string[];
  status: StorylineStatus;
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
 * `limit` is a safety valve for a pathological token, not a tuning knob: a
 * group carrying a word half the archive shares would otherwise make one
 * decision an unbounded scan. Ordered by recent coverage first so the cut,
 * when it binds, keeps the storylines a group is most likely to belong to —
 * degrading to a worse link is this layer's cheap direction, exactly as
 * grouping's own candidate cap argues (§14.3).
 */
export async function readCandidateStorylines(
  db: Kysely<Database>,
  input: { tokens: readonly string[]; limit: number },
): Promise<StorylineCandidate[]> {
  if (input.tokens.length === 0) return [];

  const { rows } = await sql<{
    id: string;
    profile_tokens: string[];
    status: StorylineStatus;
    last_coverage: Date | null;
    group_count: string;
  }>`
    select s.id,
           s.profile_tokens,
           s.status,
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
    status: row.status,
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
): Promise<{ recorded: boolean }> {
  return db.transaction().execute(async (trx) => {
    const a = await resolveIn(trx, input.storylineA);
    const b = await resolveIn(trx, input.storylineB);
    if (a === null || b === null || a === b) return { recorded: false };

    const [lo, hi] = a < b ? [a, b] : [b, a];
    const inserted = await trx
      .insertInto("storyline_bridges")
      .values({ storyline_lo: lo, storyline_hi: hi, group_id: input.groupId })
      .onConflict((conflict) => conflict.doNothing())
      .executeTakeFirst();

    return { recorded: Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0 };
  });
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
 * Re-derive the profile: every token carried by at least half the member groups.
 *
 * Group-level support, not article-level, and that is the whole point — it is the
 * majority-support rule that silenced AP live-blog vocabulary at the group layer,
 * promoted one level (ADR-0011). Counted over DISTINCT (group, token) pairs, so a
 * story syndicated forty times has one vote like everything else.
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
        where support.groups_with * 2 >= total.n),
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
    profileTokens: row.profile_tokens,
    status: row.status,
    mergedInto: row.merged_into,
    createdAt: row.created_at,
  };
}
