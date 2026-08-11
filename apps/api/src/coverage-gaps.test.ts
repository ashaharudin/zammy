import { describe, expect, it } from "vitest";
import { subtractCoverage, type Span } from "./coverage-gaps.js";

/**
 * Coverage-gap math (ARCHITECTURE 6.3 step 3): requested window − covered
 * ranges, clamped to the upstream lookback. Pure, and load-bearing in both
 * directions — a phantom gap re-spends quota on data we hold; a missed gap
 * shows a hole in the timeline and calls it "nothing was published".
 */

const NOW = new Date("2026-08-10T12:00:00.000Z");
const bounds = { now: NOW, lookbackDays: 30 };

const span = (from: string, to: string): Span => ({
  from: new Date(from),
  to: new Date(to),
});

const iso = (spans: Span[]) =>
  spans.map((s) => `${s.from.toISOString()}/${s.to.toISOString()}`);

describe("subtractCoverage", () => {
  it("returns the whole window when nothing is covered", () => {
    const gaps = subtractCoverage(
      span("2026-08-08T00:00:00Z", "2026-08-09T00:00:00Z"),
      [],
      bounds,
    );
    expect(iso(gaps)).toEqual(["2026-08-08T00:00:00.000Z/2026-08-09T00:00:00.000Z"]);
  });

  it("returns nothing when the window is fully covered", () => {
    const gaps = subtractCoverage(
      span("2026-08-08T00:00:00Z", "2026-08-09T00:00:00Z"),
      [span("2026-08-07T00:00:00Z", "2026-08-10T00:00:00Z")],
      bounds,
    );
    expect(gaps).toEqual([]);
  });

  it("splits around covered middle ground, NEWEST gap first", () => {
    // The reader starts at the top of the timeline, so the newest gap is the
    // one the synchronous fill should spend its deadline on (§6.5).
    const gaps = subtractCoverage(
      span("2026-08-01T00:00:00Z", "2026-08-09T00:00:00Z"),
      [span("2026-08-03T00:00:00Z", "2026-08-05T00:00:00Z")],
      bounds,
    );
    expect(iso(gaps)).toEqual([
      "2026-08-05T00:00:00.000Z/2026-08-09T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z/2026-08-03T00:00:00.000Z",
    ]);
  });

  it("treats overlapping and adjacent covered spans as one", () => {
    const gaps = subtractCoverage(
      span("2026-08-01T00:00:00Z", "2026-08-09T00:00:00Z"),
      [
        span("2026-08-02T00:00:00Z", "2026-08-04T00:00:00Z"),
        span("2026-08-03T00:00:00Z", "2026-08-05T00:00:00Z"), // overlaps previous
        span("2026-08-05T00:00:00Z", "2026-08-06T00:00:00Z"), // adjacent to it
      ],
      bounds,
    );
    expect(iso(gaps)).toEqual([
      "2026-08-06T00:00:00.000Z/2026-08-09T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z/2026-08-02T00:00:00.000Z",
    ]);
  });

  it("clamps to the lookback horizon — never spend a call to learn a 400", () => {
    // Upstream rejects anything older than 30 days (§6.3 step 3). The window
    // may ask; the gap plan must not.
    const gaps = subtractCoverage(
      span("2026-06-01T00:00:00Z", "2026-08-09T00:00:00Z"),
      [],
      bounds,
    );
    expect(iso(gaps)).toEqual(["2026-07-11T12:00:00.000Z/2026-08-09T00:00:00.000Z"]);
  });

  it("clamps to now — the future is not a gap", () => {
    // The canonicalizer snaps `to` upward, potentially past now (§6.2). A
    // "gap" in the future would be fetched, yield nothing, and be recorded as
    // covered — hiding articles published minutes later.
    const gaps = subtractCoverage(
      span("2026-08-10T11:00:00Z", "2026-08-10T12:15:00Z"),
      [],
      bounds,
    );
    expect(iso(gaps)).toEqual(["2026-08-10T11:00:00.000Z/2026-08-10T12:00:00.000Z"]);
  });

  it("returns nothing for a window entirely outside the reachable range", () => {
    const past = subtractCoverage(
      span("2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z"),
      [],
      bounds,
    );
    const future = subtractCoverage(
      span("2026-08-10T12:00:00Z", "2026-08-10T13:00:00Z"),
      [],
      bounds,
    );
    expect(past).toEqual([]);
    expect(future).toEqual([]);
  });

  it("ignores covered spans that do not intersect the window", () => {
    const gaps = subtractCoverage(
      span("2026-08-08T00:00:00Z", "2026-08-09T00:00:00Z"),
      [span("2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z")],
      bounds,
    );
    expect(iso(gaps)).toEqual(["2026-08-08T00:00:00.000Z/2026-08-09T00:00:00.000Z"]);
  });
});

describe("maxSpanMs — the upstream per-call range ceiling (observed 2026-08-11)", () => {
  const DAY = 86_400_000;
  const sliced = { ...bounds, maxSpanMs: 7 * DAY };

  it("slices a wide gap into ceiling-sized spans, newest first, remainder oldest", () => {
    const gaps = subtractCoverage(
      span("2026-07-24T12:00:00Z", "2026-08-10T12:00:00Z"), // 17 days
      [],
      sliced,
    );
    expect(iso(gaps)).toEqual([
      "2026-08-03T12:00:00.000Z/2026-08-10T12:00:00.000Z",
      "2026-07-27T12:00:00.000Z/2026-08-03T12:00:00.000Z",
      "2026-07-24T12:00:00.000Z/2026-07-27T12:00:00.000Z", // 3-day remainder
    ]);
  });

  it("leaves gaps at or under the ceiling untouched", () => {
    const gaps = subtractCoverage(
      span("2026-08-03T12:00:00Z", "2026-08-10T12:00:00Z"), // exactly 7 days
      [],
      sliced,
    );
    expect(iso(gaps)).toEqual(["2026-08-03T12:00:00.000Z/2026-08-10T12:00:00.000Z"]);
  });

  it("keeps global newest-first ordering across multiple sliced gaps", () => {
    const gaps = subtractCoverage(
      span("2026-07-15T12:00:00Z", "2026-08-10T12:00:00Z"),
      [span("2026-07-30T12:00:00Z", "2026-08-01T12:00:00Z")],
      sliced,
    );
    const times = gaps.map((g) => g.to.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    for (const gap of gaps) {
      expect(gap.to.getTime() - gap.from.getTime()).toBeLessThanOrEqual(7 * DAY);
    }
  });
});
