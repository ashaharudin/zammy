import { groupStorylines, type StorylineSummary, type TimelinePage } from "@zammy/shared";
import { storylineQualifiers } from "./storylineLabels.js";

/**
 * Reading a page's `memberships` (ADR-0025): which OTHER storylines the piece
 * on a row is also running in.
 *
 * Pure and separate from the rail, for the reason `storylineLabels.ts` is: the
 * rules here are easy to get subtly wrong — an arc named twice, a crossing
 * pointing at the arc you are already in, a tick with nothing to open — and
 * none of those go wrong visibly in a screenshot.
 */

/**
 * Every loaded page's memberships as one.
 *
 * The rail holds an INFINITE query: `items` is every page's slots flattened, so
 * a slot from page one must still find its group's arcs after page four has
 * arrived. The directory becomes a Map on the way through, since every read of
 * it is by id.
 *
 * Later pages win a collision, and it does not matter which way that goes: the
 * two entries are the same storyline read a few seconds apart, differing at
 * most in a size that has grown.
 */
export interface PageMemberships {
  byGroup: Record<string, string[]>;
  storylines: Map<string, StorylineSummary>;
}

export function mergeMemberships(
  pages: readonly Pick<TimelinePage, "memberships">[],
): PageMemberships {
  const byGroup: Record<string, string[]> = {};
  const storylines = new Map<string, StorylineSummary>();
  for (const page of pages) {
    Object.assign(byGroup, page.memberships.byGroup);
    for (const storyline of page.memberships.storylines) storylines.set(storyline.id, storyline);
  }
  return { byGroup, storylines };
}

/**
 * Everything one ROW needs to say where else its piece is running: the ticks to
 * draw, the arcs to list, and the date qualifiers that tell two same-labelled
 * arcs apart.
 *
 * One call rather than three, because the three have to agree. The qualifier
 * set in particular is easy to get wrong from outside: "does this label need a
 * date" is a question about the SET being shown (`storylineLabels.ts`), and the
 * set here is the row's OWN arc plus its crossings — not the page, and not the
 * crossings alone. Two storylines both labelled "Fort Hood Crash" are told
 * apart only if the one in the gutter is counted in.
 *
 * `ticks` empty is the whole "costs nothing at rest" claim: most rows cross
 * nothing, and those rows draw the marker the rail has always drawn.
 */
export interface RowMembership {
  /** Every arc this row's group is in that the page can name, current marked. */
  ticks: ArcTick[];
  /** The crossings alone — what the popover lists and its header counts. */
  others: StorylineSummary[];
  /** Storyline id → the date that separates it from its namesakes in THIS list. */
  qualifiers: Map<string, string>;
}

export interface ArcTick {
  id: string;
  current: boolean;
}

export function rowMembership(
  memberships: PageMemberships,
  groupId: string,
  readUnder: string,
): RowMembership {
  const own = memberships.storylines.get(readUnder);
  const others = crossingsOf(memberships, groupId, readUnder);
  // No solid tick, no ticks: a glyph that names several arcs and points at none
  // is the one thing `Braid`'s solid mark exists to prevent. `own` is missing
  // only when the row is read under an arc the directory does not describe,
  // which the wire contract says cannot happen and this does not rely on.
  if (others.length === 0 || own === undefined) {
    return { ticks: [], others: [], qualifiers: new Map() };
  }
  return {
    ticks: byRecency([own, ...others]).map((arc) => ({ id: arc.id, current: arc.id === own.id })),
    others,
    qualifiers: storylineQualifiers([own, ...others]),
  };
}

/**
 * The arcs a row's group runs in BESIDES the one it is being read under.
 *
 * Three things are dropped, and each of them would otherwise put a tick on
 * screen that opens nothing worth arriving at:
 *
 *  - the arc it is READ UNDER, which the gutter beside the row already names
 *    and already opens. Not a claim that arc is primary — there is no such
 *    thing (ADR-0025) — but that a list repeating the row it hangs off would be
 *    disagreeing with it.
 *  - an arc the page's directory cannot describe. The wire promises it can, so
 *    this is a floor rather than an expectation.
 *  - an UNLABELLED arc. The wire carries it deliberately, because it may be the
 *    arc a row is read under and dropping it there would take the row's own
 *    tick away — but as a DESTINATION there is nothing to offer: the gutter
 *    renders a label-less storyline as an empty gutter, and this is not the
 *    place to start calling one "unlabelled storyline" (S8's eight pills).
 */
function crossingsOf(
  memberships: PageMemberships,
  groupId: string,
  readUnder: string,
): StorylineSummary[] {
  const all = groupStorylines(memberships, groupId, readUnder);
  // The row is read under an arc its own group is not filed in — a slot in a
  // provisional storyline whose group has since joined two real ones. Nothing
  // here is about that arc, so nothing here is worth showing beside it.
  if (!all.includes(readUnder)) return [];
  return byRecency(
    all.flatMap((id) => {
      if (id === readUnder) return [];
      const storyline = memberships.storylines.get(id);
      return storyline && storyline.label !== null ? [storyline] : [];
    }),
  );
}

/**
 * Newest arc first, by the last day it covered.
 *
 * Stability is the whole requirement — the ticks and the list they open must
 * agree, render to render — and NOT a ranking. `size` or `from` would have made
 * an equally arbitrary order look like a judgement about which arc matters,
 * which is the one thing this feature may not say (ADR-0025).
 */
function byRecency(arcs: readonly StorylineSummary[]): StorylineSummary[] {
  return arcs
    .slice()
    .sort((a, b) => (a.to === b.to ? a.id.localeCompare(b.id) : b.to.localeCompare(a.to)));
}
