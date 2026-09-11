import { describe, expect, it } from "vitest";
import {
  INGEST_POLL_INTERVAL_MS,
  INGEST_POLL_WINDOW_MS,
  pollClosed,
  pollStep,
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
    let window = pollClosed;
    for (let i = 0; i < 500; i += 1) {
      const step = pollStep(window, true, 1_000);
      expect(step.interval).toBe(INGEST_POLL_INTERVAL_MS);
      window = step.window;
    }
    expect(window.since).toBe(1_000);
  });

  it("polls right up to the window and stops after it", () => {
    const open = pollStep(pollClosed, true, 1_000).window;
    expect(pollStep(open, true, 1_000 + INGEST_POLL_WINDOW_MS - 1).interval).toBe(
      INGEST_POLL_INTERVAL_MS,
    );
    expect(pollStep(open, true, 1_000 + INGEST_POLL_WINDOW_MS).interval).toBe(false);
  });

  it("stays stopped once the window is spent", () => {
    let window = pollStep(pollClosed, true, 1_000).window;
    for (const now of [61_000, 61_002, 120_000]) {
      const step = pollStep(window, true, now);
      expect(step.interval).toBe(false);
      window = step.window;
    }
    // Still the original opening instant — a spent window must not re-open
    // itself and poll forever in sixty-second instalments.
    expect(window.since).toBe(1_000);
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
