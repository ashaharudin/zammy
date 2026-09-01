import type { Kysely } from "kysely";
import {
  mergeStorylines,
  promoteStoryline,
  readStorylineLabelInput,
  readSoleGroup,
  recordFormationRefusal,
  type Database,
} from "@zammy/storage";
import { buildCoherencePrompt, readCoherenceReply } from "./storyline-coherence.js";
import { selectLabelMembers } from "./storyline-label.js";
import { nameStoryline, type LabelerDeps, type ModelAnswer } from "./storyline-naming.js";
import type { LinkOutcome } from "./storyline-linker.js";

/**
 * Resolving a DEFERRED formation: the write half of ADR-0011's coherence gate.
 *
 * The linker earned a formation on token evidence and withheld it
 * (`LinkOutcome.pendingFormation`). This asks a model whether the two groups
 * cover one story and then does one of three things, and which one it does is
 * the entire safety argument:
 *
 * | verdict | action |
 * | --- | --- |
 * | a refusal — the "NOT ONE STORY" sentinel, or a paraphrase of it | record a refusal; the groups stay apart |
 * | a usable name | perform the merge, promote, and hand that name to the writer |
 * | anything else | perform the merge, promote, and hand over "already asked, nothing usable" |
 *
 * The third row is the load-bearing one. An unavailable, slow, out-of-quota or
 * contract-breaking model produces exactly the pre-gate outcome — the archive's
 * own key has a 500-request DAILY ceiling that the labelling campaign exhausts,
 * so a gate that read silence as a refusal would dissolve storylines on a quiet
 * Tuesday rather than on evidence.
 *
 * ## Why this is free
 *
 * One model call, two answers. A promotion already spent a call on the label; it
 * now spends the same call on the verdict AND the label, because a model that can
 * name the story has thereby said it is one. Nothing here scales with attach
 * volume: `pendingFormation` is only ever set where the winner was a
 * provisional-of-one.
 *
 * The writing is somebody else's job — `storyline-naming.ts`, the one writer of
 * the label columns. This path only carries the answer over, and that is what
 * keeps the one call one: an answer handed in says "already asked", which is a
 * different thing from saying nothing and being asked again.
 *
 * ## Where it runs
 *
 * Off the latency path, in the same started-and-not-awaited tail that already
 * labels (`labelLinkedStorylines`). It therefore inherits that function's
 * contract — **it never throws for a model reason** — and adds one of its own:
 * a formation lost to a dead process or a spent quota costs a STORYLINE, never
 * an article. Both groups keep their own provisional storylines, both keep
 * rendering as ordinary slots, and the nightly late-candidate sweep offers them
 * again.
 */

/**
 * The labeler's own deps, plus the calendar.
 *
 * Not a hand-picked subset of them: a formation that goes ahead is named
 * through `storyline-naming.ts` like every other naming, so this path needs
 * exactly what that module needs. `driftFactor` rides along unread — the
 * trigger here is always `promotion`, which `needsLabel` answers without it —
 * and that is the price of one deps object instead of two that can disagree.
 */
export interface FormationDeps extends LabelerDeps {
  /**
   * The calendar day slots are bucketed by. Performing the merge the linker
   * withheld recomputes them, which is why a caller that cannot name a zone
   * must not resolve formations at all.
   */
  timeZone: string;
}

export type FormationResult =
  /** Formed. `labelled` says whether the same call also produced the name. */
  | { kind: "formed"; storylineId: string; labelled: boolean }
  /** The model said these are not one story. Nothing was written but the refusal. */
  | { kind: "refused" }
  /** No longer a formation — someone else got there first, or it vanished. */
  | { kind: "moot"; reason: string };

/**
 * Resolve one deferred formation.
 *
 * Every early return is a re-check of something the linker read BEFORE the tail
 * started, because between then and now another arrival may have attached to the
 * same storyline. A formation that is no longer a formation must not be judged by
 * a gate that is measurably wrong about established arcs — it is simply performed.
 */
export async function resolveFormation(
  deps: FormationDeps,
  pending: NonNullable<LinkOutcome["pendingFormation"]>,
): Promise<FormationResult> {
  const now = deps.now ?? (() => new Date());
  const { winnerId, groupId, partnerGroupId } = pending;

  // Still a storyline-of-one? `readSoleGroup` answers "is there a formation
  // here" and "which group is the partner" in one read, and a changed answer
  // means the gate has lost jurisdiction.
  const sole = await readSoleGroup(deps.db, winnerId);
  if (sole === null) {
    // It grew (or emptied) since the linker looked. Growing means this is now a
    // join to a real arc, which `mayRefuseFormation` excludes on measured
    // grounds, so it proceeds without a verdict.
    return performFormation(deps, pending, {
      label: null,
      reason: "no verdict sought — no longer a formation",
    });
  }
  if (sole !== partnerGroupId) {
    // The identity now wears a different group — a group merge moved underneath
    // us. The pair the verdict would be about is not the pair the linker judged,
    // so refuse to record anything against it.
    return { kind: "moot", reason: "partner group changed" };
  }

  const { members } = await readStorylineLabelInput(deps.db, {
    storylineId: winnerId,
    limit: deps.sampleSize,
  });
  const own = await ownStorylineOf(deps.db, groupId);
  if (own === null) return { kind: "moot", reason: "arriving group has no storyline" };
  const arriving = await readStorylineLabelInput(deps.db, {
    storylineId: own,
    limit: deps.sampleSize,
  });
  const coverage = [...members, ...arriving.members];
  if (coverage.length === 0) {
    // Nothing to show a model and nothing to name. Transient (retention took the
    // articles), so no refusal is recorded — that would be a verdict nobody gave.
    return { kind: "moot", reason: "no coverage" };
  }

  const sample = selectLabelMembers(coverage, deps.sampleSize);

  if (!deps.generator) {
    return performFormation(deps, pending, { label: null, reason: "no generator configured" });
  }

  const result = await deps.generator.generate({ prompt: buildCoherencePrompt(sample) });
  const reply = readCoherenceReply(result.ok ? result.text : null, sample);

  if (reply.kind === "incoherent") {
    await recordFormationRefusal(deps.db, { groupA: groupId, groupB: partnerGroupId });
    deps.logger?.debug?.(
      { winnerId, groupId, partnerGroupId },
      "coherence gate refused a formation",
    );
    return { kind: "refused" };
  }

  if (reply.kind === "unusable") {
    // The pre-gate outcome, deliberately. The raw text rides the log line because
    // the prompt is expected to iterate on live output and its refusals are the
    // only evidence of which way.
    deps.logger?.warn(
      { winnerId, groupId, reason: reply.reason },
      "coherence gate got no usable verdict; forming the storyline ungated",
    );
    return performFormation(deps, pending, { label: null, reason: reply.reason });
  }

  return performFormation(deps, pending, { label: reply.label, at: now() });
}

