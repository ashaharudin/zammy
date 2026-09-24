import { describe, expect, it } from "vitest";
import type { TraceReadResponse } from "@zammy/shared/request-trace";
import { ApiError } from "../api.js";
import { traceFixture } from "./fixtures/traceFixtures.js";
import {
  NOTICE_TEXT,
  offersCheckAgain,
  pollLine,
  readAnnouncement,
  readFailureNotice,
  recentFailureNotice,
  spokenText,
  type ReadMemory,
  type ReadSettle,
} from "./pageNotices.js";
import { TraceNotFound, TracingOff } from "./traceFetch.js";
import type { PolledTrace } from "./tracePoll.js";

/**
 * What the playback page says (ADR-0029, "The page is an operator's view on `/`",
 * as amended by ADR-0031).
 *
 * The regressions these catch are sentences that assert a cause the page does
 * not know: "a trace expires an hour after it is recorded" under a thirty-minute
 * TTL, or "tracing is off" for a store that is merely down. And the live
 * region's: a read that settles in silence, a failing poll said at every
 * interval, and the same sentence twice in a row said only once.
 */

describe("recentFailureNotice", () => {
  it("says tracing is off only when the list route is absent", () => {
    expect(recentFailureNotice(new TracingOff())).toMatch(/REQUEST_TRACE_ENABLED=false/);
    const down = recentFailureNotice(new ApiError(503, "down"));
    expect(down).toBe("The list of recorded traces could not be read (status 503).");
    expect(down).not.toMatch(/off/);
  });
});

describe("readFailureNotice", () => {
  it("does not say a trace lasts an hour (the TTL is a setting), nor pick a 404's cause", () => {
    const { text, retry } = readFailureNotice(new TraceNotFound(), false);
    expect(retry).toBe(false);
    expect(text).not.toMatch(/expires an hour after/);
    expect(text).toMatch(/REQUEST_TRACE_TTL_SECONDS, an hour by default/);
    expect(text).toMatch(/mistyped/);
    expect(text).toMatch(/tracing may be off/);
    expect(text).toMatch(/Pick another from the list/);
  });

  it("says a later 404 left the last copy playing", () => {
    const { text, retry } = readFailureNotice(new TraceNotFound(), true);
    expect(retry).toBe(false);
    expect(text).toMatch(/last copy/);
  });

  it("offers a retry for anything else, with its status when it has one", () => {
    expect(readFailureNotice(new ApiError(503, "down"), false)).toEqual({
      text: "The trace could not be read (status 503).",
      retry: true,
    });
    expect(readFailureNotice(new Error("offline"), true)).toEqual({
      text: "Checking for new job runs failed; what is playing is the last copy read.",
      retry: true,
    });
  });
});

describe("pollLine and offersCheckAgain", () => {
  it("stops saying Waiting once the window has closed, and offers Check again instead", () => {
    expect(pollLine({ kind: "waiting", awaited: 1 })).toMatch(/^Waiting for 1 job run;/);
    expect(offersCheckAgain({ kind: "waiting", awaited: 1 })).toBe(false);
    const stopped = pollLine({ kind: "stopped", awaited: 2 })!;
    expect(stopped).not.toMatch(/^Waiting/);
    expect(stopped).toMatch(/Stopped waiting for 2 job runs/);
    expect(stopped).toMatch(/Check again/);
    expect(offersCheckAgain({ kind: "stopped", awaited: 2 })).toBe(true);
  });

  it("offers Check again for a settled trace, and nothing for an expired one", () => {
    expect(pollLine({ kind: "settled" })).toBeNull();
    expect(offersCheckAgain({ kind: "settled" })).toBe(true);
    expect(pollLine({ kind: "expired" })).toBeNull();
    expect(offersCheckAgain({ kind: "expired" })).toBe(false);
    expect(offersCheckAgain({ kind: "none" })).toBe(false);
  });
});

describe("readAnnouncement", () => {
  const ID = "3f2b7c1e-9a4d-4b6e-8c2f-1a2b3c4d5e6f";
  const full = traceFixture("cold-search")!.response;
  const startedAt = Date.parse(full.trace.startedAt);
  const withRuns = (n: number): TraceReadResponse => ({ ...full, runs: full.runs.slice(0, n) });
  const polled = (response: TraceReadResponse): PolledTrace => ({
    response,
    firstReadAt: startedAt,
  });
  const settle = (overrides: Partial<ReadSettle>): ReadSettle => ({
    id: ID,
    data: polled(withRuns(1)),
    error: null,
    userAsked: false,
    nowMs: startedAt + 5_000,
    ...overrides,
  });
  /** Feeds settles through, as the page's effect does, and returns what was said. */
  const said = (...settles: ReadSettle[]) => {
    let memory: ReadMemory | null = null;
    return settles.map((s) => {
      const next = readAnnouncement(memory, s);
      memory = next.memory;
      return next.text;
    });
  };

  it("says the first good read of a trace: its headline, and what it still waits on", () => {
    const [text] = said(settle({}));
    expect(text).toMatch(/^Trace read: GET \/api\/v1\/timeline/);
    expect(text).toMatch(/Waiting for \d job runs?;/);
  });

  it("says how many job runs a poll brought, and nothing for a poll that brought none", () => {
    const one = polled(withRuns(1));
    const three = polled(withRuns(3));
    expect(said(settle({ data: one }), settle({ data: one }), settle({ data: three }))).toEqual([
      expect.stringMatching(/^Trace read:/),
      null,
      expect.stringMatching(/^2 new job runs arrived\./),
    ]);
  });

  it("answers a Check again even when it found nothing", () => {
    const one = polled(withRuns(1));
    expect(said(settle({ data: one }), settle({ data: one, userAsked: true }))[1]).toMatch(
      /^Checked: no new job runs\./,
    );
  });

  it("says a failing poll once, not once per interval, and again when the reader asks", () => {
    const one = polled(withRuns(1));
    const failed = settle({ data: one, error: new ApiError(503, "down") });
    const texts = said(settle({ data: one }), failed, failed, { ...failed, userAsked: true });
    expect(texts.slice(1)).toEqual([
      "Checking for new job runs failed (status 503); what is playing is the last copy read.",
      null,
      "Checking for new job runs failed (status 503); what is playing is the last copy read.",
    ]);
  });

  it("says a first read that 404s, and starts afresh for another id", () => {
    const [missing, other] = said(
      settle({ data: undefined, error: new TraceNotFound() }),
      settle({ id: "another", data: polled(withRuns(1)) }),
    );
    expect(missing).toMatch(/^The API has no trace with that id \(404\)/);
    expect(other).toMatch(/^Trace read:/);
  });

  it("is silent for a settle with neither a record nor an error", () => {
    expect(said(settle({ data: undefined }))).toEqual([null]);
  });
});

describe("NOTICE_TEXT", () => {
  it("sets a notice's words in the body ink, and keeps the amber for the bar beside them", () => {
    // Amber words were 3.21:1 on the light surface, under 1.4.3's 4.5:1.
    expect(NOTICE_TEXT.color).toBe("var(--fg)");
    expect(String(NOTICE_TEXT.borderLeft)).toContain("var(--amber)");
  });
});

describe("spokenText", () => {
  it("makes the same sentence twice in a row a change the region announces", () => {
    const first = spokenText("No new job runs.", 1);
    const second = spokenText("No new job runs.", 2);
    expect(first).not.toBe(second);
    expect(first.trim()).toBe(second.trim());
  });

  it("keeps silence silent", () => {
    expect(spokenText("", 1)).toBe("");
    expect(spokenText("", 2)).toBe("");
  });
});
