import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { resetStorylines } from "./storylines.js";
import { readStorylineCoverage, recordStorylineCoverage } from "./storyline-coverage.js";
import { migrateToLatest } from "./migrator.js";
import { createTestDatabase, type TestDatabase } from "./test-support.js";

/**
 * `storyline_coverage` (migration 0021) — the deepening plane's half of "did we
 * ask, or was nothing published?" (ADR-0001), keyed on an arc rather than on a
 * search.
 *
 * The cases mirror `coverage.test.ts` deliberately: this table's whole value is
 * that its spans arrive at the gap subtraction in the same shape the topic
 * table's do — disjoint, ascending, with real gaps preserved — so it is tested
 * against the same shapes. The two isolation tests are the ones with no
 * counterpart there, and they are the point of the phase.
 */

const DISCOVERY = "currents";
const DEEPENING = "google-news";

const span = (from: string, to: string) => ({ from: new Date(from), to: new Date(to) });
const iso = (spans: Array<{ from: Date; to: Date }>) =>
  spans.map((s) => `${s.from.toISOString()}/${s.to.toISOString()}`);

describe("storyline coverage", () => {
  let harness: TestDatabase;
  let arc: string;
  let otherArc: string;

  /**
   * A bare storyline row. `createProvisionalStoryline` would need a group, its
   * articles and a time zone to derive day slots from — none of which coverage
   * touches. What this table needs from a storyline is a UUID that exists.
   */
  const newArc = async (): Promise<string> => {
    const { rows } = await sql<{ id: string }>`
      insert into storylines (label, merged_into) values (null, null) returning id
    `.execute(harness.db);
    return rows[0]!.id;
  };

  beforeAll(async () => {
    harness = await createTestDatabase();
    await migrateToLatest(harness.db);
    arc = await newArc();
    otherArc = await newArc();
  });

  afterAll(async () => {
    await harness.drop();
  });

  it("starts empty", async () => {
    expect(await readStorylineCoverage(harness.db, arc, DEEPENING)).toEqual([]);
  });

  it("merges overlapping and adjacent spans on write", async () => {
    await recordStorylineCoverage(
      harness.db,
      arc,
      DEEPENING,
      span("2026-08-08T00:00:00Z", "2026-08-08T12:00:00Z"),
    );
    await recordStorylineCoverage(
      harness.db,
      arc,
      DEEPENING,
      span("2026-08-08T06:00:00Z", "2026-08-08T18:00:00Z"), // overlaps
    );
    await recordStorylineCoverage(
      harness.db,
      arc,
      DEEPENING,
      span("2026-08-08T18:00:00Z", "2026-08-09T00:00:00Z"), // adjacent
    );

    expect(iso(await readStorylineCoverage(harness.db, arc, DEEPENING))).toEqual([
      "2026-08-08T00:00:00.000Z/2026-08-09T00:00:00.000Z",
    ]);
  });

  it("keeps a gap in the middle, ascending", async () => {
    // The case the whole table exists for: a week fetched at both ends and not
    // in between must read back as two spans, or the subtraction upstairs will
    // never plan the middle.
    await recordStorylineCoverage(
      harness.db,
      arc,
      DEEPENING,
      span("2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z"),
    );

    expect(iso(await readStorylineCoverage(harness.db, arc, DEEPENING))).toEqual([
      "2026-08-01T00:00:00.000Z/2026-08-02T00:00:00.000Z",
      "2026-08-08T00:00:00.000Z/2026-08-09T00:00:00.000Z",
    ]);
  });

  it("is idempotent — re-recording a span changes nothing", async () => {
    // At-least-once delivery makes a replayed segment a certainty, not an edge
    // case (§9.1).
    const before = await readStorylineCoverage(harness.db, arc, DEEPENING);
    await recordStorylineCoverage(
      harness.db,
      arc,
      DEEPENING,
      span("2026-08-08T00:00:00Z", "2026-08-09T00:00:00Z"),
    );
    expect(iso(await readStorylineCoverage(harness.db, arc, DEEPENING))).toEqual(iso(before));
  });

  it("keeps arcs' coverage separate", async () => {
    expect(await readStorylineCoverage(harness.db, otherArc, DEEPENING)).toEqual([]);
  });

  it("keeps PROVIDERS' coverage separate, and does not merge across them", async () => {
    // ADR-0012's line, made mechanical. One provider's fetch of the first half
    // of a day and another's fetch of the second half are adjacent spans that
    // `range_agg` would happily coalesce — and the merged row would claim each
    // provider covered a span it never fetched. Scoping the fold to
    // (storyline_id, provider) is what stops it.
    await recordStorylineCoverage(
      harness.db,
      otherArc,
      DISCOVERY,
      span("2026-08-20T00:00:00Z", "2026-08-20T12:00:00Z"),
    );
    await recordStorylineCoverage(
      harness.db,
      otherArc,
      DEEPENING,
      span("2026-08-20T12:00:00Z", "2026-08-21T00:00:00Z"),
    );

    expect(iso(await readStorylineCoverage(harness.db, otherArc, DISCOVERY))).toEqual([
      "2026-08-20T00:00:00.000Z/2026-08-20T12:00:00.000Z",
    ]);
    expect(iso(await readStorylineCoverage(harness.db, otherArc, DEEPENING))).toEqual([
      "2026-08-20T12:00:00.000Z/2026-08-21T00:00:00.000Z",
    ]);
  });

  it("keeps the OLDEST fetched_at when spans merge", async () => {
    // Understating freshness costs a redundant top-up; overstating it hides
    // staleness with no error anywhere — `coverage.ts`'s rule, and this table
    // has to hold it too or a G5 top-up decision reads the wrong clock.
    const fresh = await newArc();
    await recordStorylineCoverage(
      harness.db,
      fresh,
      DEEPENING,
      span("2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z"),
    );
    await sql`
      update storyline_coverage set fetched_at = '2026-07-01T00:00:00Z'
       where storyline_id = ${fresh}::uuid
    `.execute(harness.db);
    await recordStorylineCoverage(
      harness.db,
      fresh,
      DEEPENING,
      span("2026-07-02T00:00:00Z", "2026-07-03T00:00:00Z"),
    );

    const { rows } = await sql<{ fetched_at: Date; n: string }>`
      select fetched_at, count(*) over () as n from storyline_coverage
       where storyline_id = ${fresh}::uuid
    `.execute(harness.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fetched_at.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("goes away with the storyline it belongs to", async () => {
    // ON DELETE CASCADE. A coverage row outliving its arc would be a claim
    // about a UUID nothing can resolve — and `resetStorylines` truncates this
    // table by name for the same reason.
    const doomed = await newArc();
    await recordStorylineCoverage(
      harness.db,
      doomed,
      DEEPENING,
      span("2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z"),
    );
    expect(await readStorylineCoverage(harness.db, doomed, DEEPENING)).toHaveLength(1);

    await sql`delete from storylines where id = ${doomed}::uuid`.execute(harness.db);
    expect(await readStorylineCoverage(harness.db, doomed, DEEPENING)).toEqual([]);
  });

  /**
   * Runs last in the file, because it empties every table the tests above are
   * written against.
   *
   * `resetStorylines` is the backfill's `--restart`, and its TRUNCATE carries no
   * `CASCADE` — so every table with a foreign key into `storylines` has to be
   * named in it or Postgres refuses the whole statement. Adding
   * `storyline_coverage` in migration 0021 broke it until it was named, and
   * nothing else exercises that path: the api backfill suite truncates by hand
   * with `cascade` and never reaches this function.
   */
  it("survives resetStorylines, which must name it in the truncate", async () => {
    expect(await readStorylineCoverage(harness.db, arc, DEEPENING)).not.toEqual([]);

    await resetStorylines(harness.db);

    const { rows } = await sql<{ n: string }>`
      select count(*) as n from storyline_coverage
    `.execute(harness.db);
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
