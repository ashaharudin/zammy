import { describe, expect, it } from "vitest";
import {
  LETTERS_KEY,
  PACE_KEY,
  SPEED_KEY,
  lettersFrom,
  paceFrom,
  readPlaybackPreferences,
  speedFrom,
  storedLetters,
  storedPace,
  storedSpeed,
  writePlaybackPreference,
  type PreferenceStorage,
} from "./playbackPreferences.js";

/**
 * The playback's remembered speed, pace and letter shortcuts (ADR-0029).
 *
 * The letter shortcuts' own regression is WCAG 2.1.4's: a reader who turned
 * them off (speech input, a tremor) must find them off on the next visit, and a
 * storage that cannot remember must still leave the toggle working for this one.
 *
 * The regression this catches is a preference that breaks the page: storage that
 * throws (a Safari private window, a blocked origin) must cost the reader the
 * memory of their setting, never the page, and a value from an older build or
 * another tab must read as the default rather than as garbage in the transport.
 */

function memory(
  initial: Record<string, string> = {},
): PreferenceStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

const throwing: PreferenceStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("speedFrom and storedSpeed", () => {
  it("reads a stored speed back", () => {
    expect(speedFrom("4")).toBe(4);
    expect(speedFrom("0.5")).toBe(0.5);
    expect(speedFrom("2")).toBe(2);
  });

  it("reads anything else as 1", () => {
    for (const junk of [null, "", "3", "fast", "NaN", "Infinity", "1e9", " "]) {
      expect(speedFrom(junk)).toBe(1);
    }
  });

  it("stores nothing for the default, and round-trips the rest", () => {
    expect(storedSpeed(1)).toBeNull();
    for (const speed of [0.5, 2, 4] as const) expect(speedFrom(storedSpeed(speed))).toBe(speed);
  });
});

describe("paceFrom and storedPace", () => {
  it("is readable unless the exact token says real", () => {
    expect(paceFrom(null)).toBe("readable");
    expect(paceFrom("real")).toBe("real");
    for (const junk of ["REAL", "readable", "", "fast"]) expect(paceFrom(junk)).toBe("readable");
  });

  it("stores nothing for readable, and round-trips real", () => {
    expect(storedPace("readable")).toBeNull();
    expect(paceFrom(storedPace("real"))).toBe("real");
  });
});

describe("lettersFrom and storedLetters", () => {
  it("is on unless the exact token says off", () => {
    expect(lettersFrom(null)).toBe(true);
    expect(lettersFrom("off")).toBe(false);
    for (const junk of ["OFF", "false", "0", "", "on"]) expect(lettersFrom(junk)).toBe(true);
  });

  it("stores nothing while on, and round-trips off", () => {
    expect(storedLetters(true)).toBeNull();
    expect(lettersFrom(storedLetters(false))).toBe(false);
  });
});

const DEFAULTS = { speed: 1, pace: "readable", letters: true };

describe("readPlaybackPreferences and writePlaybackPreference", () => {
  it("reads what was written", () => {
    const storage = memory();
    writePlaybackPreference(() => storage, SPEED_KEY, storedSpeed(4));
    writePlaybackPreference(() => storage, PACE_KEY, storedPace("real"));
    writePlaybackPreference(() => storage, LETTERS_KEY, storedLetters(false));
    expect(readPlaybackPreferences(() => storage)).toEqual({
      speed: 4,
      pace: "real",
      letters: false,
    });
  });

  it("turns the letters back on by removing the key", () => {
    const storage = memory({ [LETTERS_KEY]: "off" });
    writePlaybackPreference(() => storage, LETTERS_KEY, storedLetters(true));
    expect(storage.data).toEqual({});
    expect(readPlaybackPreferences(() => storage).letters).toBe(true);
  });

  it("removes the key when a setting returns to its default", () => {
    const storage = memory({ [SPEED_KEY]: "4" });
    writePlaybackPreference(() => storage, SPEED_KEY, storedSpeed(1));
    expect(storage.data).toEqual({});
  });

  it("gives the defaults and never throws when storage throws, or cannot be reached", () => {
    expect(readPlaybackPreferences(() => throwing)).toEqual(DEFAULTS);
    expect(() => writePlaybackPreference(() => throwing, LETTERS_KEY, "off")).not.toThrow();
    expect(() => writePlaybackPreference(() => throwing, SPEED_KEY, "4")).not.toThrow();
    expect(() => writePlaybackPreference(() => throwing, SPEED_KEY, null)).not.toThrow();
    const unreachable = () => {
      throw new Error("SecurityError: localStorage is not available");
    };
    expect(readPlaybackPreferences(unreachable)).toEqual(DEFAULTS);
    expect(() => writePlaybackPreference(unreachable, PACE_KEY, "real")).not.toThrow();
    expect(readPlaybackPreferences(() => undefined)).toEqual(DEFAULTS);
  });
});
