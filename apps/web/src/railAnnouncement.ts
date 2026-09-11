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
 *    sentence even though `IngestGhosts` draws it, and this is the one decision
 *    here worth arguing with. It is a LIVE queue depth: `timeline-read.ts`
 *    recomputes it per request from `queue.pendingCount`, `splicePolledPage`
 *    copies the polled `meta` onto every loaded page, and the poll runs every
 *    1.5s for up to 60s (`ingestPoll.ts`). So a draining queue would mint a new
 *    distinct string roughly forty times per ingest window — and because
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
 * 6. **A SUCCESSFUL load resolves to silence, and that is a choice rather than
 *    an oversight.** The rail itself is the resolution: the cards are on the
 *    page, under day and segment headings, and a reader navigates to them. The
 *    obvious alternative — announcing a result count — was rejected because it
 *    does not stay still. Paging appends rows and the poll splices them, so a
 *    count would re-announce on every append, which is the storm point 3 exists
 *    to avoid, one loop further out.
 */
export function railAnnouncement(state: RailAnnouncementState): string {
  if (state.isPending) return "Loading the timeline.";
  if (state.ingesting) return "Gathering articles from upstream.";
  if (state.refreshing) return "Checking for new articles.";
  if (state.isError) return "The timeline could not be loaded.";
  if (state.isEmpty) return state.emptyMessage;
  return SILENT;
}
