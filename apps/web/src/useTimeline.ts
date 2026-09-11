import { useEffect, useRef } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TimelinePage } from "@zammy/shared";
import { fetchReference, fetchTimeline, type TopicQuery } from "./api.js";
import {
  pollClosed,
  pollStep,
  splicePolledPage,
  type LoadedTimeline,
  type PollWindow,
} from "./ingestPoll.js";

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
 * The progressive-fill poll, on its own timer rather than on the query's.
 *
 * `refetchInterval` was the obvious spelling and is a fan-out: a non-directional
 * fetch of an infinite query re-runs EVERY loaded page (v5 dropped per-page
 * refetch filtering), so a reader who has scrolled pays one invocation, one
 * Postgres round trip and one Redis round trip per loaded page per tick. Forty
 * ticks over the window, four pages, one reader, one topic: 160 of each. So the
 * poll fetches page one itself and `splicePolledPage` writes it into the cache
 * the infinite query owns — one cache entry, one render path, one request.
 *
 * The window budget is unchanged and still spent on the clock, but it is now
 * spent once per POLL rather than once per evaluation: a `setTimeout` chain
 * ticks when it ticks, where a function-form `refetchInterval` was re-evaluated
 * on every render and every query state change. `pollStep`'s idempotence is
 * what made that survivable and is still its contract; nothing here needs it.
 *
 * One interleaving is accepted rather than closed: a `fetchNextPage` that
 * resolves after a poll wrote replaces the whole cache entry from the pages it
 * started with, dropping that poll's page one. It costs 1.5s — the next tick
 * writes it again — and the alternative is coordinating two writers for a
 * window measured in seconds.
 */
function useIngestPoll(topic: TopicQuery | null, ingesting: boolean) {
  const client = useQueryClient();
  // A ref, not state: writing it must not re-render, and the effect below owns
  // its whole life — opened on the first tick, closed when the stretch ends.
  const poll = useRef<PollWindow>(pollClosed);
  const topicKey = JSON.stringify(topic);

  useEffect(() => {
    if (topic === null || !ingesting) return;
    const key = timelineKey(topic);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      const step = pollStep(poll.current, true, Date.now());
      poll.current = step.window;
      if (step.interval === false) return;
      timer = setTimeout(() => void tick(), step.interval);
    };

    const tick = async () => {
      try {
        const page = await fetchTimeline(topic, undefined, controller.signal);
        client.setQueryData<LoadedTimeline>(key, (loaded) => splicePolledPage(loaded, page));
      } catch {
        // A poll that fails leaves the rail exactly as it was, which is the
        // state a reader was already looking at — never an error banner over
        // content that is fine. The next tick asks again; the window ends it.
      }
      if (!controller.signal.aborted) schedule();
    };

    schedule();
    return () => {
      controller.abort();
      clearTimeout(timer);
      // A stretch that ends closes the window, so ingest starting again later —
      // a refresh-on-read top-up, say — gets a full budget rather than the
      // remains of the last one. A window spent while ingest RUNS ON never
      // reaches here: the deps have not moved, so nothing re-opens it.
      poll.current = pollClosed;
    };
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
