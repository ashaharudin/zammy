import { useCallback, useState } from "react";
import type { Pace } from "./choreography.js";
import { SPEEDS, type Speed } from "./playbackClock.js";

/**
 * The playback's three remembered settings: speed, pace, and whether the
 * single-letter keyboard shortcuts are on (ADR-0029).
 *
 * The same storage rule as `daySummaryPreference.ts`: only a departure from the
 * default is stored, and anything unreadable reads as the default. A reader who
 * never touches the controls stores nothing; a browser that cannot store at all
 * (a private window, a blocked origin) degrades to the defaults, never to an
 * error. Every `localStorage` touch is wrapped for the same reason — a Safari
 * private window throws on `setItem`, some origins throw on `getItem`, and some
 * throw on merely reading the `localStorage` property.
 *
 * The letter shortcuts are remembered because turning them off is an
 * accessibility setting (WCAG 2.1.4: a speech-input user whose dictation lands
 * as keystrokes turns them off once, not once a visit). They default to ON —
 * the ADR's keyboard promise — so, like the others, only "off" is stored.
 *
 * Deliberately NOT remembered: the example or trace on screen (that is the URL's
 * job), the transport's position, and reduced-motion stepping (that is the
 * browser's own setting, read fresh every visit).
 *
 * The pure half is exported and tested; the hook is a thin shell over it.
 */

export const SPEED_KEY = "zammy-playback-speed";
export const PACE_KEY = "zammy-playback-pace";
export const LETTERS_KEY = "zammy-playback-letter-keys";

const DEFAULT_SPEED: Speed = 1;
const DEFAULT_PACE: Pace = "readable";

/** A stored speed, or 1 for anything that is not exactly one of `SPEEDS`. */
export function speedFrom(stored: string | null): Speed {
  if (stored === null || stored.trim() === "") return DEFAULT_SPEED;
  const value = Number(stored);
  return (SPEEDS as readonly number[]).includes(value) ? (value as Speed) : DEFAULT_SPEED;
}

/** What to store for a speed; null (remove the key) for the default. */
export function storedSpeed(speed: Speed): string | null {
  return speed === DEFAULT_SPEED ? null : String(speed);
}

/** A stored pace, or "readable" for anything but the exact "real" token. */
export function paceFrom(stored: string | null): Pace {
  return stored === "real" ? "real" : DEFAULT_PACE;
}

/** What to store for a pace; null for the default. */
export function storedPace(pace: Pace): string | null {
  return pace === DEFAULT_PACE ? null : pace;
}

/** Whether the letter shortcuts are on: yes, unless the exact token says "off". */
export function lettersFrom(stored: string | null): boolean {
  return stored !== "off";
}

/** What to store for the letter shortcuts; null (the default, on) removes the key. */
export function storedLetters(on: boolean): string | null {
  return on ? null : "off";
}

/** The slice of `Storage` the preferences use. */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The settings as the page holds them. */
export interface PlaybackPreferences {
  speed: Speed;
  pace: Pace;
  /** The single-character shortcuts (`keyToAction`'s `letters`). */
  letters: boolean;
}

/** Reads every setting; any throw — even on reaching the storage — gives the defaults. */
export function readPlaybackPreferences(
  storage: () => PreferenceStorage | undefined,
): PlaybackPreferences {
  const read = (key: string): string | null => {
    try {
      return storage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  return {
    speed: speedFrom(read(SPEED_KEY)),
    pace: paceFrom(read(PACE_KEY)),
    letters: lettersFrom(read(LETTERS_KEY)),
  };
}

/** Stores one setting (null removes it). A failed write loses the memory, never the setting. */
export function writePlaybackPreference(
  storage: () => PreferenceStorage | undefined,
  key: string,
  value: string | null,
): void {
  try {
    const target = storage();
    if (!target) return;
    if (value === null) target.removeItem(key);
    else target.setItem(key, value);
  } catch {
    // The setting still applies to the playback in front of the reader.
  }
}

const browserStorage = (): PreferenceStorage | undefined => globalThis.localStorage;

/** The reader's settings, seeded synchronously from storage, with remembering setters. */
export function usePlaybackPreferences(): PlaybackPreferences & {
  setSpeed(s: Speed): void;
  setPace(p: Pace): void;
  setLetters(on: boolean): void;
} {
  const [prefs, setPrefs] = useState(() => readPlaybackPreferences(browserStorage));
  const setSpeed = useCallback((speed: Speed) => {
    setPrefs((current) => ({ ...current, speed }));
    writePlaybackPreference(browserStorage, SPEED_KEY, storedSpeed(speed));
  }, []);
  const setPace = useCallback((pace: Pace) => {
    setPrefs((current) => ({ ...current, pace }));
    writePlaybackPreference(browserStorage, PACE_KEY, storedPace(pace));
  }, []);
  const setLetters = useCallback((letters: boolean) => {
    setPrefs((current) => ({ ...current, letters }));
    writePlaybackPreference(browserStorage, LETTERS_KEY, storedLetters(letters));
  }, []);
  return { ...prefs, setSpeed, setPace, setLetters };
}
