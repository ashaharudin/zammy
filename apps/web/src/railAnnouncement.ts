import type { RailActivity } from "./railActivity.js";

/**
 * What the rail says OUT LOUD — the one sr-only sentence a screen reader is
 * given for whatever the rail is currently doing.
 *
 * Its own module for the reason `railActivity` is: `apps/web` has no renderer in
 * its tests, so a sentence assembled inline in `TimelinePage` is guarded by
 * nothing, and this one is assembled from five values with a precedence order
 * between them. Here it is a pure function and the table in
 * `railAnnouncement.test.ts` is what a change to it has to get past.
 *
 * This replaces two components that each rendered their own
 * `<p className="sr-only" role="status" aria-live="polite">` — `SkeletonRail`'s
 * and `IngestStatus`'s. Collapsing them into one string is not a tidy-up: it is
 * the fix. See `RailAnnouncer` in `TimelinePage.tsx` for why a live region that
 * is BORN holding its message announces nothing.
 */
export interface RailAnnouncementState extends RailActivity {
  /** No response yet for this topic — the first paint, not a refresh. */
  isPending: boolean;
  /** The query is in its error state, with or without stale data behind it. */
  isError: boolean;
  /**
   * A page has been read for this topic, so there is a rail on screen whatever
   * else is true. It is what separates a load that FAILED from an update that
   * failed over a timeline the reader is looking at, and `query-core`'s reducer
   * is why the difference has to be drawn here: it sets `status: "error"`
   * unconditionally, background errors over live data included, so `isError`
   * alone cannot tell the two apart.
   */
  hasLoaded: boolean;
  /** Settled with nothing to show: `ErrorState`'s sibling, not its cousin. */
  isEmpty: boolean;
  /**
   * The words the empty state is DISPLAYING, read only under `isEmpty`.
   *
   * Passed in rather than rebuilt here because there must be exactly one
   * definition of it: announcing "no articles yet" while the screen says
   * "nothing here yet" is the kind of drift this repo counts as a defect, and
   * the two are decided by `terminal`, which lives in `TimelinePage`.
   */
  emptyMessage: string;
}

/** Nothing to say. An empty region is silent; it is not an announcement of silence. */
export const SILENT = "";

/**
 * The id of the empty live region `apps/web/index.html` carries in the
 * document's original markup, which `RailAnnouncer` portals the sentence into.
 *
 * Exported from HERE, a module with no JSX in it, so that `TimelinePage` and
 * `railAnnouncer.test.ts` can share one spelling without a node test having to
 * import a React component. Sharing it is the whole point: while each held its
 * own copy of the string, renaming this one in `TimelinePage` alone silenced
 * every announcement in the application with the types checking and all 214
 * tests green — which is precisely the failure `railAnnouncer.test.ts` exists to
 * catch, and it could not catch it, because it was checking `index.html`
 * against itself rather than against the code that reads it.
 */
