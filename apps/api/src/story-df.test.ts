import { describe, expect, it } from "vitest";
import { storyDfDay, trailingWindow } from "./story-df.js";

/**
 * The window arithmetic (ADR-0011). Pure, and worth its own tests because both
 * edges are off-by-one traps: the window is INCLUSIVE of today, and a day key
 * is a local calendar day, not a 24-hour slice of UTC.
 */

const VANCOUVER = { windowDays: 14, timeZone: "America/Vancouver" };

describe("trailingWindow", () => {
  it("covers exactly windowDays days, ending on today", () => {
    const window = trailingWindow(new Date("2026-08-14T18:00:00Z"), {
      windowDays: 14,
      timeZone: "UTC",
    });
    expect(window).toEqual({ from: "2026-08-01", to: "2026-08-14" });
  });

  it("is one day wide at windowDays 1 — not zero, and not two", () => {
    const window = trailingWindow(new Date("2026-08-14T18:00:00Z"), {
      windowDays: 1,
      timeZone: "UTC",
    });
    expect(window).toEqual({ from: "2026-08-14", to: "2026-08-14" });
  });

  it("ends on the reader's calendar day, not UTC's", () => {
    // 02:00 UTC on the 15th is still the evening of the 14th in Vancouver. A
    // UTC window would already be counting a day nobody there has lived.
    const window = trailingWindow(new Date("2026-08-15T02:00:00Z"), VANCOUVER);
    expect(window.to).toBe("2026-08-14");
    expect(window.from).toBe("2026-08-01");
  });

  it("slides one day per day, so consecutive windows overlap by all but one", () => {
    const today = trailingWindow(new Date("2026-08-14T18:00:00Z"), VANCOUVER);
    const yesterday = trailingWindow(new Date("2026-08-13T18:00:00Z"), VANCOUVER);
    expect(yesterday.to).toBe("2026-08-13");
    expect(yesterday.from).toBe("2026-07-31");
    expect(today.from > yesterday.from).toBe(true);
  });
});

describe("storyDfDay", () => {
  it("agrees with the window's edges about what day an instant belongs to", () => {
    const at = new Date("2026-08-15T02:00:00Z");
    expect(storyDfDay(at, VANCOUVER)).toBe("2026-08-14");
    expect(trailingWindow(at, VANCOUVER).to).toBe(storyDfDay(at, VANCOUVER));
  });
});
