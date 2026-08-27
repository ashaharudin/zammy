import { describe, expect, it } from "vitest";
import { LOOKBACK_PLAN_SLACK_MS, subtractCoverage, type Span } from "./coverage-gaps.js";
import {
  MAX_INGEST_DELIVERIES,
  OBSERVED_REDELIVERY_LEASE_SECONDS,
} from "./ingest-queue-vercel.js";
import { LOOKBACK_CLAMP_MARGIN_MS } from "@zammy/news-client";

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
    //
    // The horizon sits `LOOKBACK_PLAN_SLACK_MS` INSIDE the 30-day edge (12:00
    // + 15 min), which is the difference between a segment that is fetchable
    // now and one that is still fetchable when the queue gets to it.
    const gaps = subtractCoverage(
      span("2026-06-01T00:00:00Z", "2026-08-09T00:00:00Z"),
      [],
      bounds,
    );
    expect(iso(gaps)).toEqual(["2026-07-11T12:15:00.000Z/2026-08-09T00:00:00.000Z"]);
  });

  it("leaves the oldest segment fetchable for the queue's whole retry budget", () => {
    // The 400 observed in production 2026-08-26: the oldest segment of a cold
    // search started exactly ON the horizon, and the consumer dequeued it
    // seconds to minutes later, by which time the edge had moved past it —
    // `date_range: Max lookback is 30 days` on every cold search.
    //
    // Asserted as a property rather than a literal: replan the same window at
    // the last delivery a failing message gets, and the oldest segment must
    // still be STRICTLY above the live edge. Strictly — an earlier version of
    // this test measured against the message TTL instead and passed by exact
    // equality, i.e. it asserted the segment sits precisely ON the edge, which
    // is the condition the slack exists to eliminate.
    const window = span("2026-06-01T00:00:00Z", "2026-08-09T00:00:00Z");
    const oldest = subtractCoverage(window, [], bounds).at(-1)!;

    const lastDeliveryMs =
      (MAX_INGEST_DELIVERIES - 1) * OBSERVED_REDELIVERY_LEASE_SECONDS * 1000;
    const liveEdge = NOW.getTime() + lastDeliveryMs - 30 * 86_400_000;

    expect(oldest.from.getTime()).toBeGreaterThan(liveEdge);
  });

  it("keeps the plan horizon above the client's own clamp — the correctness pin", () => {
    // THE inequality the fetch-time clamp rests on, and the one nothing else
    // would catch. `processSegmentJob` raises a stale segment to
    // `planHorizon(now)` and records coverage for what it fetches; that is only
    // honest while `clampSearchParams` leaves that span alone. The client
    // clamps to `now - lookback + LOOKBACK_CLAMP_MARGIN_MS`, so the moment the
    // margin exceeds the slack it narrows BELOW the span we just clamped to,
    // `fillSegment` records the span it asked for, and days nobody fetched are
    // marked fetched — silently, with every other test still green.
    //
    // The two constants live in different packages and are read by different
    // code, so this is the only place the relationship is stated at all. The
    // headroom between them (840s) also bounds how long one `processSegmentJob`
    // invocation may run before the same narrowing reappears; `vercel.json`
    // caps the consumer and the drain at 300s, well inside it.
    expect(LOOKBACK_PLAN_SLACK_MS).toBeGreaterThan(LOOKBACK_CLAMP_MARGIN_MS);
  });

  it("keeps the plan slack longer than the delivery budget it is sized for", () => {
    // The derivation, pinned where changing either side breaks. The last
    // delivery of a failing message lands at +610s; the remainder absorbs the
    // gap between planning a segment and publishing it.
    //
    // Note what this does NOT claim. `DRAIN_MIN_AGE_MS` is the message TTL
    // exactly, so the drain route consumes this whole slack by construction,
    // and `onTruncated` re-enqueues remainders under a fresh TTL that keep the
    // original lower edge — no constant here can bound either. What makes those
    // safe is the fetch-time re-clamp in `processSegmentJob`.
    expect(LOOKBACK_PLAN_SLACK_MS).toBeGreaterThan(
      (MAX_INGEST_DELIVERIES - 1) * OBSERVED_REDELIVERY_LEASE_SECONDS * 1000,
    );
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
