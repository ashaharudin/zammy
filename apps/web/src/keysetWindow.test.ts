import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TimelineEntry, TimelinePage } from "@zammy/shared";
import { splicePolledPage, type LoadedTimeline } from "./ingestPoll.js";

/**
 * Page one's window, checked against an order Postgres actually produced.
 *
 * `splicePolledPage` trims a polled response to page one's window, and the edge
 * it trims at is §7.3's keyset tuple `(published, storylineId)` — a comparison
 * Postgres does over a timestamptz and a uuid, and the browser does over two
 * strings. The corpus is Postgres's ANSWER, recorded: 409 rows read back
 * through the read path's own `order by day_slot_published desc,
 * storyline_id desc`. It is DATA rather than a transcription of the SQL, so
 * this is not comparing the code against itself.
 *
 * **What it can and cannot catch, stated precisely, because an earlier version
 * of this comment claimed more than the corpus supports.** For canonical
 * lowercase uuid text the two comparisons are not merely equal on this corpus,
 * they are equal by construction: hex characters sort in the same order as
 * their nibble values (`'0'`–`'9'` is 0x30–0x39, `'a'`–`'f'` is 0x61–0x66) and
 * the hyphens sit at fixed positions, so a JS string comparison IS Postgres's
 * `memcmp` over the sixteen bytes. All 83,436 pairs in the corpus agree, and no
 * corpus of uuids could ever disagree. So the uuid axis is a proof, not a test,
 * and what these cases actually pin is the WINDOW: that the trim happens, that
 * the boundary is inclusive, that the tie-break exists, and that the polled
 * order does not leak into the result.
 *
 * The premise the proof rests on is that the id half is a canonical uuid, and
 * that is load-bearing rather than incidental. A v1 cursor carries a BIGINT
 * there (`cursorGeneration`), and string order over bigints is not numeric
 * order — `"10"` sorts below `"9"`. Nothing here would survive that, and what
 * prevents it is `takeCursor` (`apps/api/src/timeline-read.ts`) answering 400
 * to any non-v2 generation. The corpus asserts the shape it depends on below.
 *
 * Two further things it deliberately does not prove:
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

  it("still holds the corpus the cases below are indexed against", () => {
    expect(all.length).toBeGreaterThan(400);
    // Named, not counted. A regenerated all-random fixture that happened to
    // collide seven times at this instant would pass a count and quietly drop
    // the rows the boundary sizes were chosen to land on.
    const ties = all
      .filter((i) => i.published === "2026-09-02T12:00:00.000Z")
      .map((i) => i.storylineId);
    for (const crafted of [
      "00000000-0000-4000-8000-000000000000",
      "0fffffff-ffff-4fff-bfff-ffffffffffff",
      "10000000-0000-4000-8000-000000000000",
      "99999999-9999-4999-8999-999999999999",
      "a0000000-0000-4000-8000-000000000000",
      "f0000000-0000-4000-8000-000000000000",
      "ffffffff-ffff-4fff-bfff-ffffffffffff",
    ]) {
      expect(ties).toContain(crafted);
    }
  });

  /**
   * The premise the whole file rests on: the id half is a canonical lowercase
   * uuid, which is the only form where a string comparison is Postgres's byte
   * comparison. `takeCursor` is what keeps it true on the wire — a v1 cursor
   * carries a bigint and is answered 400 rather than served.
   */
  it("rests on ids a string comparison can order", () => {
    for (const item of all) {
      expect(item.storylineId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  // Page one is the first `size` rows of Postgres's order, so the boundary is
  // row `size - 1` and everything below it is page two's. The poll hands back
  // the whole set SHUFFLED: the trim has to be what puts the window back, not
  // the order the response happened to arrive in.
  // Sizes 30/35/40/44 put the boundary INSIDE the crafted same-instant block at
  // indices 29-43, which is the only place the tie-break is at the edge rather
  // than merely somewhere in the corpus. Without them every tested boundary sat
  // on a distinct timestamp and the tie-break was never the deciding comparison.
  it.each([1, 2, 5, 25, 30, 35, 40, 44, 100, 200, 408])(
    "agrees at a %i-slot page one",
    (size) => {
    const windowRows = all.slice(0, size);
    const loaded: LoadedTimeline = {
      pages: [page(windowRows, "boundary"), page(all.slice(size), null)],
      pageParams: [undefined, "boundary"],
    };
    const shuffled = shuffle(all, size);

    const kept = splicePolledPage(loaded, page(shuffled, "ignored"))!.pages[0]!.items;

      expect([...kept].map((i) => i.storylineId).sort()).toEqual(
        windowRows.map((i) => i.storylineId).sort(),
      );
    },
  );
});

/** Deterministic, and a real permutation: a failing case has to reproduce. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed * 2654435761 + 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
