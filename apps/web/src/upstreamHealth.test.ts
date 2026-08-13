import { describe, expect, it } from "vitest";
import { upstreamHealthRecord } from "./upstreamHealth.js";

/**
 * §11's degraded states used to be a banner in the command bar. They are a
 * fact about the response, not about the reader's search, so they now go to
 * the log for a future web-logging transport to carry — which means the record
 * has to survive without the chrome that used to explain it.
 */

describe("upstreamHealthRecord", () => {
  it("says nothing about a healthy response", () => {
    expect(
      upstreamHealthRecord({ degraded: null, stale: false, servedFrom: "cache", asOf: "2026-08-13T17:00:00Z" }),
    ).toBe(null);
  });

  it("carries the reason and what was served in its place", () => {
    expect(
      upstreamHealthRecord({
        degraded: "quota",
        stale: true,
        servedFrom: "store",
        asOf: "2026-08-13T16:41:00Z",
      }),
    ).toEqual({
      event: "upstream_degraded",
      degraded: "quota",
      stale: true,
      servedFrom: "store",
      asOf: "2026-08-13T16:41:00Z",
    });
  });

  it("reports staleness on its own — old data served as current is the thing worth knowing", () => {
    const record = upstreamHealthRecord({
      degraded: null,
      stale: true,
      servedFrom: "cache",
      asOf: "2026-08-13T09:00:00Z",
    });

    expect(record?.degraded).toBe(null);
    expect(record?.stale).toBe(true);
  });
});
