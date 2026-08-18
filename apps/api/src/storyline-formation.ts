import type { Kysely } from "kysely";
import {
  mergeStorylines,
  promoteStoryline,
  readStorylineLabelInput,
  readSoleGroup,
  recordFormationRefusal,
  setStorylineLabel,
  type Database,
} from "@zammy/storage";
import type { TextGenerator } from "./gemini.js";
import { buildCoherencePrompt, readCoherenceReply } from "./storyline-coherence.js";
import { fallbackLabel, selectLabelMembers } from "./storyline-label.js";
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
 * | an explicit "NOT ONE STORY" | record a refusal; the groups stay apart |
 * | a usable name | perform the merge, promote, and write that name |
 * | anything else | perform the merge, promote, and fall back to bigrams |
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

export interface FormationDeps {
  db: Kysely<Database>;
  /** Null with no `GEMINI_API_KEY` — every formation then proceeds ungated. */
  generator: TextGenerator | null;
  /** How a model-produced label is recorded; the configured model id. */
  modelId?: string;
  sampleSize: number;
  timeZone: string;
  now?: () => Date;
  logger?: {
    warn(fields: Record<string, unknown>, message: string): void;
    debug?(fields: Record<string, unknown>, message: string): void;
  };
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
    return performFormation(deps, pending, null);
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

  if (!deps.generator) return performFormation(deps, pending, null);

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
    return performFormation(deps, pending, null);
  }

  return performFormation(deps, pending, { label: reply.label, at: now() });
}

/**
 * Perform the merge the linker withheld, and promote.
 *
 * This is the fresh path's tail, moved: absorbing the arriving group's birth
 * storyline into the winner by merge-with-alias, so a UUID already in a reader's
 * URL keeps resolving. `named` writes the label from the same reply that
 * permitted the formation; null falls back to the bigram extractor, which is what
 * a promotion without a usable model has always produced.
 */
async function performFormation(
  deps: FormationDeps,
  pending: NonNullable<LinkOutcome["pendingFormation"]>,
  named: { label: string; at: Date } | null,
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

  const { groupCount, members } = await readStorylineLabelInput(deps.db, {
    storylineId,
    limit: deps.sampleSize,
  });
  const label = named?.label ?? fallbackLabel(selectLabelMembers(members, deps.sampleSize));
  await setStorylineLabel(deps.db, {
    storylineId,
    label,
    labelAt: named?.at ?? (deps.now ?? (() => new Date()))(),
    labelGroupCount: groupCount,
    labelSource: named ? (deps.modelId ?? "model") : label === null ? null : "bigram",
  });

  return { kind: "formed", storylineId, labelled: named !== null };
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
