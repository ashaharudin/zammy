import { describe, expect, it } from "vitest";
import { isCollapsed, nothingCollapsed, segmentKey, toggle } from "./dayCollapse.js";

describe("rail collapse", () => {
  it("shows every section expanded until one is collapsed", () => {
    expect(isCollapsed(nothingCollapsed, "Today")).toBe(false);
  });

  it("collapses only the section that was toggled", () => {
    const collapsed = toggle(nothingCollapsed, "Today");

    expect(isCollapsed(collapsed, "Today")).toBe(true);
    expect(isCollapsed(collapsed, "Yesterday")).toBe(false);
  });

  it("re-expands a section toggled a second time", () => {
    const collapsed = toggle(nothingCollapsed, "Today");

    expect(isCollapsed(toggle(collapsed, "Today"), "Today")).toBe(false);
  });

  it("keeps one day's morning apart from another's", () => {
    // The reason a segment's key carries its day: "Morning" recurs on every
    // day down the rail, and a bare label would collapse all of them at once.
    const collapsed = toggle(nothingCollapsed, segmentKey("Today", "Morning"));

    expect(isCollapsed(collapsed, segmentKey("Today", "Morning"))).toBe(true);
    expect(isCollapsed(collapsed, segmentKey("Yesterday", "Morning"))).toBe(false);
  });

  it("leaves a day's segments as they were when the day itself collapses", () => {
    // The day is the OUTER switch: it hides its segments without recording
    // anything about them, so expanding it restores what the reader left.
    const morning = segmentKey("Today", "Morning");
    const collapsed = toggle(toggle(nothingCollapsed, morning), "Today");

    expect(isCollapsed(collapsed, "Today")).toBe(true);
    expect(isCollapsed(collapsed, morning)).toBe(true);
    expect(isCollapsed(toggle(collapsed, "Today"), morning)).toBe(true);
  });
});
