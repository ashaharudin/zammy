import type { Kysely } from "kysely";
import {
  countGroups,
  markDormantStorylines,
  readLabelCandidates,
  readLastLinkedGroup,
  readLinkableGroups,
  readStorylineStats,
  resetStorylines,
  type Database,
  type LabelCursor,
  type StorylineStats,
} from "@zammy/storage";
import { readTrailingCorpus } from "./story-df.js";
import { linkGroup, type LinkerDeps } from "./storyline-linker.js";
import { labelStoryline, type LabelerDeps } from "./storyline-label-service.js";
import { needsLabel } from "./storyline-label.js";

/**
 * The full-history backfill (ADR-0011's Rollout, S5): replay the linker over
 * the entire article corpus, chronologically, building storylines, joins and
 * day slots from scratch — then label what got promoted.
 *
 * Three things make this the shape it is:
 *
 * **It replays `linkGroup`, not a copy of it.** The sweep has an in-memory
 * reimplementation of the *storage* because measuring a dozen threshold
 * combinations through Postgres would take longer than regretting them; a
 * backfill has no such excuse, and a second implementation of the decision
 * would be a second set of rules to keep in step. What is here is a loop, a
 * cursor and a report.
 *
 * **Chronological, because replay order is the canonical order.** The linker is
 * order-dependent by construction: a group can only join a storyline that
 * already exists, so walking the archive backwards would build a different and
 * equally self-consistent set of storylines. Publication order is the one that
 * matches what live ingest would have built had v2 existed all along.
 *
 * **Existing `storyline_id` data is ignored entirely.** It is the old model's
 * state, keyed on a group id, day-bounded, and ADR-0011 supersedes it whole.
 * Nothing here reads it and nothing here writes it.
 *
 * Resumable without a checkpoint table: every group the linker has reached has
 * a `storyline_groups` row, so progress is a question the data answers. See
 * `readLastLinkedGroup`.
 */

export interface BackfillOptions {
  /** Wipe v2 state and rebuild from the first group. Default: resume. */
  restart?: boolean;
  /** Groups per read. Bounds memory, not correctness. */
  batchSize?: number;
  /** Stop after this many groups — for a rehearsal on a slice of the archive. */
  maxGroups?: number;
  /** Skip the labelling pass. */
  skipLabels?: boolean;
  /** Skip the linking pass and label what is already there. */
  labelsOnly?: boolean;
  /** Ceiling on label calls per minute. The model is the only rate limit here. */
  labelRatePerMinute?: number;
  /** Ceiling on how many storylines the label pass will touch. */
  maxLabels?: number;
  /**
   * Relabel every promoted storyline, ignoring the drift check.
   *
   * The drift rule exists to stop the labeler re-naming what it has already
   * named, and it is right to — but it makes "the model config changed" an
   * unsayable thing: a run that switched from the bigram fallback to a real
   * model would skip every storyline it had already fallen back on. This is
   * how an operator says it. It spends a model call per promoted storyline, so
   * it is a flag and not a default.
   */
  relabel?: boolean;
  /** Progress callback — the CLI prints, the tests count. */
  onProgress?: (progress: BackfillProgress) => void;
  /** Cooperative cancellation, so a long run stops at a clean group boundary. */
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  /** The wall clock the closing dormancy stamp measures silence against. */
  now?: () => Date;
}

export interface BackfillProgress {
  phase: "link" | "label";
  done: number;
  /** Absent for the label phase, whose denominator is only known as it goes. */
  total?: number;
  /** Where the walk has reached, so an interrupted run's log says where. */
  at?: Date;
}

export interface BackfillReport {
  /** Groups the linker actually processed in THIS run. */
  linked: number;
  /** Groups that joined an existing storyline rather than keeping their own. */
  attached: number;
  merges: number;
  /** Groups the linker refused to process; the run continues past them. */
  failures: number;
  /** Storylines the closing stamp marked dormant (ADR-0011's Lifecycle). */
  dormant: number;
  labelled: { model: number; bigram: number; none: number; skipped: number };
  stats: StorylineStats;
  /** Wall clock, split so a slow half is visible as the slow half. */
  linkMs: number;
  labelMs: number;
  /** True when the run stopped early — cancelled, or capped. */
  incomplete: boolean;
}

/**
 * Run the backfill. Returns its report; throws only for a reason no retry
 * fixes (an unusable corpus), because everything else is worth continuing past
 * and reporting at the end.
 */
