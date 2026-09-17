declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

/** Where a storyline-opening click came from — GA4's `source` param below. */
export type StorylineOpenSource = "hero_cloud" | "braid" | "pill" | "storyline_label";

/**
 * One GA4 event, fired at the one place every "open a storyline" click
 * already converges — `openStoryline` in App.tsx, whose own comment explains
 * why that convergence exists. `source` is the only thing a report needs to
 * tell surfaces apart, so nothing here should grow a second event name for a
 * second surface.
 *
 * Fire-and-forget: `gtag` may not be loaded yet (the tag is `async`) or may
 * never load at all (blocked outright), and a missed count is not a reader's
 * problem — see `refreshStoryline` in api.ts for the same call.
 */
export function trackStorylineOpen(source: StorylineOpenSource): void {
  window.gtag?.("event", "storyline_open", { source });
}
