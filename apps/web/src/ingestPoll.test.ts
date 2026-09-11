import { describe, expect, it } from "vitest";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import type { Article, TimelineEntry, TimelinePage } from "@zammy/shared";
import {
  INGEST_POLL_INTERVAL_MS,
  INGEST_POLL_WINDOW_MS,
  pollClosed,
  pollStep,
  splicePolledPage,
  type LoadedTimeline,
} from "./ingestPoll.js";

describe("pollStep", () => {
  it("does not poll a settled ingest", () => {
    expect(pollStep(pollClosed, false, 1_000)).toEqual({
      window: pollClosed,
      interval: false,
    });
  });

  it("opens a window on the first in-progress read", () => {
    const step = pollStep(pollClosed, true, 1_000);
    expect(step.interval).toBe(INGEST_POLL_INTERVAL_MS);
    expect(step.window.since).toBe(1_000);
  });

  // The bug this module exists for: TanStack evaluates a function-form
  // `refetchInterval` once per render and once per query state change, not once
  // per poll. A budget spent by evaluations is gone in seconds.
  it("spends nothing on repeated evaluation at the same instant", () => {
    let open = pollClosed;
    for (let i = 0; i < 500; i += 1) {
      const step = pollStep(open, true, 1_000);
      expect(step.interval).toBe(INGEST_POLL_INTERVAL_MS);
      open = step.window;
    }
    expect(open.since).toBe(1_000);
  });

  it("polls right up to the window and stops after it", () => {
    const open = pollStep(pollClosed, true, 1_000).window;
    expect(pollStep(open, true, 1_000 + INGEST_POLL_WINDOW_MS - 1).interval).toBe(
      INGEST_POLL_INTERVAL_MS,
    );
    expect(pollStep(open, true, 1_000 + INGEST_POLL_WINDOW_MS).interval).toBe(false);
  });

  it("stays stopped once the window is spent", () => {
    let open = pollStep(pollClosed, true, 1_000).window;
    for (const now of [61_000, 61_002, 120_000]) {
      const step = pollStep(open, true, now);
      expect(step.interval).toBe(false);
      open = step.window;
    }
    // Still the original opening instant — a spent window must not re-open
    // itself and poll forever in sixty-second instalments.
    expect(open.since).toBe(1_000);
  });

  it("gives a fresh budget to ingest that starts again", () => {
    const spent = pollStep(pollStep(pollClosed, true, 1_000).window, true, 120_000).window;
    const settled = pollStep(spent, false, 130_000);
    expect(settled.window).toEqual(pollClosed);
    expect(pollStep(settled.window, true, 140_000)).toEqual({
      window: { since: 140_000 },
      interval: INGEST_POLL_INTERVAL_MS,
    });
  });
});

/**
 * Wire-shaped fixtures, built rather than cast: the splice reads only the
 * keyset halves, but a page it is handed in production is a whole one, and a
 * cast would let this file drift from the contract it is standing in for.
 */
let nextId = 1;

const article = (published: string): Article => {
  const id = String(nextId++);
  return {
    id,
    groupId: id,
    url: `https://example.test/${id}`,
    title: `Headline ${id}`,
    description: null,
    author: null,
    imageUrl: null,
    language: "en",
    categories: [],
    sourceCategories: [],
    sourceDomain: "example.test",
    published,
    sightingCount: 1,
    latestSeen: published,
  };
};

const entry = (published: string, storylineId: string): TimelineEntry => ({
  storylineId,
  published,
  updatedAt: published,
  article: article(published),
  related: [],
  moreCoverage: [],
  storyline: null,
});

const page = (
  items: TimelineEntry[],
  nextCursor: string | null,
  state: "complete" | "in_progress" = "in_progress",
): TimelinePage => ({
  topic: { fingerprint: "0".repeat(64), keywords: ["climate"], coverage: null },
  items,
  storylines: [],
  memberships: { byGroup: {}, storylines: [] },
  page: { nextCursor, hasMore: nextCursor !== null },
  meta: {
    servedFrom: "store",
    asOf: "2026-09-11T12:00:00.000Z",
    stale: false,
    degraded: null,
    ingest: { state, pendingJobs: state === "in_progress" ? 2 : 0 },
  },
});

