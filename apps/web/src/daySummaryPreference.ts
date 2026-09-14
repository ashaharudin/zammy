import { useCallback, useState } from "react";

/**
 * Whether the storyline view draws its day sentences (ADR-0023's preserve,
 * `TimelineEntry.daySummary`).
 *
 * ON by default, and the preference only ever records a reader who turned them
 * OFF. That asymmetry is the whole storage rule: a summary is part of what the
 * view is for, so a reader who has never touched the control gets it, and a
 * browser with no storage at all (private mode, a blocked origin) degrades to
 * the default rather than to silence.
 *
 * A reader preference and not route state, deliberately. It is a standing
 * answer to "do I want the prose", the same shape as the light/dark choice
 * (`ThemeProvider`), and putting it in the URL would mean a shared storyline
 * link also carried whether the recipient sees sentences — which is a fact
 * about the sender's reading, not about the story.
 *
 * The rules are here rather than inline in the hook so they can be tested
 * without a renderer, which is the discipline `browserDefaults` states and this
 * package keeps.
 */

const STORAGE_KEY = "zammy-day-summaries";

/** What to store for a setting, or null to store nothing — see above. */
export function storedValue(on: boolean): string | null {
  return on ? null : "off";
}

/**
 * A setting, read back from whatever was stored. Anything but the exact "off"
 * token is the default — an absent key, a value from an older build, a value
 * another tab on this origin wrote.
 */
export function settingFrom(stored: string | null): boolean {
  return stored !== "off";
}

/**
 * The reader's setting, and a way to flip it.
 *
 * Every `localStorage` touch is wrapped: a Safari private window throws on
 * `setItem` and some origins throw on `getItem`, and a reader who cannot
 * persist the choice should still be able to make it for the page in front of
 * them. So a failed write costs the preference its memory, never the toggle its
 * effect.
 */
export function useDaySummaries(): { daySummaries: boolean; toggleDaySummaries: () => void } {
  const [daySummaries, setDaySummaries] = useState<boolean>(() => {
    try {
      return settingFrom(localStorage.getItem(STORAGE_KEY));
    } catch {
      return settingFrom(null);
    }
  });

  const toggleDaySummaries = useCallback(() => {
    setDaySummaries((current) => {
      const next = !current;
      try {
        const value = storedValue(next);
        if (value === null) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, value);
      } catch {
        // See above: the setting still applies to the page they are looking at.
      }
      return next;
    });
  }, []);

  return { daySummaries, toggleDaySummaries };
}
