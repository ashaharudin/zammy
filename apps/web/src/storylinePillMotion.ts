import type { StorylineSummary } from "@zammy/shared";

/**
 * The order the surfacing pills are drawn in, and the little state machine that
 * carries the row from one search's set of pills to the next (StorylinePills).
 *
 * Pure, and a module of its own for the reason `articleEnter` is one: `apps/web`
 * has no renderer in its tests, so a reorder rule, a transition, or the shape of
 * a path left inline in the component is guarded by nothing. The fades are
 * `index.css`'s (`.storyline-pill-enter` / `.storyline-pill-exit`) and the
 * measuring is the component's; what is here is which pill is drawn where, which
 * of them is arriving, resting or leaving, and the arc a moving one travels.
 */

/**
 * Biggest storyline first.
 *
 * The API picks WHICH storylines a search surfaces by recency — most recently
 * covered first, capped at eight (`SURFACED_STORYLINE_LIMIT`) — and that
 * selection is left alone: it is what keeps today's news in the row. This is
 * the ARRANGEMENT of the ones that made it, and the reader's question of a row
 * of pills is "which of these is the big story", which size answers and arrival
 * order does not.
 *
 * `size` is the storyline's articles over its whole life, not this search's
 * share of them (see `StorylineSummary.size`) — a pill is an offer to open a
 * story, so its weight is the story's, not the query's.
 *
 * The sort is STABLE and that is load-bearing rather than incidental: two
 * storylines of the same size keep the order the API sent them in, which is
 * recency. So the row reads as size first, recency second, and equal-sized
 * pills do not shuffle between two polls of the same search.
 */
export function orderStorylinePills(
  storylines: readonly StorylineSummary[],
): readonly StorylineSummary[] {
  return [...storylines].sort((left, right) => right.size - left.size);
}

/** One pill on screen, and what it is doing. */
export type PillSlot = {
  readonly storyline: StorylineSummary;
  /** Fading out. Holds its place in the row until the fade is over. */
  readonly leaving: boolean;
  /**
   * Fading in — it was not in the row the previous response left behind.
   *
   * Stays true for as long as the pill is drawn, rather than being cleared a
   * beat later. The fade is a CSS animation that runs once on the class
   * arriving; taking the class away again — which the next progressive-fill
   * page would do — only snaps a pill that is still fading.
   */
  readonly entering: boolean;
};

/**
 * The row's state: the pills drawn, plus the set waiting on a fade-out.
 *
 * `pending` is what makes the transition two-beat rather than one. A search
 * that replaces the row wholesale would otherwise fade the old pills out, slide
 * the survivors, and fade the new ones in all at once, over the top of each
 * other. Instead the leavers go first, holding their slots so nothing moves
 * under them; then — one `exitedPills` later — the survivors slide to their new
 * places and the arrivals fade in.
 */
export type PillRow = {
  readonly slots: readonly PillSlot[];
  readonly pending: readonly StorylineSummary[] | null;
};

export const EMPTY_PILL_ROW: PillRow = { slots: [], pending: null };

/** How long a leaving pill fades for, and holds its slot. Matches `index.css`. */
export const PILL_EXIT_MS = 180;

/** How long a surviving pill takes to reach its new place. */
export const PILL_MOVE_MS = 300;

/**
 * The path a pill takes to its new place: a straight SLIDE.
 *
 * `dx`/`dy` are FLIP deltas — where the pill WAS, relative to where it now is —
 * so the path starts displaced and ends at `none`, its own resting place. Two
 * keyframes, and the browser draws the line between them.
 *
 * It used to bubble: rise out of the row, swell, travel over its neighbours and
 * settle back, so that two pills swapping places on a new search were seen to
 * pass around each other. The view's row now changes one pill at a time — a
 * taken pill leaves, the rest close ranks, a newcomer fades in at the end
 * (ADR-0028) — and on that motion the bow read as the whole row jumping every
 * time a chip was added to the prompt. A slide says "closed ranks" and nothing
 * more, which is all that happened. The reorder-on-search case lost a little
 * legibility and kept its direction: a pill still visibly travels left or
 * right to its new place.
 */
export function pillMoveKeyframes(dx: number, dy: number): Keyframe[] {
  return [
    { offset: 0, transform: `translate(${round(dx)}px, ${round(dy)}px)` },
    { offset: 1, transform: "none" },
  ];
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * The row a new response asks for.
 *
 * Returns the SAME row when nothing about it changed, which is what lets the
 * component derive this during render: a re-render that hands over an equal set
 * — a progressive-fill page, a poll of the same search — must not produce a new
 * state object, or the derivation feeds itself.
 */
export function receivePills(row: PillRow, storylines: readonly StorylineSummary[]): PillRow {
  const target = orderStorylinePills(storylines);
  const staying = new Set(target.map((storyline) => storyline.id));
  const leaving = row.slots.filter((slot) => !staying.has(slot.storyline.id));

  if (leaving.length > 0) {
    // Beat one: the leavers fade where they stand. The order is deliberately
    // left alone — reordering under a fade is the collision this exists to
    // avoid — and the arrivals wait in `pending`.
    const slots = row.slots.map((slot) => {
      const stays = staying.has(slot.storyline.id);
      // A pill can be reprieved: the reader searches again inside the fade and
      // this storyline matches once more. It stops leaving rather than
      // finishing a fade it is no longer doing.
      if (stays) return slot.leaving ? { ...slot, leaving: false } : slot;
      return slot.leaving ? slot : { ...slot, leaving: true, entering: false };
    });
    return { slots, pending: target };
  }

  // Beat two, or a response that only ever added: the row is the target, and
  // anything the previous row did not hold is arriving. A pill the row already
  // held keeps its own slot object where the response left it untouched, so an
  // equal response is an equal row (see the identity note above).
  const held = new Map(row.slots.map((slot) => [slot.storyline.id, slot] as const));
  const slots = target.map((storyline) => {
    const previous = held.get(storyline.id);
    if (!previous) return { storyline, leaving: false, entering: true };
    if (previous.storyline === storyline && !previous.leaving) return previous;
    return { storyline, leaving: false, entering: previous.entering };
  });
  if (row.pending === null && sameSlots(row.slots, slots)) return row;
  return { slots, pending: null };
}

/**
 * The row once the fade-out has finished: the leavers are dropped and the set
 * that was waiting on them takes effect.
 */
export function exitedPills(row: PillRow): PillRow {
  if (row.pending === null) return row;
  const kept = row.slots.filter((slot) => !slot.leaving);
  return receivePills({ slots: kept, pending: null }, row.pending);
}

function sameSlots(left: readonly PillSlot[], right: readonly PillSlot[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((slot, index) => {
    const other = right[index]!;
    return (
      slot.storyline === other.storyline &&
      slot.leaving === other.leaving &&
      slot.entering === other.entering
    );
  });
}