/**
 * The fan-out this replaces: `refetchInterval` on an infinite query re-runs
 * every loaded page, which on Vercel is an invocation, a Postgres round trip
 * and a Redis round trip EACH, forty times over the poll window. One response
 * has to do the work of all of them.
 */
describe("splicePolledPage", () => {
  const A = entry("2026-09-11T10:00:00.000Z", "aaaaaaaa-0000-4000-8000-000000000000");
  const B = entry("2026-09-11T09:00:00.000Z", "bbbbbbbb-0000-4000-8000-000000000000");
  const C = entry("2026-09-11T08:00:00.000Z", "cccccccc-0000-4000-8000-000000000000");
  const D = entry("2026-09-11T07:00:00.000Z", "dddddddd-0000-4000-8000-000000000000");

  it("leaves an empty cache alone", () => {
    expect(splicePolledPage(undefined, page([A], null))).toBeUndefined();
    expect(splicePolledPage({ pages: [], pageParams: [] }, page([A], null))).toEqual({
      pages: [],
      pageParams: [],
    });
  });

  it("replaces a one-page rail outright, window and all", () => {
    const loaded = { pages: [page([A], null, "in_progress")], pageParams: [undefined] };
    const polled = page([A, B], "cursor-b", "in_progress");
    expect(splicePolledPage(loaded, polled)).toEqual({
      pages: [polled],
      pageParams: [undefined],
    });
  });

  // The whole point: N loaded pages, one request, and the tail untouched.
  it("refreshes page one and leaves every loaded page below it as it was", () => {
    const first = page([A, B], "cursor-b");
    const second = page([C, D], null);
    const loaded = { pages: [first, second], pageParams: [undefined, "cursor-b"] };

    const freshA = entry("2026-09-11T10:00:00.000Z", A.storylineId);
    const spliced = splicePolledPage(loaded, page([freshA, B], "cursor-b"))!;

    expect(spliced.pages).toHaveLength(2);
    expect(spliced.pages[0]!.items).toEqual([freshA, B]);
    expect(spliced.pages[1]!.items).toBe(second.items);
    expect(spliced.pageParams).toEqual([undefined, "cursor-b"]);
  });

  /**
   * `meta` is a fact about the topic, not about a page, so the one response
   * answers for all of them. Without this the rail reads `ingest.state` off
   * `pages.at(-1)` — a snapshot from whenever the reader paged — and the
   * ingest animation runs until the poll window closes.
   */
  it("carries the polled meta onto every loaded page", () => {
    const loaded = {
      pages: [page([A, B], "cursor-b"), page([C, D], null)],
      pageParams: [undefined, "cursor-b"],
    };
    const spliced = splicePolledPage(loaded, page([A, B], "cursor-b", "complete"))!;
    for (const p of spliced.pages) expect(p.meta.ingest.state).toBe("complete");
  });

  /**
   * Page one's `nextCursor` is the boundary page two was fetched from. Moving
   * it would leave the loaded tail hanging off a cursor nobody asked with.
   */
  it("holds page one's window still even when the response would widen it", () => {
    const first = page([A, B], "cursor-b");
    const loaded = { pages: [first, page([C, D], null)], pageParams: [undefined, "cursor-b"] };

    // B slipped below the boundary (an older article landed in its day), so the
    // server filled page one down to C — which page two already holds.
    const slipped = entry("2026-09-11T06:00:00.000Z", B.storylineId);
    const spliced = splicePolledPage(loaded, page([A, slipped, C], "cursor-c"))!;

    expect(spliced.pages[0]!.items).toEqual([A]);
    expect(spliced.pages[0]!.page).toEqual(first.page);
  });

  it("keeps the boundary slot itself, which the cursor excludes only for page two", () => {
    const loaded = {
      pages: [page([A, B], "cursor-b"), page([C, D], null)],
      pageParams: [undefined, "cursor-b"],
    };
    const spliced = splicePolledPage(loaded, page([A, B], "cursor-b"))!;
    expect(spliced.pages[0]!.items).toEqual([A, B]);
  });

  it("breaks ties on the storyline id, the keyset's second half", () => {
    const early = entry("2026-09-11T09:00:00.000Z", "0000aaaa-0000-4000-8000-000000000000");
    const loaded = {
      pages: [page([A, B], "cursor-b"), page([C], null)],
      pageParams: [undefined, "cursor-b"],
    };
    // Same instant as the boundary, lower id: descending keyset puts it BELOW.
    const spliced = splicePolledPage(loaded, page([A, B, early], "cursor-x"))!;
    expect(spliced.pages[0]!.items).toEqual([A, B]);
  });

  it("keeps the previous page one rather than leaving the rail headless", () => {
    const first = page([A, B], "cursor-b");
    const loaded = { pages: [first, page([C], null)], pageParams: [undefined, "cursor-b"] };
    const spliced = splicePolledPage(loaded, page([C, D], "cursor-d", "complete"))!;
    expect(spliced.pages[0]).toBe(first);
  });
});