export async function backfillStorylines(
  deps: LinkerDeps & { labeler?: Omit<LabelerDeps, "db"> },
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const batchSize = options.batchSize ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const report: BackfillReport = {
    linked: 0,
    attached: 0,
    merges: 0,
    failures: 0,
    dormant: 0,
    labelled: { model: 0, bigram: 0, none: 0, skipped: 0 },
    stats: await readStorylineStats(deps.db),
    linkMs: 0,
    labelMs: 0,
    incomplete: false,
  };

  if (!options.labelsOnly) {
    const startedAt = Date.now();
    Object.assign(report, await link(deps, options, batchSize));
    report.linkMs = Date.now() - startedAt;
  }

  if (!options.skipLabels && deps.labeler) {
    const startedAt = Date.now();
    report.labelled = await labelPass(deps.db, deps.labeler, options, sleep);
    report.labelMs = Date.now() - startedAt;
  }

  // The closing stamp: a replay builds storylines whose coverage ended months
  // ago, and every one of them is written `active` on the way in. The nightly
  // sweep would fix that at 3am; a fresh archive must not read as five months of
  // live stories until then. Same knob the linker's own gate uses, so the column
  // and the bar cannot disagree the moment the backfill finishes.
  const now = options.now ?? (() => new Date());
  report.dormant = await markDormantStorylines(deps.db, {
    before: new Date(now().getTime() - deps.config.rules.dormancyDays * 86_400_000),
  });

  report.stats = await readStorylineStats(deps.db);
  return report;
}

/** The linking pass: every group, in publication order, through `linkGroup`. */
async function link(
  deps: LinkerDeps,
  options: BackfillOptions,
  batchSize: number,
): Promise<Pick<BackfillReport, "linked" | "attached" | "merges" | "failures" | "incomplete">> {
  if (options.restart) await resetStorylines(deps.db);

  // A backfill against an empty trailing corpus silently builds nothing: every
  // group finds `corpus.size === 0`, keeps its own storyline and moves on, and
  // the report says "19,027 storylines, 0 promoted" without a word about why.
  // Refuse instead — this is the one failure a retry cannot fix, and the fix
  // is a command the operator has to run.
  await assertCorpusExists(deps);

  const total = await countGroups(deps.db);
  const resumeFrom = options.restart ? null : await readLastLinkedGroup(deps.db);
  let after: { published: Date; groupId: string } | null = resumeFrom;
  // Only the FIRST read re-runs its cursor row. Resuming has to: the group the
  // last run died on may have been born without its bridges recorded, and
  // `linkGroup` is idempotent precisely so re-running it finishes the job.
  // Every read after that is exclusive, or each batch redoes the last group of
  // the one before it.
  let inclusive = resumeFrom !== null;
  const tally = { linked: 0, attached: 0, merges: 0, failures: 0, incomplete: false };

  for (;;) {
    if (options.signal?.aborted) {
      tally.incomplete = true;
      break;
    }

    const batch = await readLinkableGroups(deps.db, {
      ...(after ? { after: { ...after, inclusive } } : {}),
      limit: batchSize,
    });
    inclusive = false;
    if (batch.length === 0) break;

    for (const group of batch) {
      if (options.signal?.aborted) {
        tally.incomplete = true;
        break;
      }
      if (options.maxGroups !== undefined && tally.linked >= options.maxGroups) {
        tally.incomplete = true;
        break;
      }

      try {
        const outcome = await linkGroup(deps, {
          groupId: group.groupId,
          memberTokens: group.memberTokens,
          language: group.language,
          published: group.published,
        });
        if (outcome.attached) tally.attached += 1;
        tally.merges += outcome.merged.length;
      } catch (error) {
        // One group's failure is one group standing alone, not a lost run.
        // The same posture the live linker takes, for the same reason: the
        // articles are stored and already paged either way.
        tally.failures += 1;
        deps.log?.warn(
          { err: error, groupId: group.groupId },
          "backfill: linking failed for one group; it leads its own storyline",
        );
      }
      tally.linked += 1;
      after = { published: group.published, groupId: group.groupId };
    }

    options.onProgress?.({
      phase: "link",
      done: tally.linked,
      total,
      ...(after ? { at: after.published } : {}),
    });

    if (tally.incomplete) break;
    // A batch shorter than asked for is the last one — but only if the cursor
    // moved. It cannot fail to move here (the loop above advances it on every
    // group, failures included), and the check is what makes that explicit.
    if (batch.length < batchSize) break;
  }

  return tally;
}

