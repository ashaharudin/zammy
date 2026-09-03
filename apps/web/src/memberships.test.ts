import { describe, expect, it } from "vitest";
import type { StorylineSummary } from "@zammy/shared";
import { mergeMemberships, rowMembership, type PageMemberships } from "./memberships.js";

const ARC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ARC_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const arc = (
  id: string,
  label: string | null,
  overrides: Partial<StorylineSummary> = {},
): StorylineSummary => ({
  id,
  label,
  from: "2026-08-10T09:00:00.000Z",
  to: "2026-08-12T09:00:00.000Z",
  size: 6,
  dormant: false,
  ...overrides,
});

const page = (
  byGroup: Record<string, string[]>,
  storylines: StorylineSummary[],
): { memberships: { byGroup: Record<string, string[]>; storylines: StorylineSummary[] } } => ({
  memberships: { byGroup, storylines },
});

const memberships = (
  byGroup: Record<string, string[]>,
  storylines: StorylineSummary[],
): PageMemberships => mergeMemberships([page(byGroup, storylines)]);

describe("mergeMemberships", () => {
  it("holds every loaded page's groups, not just the newest page's", () => {
    // The rail is an infinite query: a slot from page one must still find its
    // arcs after page four has arrived.
    const merged = mergeMemberships([
      page({ "1": [ARC_A, ARC_B] }, [arc(ARC_A, "Pacific Storms"), arc(ARC_B, "Shipping")]),
      page({ "2": [ARC_A, ARC_C] }, [arc(ARC_C, "Sanctions")]),
    ]);
    expect(Object.keys(merged.byGroup).sort()).toEqual(["1", "2"]);
    expect([...merged.storylines.keys()].sort()).toEqual([ARC_A, ARC_B, ARC_C].sort());
  });
});

describe("rowMembership", () => {
  it("says nothing for a group the page does not name", () => {
    // The common case, and it must cost nothing: the row keeps the marker the
    // rail has always drawn.
    const row = rowMembership(memberships({}, []), "42", ARC_A);
    expect(row.ticks).toEqual([]);
    expect(row.others).toEqual([]);
  });

  it("draws a tick per arc, with the one being read under marked", () => {
    const row = rowMembership(
      memberships({ "42": [ARC_A, ARC_B] }, [arc(ARC_A, "Pacific Storms"), arc(ARC_B, "Shipping")]),
      "42",
      ARC_A,
    );
    expect(row.ticks).toHaveLength(2);
    expect(row.ticks.filter((tick) => tick.current).map((tick) => tick.id)).toEqual([ARC_A]);
  });

  it("lists ONLY the crossings, since the gutter already names the other one", () => {
    const row = rowMembership(
      memberships({ "42": [ARC_A, ARC_B] }, [arc(ARC_A, "Pacific Storms"), arc(ARC_B, "Shipping")]),
      "42",
      ARC_A,
    );
    expect(row.others.map((other) => other.id)).toEqual([ARC_B]);
  });

  it("offers no unlabelled arc as a destination, and draws no tick for one", () => {
    // The wire carries a label-less promoted arc deliberately — it may be the
    // arc a row is READ under. As somewhere to go there is nothing to offer,
    // and the tick count must agree with the list it opens.
    const row = rowMembership(
      memberships({ "42": [ARC_A, ARC_B] }, [arc(ARC_A, "Pacific Storms"), arc(ARC_B, null)]),
      "42",
      ARC_A,
    );
    expect(row.others).toEqual([]);
    expect(row.ticks).toEqual([]);
  });

  it("keeps a row's own tick when the arc it is read under is unlabelled", () => {
    const row = rowMembership(
      memberships({ "42": [ARC_A, ARC_B] }, [arc(ARC_A, null), arc(ARC_B, "Shipping")]),
      "42",
      ARC_A,
    );
    expect(row.others.map((other) => other.id)).toEqual([ARC_B]);
    expect(row.ticks.filter((tick) => tick.current).map((tick) => tick.id)).toEqual([ARC_A]);
  });

  it("drops an arc the directory cannot describe rather than drawing a dead tick", () => {
    const row = rowMembership(
      memberships({ "42": [ARC_A, ARC_B] }, [arc(ARC_A, "Pacific Storms")]),
      "42",
      ARC_A,
    );
    expect(row.ticks).toEqual([]);
  });

  it("draws nothing when the row's own arc is not one the group is filed in", () => {
    // A slot whose group has since joined two other arcs: there is no solid
    // tick to draw, and a glyph naming two arcs and pointing at neither is
    // worse than no glyph.
    //
    // ARC_A is in the DIRECTORY but not in the group's list, and that is the
    // whole point of the fixture: leaving it out of both would let the
    // "describable" branch answer instead, and this assertion would pass
    // without the membership check it names ever running. Mutation-tested.
    const row = rowMembership(
      memberships({ "42": [ARC_B, ARC_C] }, [
        arc(ARC_A, "Pacific Storms"),
        arc(ARC_B, "Shipping"),
        arc(ARC_C, "Sanctions"),
      ]),
      "42",
      ARC_A,
    );
    expect(row.ticks).toEqual([]);
    expect(row.others).toEqual([]);
  });

  it("dates two same-labelled arcs apart over the row's OWN arc plus its crossings", () => {
    // The set the reader sees is the gutter's arc AND the crossings, so the
    // qualifier has to be computed over both — a collision between the arc in
    // the gutter and one in the list is exactly the case this exists for.
    const row = rowMembership(
      memberships({ "42": [ARC_A, ARC_B] }, [
        arc(ARC_A, "Fort Hood Crash", { from: "2026-03-02T00:00:00.000Z" }),
        arc(ARC_B, "Fort Hood Crash", { from: "2026-08-02T00:00:00.000Z" }),
      ]),
      "42",
      ARC_A,
    );
    expect(row.qualifiers.get(ARC_A)).toBeDefined();
    expect(row.qualifiers.get(ARC_B)).toBeDefined();
    expect(row.qualifiers.get(ARC_A)).not.toBe(row.qualifiers.get(ARC_B));
  });

  it("leaves an unambiguous label undated", () => {
    const row = rowMembership(
      memberships({ "42": [ARC_A, ARC_B] }, [arc(ARC_A, "Pacific Storms"), arc(ARC_B, "Shipping")]),
      "42",
      ARC_A,
    );
    expect(row.qualifiers.size).toBe(0);
  });

  it("orders arcs by their last covered day, newest first, in both the ticks and the list", () => {
    // Stability, not a ranking — the ticks and the list they open must agree.
    const row = rowMembership(
      memberships({ "42": [ARC_A, ARC_B, ARC_C] }, [
        arc(ARC_A, "Oldest", { to: "2026-08-01T00:00:00.000Z" }),
        arc(ARC_B, "Newest", { to: "2026-08-20T00:00:00.000Z" }),
        arc(ARC_C, "Middle", { to: "2026-08-10T00:00:00.000Z" }),
      ]),
      "42",
      ARC_A,
    );
    expect(row.ticks.map((tick) => tick.id)).toEqual([ARC_B, ARC_C, ARC_A]);
    expect(row.others.map((other) => other.id)).toEqual([ARC_B, ARC_C]);
  });
});
