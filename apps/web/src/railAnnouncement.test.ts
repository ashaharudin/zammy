import { describe, expect, it } from "vitest";
import { railAnnouncement, SILENT, type RailAnnouncementState } from "./railAnnouncement.js";

/** A settled rail with one loaded page of cards. Each case names what it changes. */
const settled: RailAnnouncementState = {
  isPending: false,
  isError: false,
  hasLoaded: true,
  isEmpty: false,
  emptyMessage: "No articles yet for “climate”.",
  ingesting: false,
  refreshing: false,
};

describe("railAnnouncement", () => {
  it("says nothing about a settled rail that has cards on it", () => {
    // Point 6: the rail IS the resolution. A result count was rejected because
    // paging and the poll both append, so it would re-announce on every append.
    expect(railAnnouncement(settled)).toBe(SILENT);
  });

  it("announces the first paint as loading, not as an ingest", () => {
    // The distinction ARCHITECTURE §8.1 (States) makes load-bearing: a first
    // request is often a fill being planned and often not, and the storyline
    // view never fetches at all.
    expect(railAnnouncement({ ...settled, isPending: true })).toBe("Loading the timeline.");
  });

  it("is the only clause that can produce the first paint's sentence", () => {
    // Not belt-and-braces: under `isPending` there is no `latest`, so every
    // other clause is false and dropping this one would make the first paint
    // silent rather than merely differently worded.
    const firstPaint = { ...settled, isPending: true };
    const withoutTheClause = { ...firstPaint, isPending: false };
    expect(railAnnouncement(withoutTheClause)).toBe(SILENT);
    expect(railAnnouncement(firstPaint)).toBe("Loading the timeline.");
  });

  it("announces an ingest without a count, however deep the queue", () => {
    // Point 3, and the property the whole decision rests on: the sentence must
    // not move while the queue drains, or `aria-atomic` re-reads it ~40 times
    // per window. There is no input here that a poll tick could change.
    expect(railAnnouncement({ ...settled, ingesting: true })).toBe(
      "Gathering articles from upstream.",
    );
  });

  it("calls a refetch with no count of its own checking, not gathering", () => {
    expect(railAnnouncement({ ...settled, refreshing: true })).toBe("Checking for new articles.");
  });

  it("prefers the ingest to the refetch when both are running", () => {
    // Both flags are true on a pull that lands during ingest. One region means
    // one sentence, and upstream work is the more specific claim.
    expect(railAnnouncement({ ...settled, ingesting: true, refreshing: true })).toBe(
      "Gathering articles from upstream.",
    );
  });

  it("announces a failed load, so the first paint's promise resolves", () => {
    expect(railAnnouncement({ ...settled, isError: true, hasLoaded: false })).toBe(
      "The timeline could not be loaded.",
    );
  });

  it("says the UPDATE failed when there is already a rail on screen", () => {
    // `query-core` sets `status: "error"` for a background error too, so a
    // failed pull — or a "Load older" whose rows never arrived — reaches this
    // function with the timeline still in front of the reader. Announcing
    // "could not be loaded" there describes the opposite of what they have.
    expect(railAnnouncement({ ...settled, isError: true })).toBe(
      "The timeline could not be updated.",
    );
  });

  it("announces the retry rather than repeating the error under it", () => {
    // Point 2. Repeating the error text would be no change to the region and
    // so no announcement at all — the reader would press retry and hear
    // nothing. The error returns, audibly, if the retry fails.
    expect(railAnnouncement({ ...settled, isError: true, refreshing: true })).toBe(
      "Checking for new articles.",
    );
  });

  it("announces the empty rail in the words the empty state is showing", () => {
    expect(railAnnouncement({ ...settled, isEmpty: true })).toBe("No articles yet for “climate”.");
    expect(
      railAnnouncement({ ...settled, isEmpty: true, emptyMessage: "Nothing here yet." }),
    ).toBe("Nothing here yet.");
  });

  it("keeps quiet about an empty rail that is still being filled", () => {
    // An ingest over an empty rail is not an empty rail yet, and saying so
    // would contradict the ghost slots below it.
    expect(railAnnouncement({ ...settled, isEmpty: true, ingesting: true })).toBe(
      "Gathering articles from upstream.",
    );
  });

  it("announces the refetch over an empty rail, not the emptiness under it", () => {
    // Reachable and load-bearing: `Rail` has a whole branch for a pull over an
    // empty rail (the beacon alone above the message), because a search that
    // found nothing is the one a reader retries. Without this precedence the
    // pull would be silent.
    expect(railAnnouncement({ ...settled, isEmpty: true, refreshing: true })).toBe(
      "Checking for new articles.",
    );
  });

  it("announces a failure over an empty rail rather than repeating the emptiness", () => {
    expect(railAnnouncement({ ...settled, isEmpty: true, isError: true })).toBe(
      "The timeline could not be updated.",
    );
  });

  it("ignores the empty message whenever the rail is not empty", () => {
    // `emptyMessage` is read ONLY under `isEmpty`. `TimelinePage` computes it
    // unconditionally, so it is always populated and must never leak out.
    expect(railAnnouncement({ ...settled, emptyMessage: "leaked" })).toBe(SILENT);
    expect(railAnnouncement({ ...settled, refreshing: true, emptyMessage: "leaked" })).toBe(
      "Checking for new articles.",
    );
  });
});
