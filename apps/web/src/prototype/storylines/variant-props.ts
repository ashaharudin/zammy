import type { MockSlot, MockStoryline } from "./mock-data.js";

/**
 * PROTOTYPE (S8) — what the host hands every variant. The QUESTION each variant
 * answers differently: given `surfaced`, where on the page do matched
 * storylines appear, and what does the reader click?
 */
export interface VariantProps {
  query: string;
  /** Slots the search matched, newest first — or the storyline's own days. */
  slots: MockSlot[];
  /** Storylines this search surfaced (keywords ⊆ profile tokens). */
  surfaced: MockStoryline[];
  /** Non-null in the storyline view. */
  viewing: MockStoryline | null;
  onQueryChange: (q: string) => void;
  onOpenStoryline: (storylineId: string) => void;
  onDismissView: () => void;
}
