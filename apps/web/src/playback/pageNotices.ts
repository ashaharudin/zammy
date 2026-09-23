/**
 * What the playback page SAYS about where its trace came from — the status
 * plate's notices, the poll line under the transport, and the sentences it
 * speaks into the live region — as pure functions (ADR-0029, "The page is an
 * operator's view on `/`").
 *
 * Its own module for `railAnnouncement.ts`'s reason: `apps/web` has no renderer
 * in its tests, so a sentence assembled inline in `PlaybackPage.tsx` is guarded
 * by nothing, and these sentences are the page's most important ones — the
 * explanation of why a recording did not become a playback. Every one of them
 * says ONLY what the page knows. A response header tells it whether a trace was
 * stored and a status code tells it how the request ended; neither tells it
 * WHY, and a sentence that names one cause where several fit sends the operator
 * after the wrong one (a Redis timeout for a schema refusal, "the CDN answered"
 * for a function the platform stopped after a minute, "an hour" for a TTL set to
 * thirty minutes).
 *
 * The live-region half follows the house pattern (`RailAnnouncer`,
 * `PlaybackAnnouncer.tsx`): one polite region, one sentence, set ONCE per
 * event — a reader's transport action, a record run coming back, a read of the
 * trace settling — and never per frame or per identical poll.
 *
 * Deliberately not here: any decision about polling (`tracePoll.ts`) or about
 * what a response header means (`traceFetch.ts`); this module only words what
 * those decided.
 */
import type { CSSProperties } from "react";
import { ApiError } from "../api.js";
import { describeHeadline } from "./stepText.js";
import { TraceNotFound, type RecordResult } from "./traceFetch.js";
import { pollStatus, type PollStatus, type PolledTrace } from "./tracePoll.js";

const jobRuns = (n: number) => (n === 1 ? "1 job run" : `${n} job runs`);

/**
 * How every notice, warning and form error on the page is SET: its words in
 * `--fg`, and the amber that marks it as a warning carried by a bar beside it.
 * The words were amber once, and in the light theme `--amber` (#b58900) is
 * 3.21:1 on `--surface` and 3.07:1 on `--bg`, under WCAG 1.4.3's 4.5:1 for text
 * this size — on the very sentences that say why a recording failed. The bar
 * is a graphic, where 3:1 is the bar (1.4.11), and the words carry the meaning
 * without it. The tokens stay as they are: the rest of the app uses them.
 */
export const NOTICE_TEXT: CSSProperties = {
  margin: 0,
  paddingLeft: "0.6rem",
  borderLeft: "3px solid var(--amber)",
  color: "var(--fg)",
  lineHeight: 1.5,
};

// ── a record run coming back ────────────────────────────────────────────────

/**
 * The status plate's notice for a record run that did not become a stored
 * trace; null for `traced` (the read that follows speaks for it) and `invalid`
 * (the record panel shows its own form errors, next to the field at fault).
 */
export function recordNotice(result: RecordResult): string | null {
  switch (result.kind) {
    case "traced":
    case "invalid":
      return null;
    case "browser":
      return result.cause === "cache"
        ? "The CDN answered that request from its cache, so no function ran and nothing was " +
            "traced: the browser drew this one from the response headers. It is not saved and " +
            "has no link."
        : // A 504 with no id: the platform answered in the API's place. A function may well
          // have run for its whole time limit, so nothing here may say none did.
          "That request came back 504 with no trace id: the platform answered in the API's " +
            "place, most likely because the function ran to its time limit and was stopped " +
            "before it could store a trace (an edge that cannot reach the function answers " +
            "the same way). The browser drew this one from what it saw. It is not saved and " +
            "has no link.";
    case "unstored":
      // Three causes send `unstored` (`trace-http.ts`): a draft that failed its own
      // schema, a write Redis refused or was not ready for, and anything thrown.
      return (
        `The API traced that request (status ${result.status}) but could not store the ` +
        "trace: the store was not ready, the write failed, or the record was refused, and " +
        "the API's log says which. Nothing was saved to play back."
      );
    case "untraced":
      return (
        `That request was answered (status ${result.status}) but not traced. Tracing may be ` +
        "off (REQUEST_TRACE_ENABLED), the token may be wrong, or this instance's trace " +
        "budget is spent; the API does not say which, on purpose."
      );
  }
}

/**
 * What to say out loud when a record run comes back: its notice, or for a
 * stored trace that the read has begun. Null for `invalid`, which the record
 * panel announces itself (`role="alert"`).
 */
export function recordAnnouncement(result: RecordResult): string | null {
  if (result.kind === "traced") return "Recorded. Reading the trace…";
  return recordNotice(result);
}

// ── a read of a recorded trace failing ──────────────────────────────────────

/**
 * Why a recorded trace could not be read, and whether asking again could help.
 * `hadCopy`: an earlier read succeeded, so the page is still playing that copy
 * (a poll or "Check again" failed); without one it shows the default example.
 *
 * A 404 is final and has four causes the page cannot tell apart (`TraceNotFound`):
 * expired, mistyped, a record a newer API wrote, or no read route because tracing
 * is off. Its TTL is a setting (`REQUEST_TRACE_TTL_SECONDS`, 30 minutes to a
 * day), so "an hour" is only its default.
 */
