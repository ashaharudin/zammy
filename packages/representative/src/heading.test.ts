import { describe, expect, it } from "vitest";
import { chooseHeading, LATER_PART_RULE, type Grouped } from "./heading.js";

/**
 * The **representative** rule, pinned once (CONTEXT.md, Representative).
 *
 * The table below is the test this module exists for. Before it, the rule's
 * clauses lived in `packages/storage` (the matched-members join), `apps/api`
 * (`leadBeats`, `chooseRepresentative`) and `apps/web` (`earliestIndex`), each
 * pinned by its own file against its own fixtures — so "the lead card and the
 * 18:00 card follow one rule" was a sentence in two doc comments a package
 * apart and an assertion nowhere. One fixture through both settings of `within`
 * is what makes it an assertion: every row states what a timeline slot shows
 * AND what a card cut out of a later part of the reader's day shows, from the
 * same members, and the rows where the two columns differ ARE the product
 * change `LATER_PART_RULE` is holding back.
 */

interface Member extends Grouped {
  /** Not in `Grouped`, and here to prove the rule cannot see it. */
  sightingCount: number;
}

/** `id/group @ HH:MM from source`, newest first as the wire sends them. */
function member(spec: {
  id: string;
  group: string;
  at: string;
  from?: string;
  seen?: number;
}): Member {
  return {
    id: spec.id,
    groupId: spec.group,
    sourceDomain: spec.from ?? "contentfarm.example",
    published: `2026-08-11T${spec.at}:00.000Z`,
    sightingCount: spec.seen ?? 1,
  };
}

/**
 * One set of members, and the headline each rule draws from it.
 *
 * `lead` is §14.3's rule — the largest group leads, source authority picks
 * within it — which a timeline slot uses and which a later part of the day
 * WOULD use if `LATER_PART_RULE` were flipped. `part` is what a later part uses
 * today: the earliest article the part holds.
 */
const RULES: {
  case: string;
  members: Member[];
  lead: string;
  part: string;
}[] = [
  {
    case: "a group of one is the whole answer either way",
    members: [member({ id: "1", group: "1", at: "09:00" })],
    lead: "1",
    part: "1",
  },
  {
    case: "the largest group leads, and authority picks inside it",
    // Group 10 is the story — three outlets ran it — and the BBC copy is the
    // last of the three. Group 20 is one earlier angle piece. §14.3 wants the
    // BBC copy; the part rule wants the angle piece for having run first.
    members: [
      member({ id: "4", group: "10", at: "11:00", from: "bbc.co.uk" }),
      member({ id: "3", group: "10", at: "10:00" }),
      member({ id: "2", group: "10", at: "08:00" }),
      member({ id: "1", group: "20", at: "07:00" }),
    ],
    lead: "4",
    part: "1",
  },
  {
    case: "a tier-1 latecomer takes the headline without moving anything",
    // Authority is a property of the domain and time is not, so the group
    // stays where its earliest member put it while its headline changes in
    // place (§14.3). The part rule cannot express that at all.
    members: [
      member({ id: "2", group: "10", at: "11:00", from: "apnews.com" }),
      member({ id: "1", group: "10", at: "08:00" }),
    ],
    lead: "2",
    part: "1",
  },
  {
    case: "no tier-1 member anywhere falls back to earliest published",
    // The Anglophone cost, stated in §14.3: on a Spanish or Arabic timeline
    // this is the only branch that runs, and the two rules then agree whenever
    // the earliest article is in the largest group.
    members: [
      member({ id: "3", group: "10", at: "10:00", from: "elpais.example" }),
      member({ id: "2", group: "10", at: "07:00", from: "clarin.example" }),
      member({ id: "1", group: "20", at: "09:00" }),
    ],
    lead: "2",
    part: "2",
  },
  {
    case: "equal-sized groups break to the earliest, then to the lowest group id",
    // Two groups of two, both starting at 08:00: the tie-break has to be total
    // or a replayed read reaches a different card (§7.4's replay discipline).
    // Group "10" wins on id, and its BBC member then wins on authority.
    members: [
      member({ id: "4", group: "20", at: "12:00", from: "reuters.com" }),
      member({ id: "3", group: "10", at: "11:00", from: "bbc.co.uk" }),
      member({ id: "2", group: "20", at: "08:00" }),
      member({ id: "1", group: "10", at: "08:00" }),
    ],
    lead: "3",
    part: "2",
  },
  {
    case: "group ids compare as numbers, not as strings",
    // A group id IS an article id, the seed's: decimal over a bigint column.
    // "10" < "9" lexicographically, which would invert the tie-break.
    members: [
      member({ id: "2", group: "10", at: "08:00" }),
      member({ id: "1", group: "9", at: "08:00" }),
    ],
    lead: "1",
    part: "2",
  },
  {
    case: "article ids compare as numbers, not as strings",
    members: [
      member({ id: "10", group: "1", at: "08:00", from: "npr.org" }),
      member({ id: "9", group: "1", at: "08:00", from: "npr.org" }),
    ],
    lead: "9",
    part: "10",
  },
  {
    case: "re-emission never promotes a member under either rule",
    // `sighting_count` measures upstream re-emission, not importance — one
    // link-roundup page arrived 50 times (PROBE-FINDINGS 4). Ranking by it
    // would hand the front of every slot to the noisiest wire, which is what
    // §7.4's collapse exists to neutralise.
    members: [
      member({ id: "2", group: "10", at: "11:00", from: "roundup.example", seen: 50 }),
      member({ id: "1", group: "10", at: "10:00", from: "npr.org" }),
    ],
    lead: "1",
    part: "1",
  },
  {
    case: "the rules disagree when the earliest article is outside the largest group",
    // The whole of the product delta, in one row. A wire service ran the story
    // three times over from 14:00; a single blog got a line out at 13:00. The
    // part of the day is headed by the blog today and would be headed by the
    // wire service under `within: "lead"`.
    members: [
      member({ id: "4", group: "10", at: "16:00" }),
      member({ id: "3", group: "10", at: "15:00", from: "reuters.com" }),
      member({ id: "2", group: "10", at: "14:00" }),
      member({ id: "1", group: "20", at: "13:00" }),
    ],
    lead: "3",
    part: "1",
  },
  {
    case: "two articles published at one instant leave the headline where the wire put it",
    // Ties go to the FIRST of the newest-first list under the part rule, so a
    // re-render cannot swap the headline between two simultaneous arrivals.
    members: [
      member({ id: "2", group: "20", at: "09:00" }),
      member({ id: "1", group: "10", at: "09:00" }),
    ],
    lead: "1",
    part: "2",
  },
];

