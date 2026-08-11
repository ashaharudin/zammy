import { describe, expect, it } from "vitest";
import { isCollapsed, noDaysCollapsed, toggleDay } from "./dayCollapse.js";

describe("day collapse", () => {
  it("shows every day expanded until one is collapsed", () => {
    expect(isCollapsed(noDaysCollapsed, "Today")).toBe(false);
  });

  it("collapses only the day that was toggled", () => {
    const collapsed = toggleDay(noDaysCollapsed, "Today");

    expect(isCollapsed(collapsed, "Today")).toBe(true);
    expect(isCollapsed(collapsed, "Yesterday")).toBe(false);
  });

  it("re-expands a day toggled a second time", () => {
    const collapsed = toggleDay(noDaysCollapsed, "Today");

    expect(isCollapsed(toggleDay(collapsed, "Today"), "Today")).toBe(false);
  });
});
