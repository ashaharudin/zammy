import { describe, expect, it } from "vitest";
import { settingFrom, storedValue } from "./dayPartsPreference.js";

describe("day parts preference", () => {
  it("is on for a reader who has never touched it", () => {
    // The parts are the rail's own structure; a reader has to ask to lose them.
    expect(settingFrom(null)).toBe(true);
  });

  it("stores nothing for on, so the default survives a storage that cannot write", () => {
    expect(storedValue(true)).toBeNull();
  });

  it("round-trips the one thing worth remembering: off", () => {
    const stored = storedValue(false);
    expect(stored).not.toBeNull();
    expect(settingFrom(stored)).toBe(false);
  });

  it("reads anything it does not recognise as the default", () => {
    // A value from an older build, or another tab on this origin. A flattened
    // rail is the one state that has to be asked for explicitly.
    for (const junk of ["", "on", "true", "OFF", "0"]) {
      expect(settingFrom(junk)).toBe(true);
    }
  });
});
