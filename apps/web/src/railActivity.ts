import type { IngestState } from "@zammy/shared";

/**
 * What the rail's ingest animation is being told, derived from the timeline
 * query's flags and the newest response it holds.
 *
 * Its own module because it is the part of the animation that can be WRONG in a
 * way nothing would notice. `apps/web` has no renderer in its tests by design,
 * so a gate left inline in `TimelinePage` is guarded by nothing: flipping
 * `!isFetchingNextPage` to `true` there passes every test in the package. Here
 * it is a pure function over four booleans and one wire field, and the table in
 * `railActivity.test.ts` is what a change to it has to get past.
 */

export interface TimelineFetchState {
  /** No response yet for this topic — the first paint, not a refresh. */
  isPending: boolean;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  /**
   * Always false today: `useTimeline` sets no `getPreviousPageParam` and nothing
   * calls `fetchPreviousPage`. Taken anyway so the exclusion of PAGING is
   * complete rather than complete-in-the-only-direction-that-exists — backward
   * paging would raise `isFetching` exactly like forward paging does, and the
   * reasoning that keeps one out is the reasoning that keeps the other out.
   */
  isFetchingPreviousPage: boolean;
  /** `meta.ingest.state` off the newest loaded page; undefined before one. */
  ingestState: IngestState | undefined;
}

export interface RailActivity {
  /** Upstream work is outstanding for this topic: the head AND the ghost slots. */
  ingesting: boolean;
  /**
   * A fetch of what is already here, rather than upstream still arriving: the
   * head alone.
   */
  refreshing: boolean;
}

/**
 * `refreshing` is every fetch a reader has no other way to see — the refetch a
 * remount of an already-loaded topic runs, the one a pull fires, the one
 * `refetchOnReconnect` fires when the network comes back, and `ErrorState`'s
 * retry over data that is still on screen. All four keep every card in place on
 * purpose (ARCHITECTURE §8.2), so without a mark of their own the rail is
 * indistinguishable from one that is idle.
 *
 * Three things are deliberately NOT `refreshing`:
 *
 * - **The first paint** (`isPending`). There is no rail to mark yet, and
 *   `TimelinePage` renders the skeleton instead.
 * - **Paging**, in either direction. It raises the same `isFetching`, but its
 *   rows land at the TAIL, where "Load older" already says so, and the head of
 *   the animation sits at the top — lighting it would describe the wrong end.
 * - **The ingest poll**, which is not a fetch of this query at all: it calls
 *   `fetchTimeline` itself and writes through `setQueryData` (`ingestPoll.ts`),
 *   and `setQueryData` never touches `fetchStatus`. So through the whole poll
 *   window `isFetching` stays false and the head is lit by `ingesting` alone —
 *   which is the correct source, since that is the state the poll is watching.
 */
export function railActivity(state: TimelineFetchState): RailActivity {
  return {
    ingesting: state.ingestState === "in_progress",
    refreshing:
      state.isFetching &&
      !state.isPending &&
      !state.isFetchingNextPage &&
      !state.isFetchingPreviousPage,
  };
}
