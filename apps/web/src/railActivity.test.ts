import { describe, expect, it } from "vitest";
import { railActivity, type TimelineFetchState } from "./railActivity.js";

/** Idle, with one settled page loaded. Each case names only what it changes. */
const idle: TimelineFetchState = {
  isPending: false,
  isFetching: false,
  isFetchingNextPage: false,
  isFetchingPreviousPage: false,
  ingestState: "complete",
};

describe("railActivity", () => {
  it("is silent on a settled rail", () => {
    expect(railActivity(idle)).toEqual({ ingesting: false, refreshing: false });
  });

  it("reports ingesting from the wire, not from any fetch flag", () => {
    // The poll's own state: it fetches OUTSIDE the query, so nothing here is
    // fetching and the head is lit by the response alone.
    expect(railActivity({ ...idle, ingestState: "in_progress" })).toEqual({
      ingesting: true,
      refreshing: false,
    });
  });

  it("reports refreshing for a plain refetch over loaded data", () => {
    expect(railActivity({ ...idle, isFetching: true })).toEqual({
      ingesting: false,
      refreshing: true,
    });
  });

  it("does not report refreshing for the first paint", () => {
    expect(
      railActivity({ ...idle, isPending: true, isFetching: true, ingestState: undefined }),
    ).toEqual({ ingesting: false, refreshing: false });
  });

  it("does not report refreshing while paging forward", () => {
    // The one gate nothing else in this package would catch: `fetchNextPage`
    // raises `isFetching` too, and its rows land at the tail.
    expect(railActivity({ ...idle, isFetching: true, isFetchingNextPage: true })).toEqual({
      ingesting: false,
      refreshing: false,
    });
  });

  it("does not report refreshing while paging backward", () => {
    expect(railActivity({ ...idle, isFetching: true, isFetchingPreviousPage: true })).toEqual({
      ingesting: false,
      refreshing: false,
    });
  });

  it("reports both while a refetch runs during ingest", () => {
    // Both are true and both are wanted: the head is one mark either way, and
    // the ghost slots read `ingesting` on its own.
    expect(
      railActivity({ ...idle, isFetching: true, ingestState: "in_progress" }),
    ).toEqual({ ingesting: true, refreshing: true });
  });

  it("keeps paging silent even while ingest runs", () => {
    // `ingesting` still lights the head — but it is the response saying so, not
    // the page fetch, which must stay out of it.
    expect(
      railActivity({
        ...idle,
        isFetching: true,
        isFetchingNextPage: true,
        ingestState: "in_progress",
      }),
    ).toEqual({ ingesting: true, refreshing: false });
  });
});
