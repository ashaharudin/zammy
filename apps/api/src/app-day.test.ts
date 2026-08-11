import { describe, expect, it } from "vitest";
import { zonedDayBounds, zonedDayKey } from "./app-day.js";

/**
 * "Today" is the APP_TIMEZONE day, not the UTC day (ARCHITECTURE 10.1): under
 * UTC, a Vancouver afternoon is already tomorrow, and the landing page would
 * show a near-empty cloud every day after ~5pm local.
 */

describe("zonedDayKey", () => {
  it("a Vancouver evening is still today there, already tomorrow in UTC", () => {
    const instant = new Date("2026-08-10T02:00:00.000Z"); // Aug 9, 7pm PDT
    expect(zonedDayKey(instant, "America/Vancouver")).toBe("2026-08-09");
    expect(zonedDayKey(instant, "UTC")).toBe("2026-08-10");
  });
});

describe("zonedDayBounds", () => {
  it("brackets the local day as UTC instants", () => {
    expect(zonedDayBounds("2026-08-09", "America/Vancouver")).toEqual({
      from: new Date("2026-08-09T07:00:00.000Z"), // local midnight, PDT = UTC-7
      to: new Date("2026-08-10T07:00:00.000Z"),
    });
    expect(zonedDayBounds("2026-08-09", "UTC")).toEqual({
      from: new Date("2026-08-09T00:00:00.000Z"),
      to: new Date("2026-08-10T00:00:00.000Z"),
    });
  });

  it("round-trips: an instant's day key contains that instant", () => {
    const instant = new Date("2026-01-15T05:30:00.000Z"); // PST, winter offset
    const day = zonedDayKey(instant, "America/Vancouver");
    const bounds = zonedDayBounds(day, "America/Vancouver");
    expect(bounds.from.getTime()).toBeLessThanOrEqual(instant.getTime());
    expect(bounds.to.getTime()).toBeGreaterThan(instant.getTime());
  });
});
