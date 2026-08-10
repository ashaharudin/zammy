import { useEffect, useRef } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { TimelinePage } from "@zammy/shared";
import { fetchReference, fetchTimeline, type TopicQuery } from "./api.js";

/**
 * Server state for the timeline (ARCHITECTURE 8.2).
 *
 * Progressive fill (§6.5): while the newest response says
 * meta.ingest.state === "in_progress", refetch every ~1.5s so rows appear as
 * the background jobs land, stopping on "complete" or after INGEST_POLL_MAX
 * ticks. TanStack keeps existing data on refetch, so content only ever grows —
 * no spinner ever replaces cards.
 */
const INGEST_POLL_INTERVAL_MS = 1500;
const INGEST_POLL_MAX = 40; // ~60s of polling before we stop asking

/** 30s: the client's idea of "fresh" for a page it just rendered (§6.4). */
const TIMELINE_STALE_TIME_MS = 30_000;

export function useTimeline(topic: TopicQuery | null) {
  const pollsUsed = useRef(0);
  const topicKey = JSON.stringify(topic);
  useEffect(() => {
    pollsUsed.current = 0;
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
      if (!latest || latest.meta.ingest.state !== "in_progress") return false;
      if (pollsUsed.current >= INGEST_POLL_MAX) return false;
      pollsUsed.current += 1;
      return INGEST_POLL_INTERVAL_MS;
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
