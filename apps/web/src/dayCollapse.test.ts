import { describe, expect, it } from "vitest";
import { isCollapsed, nothingCollapsed, segmentKey, toggle } from "./dayCollapse.js";

// Sections are keyed by the day's YYYY-MM-DD key, never by the label the rail
// renders — labels move at midnight, keys do not.
const TODAY = "2026-08-12";
const YESTERDAY = "2026-08-11";

describe("rail collapse", () => {
  it("shows every section expanded until one is collapsed", () => {
    expect(isCollapsed(nothingCollapsed, TODAY)).toBe(false);
  });

  it("collapses only the section that was toggled", () => {
    const collapsed = toggle(nothingCollapsed, TODAY);

    expect(isCollapsed(collapsed, TODAY)).toBe(true);
    expect(isCollapsed(collapsed, YESTERDAY)).toBe(false);
  });

  it("re-expands a section toggled a second time", () => {
    const collapsed = toggle(nothingCollapsed, TODAY);

    expect(isCollapsed(toggle(collapsed, TODAY), TODAY)).toBe(false);
  });

  it("keeps one day's morning apart from another's", () => {
    // The reason a segment's key carries its day: "Morning" recurs on every
    // day down the rail, and a bare label would collapse all of them at once.
    const collapsed = toggle(nothingCollapsed, segmentKey(TODAY, "Morning"));

    expect(isCollapsed(collapsed, segmentKey(TODAY, "Morning"))).toBe(true);
    expect(isCollapsed(collapsed, segmentKey(YESTERDAY, "Morning"))).toBe(false);
  });

  it("leaves a day's segments as they were when the day itself collapses", () => {
    // The day is the OUTER switch: it hides its segments without recording
    // anything about them, so expanding it restores what the reader left.
    const morning = segmentKey(TODAY, "Morning");
    const collapsed = toggle(toggle(nothingCollapsed, morning), TODAY);

    expect(isCollapsed(collapsed, TODAY)).toBe(true);
    expect(isCollapsed(collapsed, morning)).toBe(true);
    expect(isCollapsed(toggle(collapsed, TODAY), morning)).toBe(true);
  });
});
