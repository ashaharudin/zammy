/**
 * The progressive-fill poll (§6.5) as pure functions: how long it stays on,
 * and what one response does to the pages a reader has loaded.
 *
 * §8.2 asks for "poll every ~1.5s while `meta.ingest.state === 'in_progress'`,
 * stopping on `complete` or when the 60s poll window closes" — a budget, so a
 * topic whose ingest never settles cannot poll a reader's browser forever.
 * §6.5 says that budget is spent in WALL-CLOCK TIME rather than in ticks, and
 * that is the whole reason this lives in a module of its own with a test.
 *
 * The counter it replaces was spent by RENDERS. TanStack calls a function-form
 * `refetchInterval` from `QueryObserver.setOptions`, which React calls on every
 * render of the component holding the query, and again from `onQueryUpdate` on
 * every state change of the query — so a `pollsUsed += 1` inside it counted
 * StrictMode's double render, the fetching→settled flip of each poll, and every
 * unrelated re-render of the page, none of which are polls. Forty of those are
 * reached in a few seconds, and the poll a reader is waiting on dies long
 * before the sixty seconds it was sized for.
 *
 * So the contract here is IDEMPOTENCE under repeated evaluation: asking twice
 * at the same instant must give the same answer and leave the same window.
 * Nothing but the clock closes it, which is what makes the budget mean the
 * thing §8.2 says it means.
 *
 * The poll no longer runs through `refetchInterval` at all — that spelling fans
 * a tick out across every loaded page, which is what `splicePolledPage` below
 * exists to stop — so `pollStep` is now asked once per tick by a `setTimeout`
 * chain. The contract stands anyway: it is what makes the budget a fact about
 * the clock rather than about its caller, and the next caller is not promised
 * to be as well behaved as this one.
 */

import type { InfiniteData } from "@tanstack/react-query";
import type { TimelineEntry, TimelinePage } from "@zammy/shared";

/**
 * The infinite query's cache entry, named so the splice below is a pure
 * function over it rather than a callback buried in a hook. The page param is
 * the opaque keyset cursor, absent for page one.
 */
export type LoadedTimeline = InfiniteData<TimelinePage, string | undefined>;

/** §8.2's ~1.5s cadence, fast enough that rows appear as jobs land. */
export const INGEST_POLL_INTERVAL_MS = 1500;

/**
 * How long a single in-progress stretch is polled for. Sixty seconds, which is
 * what the old tick budget was sized to mean (40 × 1.5s).
 *
 * It is deliberately far short of how long `meta.ingest.state` can stay
 * `in_progress` — an unsettled pending entry holds it for `STALE_PENDING_MS`,
 * fifteen minutes — because the poll is not how a reader gets the rest of the
 * store. Pages already in Postgres are reachable by paging (the rail's "Load
 * older", which is gated on `hasMore` ALONE for exactly this reason); the poll
 * only covers rows arriving while the reader watches.
 */
export const INGEST_POLL_WINDOW_MS = 60_000;

/** An open poll window, or the absence of one. */
export interface PollWindow {
  /** Epoch ms the current in-progress stretch opened at; null when closed. */
  readonly since: number | null;
}

export const pollClosed: PollWindow = { since: null };

export interface PollStep {
  /** The window to carry into the next evaluation. */
  readonly window: PollWindow;
  /** What to hand TanStack: a delay in ms, or false to stop polling. */
  readonly interval: number | false;
}

/**
 * The interval to poll at now, and the window that follows.
 *
 * `ingesting` is the newest loaded page's `meta.ingest.state === "in_progress"`.
 * A stretch that ends closes the window, so ingest starting again later — a
 * refresh-on-read top-up, say — gets a full budget rather than the remains of
 * the last one.
 */
export function pollStep(open: PollWindow, ingesting: boolean, now: number): PollStep {
  if (!ingesting) return { window: pollClosed, interval: false };
  const since = open.since ?? now;
  if (now - since >= INGEST_POLL_WINDOW_MS) {
    // Keep `since` rather than closing: closing here would re-open on the very
    // next evaluation and poll forever in 60s instalments.
    return { window: { since }, interval: false };
  }
  return { window: { since }, interval: INGEST_POLL_INTERVAL_MS };
}