describe("the representative rule", () => {
  it.each(RULES)("$case", ({ members, lead, part }) => {
    // ONE fixture, both rules. This is the assertion three packages could not
    // make between them.
    expect({
      lead: chooseHeading(members, { within: "lead" }).representative.id,
      part: chooseHeading(members, { within: "part" }).representative.id,
    }).toEqual({ lead, part });
  });

  it("heads a timeline slot by the lead rule and a later part of the day by the part rule", () => {
    // The wiring the two call sites use, asserted here so that a change to
    // either default is visible in this file and not only at the call site.
    // `apps/api/src/timeline-read.ts` takes the default; `apps/web`'s rail
    // passes `LATER_PART_RULE`.
    const disagreeing = RULES.find((row) => row.lead !== row.part)!;
    expect(chooseHeading(disagreeing.members).representative.id).toBe(disagreeing.lead);
    expect(
      chooseHeading(disagreeing.members, { within: LATER_PART_RULE }).representative.id,
    ).toBe(disagreeing.part);
    expect(LATER_PART_RULE).toBe("part");
  });
});

describe("what sits behind the headline", () => {
  const members = [
    member({ id: "4", group: "10", at: "16:00" }),
    member({ id: "3", group: "20", at: "15:00" }),
    member({ id: "2", group: "10", at: "14:00", from: "bbc.co.uk" }),
    member({ id: "1", group: "20", at: "13:00" }),
  ];

  it("splits the heading group off as related and flattens the rest as coverage", () => {
    const heading = chooseHeading(members, { within: "lead" });
    // Groups tie at two members each; group 10 starts at 14:00 against group
    // 20's 13:00, so group 20 leads and its earliest member heads it.
    expect(heading.representative.id).toBe("1");
    expect(heading.related.map((m) => m.id)).toEqual(["3"]);
    expect(heading.coverage.map((m) => m.id)).toEqual(["4", "2"]);
  });

  it("keeps the order it was given, so the disclosure stays newest first", () => {
    // §14.3: the wire sends members newest first and that is the order the
    // disclosure renders in. This function decides which LIST an article goes
    // in, never where it sits once there.
    const heading = chooseHeading(members, { within: "part" });
    expect([
      heading.representative.id,
      ...heading.related.map((m) => m.id),
      ...heading.coverage.map((m) => m.id),
    ].sort()).toEqual(["1", "2", "3", "4"]);
    expect(heading.coverage.map((m) => m.id)).toEqual(["4", "2"]);
  });

  it("refuses an empty card rather than inventing a headline", () => {
    expect(() => chooseHeading([])).toThrow(/at least one member/);
  });
});

describe("clause 1 — among the members that matched that search", () => {
  it("promotes a different article once an unmatched member is filtered out", () => {
    // The clause itself is a SQL join (`packages/storage`, step 2) and cannot
    // live here; its CONSEQUENCE can, and this is it. A global choice would
    // surface an article the reader's keywords never found and bury the
    // matching one under "related" (§14.3). Same slot, two searches: whichever
    // members reach this function are the ones it may promote.
    const wholeSlot = [
      member({ id: "2", group: "10", at: "11:00", from: "bbc.co.uk" }),
      member({ id: "1", group: "10", at: "09:00" }),
    ];
    const matched = wholeSlot.filter((m) => m.id !== "2");

    expect(chooseHeading(wholeSlot).representative.id).toBe("2");
    expect(chooseHeading(matched).representative.id).toBe("1");
  });
});
