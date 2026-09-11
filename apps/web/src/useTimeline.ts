import { useEffect, useRef } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { TimelinePage } from "@zammy/shared";
import { fetchReference, fetchTimeline, type TopicQuery } from "./api.js";
import { pollClosed, pollStep, type PollWindow } from "./ingestPoll.js";

/**
 * Server state for the timeline (ARCHITECTURE 8.2).
 *
 * Progressive fill (§6.5): while the newest response says
 * meta.ingest.state === "in_progress", refetch every ~1.5s so rows appear as
 * the background jobs land, stopping on "complete" or when the poll window
 * closes. TanStack keeps existing data on refetch, so content only ever grows —
 * no spinner ever replaces cards.
 *
 * How long "while" lasts is `ingestPoll.ts`'s, and is measured on the clock
 * rather than in calls to the callback below: TanStack evaluates it once per
 * render and once per query state change, so anything counted here counts
 * renders. Its module header has the whole of that argument.
 */

/** 30s: the client's idea of "fresh" for a page it just rendered (§6.4). */
const TIMELINE_STALE_TIME_MS = 30_000;

export function useTimeline(topic: TopicQuery | null) {
  // A ref rather than state because writing it must not re-render: the write
  // happens inside `refetchInterval`, which React calls during the render it
  // would be scheduling. `pollStep` is idempotent for a given instant, so the
  // several evaluations one render produces all agree.
  const poll = useRef<PollWindow>(pollClosed);
  const topicKey = JSON.stringify(topic);
  useEffect(() => {
    poll.current = pollClosed;
  }, [topicKey]);

  return useInfiniteQuery({
    queryKey: ["timeline", topic],
    enabled: topic !== null,
    queryFn: ({ pageParam, signal }) => fetchTimeline(topic!, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: TimelinePage) => last.page.nextCursor ?? undefined,
    staleTime: TIMELINE_STALE_TIME_MS,
    refetchInterval: (query) => {
      const latest = query.state.data?.pages.at(-1);
      const step = pollStep(
        poll.current,
        latest?.meta.ingest.state === "in_progress",
        Date.now(),
      );
      poll.current = step.window;
      return step.interval;
    },
  });
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
