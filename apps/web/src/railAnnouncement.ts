import type { RailActivity } from "./railActivity.js";

/**
 * What the rail says OUT LOUD — the one sr-only sentence a screen reader is
 * given for whatever the rail is currently doing.
 *
 * Its own module for the reason `railActivity` is: `apps/web` has no renderer in
 * its tests, so a sentence assembled inline in `TimelinePage` is guarded by
 * nothing, and this one is assembled from four values with a precedence order
 * between them. Here it is a pure function and the table in
 * `railAnnouncement.test.ts` is what a change to it has to get past.
 *
 * This replaces two separate components that each rendered their own
 * `<p className="sr-only" role="status" aria-live="polite">` — `SkeletonRail`'s
 * and `IngestStatus`'s. Collapsing them into one string is not a tidy-up: it is
 * the fix. See `RailAnnouncer` in `TimelinePage.tsx` for why a live region that
 * is BORN holding its message announces nothing at all.
 */
export interface RailAnnouncementState extends RailActivity {
  /** No response yet for this topic — the first paint, not a refresh. */
  isPending: boolean;
  /**
   * `meta.ingest.pendingJobs` off the newest loaded page, or 0 before one.
   *
   * Read ONLY when `ingesting` is true. A count that arrived with a response
   * saying `complete` describes a queue that has already drained, and a
   * `refreshing` rail has no fresh count at all — §6.4 has a stale read
   * enqueueing a top-up, but the response that says how much has not come back
   * yet. Both are why the caller may pass a stale number here without it
   * reaching the reader.
   */
  pendingJobs: number;
}

/** Nothing to say. An empty region is silent; it is not an announcement of silence. */
export const SILENT = "";

/**
 * Precedence, and why it is this way round:
 *
 * 1. **The first paint wins.** `isPending` means no response has been read, so
 *    there is no `meta.ingest` to speak for and no rail on screen to describe —
 *    `TimelinePage` is drawing `SkeletonRail`. The sentence is "Loading the
 *    timeline" and deliberately NOT "gathering articles from upstream", which
 *    would assert an ingest the server may have already said is false: steps 1
 *    and 2 of §6.3 serve a cache or a covered, fresh window with no upstream
 *    call, and the storyline view answers `complete` / `pendingJobs: 0`
 *    unconditionally because it never fetches (ARCHITECTURE §8.1, States).
 *    `railActivity` already forces `refreshing` false under `isPending`, so this
 *    clause is belt-and-braces rather than load-bearing — but the order is what
 *    records which fact outranks which, so it is written down rather than
 *    inferred from a flag another module happens to set.
 *
 * 2. **A known queue beats an unknown one.** `ingesting` with a count is the
 *    only state that can say how much is coming.
 *
 * 3. **Zero pending jobs under `ingesting` is NOT a contradiction**, so it drops
 *    the clause rather than printing "0 jobs pending". A reader who loses the
 *    single-flight lock reads a peer's fetch as their own `in_progress` and
 *    queues nothing of their own (`coverage-fill.ts`, `lockLostToPeer` — §12's
 *    invariant that a reader never queues on someone else's ingest). Printing
 *    the zero would contradict both the animation and the single ghost slot
 *    `IngestGhosts` floors that count at.
 *
 * 4. **A refetch with no count of its own** is "checking", not "gathering":
 *    §6.4 has a stale read enqueueing a top-up, so "this queues nothing" would
 *    be false, but nothing has told it a number yet either.
 *
 * 5. **Otherwise silence.** A settled rail says nothing, and — because the
 *    region is now persistent and React writes the DOM only when the string
 *    actually changes — a rail that stays settled goes on saying nothing rather
 *    than re-announcing itself. That is the second half of the bug this module
 *    was written for: the old `IngestStatus` lived inside `Rail`, so moving from
 *    a populated topic to an empty one unmounted one node and mounted another
 *    carrying the same words, which reads to a screen reader as fresh news.
 */
export function railAnnouncement(state: RailAnnouncementState): string {
  if (state.isPending) return "Loading the timeline.";
  if (state.ingesting) {
    return state.pendingJobs === 0
      ? "Gathering articles from upstream."
      : `Gathering articles from upstream — ${state.pendingJobs} job${
          state.pendingJobs === 1 ? "" : "s"
        } pending.`;
  }
  if (state.refreshing) return "Checking for new articles.";
  return SILENT;
}
