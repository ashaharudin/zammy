import { describe, expect, it } from "vitest";
import { chooseRepresentative, isTier1, TIER_1_SOURCES } from "./source-authority.js";
import type { Grouped } from "./heading.js";

/**
 * The headline choice inside a group (ARCHITECTURE 14.3): a two-tier
 * source-authority list, NOT a score and NOT `sighting_count`.
 *
 * The list itself is an editorial stance and cannot be unit-tested; what these
 * tests pin is the selection RULE — authority first, then time, then id — and
 * the two signals that must never influence it.
 *
 * Moved here with the list from `apps/api` (ADR-0004: the browser needs this
 * and `shared` may not hold it). The fixture is a `Grouped` rather than an
 * `Article` because this package deliberately has no dependency on the wire
 * contract, and `sightingCount` is bolted onto it by hand for the one test that
 * proves the rule ignores a field its parameter type does not even carry.
 */

interface Member extends Grouped {
  sightingCount: number;
}

function article(overrides: Partial<Member> & { id: string }): Member {
  return {
    id: overrides.id,
    // These are a GROUP's members by the time they reach `chooseRepresentative`
    // — the caller has already read `groupId` to split them — so one id for all
    // of them is what the real call site passes.
    groupId: overrides.groupId ?? "1",
    sourceDomain: overrides.sourceDomain ?? "example.com",
    published: overrides.published ?? "2026-08-11T10:00:00.000Z",
    sightingCount: overrides.sightingCount ?? 1,
  };
}

describe("isTier1", () => {
  it("matches on the registrable domain the normalizer produces", () => {
    expect(isTier1("bbc.co.uk")).toBe(true);
    expect(isTier1("apnews.com")).toBe(true);
    expect(isTier1("some-aggregator.example")).toBe(false);
  });

  it("treats a missing domain as untiered rather than throwing", () => {
    expect(isTier1(null)).toBe(false);
  });

  it("holds no outlet twice and no bare suffixes", () => {
    // The list is matched against a REGISTRABLE domain, so an entry like
    // `go.com` (abcnews.go.com's registrable domain) would tier every site
    // under it. Sub-two-label entries are the shape of that mistake.
    for (const domain of TIER_1_SOURCES) {
      expect(domain).toBe(domain.toLowerCase());
      expect(domain.split(".").length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("chooseRepresentative", () => {
  it("prefers a tier-1 member over an earlier untiered one", () => {
    // Authority is a property of the domain, not of time — which is exactly
    // why it cannot move the group: the group is positioned by earliest
    // published regardless of who holds the headline (§14.3).
    const members = [
      article({ id: "1", sourceDomain: "contentfarm.example", published: "2026-08-11T08:00:00.000Z" }),
      article({ id: "2", sourceDomain: "bbc.co.uk", published: "2026-08-11T11:00:00.000Z" }),
    ];

    expect(chooseRepresentative(members).id).toBe("2");
  });

  it("breaks a tier-1 tie by earliest published, then by lowest id", () => {
    const members = [
      article({ id: "5", sourceDomain: "apnews.com", published: "2026-08-11T09:00:00.000Z" }),
      article({ id: "3", sourceDomain: "cbc.ca", published: "2026-08-11T08:00:00.000Z" }),
      article({ id: "4", sourceDomain: "reuters.com", published: "2026-08-11T08:00:00.000Z" }),
    ];

    expect(chooseRepresentative(members).id).toBe("3");
  });

  it("falls back to earliest published when no member is tier 1", () => {
    // The Anglophone cost, stated in §14.3: on a Spanish or Arabic timeline
    // this is the ONLY branch that ever runs, and it must be sane on its own.
    const members = [
      article({ id: "7", sourceDomain: "elpais.example", published: "2026-08-11T09:00:00.000Z" }),
      article({ id: "8", sourceDomain: "clarin.example", published: "2026-08-11T07:00:00.000Z" }),
    ];

    expect(chooseRepresentative(members).id).toBe("8");
  });

  it("never promotes a member for being re-emitted", () => {
    // `sighting_count` measures upstream re-emission, not importance — one
    // page arrived 50 times (PROBE-FINDINGS 4). Ranking by it would promote
    // exactly what §7.4 exists to neutralise.
    const members = [
      article({
        id: "9",
        sourceDomain: "roundup.example",
        published: "2026-08-11T10:00:00.000Z",
        sightingCount: 50,
      }),
      article({ id: "10", sourceDomain: "npr.org", published: "2026-08-11T10:00:00.000Z" }),
    ];

    expect(chooseRepresentative(members).id).toBe("10");
  });

  it("compares ids numerically, not as strings", () => {
    // Article ids are decimal strings over a bigint column: "10" < "9"
    // lexicographically, which would silently invert the tie-break.
    const members = [
      article({ id: "10", sourceDomain: "npr.org" }),
      article({ id: "9", sourceDomain: "npr.org" }),
    ];

    expect(chooseRepresentative(members).id).toBe("9");
  });

  it("returns the only member of a group of one", () => {
    const only = article({ id: "1" });
    expect(chooseRepresentative([only])).toBe(only);
  });
});
