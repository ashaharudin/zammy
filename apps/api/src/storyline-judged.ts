/**
 * Scoring a replay against the archive's HAND-JUDGED storylines.
 *
 * The sweep's own columns cannot answer the question that matters. Storyline
 * counts, attach volume and the percolation alarm all say how MUCH a setting
 * builds; none of them says whether what it built is a story. ADR-0011 forbids
 * entity and beat storylines, docs/STORYLINE-LINKING.md records that "a sweep
 * table cannot tell you whether a storyline is coherent", and the anchor share
 * was pinned by an operator READING what each setting produced.
 *
 * The labelling campaign left something better than reading behind it. Asked to
 * name every storyline the bigram fallback had labelled or left bare, a model
 * named 1,189 and declined 382 as unnameable, and the declines are dominated by
 * two unrelated articles sharing a word. That gives the linker a labelled
 * evaluation set in both directions, which is the thing the tuning record says
 * it never had:
 *
 *  - **declined** — storylines that should NOT have formed. A candidate change
 *    is trying to stop these.
 *  - **named** — storylines that SHOULD exist, including every large correct arc
 *    in the archive. A candidate change must leave these standing.
 *
 * Measuring only the first is how a threshold gets tightened until the piles
 * stop and the coverage fragments with them. Both numbers together are what make
 * "fewer bad storylines" distinguishable from "fewer storylines".
 *
 * Nothing here reads a database or a model: it takes the storylines a replay
 * built and the group sets the archive judged, and reports how they overlap.
 *
 * ## Reading the numbers
 *
 * A judged storyline is a SET OF GROUPS. The replay assigns every group a home,
 * so the question for each judged set is how much of it landed in one place —
 * `together`, the size of its largest intact fragment:
 *
 *  - a **declined** set with `together >= 2` still formed: the pile is back.
 *  - a **named** set is `intact` when `together` covers all of it, and
 *    `groupsTogether / groupsTotal` reports the softer version — a 90-group arc
 *    that replays as 89 has not been destroyed, and a pass/fail count alone
 *    would say it had.
 *
 * These are RELATIVE measures, and the baseline is not 100%. The replay
 * substitutes storage (`storyline-replay.ts`) and models neither the
 * label-agreement merge nor the nightly bridge sweep, both of which built the
 * archive's biggest arcs — so at the pinned values it reassembles about a third
 * of the named sets exactly. Compare a candidate against the pinned baseline in
 * this same harness; do not read the absolute figure as a grade.
 */

/** One storyline the archive has a human-checked verdict on. */
export interface JudgedStoryline {
  /** The live storyline's id — for naming a row in a report, never matched on. */
  id: string;
  label: string | null;
  /** Its member groups, as the archive holds them. */
  groupIds: readonly string[];
}

/** A replayed storyline, as `ReplayResult.built` reports it. */
export interface BuiltStoryline {
  groupIds: readonly string[];
}

export interface JudgedVerdict extends JudgedStoryline {
  /** Groups of this set that the replay put in one storyline, at most. */
  together: number;
  /** `groupIds.length`, carried so a report needs nothing else. */
  size: number;
  /** The whole set landed in one replayed storyline. */
  intact: boolean;
  /** At least two of its groups share a storyline — for a decline, the pile. */
  formed: boolean;
}

export interface JudgedScore {
  n: number;
  /**
   * Sets whose groups still share a storyline. Read as "piles that formed" for
   * the declined set and "arcs that survive at all" for the named one.
   */
  formed: number;
  /** Sets the replay reassembled completely. */
  intact: number;
  /** Σ `together` and Σ `size`: coverage kept, weighted by arc length. */
  groupsTogether: number;
  groupsTotal: number;
  /** Per-set detail, largest set first — what a report prints. */
  verdicts: JudgedVerdict[];
}

/**
 * Where the replay put each group. Later entries win, which cannot happen for a
 * replay's own output — `built` partitions the groups — but a caller filtering
 * `built` should not get a silently wrong count either way.
 */
function homesOf(built: readonly BuiltStoryline[]): Map<string, number> {
  const home = new Map<string, number>();
  built.forEach((storyline, index) => {
    for (const groupId of storyline.groupIds) home.set(groupId, index);
  });
  return home;
}

/**
 * Score one judged set against what a replay built.
 *
 * Groups the replay never saw are skipped rather than counted as lost: a judged
 * storyline may reach back past the replay's window, and charging a setting for
 * a group it was never offered would make every window length look like a
 * different rule.
 */
export function scoreJudged(
  built: readonly BuiltStoryline[],
  judged: readonly JudgedStoryline[],
  knownGroup?: (groupId: string) => boolean,
): JudgedScore {
  const home = homesOf(built);
  const verdicts: JudgedVerdict[] = [];
  let formed = 0;
  let intact = 0;
  let groupsTogether = 0;
  let groupsTotal = 0;

  for (const storyline of judged) {
    const considered = knownGroup
      ? storyline.groupIds.filter((groupId) => knownGroup(groupId))
      : storyline.groupIds;
    if (considered.length < 2) continue;

    const perHome = new Map<number, number>();
    for (const groupId of considered) {
      const index = home.get(groupId);
      if (index === undefined) continue;
      perHome.set(index, (perHome.get(index) ?? 0) + 1);
    }
    const together = perHome.size === 0 ? 0 : Math.max(...perHome.values());

    const verdict: JudgedVerdict = {
      ...storyline,
      groupIds: considered,
      together,
      size: considered.length,
      intact: together === considered.length,
      formed: together >= 2,
    };
    verdicts.push(verdict);
    if (verdict.formed) formed += 1;
    if (verdict.intact) intact += 1;
    groupsTogether += together;
    groupsTotal += considered.length;
  }

  verdicts.sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1));
  return { n: verdicts.length, formed, intact, groupsTogether, groupsTotal, verdicts };
}

/**
 * `label_source` as a verdict.
 *
 * The column is provenance rather than a judgement — it answers "would a relabel
 * against the currently-configured model change this" — but the campaign gave it
 * a second, sharper meaning that this reads back: a model that was shown the
 * coverage and produced a name grounded in it CONSIDERED the storyline
 * nameable, and `bigram` on a storyline the campaign reached means it did not.
 *
 * Null is neither. Those storylines were never offered to a model, so they carry
 * no verdict and belong in no evaluation set — 776 of them sit at two groups in
 * the dev archive, and counting them as either side would be inventing data.
 */
export function judgedSetOf(labelSource: string | null): "declined" | "named" | null {
  if (labelSource === null) return null;
  if (labelSource === "bigram") return "declined";
  return "named";
}
