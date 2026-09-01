import { chooseRepresentative, type Attributable } from "./source-authority.js";

/**
 * The **representative** rule, whole (CONTEXT.md, Representative; ARCHITECTURE
 * §14.3 and §8.1).
 *
 * CONTEXT.md states it as one rule with four clauses:
 *
 *  1. "among the members that matched that search" — a PRECONDITION on the
 *     caller, below.
 *  2. "the slot's lead group — the largest the storyline shows that day" —
 *     `leadGroup`.
 *  3. "by source authority" — `chooseRepresentative` (`source-authority.ts`).
 *  4. "a card cut out of a LATER part is headed by the earliest article that
 *     part holds" — the `within` option, defaulted to that.
 *
 * They lived in four modules across three packages, and nothing pinned that
 * they agreed because nothing could: different packages, different fixtures.
 * Two prose restatements of one invariant sat a package apart and drifted
 * independently. They are one function now, so "the lead card and the 18:00
 * card follow one rule" is a table in `heading.test.ts` rather than a claim.
 *
 * **Clause 1 is a precondition, not a step.** It is a SQL join
 * (`packages/storage/src/storyline-timeline.ts`, step 2) and cannot be moved
 * here; what this module owns is the contract it creates. Pass exactly the
 * members that matched the search. Passing more surfaces an article the
 * reader's keywords never found and buries the matching one under "related"
 * (§14.3, "groups are global; the representative is per-topic"), and this
 * function cannot tell — every member it is handed is one it may promote.
 *
 * **Clause 4 is a parameter and not a second algorithm** because it is the one
 * clause under review. See `LATER_PART_RULE`.
 */

/** A member of a group, with the four fields the rule reads and no more. */
export interface Grouped extends Attributable {
  /** Which articles are one piece — the fold clauses 2 and 4 both read. */
  groupId: string;
}

/**
 * How a heading group is picked out of a set of members.
 *
 *  - `"lead"` — §14.3's rule: the LARGEST group leads, and source authority
 *    picks within it. What a timeline slot uses.
 *  - `"part"` — the earliest article the set holds heads it, and its group is
 *    the heading group. What a card cut out of a later part of the reader's
 *    day uses today.
 */
export type Within = "lead" | "part";

/**
 * Which rule a card cut out of a LATER part of the reader's day follows.
 *
 * **Flipping this to `"lead"` changes which headline a reader sees**, so it is
 * a product change with its own review and its own evidence, not something a
 * restructure may do on its way past. It is a constant rather than an inlined
 * literal so that the change is one line when the evidence supports it — which
 * is the whole reason clause 4 is a parameter here instead of a second
 * algorithm in `apps/web`.
 *
 * Held deliberately, not forced. It was once forced: the wire carried no group
 * structure below the slot, so a part of the day had nothing to choose within.
 * Every article names its group now (`Article.groupId`, ADR-0004's test
 * applied), so `"lead"` is available and merely unchosen.
 */
export const LATER_PART_RULE: Within = "part";

/** What heads a card, and how the rest of its members split behind it. */
export interface Heading<T> {
  /**
   * The **representative**: the article whose headline the card shows.
   * _Avoid_: primary, canonical, best, winner.
   */
  representative: T;
  /** The rest of the heading group — one piece, several outlets. "N related". */
  related: T[];
  /** Every other group's members, flattened: the wider coverage around it. */
  coverage: T[];
}

/**
 * Read a set of members as a card: what heads it, and what sits behind it.
 *
 * `members` must be the ones that matched the search (clause 1) and must be
 * non-empty. The order given is the order returned — the wire sends members
 * newest-first and that is the order the disclosure renders in (§14.3), so this
 * function decides which list an article goes in and never where it sits once
 * there.
 *
 * Nothing here reads `sightingCount`, and `Grouped` is the guard: it measures
 * upstream re-emission rather than importance — one link-roundup page arrived
 * 50 times (PROBE-FINDINGS 4) — so ranking by it would hand the front of every
 * slot to the noisiest wire, which is exactly what §7.4's collapse exists to
 * neutralise. Reaching for it has to be a type error rather than a judgement
 * call.
 */
export function chooseHeading<T extends Grouped>(
  members: readonly T[],
  options: { within?: Within } = {},
): Heading<T> {
  if (members.length === 0) {
    throw new Error("a card always has at least one member");
  }

  const groups = new Map<string, T[]>();
  for (const member of members) {
    const group = groups.get(member.groupId);
    if (group) group.push(member);
    else groups.set(member.groupId, [member]);
  }

  const representative =
    (options.within ?? "lead") === "lead"
      ? // Clauses 2 then 3: the largest group leads, source authority picks
        // within it.
        chooseRepresentative(leadGroup(groups))
      : // Clause 4 as it ships: the earliest article the set holds, whichever
        // group it came from. Its group becomes the heading group by
        // consequence rather than by choice — which is precisely the asymmetry
        // `LATER_PART_RULE` exists to make reviewable.
        earliest(members);

  const headingGroup = representative.groupId;
  const related: T[] = [];
  const coverage: T[] = [];
  for (const member of members) {
    if (member === representative) continue;
    (member.groupId === headingGroup ? related : coverage).push(member);
  }
  return { representative, related, coverage };
}

/**
 * The largest group, tie-broken by earliest published then lowest group id —
 * "the largest the storyline shows that day".
 *
 * Largest rather than most authoritative: the story itself, rather than an
 * angle piece that happens to cite a tier-1 domain. The tie-break is total so
 * that a replayed read reaches the same card (§7.4's replay discipline), and
 * it compares BigInt for the same reason `chooseRepresentative` does — a group
 * id IS an article id, the seed's, decimal over a bigint column.
 */
function leadGroup<T extends Grouped>(groups: ReadonlyMap<string, T[]>): T[] {
  let lead: { groupId: string; members: T[] } | null = null;
  for (const [groupId, members] of groups) {
    if (lead === null || outgrows({ groupId, members }, lead)) lead = { groupId, members };
  }
  // `chooseHeading` refuses an empty `members`, so there is always a group.
  return lead!.members;
}

function outgrows<T extends Grouped>(
  candidate: { groupId: string; members: T[] },
  incumbent: { groupId: string; members: T[] },
): boolean {
  if (candidate.members.length !== incumbent.members.length) {
    return candidate.members.length > incumbent.members.length;
  }
  const delta =
    Date.parse(earliest(candidate.members).published) -
    Date.parse(earliest(incumbent.members).published);
  if (delta !== 0) return delta < 0;
  return BigInt(candidate.groupId) < BigInt(incumbent.groupId);
}

/**
 * The earliest of `members`. Ties go to the FIRST, which is the newest-first
 * list's own answer — so two articles published at one instant cannot swap the
 * headline between renders.
 */
function earliest<T extends Attributable>(members: readonly T[]): T {
  let best = members[0]!;
  for (const member of members) {
    if (Date.parse(member.published) < Date.parse(best.published)) best = member;
  }
  return best;
}
