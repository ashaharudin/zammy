/**
 * How long the progressive-fill poll (§6.5) stays on, as a pure step function.
 *
 * §8.2 asks for "poll every ~1.5s while `meta.ingest.state === 'in_progress'`,
 * stopping on `complete` or when the 60s poll window closes" — a budget, so a
 * topic whose ingest never settles cannot poll a reader's browser forever.
 * §6.5 says that budget is spent in WALL-CLOCK TIME rather than in ticks, and
 * that is the whole reason this lives in a module of its own with a test.
 *
 * The counter it replaces was spent by RENDERS. TanStack calls a function-form
 * `refetchInterval` from `QueryObserver.setOptions`, which React calls on every
 * render of the component holding the query, and again from `onQueryUpdate` on
 * every state change of the query — so a `pollsUsed += 1` inside it counted
 * StrictMode's double render, the fetching→settled flip of each poll, and every
 * unrelated re-render of the page, none of which are polls. Forty of those are
 * reached in a few seconds, and the poll a reader is waiting on dies long
 * before the sixty seconds it was sized for.
 *
 * So the contract here is IDEMPOTENCE under repeated evaluation: asking twice
 * at the same instant must give the same answer and leave the same window.
 * Nothing but the clock closes it, which is what makes the budget mean the
 * thing §8.2 says it means.
 */

/** §8.2's ~1.5s cadence, fast enough that rows appear as jobs land. */
export const INGEST_POLL_INTERVAL_MS = 1500;

/**
 * How long a single in-progress stretch is polled for. Sixty seconds, which is
 * what the old tick budget was sized to mean (40 × 1.5s).
 *
 * It is deliberately far short of how long `meta.ingest.state` can stay
 * `in_progress` — an unsettled pending entry holds it for `STALE_PENDING_MS`,
 * fifteen minutes — because the poll is not how a reader gets the rest of the
 * store. Pages already in Postgres are reachable by paging (the rail's "Load
 * older", which is gated on `hasMore` ALONE for exactly this reason); the poll
 * only covers rows arriving while the reader watches.
 */
export const INGEST_POLL_WINDOW_MS = 60_000;

/** An open poll window, or the absence of one. */
export interface PollWindow {
  /** Epoch ms the current in-progress stretch opened at; null when closed. */
  readonly since: number | null;
}

export const pollClosed: PollWindow = { since: null };

export interface PollStep {
  /** The window to carry into the next evaluation. */
  readonly window: PollWindow;
  /** What to hand TanStack: a delay in ms, or false to stop polling. */
  readonly interval: number | false;
}

/**
 * The interval to poll at now, and the window that follows.
 *
 * `ingesting` is the newest loaded page's `meta.ingest.state === "in_progress"`.
 * A stretch that ends closes the window, so ingest starting again later — a
 * refresh-on-read top-up, say — gets a full budget rather than the remains of
 * the last one.
 */
export function pollStep(open: PollWindow, ingesting: boolean, now: number): PollStep {
  if (!ingesting) return { window: pollClosed, interval: false };
  const since = open.since ?? now;
  if (now - since >= INGEST_POLL_WINDOW_MS) {
    // Keep `since` rather than closing: closing here would re-open on the very
    // next evaluation and poll forever in 60s instalments.
    return { window: { since }, interval: false };
  }
  return { window: { since }, interval: INGEST_POLL_INTERVAL_MS };
}