/**
 * Perform the merge the linker withheld, promote, and hand the naming over.
 *
 * This is the fresh path's tail, moved: absorbing the arriving group's birth
 * storyline into the winner by merge-with-alias, so a UUID already in a reader's
 * URL keeps resolving. What it does NOT do any more is write the label itself.
 * A promotion is a promotion whoever caused it, so the name is written by the
 * one writer of the label columns (`storyline-naming.ts`) under the trigger it
 * really is.
 *
 * `answer` is what keeps that free. The gate's model call already produced
 * both the permission and the name (ADR-0011's amendment: "one model call, two
 * answers"), so it is passed through rather than re-earned — and when the gate
 * got nothing usable, passing the reason through says "already asked" rather
 * than "not yet asked", which is what stops one call becoming two. The naming
 * module then falls back to the bigram extractor exactly as an ungated
 * promotion always has.
 */
async function performFormation(
  deps: FormationDeps,
  pending: NonNullable<LinkOutcome["pendingFormation"]>,
  answer: ModelAnswer,
): Promise<FormationResult> {
  const own = await ownStorylineOf(deps.db, pending.groupId);
  if (own === null) return { kind: "moot", reason: "arriving group has no storyline" };
  const absorbed = await mergeStorylines(deps.db, {
    winnerId: pending.winnerId,
    loserId: own,
    timeZone: deps.timeZone,
  });
  const storylineId = absorbed.winnerId ?? pending.winnerId;
  if (!absorbed.merged) return { kind: "moot", reason: "already one storyline" };

  await promoteStoryline(deps.db, { storylineId });

  await nameStoryline(deps, { storylineId, trigger: "promotion", asked: answer });

  return { kind: "formed", storylineId, labelled: answer.label !== null };
}

/**
 * The storyline a group is alone in — its birth identity.
 *
 * The arriving group has not been re-homed (that is what deferring means), so it
 * still leads a storyline of one. Picking the SMALLEST membership rather than the
 * first row matters when the group is multi-homed by retroactive attachment: the
 * birth storyline is the one holding nothing else, and merging a real arc into
 * the winner instead would be a merge with no bridge evidence at all — the
 * percolation K exists to prevent.
 */
async function ownStorylineOf(db: Kysely<Database>, groupId: string): Promise<string | null> {
  const rows = await db
    .selectFrom("storyline_groups as mine")
    .select((eb) => [
      "mine.storyline_id",
      eb
        .selectFrom("storyline_groups as all_of")
        .select((inner) => inner.fn.countAll<string>().as("n"))
        .whereRef("all_of.storyline_id", "=", "mine.storyline_id")
        .as("size"),
    ])
    .innerJoin("storylines", "storylines.id", "mine.storyline_id")
    .where("mine.group_id", "=", groupId)
    .where("storylines.merged_into", "is", null)
    .execute();

  const sorted = [...rows].sort(
    (a, b) =>
      Number(a.size ?? 0) - Number(b.size ?? 0) ||
      (a.storyline_id < b.storyline_id ? -1 : 1),
  );
  return sorted[0]?.storyline_id ?? null;
}

/**
 * Resolve every deferred formation in a batch, in order.
 *
 * Serial rather than concurrent: the Gemini client paces itself against a
 * per-KEY ceiling anyway, and two formations in one batch may name the same
 * storyline — the second must see the first's write, or both would merge into a
 * winner that only one of them read.
 *
 * Never throws, for `labelLinkedStorylines`' reason: the caller does not await
 * this, and an unhandled rejection is a process-level event for what is at worst
 * one storyline that did not form.
 */
export async function resolvePendingFormations(
  deps: FormationDeps,
  outcomes: readonly LinkOutcome[],
): Promise<Map<string, FormationResult>> {
  const resolved = new Map<string, FormationResult>();
  for (const outcome of outcomes) {
    const pending = outcome.pendingFormation;
    if (!pending) continue;
    try {
      resolved.set(pending.winnerId, await resolveFormation(deps, pending));
    } catch (error) {
      deps.logger?.warn(
        { err: error, winnerId: pending.winnerId, groupId: pending.groupId },
        "resolving a deferred formation failed; the late-candidate sweep will re-offer it",
      );
    }
  }
  return resolved;
}
