import { describe, expect, it } from "vitest";
import { TimelinePage, groupStorylines } from "./timeline.js";

/**
 * The wire contract's own readings — the parts of it that are a RULE rather
 * than a field, and so can be got wrong without failing a type.
 */

const ARC_A = "11111111-1111-4111-8111-111111111111";
const ARC_B = "22222222-2222-4222-8222-222222222222";

describe("groupStorylines", () => {
  it("returns the arc a row is read under for a group the map does not name", () => {
    // The "absent means exactly one" rule. A group in one storyline is left out
    // of `byGroup`, and the one arc it is in must be the arc of the slot it
    // appears in — there is nowhere else it could be.
    expect(groupStorylines({ byGroup: {} }, "42", ARC_A)).toEqual([ARC_A]);
  });

  it("returns every arc the map names, the one being read under included", () => {
    const memberships = { byGroup: { "42": [ARC_A, ARC_B] } };
    expect(new Set(groupStorylines(memberships, "42", ARC_A))).toEqual(new Set([ARC_A, ARC_B]));
    // And the same answer whichever of them the row is being read under: the
    // list is a fact about the group, not about the slot asking.
    expect(new Set(groupStorylines(memberships, "42", ARC_B))).toEqual(new Set([ARC_A, ARC_B]));
  });
});

describe("TimelinePage.memberships", () => {
  const page = {
    topic: { fingerprint: "0".repeat(64), keywords: [], coverage: null },
    items: [],
    page: { nextCursor: null, hasMore: false },
    meta: {
      servedFrom: "store",
      asOf: "2026-09-02T00:00:00.000Z",
      stale: false,
      degraded: null,
      ingest: { state: "complete", pendingJobs: 0 },
    },
  };

  it("defaults to empty, so a page that reports no crossing parses", () => {
    const parsed = TimelinePage.parse(page);
    expect(parsed.memberships).toEqual({ byGroup: {}, storylines: [] });
    expect(groupStorylines(parsed.memberships, "42", ARC_A)).toEqual([ARC_A]);
  });

  it("carries the directory alongside the map, since ids alone name nothing", () => {
    const parsed = TimelinePage.parse({
      ...page,
      memberships: {
        byGroup: { "42": [ARC_A, ARC_B] },
        storylines: [
          {
            id: ARC_B,
            label: "Shipping Disruption",
            from: "2026-08-10T09:00:00.000Z",
            to: "2026-08-11T09:00:00.000Z",
            size: 7,
            dormant: false,
          },
        ],
      },
    });
    expect(parsed.memberships.storylines[0]?.label).toBe("Shipping Disruption");
  });

  it("keeps the SEARCH's surfaced storylines a separate list (ADR-0011)", () => {
    // Widening `storylines` into "every storyline this page mentions" would put
    // arcs no keyword matched into the pills row, which is a different claim.
    const parsed = TimelinePage.parse({
      ...page,
      memberships: { byGroup: { "42": [ARC_A, ARC_B] }, storylines: [] },
    });
    expect(parsed.storylines).toEqual([]);
  });
});
