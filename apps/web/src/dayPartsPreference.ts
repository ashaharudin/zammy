import { useCallback, useState } from "react";

/**
 * Whether the rail divides each day into its parts — Night/Morning/Afternoon/
 * Evening (§8.1's segment dividers) — or draws the day as one undivided run.
 *
 * ON by default, and the preference only ever records a reader who turned it
 * OFF. The parts are the rail's own structure and a reader who has never
 * touched the control gets them; a browser with no storage at all (private
 * mode, a blocked origin) degrades to that default rather than to a flattened
 * rail nobody asked for. Same asymmetry, for the same reason, as
 * `daySummaryPreference`.
 *
 * A reader preference and not route state, deliberately, on the same ground as
 * the day sentences: it is a standing answer to "how finely do I want the rail
 * chunked", and putting it in the URL would mean a shared link also carried the
 * sender's chunking — a fact about their reading, not about the story.
 *
 * Distinct from COLLAPSE (`dayCollapse`), which is this session's set of hidden
 * sections. Collapsing hides a part's cards behind its heading; turning the
 * parts off removes the headings and pours the cards into one run. Nothing is
 * hidden either way, so the two never have to agree — and because a combined
 * day leaves every segment key untouched, turning the parts back on restores
 * whatever was collapsed under them.
 *
 * The rules live here rather than inline in the hook so they can be tested
 * without a renderer, which is the discipline `browserDefaults` states and this
 * package keeps.
 */

const STORAGE_KEY = "zammy-day-parts";

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
export function useDayParts(): { dayParts: boolean; toggleDayParts: () => void } {
  const [dayParts, setDayParts] = useState<boolean>(() => {
    try {
      return settingFrom(localStorage.getItem(STORAGE_KEY));
    } catch {
      return settingFrom(null);
    }
  });

  const toggleDayParts = useCallback(() => {
    setDayParts((current) => {
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

  return { dayParts, toggleDayParts };
}
