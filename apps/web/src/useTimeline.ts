import { useEffect } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TimelinePage } from "@zammy/shared";
import { fetchReference, fetchTimeline, type TopicQuery } from "./api.js";
import { splicePolledPage, startIngestPoll, type LoadedTimeline } from "./ingestPoll.js";

/**
 * Server state for the timeline (ARCHITECTURE 8.2).
 *
 * Progressive fill (§6.5): while the newest response says
 * meta.ingest.state === "in_progress", ask again every ~1.5s so rows appear as
 * the background jobs land, stopping on "complete" or when the poll window
 * closes. TanStack keeps existing data on refetch, so content only ever grows —
 * no spinner ever replaces cards.
 *
 * How long "while" lasts is `ingestPoll.ts`'s, and so is what one response does
 * to the loaded pages. Both module headers carry their own argument.
 */

/** 30s: the client's idea of "fresh" for a page it just rendered (§6.4). */
const TIMELINE_STALE_TIME_MS = 30_000;

/** One key for the query and for the poll that writes into it. */
function timelineKey(topic: TopicQuery | null) {
  return ["timeline", topic];
}

export function useTimeline(topic: TopicQuery | null) {
  const timeline = useInfiniteQuery({
    queryKey: timelineKey(topic),
    enabled: topic !== null,
    queryFn: ({ pageParam, signal }) => fetchTimeline(topic!, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: TimelinePage) => last.page.nextCursor ?? undefined,
    staleTime: TIMELINE_STALE_TIME_MS,
  });

  // Read off the same page the rail reads `meta` from, which the poll keeps
  // current across every loaded page (`splicePolledPage`).
  const ingesting = timeline.data?.pages.at(-1)?.meta.ingest.state === "in_progress";
  useIngestPoll(topic, ingesting);

  return timeline;
}

/**
 * The progressive-fill poll: started and stopped here, run by `ingestPoll.ts`.
 *
 * `refetchInterval` was the obvious spelling and is a fan-out: a non-directional
 * fetch of an infinite query re-runs EVERY loaded page (v5 dropped per-page
 * refetch filtering), so a reader who has scrolled pays one invocation, one
 * Postgres round trip and one Redis round trip per loaded page per tick. Forty
 * ticks over the window, four pages, one reader, one topic: 160 of each. So the
 * poll fetches page one itself and `splicePolledPage` writes it into the cache
 * the infinite query owns — one cache entry, one render path, one request.
 *
 * What is left here is only the WIRING — when to start, when to stop, and what
 * "fetch" and "write" mean. The loop, its clock and its teardown are
 * `startIngestPoll`'s, where they can be driven by a test instead of by a
 * renderer this package does not have.
 *
 * Two things a reader could notice, changed because the poll no longer moves
 * the query's own flags, and both wanted:
 *
 * - **Pull-to-refresh works during ingest again.** Its busy guard is
 *   `timeline.isFetching`, which the old fan-out held true through most of the
 *   window. A pull is also the only thing that re-chains the cursors, which is
 *   the documented repair for the one slot `splicePolledPage` can drop — so
 *   being unable to pull during ingest was the wrong way round.
 * - **A failed poll no longer raises the error banner.** It used to move the
 *   query into `isError`, which `TimelinePage` renders above content that is
 *   perfectly fine. §6.5 records both.
 *
 * One interleaving is accepted rather than closed: a `fetchNextPage` that
 * resolves after a poll wrote replaces the whole cache entry from the pages it
 * started with, dropping that poll's page one and the topic facts it fanned
 * out. It costs 1.5s — the next tick writes them again. If the reverted page
 * happens to say `in_progress` when the poll had just seen `complete`, the
 * effect below remounts and the 60s window starts over; the cost is bounded by
 * the reader's own paging, and the alternative is coordinating two writers for
 * a window measured in seconds.
 */
function useIngestPoll(topic: TopicQuery | null, ingesting: boolean) {
  const client = useQueryClient();
  const topicKey = JSON.stringify(topic);

  useEffect(() => {
    if (topic === null || !ingesting) return;
    const key = timelineKey(topic);
    return startIngestPoll({
      fetchFirstPage: (signal) => fetchTimeline(topic, undefined, signal),
      write: (polled) =>
        client.setQueryData<LoadedTimeline>(key, (loaded) => splicePolledPage(loaded, polled)),
    });
    // `topic` rides on `topicKey` rather than on itself: a fresh object every
    // render would tear the poll down and restart it on every one of them.
  }, [topicKey, ingesting, client]);
}

/** Filter options for the command bar. Upstream refreshes daily (§9.1). */
export function useReference() {
  return useQuery({
    queryKey: ["reference"],
    queryFn: ({ signal }) => fetchReference(signal),
    staleTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });
}
