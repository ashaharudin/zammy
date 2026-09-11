import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TimelineEntry, TimelinePage } from "@zammy/shared";
import { splicePolledPage, type LoadedTimeline } from "./ingestPoll.js";

/**
 * The browser's copy of §7.3's keyset order, replayed against Postgres's own.
 *
 * `splicePolledPage` trims a polled response to page one's window, and the edge
 * it trims at is the keyset tuple `(published, storylineId)` — a comparison
 * Postgres does over a timestamptz and a uuid, and the browser does over an ISO
 * string and a hyphenated one. Two implementations of one order, in two
 * languages, and a diff of the code proves nothing about whether they agree.
 *
 * So the corpus is Postgres's ANSWER, recorded: 409 rows read back through the
 * read path's own `order by day_slot_published desc, storyline_id desc`, with
 * ties chosen to sit on the boundaries a string comparison could get wrong
 * where a byte comparison does not (a uuid starting with a digit against one
 * starting with a letter, and the 0f/10 and 99/a0 crossings). It is DATA rather
 * than a transcription of the SQL: a harness that re-implemented the ordering
 * to check the ordering would be comparing this code against itself.
 * `fixtures/keyset-order-postgres.json` records how to make it again.
 *
 * Two things this deliberately does not prove, so nothing later reads more into
 * it than it says:
 *
 * - **Parsing `published` rather than comparing it as a string is defensive,
 *   not load-bearing.** Every provider normalizes through
 *   `new Date(ms).toISOString()`, so the wire spelling is uniform and a string
 *   comparison would agree today. It is parsed because `format.ts` has already
 *   been bitten by the other assumption, not because this corpus catches it.
 * - **Sub-millisecond ties cannot be resolved from the wire at all.** Two slots
 *   inside one millisecond whose microsecond order disagrees with their uuid
 *   order would be ordered one way by Postgres and the other way here. That is
 *   unreachable rather than handled: those same normalizers mean no value below
 *   millisecond precision is ever written, so the corpus has none either.
 */
const CORPUS = JSON.parse(
  readFileSync(new URL("../../../fixtures/keyset-order-postgres.json", import.meta.url), "utf8"),
) as { rows: { published: string; storylineId: string }[] };

const entry = (row: { published: string; storylineId: string }): TimelineEntry => ({
  storylineId: row.storylineId,
  published: row.published,
  updatedAt: row.published,
  article: {
    id: "1",
    groupId: "1",
    url: "https://example.test/1",
    title: "Headline",
    description: null,
    author: null,
    imageUrl: null,
    language: "en",
    categories: [],
    sourceCategories: [],
    sourceDomain: "example.test",
    published: row.published,
    sightingCount: 1,
    latestSeen: row.published,
  },
  related: [],
  moreCoverage: [],
  storyline: null,
});

const page = (items: TimelineEntry[], nextCursor: string | null): TimelinePage => ({
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
    ingest: { state: "in_progress", pendingJobs: 1 },
  },
});

describe("page one's window, against Postgres's own ordering", () => {
  const all = CORPUS.rows.map(entry);

  it("has a corpus big enough to be worth replaying", () => {
    expect(all.length).toBeGreaterThan(400);
    // The chosen ties: one instant carrying the uuid boundaries. Without these
    // the corpus is 400 random rows that agree by luck rather than by rule.
    const ties = all.filter((i) => i.published === "2026-09-02T12:00:00.000Z");
    expect(ties.length).toBeGreaterThanOrEqual(7);
  });

  // Page one is the first `size` rows of Postgres's order, so the boundary is
  // row `size - 1` and everything below it is page two's. The poll hands back
  // the whole set SHUFFLED: the trim has to be what puts the window back, not
  // the order the response happened to arrive in.
  it.each([1, 2, 5, 25, 100, 200, 408])("agrees at a %i-slot page one", (size) => {
    const windowRows = all.slice(0, size);
    const loaded: LoadedTimeline = {
      pages: [page(windowRows, "boundary"), page(all.slice(size), null)],
      pageParams: [undefined, "boundary"],
    };
    const shuffled = [...all].sort(() => Math.random() - 0.5);

    const kept = splicePolledPage(loaded, page(shuffled, "ignored"))!.pages[0]!.items;

    expect([...kept].map((i) => i.storylineId).sort()).toEqual(
      windowRows.map((i) => i.storylineId).sort(),
    );
  });
});
