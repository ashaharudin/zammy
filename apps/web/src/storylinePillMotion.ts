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
 * How far out of the row a moving pill bows on its way. Enough to read as a
 * pill rising past its neighbours rather than sliding through them, and not so
 * far that it leaves the chrome it belongs to.
 */
export const PILL_ARC_PX = 8;

/**
 * The path a pill takes to its new place: it BUBBLES there.
 *
 * A straight line between two slots is the cheapest reading of a reorder and
 * the least legible one — two pills swapping places pass through each other and
 * the row reads as a shuffle. A pill moving UP the order (earlier in the row,
 * or up a wrapped line) rises out of the row, travels, and settles back into
 * it; a pill moving DOWN sinks below it and comes back up. The direction of the
 * bow is the whole message: the reader sees which way each pill went, not just
 * that the row is different now.
 *
 * `dx`/`dy` are FLIP deltas — where the pill WAS, relative to where it now is —
 * so the path starts displaced and ends at `none`, its own resting place. The
 * bow is a parabola (`4t(1-t)`, zero at both ends, one in the middle) sampled
 * at quarters, because a single mid keyframe interpolates as a triangle and a
 * pill with a corner in its trajectory reads as a glitch rather than a rise.
 *
 * The rising pill also swells a little and the sinking one shrinks, by the same
 * parabola: nearer and further, which is what makes it a bubble rather than a
 * detour. The riser is lifted over its neighbours for the trip, too — a flex
 * item honours `z-index`, and without it the pill would pass BEHIND the ones it
 * overtakes, since after the commit it is already the earlier sibling. Rising
 * in front and sinking behind is the whole of what "up" and "down" mean in a
 * row that has no third dimension.
 */
export function pillMoveKeyframes(dx: number, dy: number): Keyframe[] {
  // Up a wrapped line is unambiguous; along one line, leftward is earlier.
  // The sub-pixel band is the same one the caller uses to decide a pill moved
  // at all, so a pill that only shifted sideways is never called a riser by a
  // fraction of a pixel of vertical noise.
  const rising = dy > 1 || (Math.abs(dy) <= 1 && dx > 0);
  const arc = rising ? -PILL_ARC_PX : PILL_ARC_PX;
  const swell = rising ? 0.04 : -0.03;

  // Held for the whole trip rather than only over the peak: z-index is not
  // interpolated, and a pill that changed depth halfway would flicker.
  const lift = rising ? { zIndex: "1" } : {};

  return [0, 0.25, 0.5, 0.75, 1].map((offset) => {
    if (offset === 1) return { ...lift, offset, transform: "none" };
    const remaining = 1 - offset;
    const bow = 4 * offset * (1 - offset);
    const x = round(dx * remaining);
    const y = round(dy * remaining + bow * arc);
    return {
      ...lift,
      offset,
      transform: `translate(${x}px, ${y}px) scale(${round(1 + bow * swell)})`,
    };
  });
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