/**
 * The same splice against the real cache rather than a shape that resembles it.
 *
 * Two premises the design rests on and neither of which is ours to keep true:
 * that a non-directional refetch of an infinite query really does re-run every
 * loaded page, and that what sits in the cache is an `InfiniteData` a plain
 * `setQueryData` can rewrite. Both are TanStack's, so both are pinned here —
 * a version that changed either would take the poll's shape with it.
 */
describe("the poll against a live query cache", () => {
  const WIRE = [
    page([entry("2026-09-11T10:00:00.000Z", "aaaa")], "c1"),
    page([entry("2026-09-11T09:00:00.000Z", "bbbb")], "c2"),
    page([entry("2026-09-11T08:00:00.000Z", "cccc")], "c3"),
    page([entry("2026-09-11T07:00:00.000Z", "dddd")], "c4"),
  ];

  /** A four-deep rail, and every page param the client asked with to build it. */
  async function pagedFourDeep() {
    const asked: (string | undefined)[] = [];
    const client = new QueryClient();
    const observer = new InfiniteQueryObserver<TimelinePage>(client, {
      queryKey: ["timeline"],
      queryFn: ({ pageParam }) => {
        asked.push(pageParam as string | undefined);
        return Promise.resolve(WIRE[pageParam === undefined ? 0 : Number(String(pageParam).at(-1))]!);
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last: TimelinePage) => last.page.nextCursor ?? undefined,
    });
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();
    for (let i = 0; i < 3; i += 1) await observer.fetchNextPage();
    expect(asked).toEqual([undefined, "c1", "c2", "c3"]);
    asked.length = 0;
    return { client, observer, asked, unsubscribe };
  }

  it("fans a plain refetch out across every loaded page — the cost being avoided", async () => {
    const { asked, observer, unsubscribe } = await pagedFourDeep();
    await observer.refetch();
    expect(asked).toEqual([undefined, "c1", "c2", "c3"]);
    unsubscribe();
  });

  it("writes all four pages from the one request the poll makes", async () => {
    const { client, observer, asked, unsubscribe } = await pagedFourDeep();

    // What a tick does: fetch page one, splice, and nothing else.
    const polled = page([entry("2026-09-11T10:00:00.000Z", "aaaa")], "c1", "complete");
    client.setQueryData<LoadedTimeline>(["timeline"], (loaded) =>
      splicePolledPage(loaded, polled),
    );

    expect(asked).toEqual([]);
    const data = client.getQueryData<LoadedTimeline>(["timeline"])!;
    expect(data.pages).toHaveLength(4);
    expect(data.pageParams).toEqual([undefined, "c1", "c2", "c3"]);
    // Every page answers with the ingest state the one response observed, so
    // the rail stops animating without three more requests to tell it to.
    expect(data.pages.map((p) => p.meta.ingest.state)).toEqual(Array(4).fill("complete"));
    expect(data.pages.slice(1).map((p) => p.items)).toEqual(WIRE.slice(1).map((p) => p.items));
    // And paging still works off the last page's own cursor.
    expect(observer.getCurrentResult().hasNextPage).toBe(true);
    unsubscribe();
  });
});
