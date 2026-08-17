import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudDetail, windowHours, windowPhrase } from "./cloudLabels.js";

/**
 * What the cloud says in words (ARCHITECTURE 10.5). Worth its own tests because
 * this IS the accessible view: size and colour carry the same two facts for
 * sighted readers, and if these strings are wrong the cloud has no fallback.
 */

const WINDOW = {
  windowStart: "2026-08-16T12:00:00.000Z",
  windowEnd: "2026-08-17T12:00:00.000Z",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("windowHours / windowPhrase", () => {
  it("reads the window off the response rather than assuming 24", () => {
    expect(windowHours(WINDOW)).toBe(24);
    expect(
      windowHours({
        windowStart: "2026-08-15T12:00:00.000Z",
        windowEnd: "2026-08-17T12:00:00.000Z",
      }),
    ).toBe(48);
  });

  it("falls back to 24 for a window it cannot read", () => {
    // The component holds empty bounds until the first response lands.
    expect(windowHours({ windowStart: "", windowEnd: "" })).toBe(24);
  });

  it("says 'hours' in the plural, and 'the last hour' in the singular", () => {
    expect(windowPhrase(WINDOW)).toBe("the last 24 hours");
    expect(
      windowPhrase({
        windowStart: "2026-08-17T11:00:00.000Z",
        windowEnd: "2026-08-17T12:00:00.000Z",
      }),
    ).toBe("the last hour");
  });
});

describe("cloudDetail", () => {
  it("carries the window's count, the update time, and the arc's size", () => {
    vi.useFakeTimers({ now: new Date("2026-08-17T12:00:00.000Z") });
    expect(
      cloudDetail(
        { windowArticles: 3, size: 41, lastUpdated: "2026-08-17T10:00:00.000Z" },
        WINDOW,
      ),
    ).toBe("3 articles in the last 24 hours, updated 2h ago · 41 in all");
  });

  it("singularizes one article", () => {
    vi.useFakeTimers({ now: new Date("2026-08-17T12:00:00.000Z") });
    expect(
      cloudDetail(
        { windowArticles: 1, size: 9, lastUpdated: "2026-08-17T11:30:00.000Z" },
        WINDOW,
      ),
    ).toBe("1 article in the last 24 hours, updated 30m ago · 9 in all");
  });

  it("drops the arc total when the window already holds the whole story", () => {
    // "2 articles in the last 24 hours · 2 in all" is a sentence about nothing.
    vi.useFakeTimers({ now: new Date("2026-08-17T12:00:00.000Z") });
    expect(
      cloudDetail(
        { windowArticles: 2, size: 2, lastUpdated: "2026-08-17T11:00:00.000Z" },
        WINDOW,
      ),
    ).toBe("2 articles in the last 24 hours, updated 1h ago");
  });
});
