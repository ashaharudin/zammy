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
 * **A response answers for the TOPIC as well as for its page, and the two
 * halves travel differently.** `meta`, `storylines` and `topic` are facts about
 * the REQUEST: the server builds `meta` from the queue and the fill, and both
 * `storylines` and `topic` from the query's keywords alone — `findSurfacedStorylines`
 * never looks at the page's slots (`apps/api/src/timeline-read.ts`). So the
 * polled response is the freshest answer for all of them on every loaded page,
 * and `topicFacts` writes them onto all of them. `items`, `page` and
 * `memberships` are the page's own — `memberships` is read over that page's
 * groups specifically — so those are never carried ACROSS pages. Page one takes
 * the polled response's own three, of course: its rows were just refreshed, so
 * its memberships were too. Get the line wrong in either direction and
 * something goes quietly stale: the rail reads `ingest.state`, the
 * surfaced-storyline pills and the topic's coverage off `pages.at(-1)`, which
 * without this is a snapshot from whenever the reader paged — so the ingest
 * animation never stops and a storyline promoted mid-fill never surfaces.
 *
 * The storyline view never reaches any of this, and not by anything here:
 * `readStorylineView` builds its `storylines` from the page rather than the
 * query, which would put it on the wrong side of the line — but it also answers
 * `ingest.state: "complete"` always, so the poll never starts there.
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

  // The boundary is page one's own last slot, which is exactly the tuple its
  // `nextCursor` encodes — `(published, storylineId)`, the keyset axis of §7.3 —
  // so this needs no cursor decoding and cannot drift from what the server did.
  // It is also why `decodeCursor` is not called here: it is `Buffer`-based and
  // does not run in a browser.
  //
  // Its absence is unreachable rather than handled: a page one with no items
  // carries no `nextCursor`, so there was nothing to fetch a page two with and
  // `tail` is empty above. A cache that manages it anyway is left alone rather
  // than guessed at.
  const boundary = first!.items.at(-1);
  if (!boundary) return loaded;

  // Inclusive: the cursor is exclusive for page TWO, so the boundary slot is
  // page one's. Every slot below it belongs to a page already loaded.
  const kept = polled.items.filter((item) => !isOlder(item, boundary));
  return {
    pages: [
      // Every slot below the boundary would leave the rail headless, so page
      // one's rows stay as they were — but the topic facts still travel, since
      // they are the freshest answer whatever happened to the rows.
      kept.length === 0
        ? { ...first!, ...topicFacts(polled) }
        : { ...polled, items: kept, page: first!.page },
      ...tail.map((page) => ({ ...page, ...topicFacts(polled) })),
    ],
    pageParams: loaded.pageParams,
  };
}

/**
 * The parts of a response that answer for the topic rather than for the page,
 * and so are true of every loaded page the moment this one lands.
 *
 * Named rather than spread inline because the LINE is the point: adding a field
 * to `TimelinePage` means deciding which side of it the field falls on, and a
 * wrong answer here is invisible — the rail renders, it just renders something
 * from minutes ago.
 */
function topicFacts(polled: TimelinePage): Pick<TimelinePage, "meta" | "storylines" | "topic"> {
  return { meta: polled.meta, storylines: polled.storylines, topic: polled.topic };
}

/** `(published, storylineId)` descending — §7.3's keyset order, in the browser. */
function isOlder(item: TimelineEntry, boundary: TimelineEntry): boolean {
  const at = Date.parse(item.published);
  const edge = Date.parse(boundary.published);
  if (at !== edge) return at < edge;
  return item.storylineId < boundary.storylineId;
}

/** What the poll needs from the world, so a test can be the world. */
export interface PollDeps {
  /** Fetch page one. The signal is aborted when the poll stops. */
  readonly fetchFirstPage: (signal: AbortSignal) => Promise<TimelinePage>;
  /** Hand a response to the cache. Called once per successful tick. */
  readonly write: (polled: TimelinePage) => void;
  /** Whether the reader can see the page; a hidden tab is not asked for. */
  readonly isVisible: () => boolean;
}

/**
 * The poll loop itself, out here rather than inside the effect that starts it.
 *
 * It lives in this module because it is the part worth testing and the part a
 * React hook makes untestable: a `setTimeout` chain, an `AbortController` and a
 * teardown inside `useEffect` are reachable only through a renderer, and this
 * package has no renderer in its tests by choice — every other module here is
 * pure and tested directly. Leaving the loop in the hook meant a mutant that
 * removed BOTH the abort guard and the whole teardown — leaking a timer chain
 * on every topic switch and polling forever — passed the entire suite. It does
 * not now.
 *
 * Call it when a response says ingest is in progress; call the returned `stop`
 * when that stops being true, when the topic changes, or on unmount. `stop` is
 * idempotent, aborts the request in flight, and cancels the tick that was
 * pending — after it returns, nothing further is fetched or written.
 *
 * The first fetch is one interval away rather than immediate: the response that
 * said "in_progress" is the one on screen, and asking again in the same breath
 * would be asking the server what it just said.
 *
 * A tick that throws is swallowed on purpose. A poll that fails leaves the rail
 * exactly as it was, which is the state the reader was already looking at —
 * never an error banner over content that is fine. The next tick asks again and
 * the window is what ends it.
 *
 * **A hidden tab is not asked for, and the clock runs anyway.** This came free
 * from `refetchInterval`, which fires only when
 * `refetchIntervalInBackground || focusManager.isFocused()` and never had the
 * flag set — so a backgrounded reader cost NOTHING, and a poll on a timer of
 * its own that did not inherit the gate would have taken that zero to forty:
 * a regression in the exact currency this change exists to spend less of, and
 * one that would have shipped looking like a saving. The tick still fires and
 * the window is still spent while hidden, which is also what TanStack did — so
 * a reader who hides a tab for the whole window comes back to a rail that has
 * stopped polling, exactly as before. Resuming instead is a nicer behaviour and
 * a different change.
 */
export function startIngestPoll(deps: PollDeps): () => void {
  const controller = new AbortController();
  let open: PollWindow = pollClosed;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    const step = pollStep(open, true, Date.now());
    open = step.window;
    if (step.interval === false) return;
    timer = setTimeout(() => void tick(), step.interval);
  };

  const tick = async () => {
    try {
      // Skips the FETCH, not the tick — an early return here would exit `tick`
      // before it reschedules and end the poll for good rather than pause it.
      // The budget is wall-clock, so a window spent behind another tab is spent.
      if (deps.isVisible()) {
        const polled = await deps.fetchFirstPage(controller.signal);
        // The abort may have landed while the request was in flight; a write
        // after `stop` would resurrect a poll the caller has already ended.
        if (!controller.signal.aborted) deps.write(polled);
      }
    } catch {
      // See above: an un-refreshed page is the status quo, never a reader's
      // problem. Includes the abort, which throws out of `fetch`.
    }
    if (!controller.signal.aborted) schedule();
  };

  schedule();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