/**
 * What one poll response does to the pages a reader has loaded.
 *
 * A poll asks for the FIRST page and nothing else, which is what §6.5 point 4
 * always said it did and what this function makes true. The obvious spelling —
 * TanStack's own `refetchInterval` on the infinite query — is a fan-out: v5
 * dropped per-page refetch filtering, so a non-directional fetch loops over
 * every loaded page and re-chains their cursors. On a long-lived server that is
 * nearly free; on Vercel each page is an invocation plus a Postgres round trip
 * through the pooler plus a Redis one, so a four-page rail pays four of each,
 * forty times over the poll window, for one reader on one topic.
 *
 * Three things make one response enough:
 *
 * **`meta` is a fact about the TOPIC, not about a page.** `ingest.state`,
 * `pendingJobs`, `stale`, `degraded`, `servedFrom`, `asOf` all describe the
 * request, so the polled response's `meta` is the freshest answer for every
 * loaded page and is written onto all of them. Without that the rail reads
 * `ingest.state` off `pages.at(-1)` — a snapshot from whenever the reader
 * paged — and the ingest animation never stops.
 *
 * **Page one keeps its window.** Its `nextCursor` is the boundary page two was
 * fetched from, so re-deriving it would leave the loaded tail hanging off a
 * cursor nobody asked with — a gap, or worse a slot drawn twice under one React
 * key. The polled items are trimmed to that window instead and the old
 * `page` block is carried over: the poll may refresh what is INSIDE page one,
 * never move where page one ends.
 *
 * **The tail is older rows, and progressive fill appends further back.** What
 * the poll exists to reveal lands past the tail, where paging reaches it —
 * which is why §8.2 gates "Load older" on `hasMore` alone. Re-fetching pages
 * two onward buys the reader nothing the next `fetchNextPage` will not.
 *
 * The cost of holding page one's window still: a slot whose `published` moves
 * EARLIER than the boundary — an older article landing in a day already on
 * screen — drops out of page one and is not in the loaded page two either, so
 * it is missing until a pull-to-refresh or a reload re-chains the cursors. One
 * slot, inside the ingest window, and the alternative is the fan-out.
 */
export function splicePolledPage(
  loaded: LoadedTimeline | undefined,
  polled: TimelinePage,
): LoadedTimeline | undefined {
  if (!loaded || loaded.pages.length === 0) return loaded;
  const [first, ...tail] = loaded.pages;
  // A one-page rail is the whole of the old behaviour: nothing to fan out to,
  // nothing to pin, so the response simply replaces what it refreshed.
  if (tail.length === 0) return { pages: [polled], pageParams: loaded.pageParams };
  return {
    pages: [trimToWindow(first!, polled), ...tail.map((page) => ({ ...page, meta: polled.meta }))],
    pageParams: loaded.pageParams,
  };
}

/**
 * The polled response as page one's window sees it.
 *
 * The boundary is page one's own last slot, which is exactly the tuple its
 * `nextCursor` encodes — `(published, storylineId)`, the keyset axis of §7.3 —
 * so this needs no cursor decoding and cannot drift from what the server did.
 * The cursor is exclusive for page two, so the boundary slot belongs to page
 * one and the comparison is inclusive.
 *
 * `memberships` and `storylines` come across whole rather than filtered to the
 * kept slots: both are merged across pages by the rail, so a spare entry for a
 * slot that fell out of the window is unread, not wrong.
 */
function trimToWindow(previous: TimelinePage, polled: TimelinePage): TimelinePage {
  const boundary = previous.items.at(-1);
  if (!boundary) return previous;
  const items = polled.items.filter((item) => !isOlder(item, boundary));
  // Every slot below the boundary would leave the rail headless. Keeping the
  // previous page one is stale; showing nothing above the tail is broken.
  if (items.length === 0) return previous;
  return { ...polled, items, page: previous.page };
}

/** `(published, storylineId)` descending — §7.3's keyset order, in the browser. */
function isOlder(item: TimelineEntry, boundary: TimelineEntry): boolean {
  const at = Date.parse(item.published);
  const edge = Date.parse(boundary.published);
  if (at !== edge) return at < edge;
  return item.storylineId < boundary.storylineId;
}