/**
 * The labelling pass: promoted storylines that need a label, batched and
 * rate-limited.
 *
 * Resumable for the same reason the linking pass is — `needsLabel` reads the
 * row, so a storyline that already has a current label is skipped whether it
 * was labelled a moment ago or last month. A re-run costs the reads and no
 * model calls.
 *
 * Rate-limited because this is the one part of the system that spends money per
 * call and the only place a backfill can spend it in a burst: 3,000 promoted
 * storylines is 3,000 calls, and a full-archive run is exactly when an API's
 * per-minute ceiling is met. The limit is wall-clock spacing rather than a
 * token bucket — the simplest thing that cannot burst, for a pass with no
 * deadline.
 *
 * Exported because the nightly drift chore IS this pass, bounded: same
 * candidates, same drift rule, same spacing (ADR-0011's third trigger). A second
 * copy of the loop would be a second place for the cursor discipline to go
 * wrong, and the cursor discipline is the part that is easy to get wrong.
 */
export async function labelPass(
  db: Kysely<Database>,
  labeler: Omit<LabelerDeps, "db">,
  options: BackfillOptions,
  sleep: (ms: number) => Promise<void>,
): Promise<BackfillReport["labelled"]> {
  const tally = { model: 0, bigram: 0, none: 0, skipped: 0 };
  const rate = options.labelRatePerMinute ?? 60;
  // Only the MODEL is rate-limited, because it is the only thing here with a
  // per-minute ceiling and a bill. With no generator configured every label
  // comes from the bigram extractor — pure CPU — and spacing those would have
  // made a no-key backfill of 3,000 storylines take an hour to do a second of
  // work. Measured the hard way on the dev archive.
  const spacingMs = rate > 0 && labeler.generator ? Math.ceil(60_000 / rate) : 0;
  const batchSize = options.batchSize ?? 500;

  // Keyset over `(created_at, id)`, not "read the ones that need a label
  // again": the pass MUTATES what it reads — a labelled storyline stops
  // needing one — so re-reading from the start would spin for ever on the
  // storylines it skips. The cursor walks strictly backwards through creation
  // order instead, which is what `readLabelCandidates` sorts by.
  let after: LabelCursor | undefined;
  let attempted = 0;

  for (;;) {
    if (options.signal?.aborted) break;

    const candidates = await readLabelCandidates(db, {
      limit: batchSize,
      ...(after ? { after } : {}),
    });
    if (candidates.length === 0) break;

    for (const storyline of candidates) {
      if (options.signal?.aborted) break;
      if (options.maxLabels !== undefined && attempted >= options.maxLabels) break;

      if (
        !options.relabel &&
        !needsLabel(storyline, {
          groupCount: storyline.groupCount,
          trigger: "drift",
          driftFactor: labeler.driftFactor,
        })
      ) {
        tally.skipped += 1;
        continue;
      }

      if (attempted > 0 && spacingMs > 0) await sleep(spacingMs);
      attempted += 1;

      const outcome = await labelStoryline(
        { db, ...labeler },
        { storyline, trigger: options.relabel ? "promotion" : "drift" },
      );
      if (outcome.source === "model") tally.model += 1;
      else if (outcome.source === "bigram") tally.bigram += 1;
      else if (outcome.source === "skipped") tally.skipped += 1;
      else tally.none += 1;

      options.onProgress?.({ phase: "label", done: attempted });
    }

    if (options.maxLabels !== undefined && attempted >= options.maxLabels) break;
    const last = candidates[candidates.length - 1]!;
    after = { createdAt: last.createdAt, id: last.id };
    if (candidates.length < batchSize) break;
  }

  return tally;
}

/**
 * Is there a trailing corpus to measure rarity against? One probe against the
 * newest group, which is the one most likely to have a populated window.
 */
async function assertCorpusExists(deps: LinkerDeps): Promise<void> {
  const newest = await deps.db
    .selectFrom("articles")
    .select(["language", "published", "story_tokens"])
    .orderBy("published", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!newest) return; // An empty archive backfills to nothing, correctly.

  const corpus = await readTrailingCorpus(
    { db: deps.db, config: deps.config.storyDf },
    {
      language: newest.language,
      now: newest.published,
      tokens: newest.story_tokens.slice(0, 8),
    },
  );
  if (corpus.size === 0) {
    throw new Error(
      "the trailing corpus is empty, so every rarity decision would be refused " +
        "and the backfill would build nothing. Populate it first:\n" +
        "  pnpm story:df --rebuild --days=<archive length + 1>",
    );
  }
}
