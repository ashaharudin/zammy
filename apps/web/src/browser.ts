/**
 * The one place that reads the browser's own settings.
 *
 * `browserDefaults` states the discipline — "the browser's readings come in as
 * arguments rather than off `navigator`, so the rules are testable without a
 * DOM and the caller owns the one place that touches globals" — but the
 * readings themselves had no home, so that one place was a helper private to
 * the filter chips. The timeline needs the zone too (§8.1, part-of-day
 * segments), and a second `resolvedOptions()` call elsewhere would have made
 * that comment false.
 *
 * The reduced-motion reading moved here for the same reason (ADR-0029, the
 * playback view): the landing cloud held it as a hook private to itself, and a
 * second scripted animation needing it would otherwise have been its third copy.
 * The device-pixel-ratio watch the playback canvas sizes itself by lives here
 * too, for the first reason: it is a reading of the browser's own settings.
 */

import { useEffect, useState } from "react";

/** What `browserDefaults` takes: the reader's languages and where they are. */
export function readBrowser(): { locales: readonly string[]; timeZone: string | undefined } {
  return {
    locales: navigator.languages?.length ? navigator.languages : [navigator.language],
    timeZone: readTimeZone(),
  };
}

/**
 * The reader's own IANA zone — what the rail's days and segments are cut by.
 *
 * Deliberately NOT derived from the country chip: that answers "whose news",
 * and a reader on `en-GB` sitting in Vancouver wants Vancouver's evening. And
 * deliberately not `APP_TIMEZONE`, which is the write path's day (§7.4,
 * ADR-0005) and has never been the reader's.
 *
 * `resolvedOptions()` is specified to always name a zone, so the fallback is a
 * formality rather than a case that occurs.
 */
export function readTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Whether the reader can actually see the page.
 *
 * The progressive-fill poll asks this before every fetch. It used to get the
 * answer for free: TanStack's `refetchInterval` fires the fetch only when
 * `refetchIntervalInBackground || focusManager.isFocused()`
 * (`queryObserver.js`), the flag was never set, and `isFocused()` is this same
 * reading. Running the poll on a timer of its own meant inheriting the
 * question, so it is asked here — the one place that touches globals — rather
 * than inside the loop, which stays drivable by a test with no DOM.
 *
 * `visibilityState` and not `document.hasFocus()`: a tab the reader is looking
 * at beside another window is visible, and a poll that stopped for it would
 * stall the rail someone is watching.
 */
export function isPageVisible(): boolean {
  return globalThis.document?.visibilityState !== "hidden";
}

/** The media query both readings below ask, spelled once. */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Whether the reader has asked for less motion, read once, now.
 *
 * For a caller that decides once, at the moment its motion would start (the
 * reading `StorylinePills` still spells inline for its one scripted slide), and
 * for the hook below, which seeds its state with it. Absent `matchMedia` (a
 * node test, a server render) this is false: the stylesheet's own
 * `@media (prefers-reduced-motion: reduce)` blocks still carry the preference
 * for everything CSS animates, so false is the safe half to be wrong about
 * there. There is no motion CSS cannot reach (a canvas, a
 * `requestAnimationFrame` loop) where no `matchMedia` exists either, so the
 * fallback never decides one of those.
 */
export function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
}

/**
 * Whether the reader has asked for less motion, as a subscription rather than
 * a read: the cloud drifts for as long as the landing page is open, and a
 * reader who turns the preference on while looking at it is exactly the reader
 * who meant it.
 *
 * SEEDED SYNCHRONOUSLY, so the first render already knows. The copy this
 * replaces (private to `TrendingCloud`) started at `false` and corrected itself
 * in an effect, which was harmless there — the stylesheet holds the drift still
 * anyway, so the reader saw at most one painted frame of the wrong layout — and
 * is not harmless for the playback view, which decides on its first render
 * whether to autoplay (it must not, under reduced motion) and whether to paint
 * the static overview first. A render that believed `false` would start the
 * loop before the effect could stop it. The effect still re-reads: the setting
 * can change between the render that seeded the state and the effect that
 * subscribes.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const query = globalThis.matchMedia?.(REDUCED_MOTION_QUERY);
    if (!query) return;
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** What `watchDevicePixelRatio` reads off `window`, so a test can hand it a stand-in. */
export interface PixelRatioWindow {
  readonly devicePixelRatio: number;
  matchMedia?(query: string): {
    addEventListener(type: "change", listener: () => void): void;
    removeEventListener(type: "change", listener: () => void): void;
  };
}

/**
 * Calls `onChange` with the new device pixel ratio whenever it changes — a page
 * zoom, a window dragged to another monitor — until the returned function is
 * called.
 *
 * For the playback's canvas (ADR-0029), whose backing store is its css size
 * times the ratio so the browser never resamples the pixel art. Its container's
 * `ResizeObserver` cannot stand in for this: the page is capped at
 * `--page-max`, so on a desktop a zoom changes the ratio and leaves the
 * container's css width exactly where it was, and nothing fires.
 *
 * There is no "resolution changed" event, only a media query that stops
 * matching: `(resolution: Xdppx)` for the CURRENT ratio fires `change` once the
 * ratio is anything else, and is then re-armed for the new one (MDN's
 * recipe). Absent `matchMedia` (a node test, a server render) it watches
 * nothing and returns a no-op.
 */
export function watchDevicePixelRatio(
  onChange: (ratio: number) => void,
  win: PixelRatioWindow | undefined = globalThis as unknown as PixelRatioWindow | undefined,
): () => void {
  if (!win || typeof win.matchMedia !== "function") return () => {};
  let query: ReturnType<NonNullable<PixelRatioWindow["matchMedia"]>> | null = null;
  const ratio = () => win.devicePixelRatio || 1;
  const arm = () => {
    query = win.matchMedia!(`(resolution: ${ratio()}dppx)`);
    query.addEventListener("change", fire);
  };
  const fire = () => {
    query?.removeEventListener("change", fire);
    arm();
    onChange(ratio());
  };
  arm();
  return () => {
    query?.removeEventListener("change", fire);
    query = null;
  };
}