export const RAIL_STATUS_ID = "rail-status";

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
 *    This clause is the ONLY source of that sentence — under `isPending` there
 *    is no `latest`, so `ingesting` is false too and every other clause would
 *    fall through to silence. What is merely belt-and-braces is its ORDERING
 *    against `refreshing`, which `railActivity` already forces false here.
 *
 * 2. **Work in flight outranks the outcome of the last attempt.** `ingesting`
 *    and `refreshing` come before `isError` so that a retry over an error
 *    banner says so: the reader pressed the button, and repeating the error
 *    text would be no change to the region and therefore no announcement at
 *    all. When the retry fails, the error sentence returns — a change, so it is
 *    heard — and when it succeeds the rail speaks for itself.
 *
 * 3. **NO COUNT.** `pendingJobs` is deliberately absent from the spoken
 *    sentence, and this is the one decision here worth arguing with. Note that
 *    nothing else DRAWS it either — `IngestGhosts` clamps it to one-to-four
 *    ghost slots, a SHAPE saying work is outstanding rather than a plot of the
 *    queue — so no number ever reached a sighted reader. It did reach a screen
 *    reader, though: the `IngestStatus` line this replaced printed it, and that
 *    region stayed mounted, so a count that moved was announced. Removing it
 *    takes something away from exactly one audience, which is why the reasoning
 *    below is about that audience's cost rather than about parity. It is a LIVE
 *    queue depth: `timeline-read.ts`
 *    recomputes it per request from `queue.pendingCount`, `splicePolledPage`
 *    copies the polled `meta` onto every loaded page, and the poll runs every
 *    1.5s for up to 60s (`ingestPoll.ts`). So a draining queue would mint a new
 *    string once per distinct depth it passes through, up to the window's forty
 *    ticks — the measured stub walked 5, 4, 3 — and because
 *    `role="status"` implies `aria-atomic="true"`, each one re-reads the WHOLE
 *    sentence rather than the digits that changed. A polite live region is a
 *    notification channel, not a readout; forty serialised re-reads of a
 *    seven-word sentence would bury everything else the reader is trying to do.
 *    Without the count the sentence is stable for the whole episode, so ingest
 *    announces exactly once.
 *
 *    The alternative was latching the count at the rising edge of `ingesting`
 *    and speaking that snapshot — one announcement, still carrying a number.
 *    Rejected because the number is worth less than the machinery: it is a
 *    queue depth rather than a count of articles or an estimate of time, it is
 *    frequently 0 for a reader who lost the single-flight lock and is watching
 *    a peer's ingest (§12), and latching it means state that has to survive
 *    StrictMode's double-invoke and concurrent re-renders to stay honest.
 *
 * 4. **A refetch with no count of its own** is "checking", not "gathering":
 *    §6.4 has a stale read enqueueing a top-up, so "this queues nothing" would
 *    be false, but nothing has told it a number yet either.
 *
 * 5. **The error and the empty rail resolve the promise the first paint made.**
 *    Both render a message on screen and neither used to be announced. That was
 *    survivable while the view was silent throughout; it is not once "Loading
 *    the timeline" is actually heard, because a reader who is told a load began
 *    and then told nothing is left waiting on a screen that has already
 *    finished — and in the error case, waiting beside a retry button they have
 *    no reason to go looking for.
 *
 *    The error speaks in two spellings because `isError` covers two different
 *    events. With no page read, the load failed and there is nothing there.
 *    With one read, the timeline is ON SCREEN and what failed is an attempt to
 *    move it — a pull, a reconnect, or a "Load older" whose rows never came
 *    (paging is excluded from `refreshing` deliberately, so its failure is the
 *    only thing about it this region ever says). Announcing "could not be
 *    loaded" over a rail full of cards would describe the opposite of what the
 *    reader has in front of them.
 *
 * 6. **A SUCCESSFUL load resolves to silence, and that is a choice rather than
 *    an oversight.** It is the weakest clause here, so the argument is worth
 *    stating in full. The rail itself is the resolution: unlike the error and
 *    the empty rail, which leave a static sentence and nothing to move through,
 *    a loaded rail puts navigable content on the page — day headings, segment
 *    headings, card links — and the reader's next keystroke lands in it.
 *
 *    Two alternatives were weighed. A result COUNT does not stay still: paging
 *    appends rows and the poll splices them, so it would re-announce on every
 *    append, which is point 3's storm one loop further out. A countless
 *    sentence ("the timeline is up to date") survives that objection, and was
 *    rejected on a different one — it never leaves. SILENT empties the region,
 *    so the steady state of every page is an empty node; a success sentence
 *    would make the steady state a stray sr-only paragraph that every reader
 *    meets in browse mode, on every topic, forever, saying something no longer
 *    news. That cost is paid continuously and the benefit is paid once.
 *
 *    KNOWN GAP, not covered by the argument above: the "N new articles" pill.
 *    Held arrivals (§6.5) are the one thing the rail does NOT put on the page —
 *    they sit behind a button, so "navigate to the content" is not available,
 *    and nothing here announces that the button appeared. A stable sentence
 *    gated on `newCount > 0` would close it; a sentence carrying N would not,
 *    since N climbs with every arrival and that is the storm again.
 */
export function railAnnouncement(state: RailAnnouncementState): string {
  if (state.isPending) return "Loading the timeline.";
  if (state.ingesting) return "Gathering articles from upstream.";
  if (state.refreshing) return "Checking for new articles.";
  if (state.isError) {
    return state.hasLoaded
      ? "The timeline could not be updated."
      : "The timeline could not be loaded.";
  }
  if (state.isEmpty) return state.emptyMessage;
  return SILENT;
}
