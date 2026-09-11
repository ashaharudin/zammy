import { describe, expect, it } from "vitest";
import { railAnnouncement, SILENT, type RailAnnouncementState } from "./railAnnouncement.js";

/** A settled rail with one loaded page. Each case names only what it changes. */
const settled: RailAnnouncementState = {
  isPending: false,
  ingesting: false,
  refreshing: false,
  pendingJobs: 0,
};

describe("railAnnouncement", () => {
  it("says nothing about a settled rail", () => {
    expect(railAnnouncement(settled)).toBe(SILENT);
  });

  it("announces the first paint as loading, not as an ingest", () => {
    // The distinction ARCHITECTURE §8.1 (States) makes load-bearing: a first
    // request is often a fill being planned and often not, and the storyline
    // view never fetches at all.
    expect(railAnnouncement({ ...settled, isPending: true })).toBe("Loading the timeline.");
  });

  it("keeps the first paint's wording even when a count is somehow already in hand", () => {
    // Precedence, stated rather than inferred: `isPending` means no response has
    // been read, so any count reaching this function is not one it may speak.
    expect(railAnnouncement({ ...settled, isPending: true, ingesting: true, pendingJobs: 4 })).toBe(
      "Loading the timeline.",
    );
  });

  it("reports a known queue with its count", () => {
    expect(railAnnouncement({ ...settled, ingesting: true, pendingJobs: 3 })).toBe(
      "Gathering articles from upstream — 3 jobs pending.",
    );
  });

  it("says job, singular, for exactly one", () => {
    expect(railAnnouncement({ ...settled, ingesting: true, pendingJobs: 1 })).toBe(
      "Gathering articles from upstream — 1 job pending.",
    );
  });

  it("drops the clause rather than announcing zero pending jobs", () => {
    // Not a contradiction and not a race: a reader who lost the single-flight
    // lock is watching a peer's ingest and has queued nothing of their own.
    // "0 jobs pending" would contradict the animation and the floored ghost slot.
    expect(railAnnouncement({ ...settled, ingesting: true, pendingJobs: 0 })).toBe(
      "Gathering articles from upstream.",
    );
  });

  it("calls a refetch with no count of its own checking, not gathering", () => {
    expect(railAnnouncement({ ...settled, refreshing: true })).toBe("Checking for new articles.");
  });

  it("prefers the ingest's count over the refetch when both are running", () => {
    // Both flags are true on a pull that lands during ingest. One region means
    // one sentence, and the one that can say how much is the one worth saying.
    expect(
      railAnnouncement({ ...settled, ingesting: true, refreshing: true, pendingJobs: 2 }),
    ).toBe("Gathering articles from upstream — 2 jobs pending.");
  });

  it("ignores a count left over from a response that is no longer ingesting", () => {
    // `pendingJobs` is read ONLY under `ingesting`. `TimelinePage` passes the
    // newest page's number straight through, and that number outlives the
    // `in_progress` that made it meaningful.
    expect(railAnnouncement({ ...settled, pendingJobs: 7 })).toBe(SILENT);
    expect(railAnnouncement({ ...settled, refreshing: true, pendingJobs: 7 })).toBe(
      "Checking for new articles.",
    );
  });

  it("repeats itself exactly for an unchanged state, so an idle rail stays quiet", () => {
    // The property the persistent region rests on: equal states produce an
    // equal string, React writes no DOM for an unchanged string, and no DOM
    // write is no announcement. This is what stops a topic switch between two
    // equally-busy rails from re-announcing the same words as fresh news.
    const during = { ...settled, ingesting: true, pendingJobs: 2 };
    expect(railAnnouncement(during)).toBe(railAnnouncement({ ...during }));
  });
});