export function readFailureNotice(
  error: unknown,
  hadCopy: boolean,
): { text: string; retry: boolean } {
  if (error instanceof TraceNotFound) {
    return hadCopy
      ? {
          text:
            "The API no longer has this trace (404): it has expired, or tracing has been " +
            "turned off since it was read. What is playing is the last copy.",
          retry: false,
        }
      : {
          text:
            "The API has no trace with that id (404). It may have expired (a trace lasts " +
            "REQUEST_TRACE_TTL_SECONDS, an hour by default), the id may be mistyped, or " +
            "tracing may be off on this API; a 404 does not say which. The default example " +
            "is showing instead.",
          retry: false,
        };
  }
  const status = error instanceof ApiError ? ` (status ${error.status})` : "";
  return hadCopy
    ? {
        text: `Checking for new job runs failed${status}; what is playing is the last copy read.`,
        retry: true,
      }
    : {
        text: `The trace could not be read${status}. The default example is showing meanwhile.`,
        retry: true,
      };
}

// ── the poll line ────────────────────────────────────────────────────────────

/**
 * The line under the transport for a recorded trace, or null for none. It
 * stops saying "Waiting" the moment the poll does: past the window nothing
 * reads the trace again unless the reader asks.
 */
export function pollLine(status: PollStatus): string | null {
  switch (status.kind) {
    case "waiting":
      return `Waiting for ${jobRuns(status.awaited)}; they walk onto the floor as they land.`;
    case "stopped":
      return (
        `Stopped waiting for ${jobRuns(status.awaited)}: this page polls a trace for thirty ` +
        "minutes. A run that lands later shows up with Check again."
      );
    case "none":
    case "settled":
    case "expired":
      return null;
  }
}

/** Whether "Check again" is offered: once the poll has stopped, for a trace still there. */
export function offersCheckAgain(status: PollStatus): boolean {
  return status.kind === "stopped" || status.kind === "settled";
}

// ── a read settling, out loud ────────────────────────────────────────────────

/** What the page last said about one recorded trace's reads. */
export interface ReadMemory {
  id: string;
  /** How many job runs the last good read held; null before the first. */
  runs: number | null;
  /** The last failure sentence said, so a failing poll is said once, not per interval. */
  failure: string | null;
}

/** One settle of the recorded trace's query: its state just after a read finished. */
export interface ReadSettle {
  id: string;
  data: PolledTrace | undefined;
  /** The query's error: null after a good read, the failure after a failed one. */
  error: unknown;
  /** The reader asked for this read ("Try again", "Check again"): say how it went, always. */
  userAsked: boolean;
  nowMs: number;
}

/**
 * What to say when a read of a recorded trace settles, and what to remember:
 *
 *  - the first good read of an id: the trace's headline, and what it waits on;
 *  - a later one that brought job runs: how many arrived;
 *  - one the reader asked for that brought nothing: that it brought nothing;
 *  - a failure: its notice, the first time it is that failure — or whenever the
 *    reader asked. A poll that keeps failing the same way is said once.
 *
 * Every other settle (a poll with nothing new) is silent: the region is for
 * what changed.
 */
export function readAnnouncement(
  memory: ReadMemory | null,
  settle: ReadSettle,
): { text: string | null; memory: ReadMemory } {
  const known: ReadMemory =
    memory !== null && memory.id === settle.id
      ? memory
      : { id: settle.id, runs: null, failure: null };
  if (settle.error !== null && settle.error !== undefined) {
    const notice = readFailureNotice(settle.error, settle.data !== undefined).text;
    const say = settle.userAsked || notice !== known.failure;
    return { text: say ? notice : null, memory: { ...known, failure: notice } };
  }
  if (settle.data === undefined) return { text: null, memory: known };
  const runs = settle.data.response.runs.length;
  const line = pollLine(pollStatus({ data: settle.data, error: null }, settle.nowMs));
  const after = line === null ? "" : ` ${line}`;
  let text: string | null = null;
  if (known.runs === null) {
    text = `Trace read: ${describeHeadline(settle.data.response.trace)}.${after}`;
  } else if (runs > known.runs) {
    const arrived = runs - known.runs;
    text = `${arrived === 1 ? "A new job run" : `${arrived} new job runs`} arrived.${after}`;
  } else if (settle.userAsked) {
    text = `Checked: no new job runs.${after}`;
  }
  return { text, memory: { ...known, runs, failure: null } };
}

/**
 * The text to put in the live region for the `serial`-th thing said. A region
 * is announced when its contents CHANGE, so saying the same sentence twice in a
 * row — a second record run refused the same way, a second "Check again" that
 * found nothing — would be silence the second time. Every other sentence
 * carries a trailing no-break space, which a screen reader does not voice and
 * which makes it a change.
 */
export function spokenText(text: string, serial: number): string {
  return text === "" || serial % 2 === 0 ? text : `${text} `;
}
