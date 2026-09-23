import { createPortal } from "react-dom";
import { RAIL_STATUS_ID } from "../railAnnouncement.js";

/**
 * What the playback says out loud (ADR-0029, "The page is an operator's view on `/`"): one
 * sentence, portalled into the page's static live region, `#rail-status` (polite).
 *
 * The house pattern (`RailAnnouncer` in `TimelinePage.tsx`, which explains it at length): a
 * live region is only announced when its contents CHANGE inside a region the screen reader is
 * already tracking, so the region has to be in the original markup (`index.html`) and this
 * component only fills it. The playback page never coexists with the rail — `App.tsx` renders
 * one or the other — so the two never speak over each other in the one region.
 *
 * The message is set once per EVENT, never per frame: a reader's own transport action —
 * play, pause, a step, a seek, restart, end — saying where it landed (`describeStep`) or
 * "Playing"; a record run coming back, saying what became of it; and a read of the trace
 * settling with something new — its headline, job runs arriving, a failure, the poll giving
 * up (`pageNotices.ts` words and decides all but the transport's). An animation narrating
 * itself sixty times a second is noise, and the steps list is the place to read the whole
 * run at the reader's own pace. An empty message puts no text node in the region, which is
 * what silence has to look like there.
 *
 * ONE of these per page, mounted by `PlaybackPage` above the keyed player, so a new trace
 * starting afresh does not also wipe what was just said about how it got there.
 *
 * Deliberately not here: deciding what to say, and any fallback region of its own — without
 * `#rail-status` the page stays silent rather than mounting a region that would announce
 * nothing (see `RailAnnouncer` for why a missing node degrades rather than throws).
 */
export function PlaybackAnnouncer({ message }: { message: string }) {
  const host = document.getElementById(RAIL_STATUS_ID);
  if (!host) return null;
  return createPortal(message, host);
}
