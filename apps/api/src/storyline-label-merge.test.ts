import { describe, expect, it } from "vitest";
import { singular } from "./grouping.js";
import { properNounEvidence } from "./headline-tokens.js";
import {
  labelWords,
  normalizeLabel,
  planLabelMerge,
  sharedLabels,
  spansTouch,
  type LabelMergeCandidate,
  type LabelMergeRules,
} from "./storyline-label-merge.js";

/**
 * The label-agreement merge decision.
 *
 * Two cases from the dev archive drive most of this file, because they are what
 * the design was measured against: "Strait of Hormuz Crisis" (six arcs, one
 * evolving situation, MUST merge) and "Q2 2026 Financial Results" (three arcs,
 * unrelated companies reporting earnings, MUST NOT). Their spans overlap alike,
 * so every test that separates them is testing the grounding guard.
 */

const RULES: LabelMergeRules = { graceDays: 7, maxComponent: 25 };
const DAY = 86_400_000;
const day = (iso: string): number => new Date(`${iso}T12:00:00Z`).getTime();

function arc(
  id: string,
  label: string,
  from: string,
  to: string,
  groupCount = 3,
): LabelMergeCandidate {
  return { id, label, spanFromMs: day(from), spanToMs: day(to), groupCount };
}

/** Names in the Hormuz coverage; everything else reads as a common word. */
const HORMUZ_NAMES = new Set(["hormuz", "iran", "oman", "tehran", "trump"]);
const isHormuzName = (word: string): boolean => HORMUZ_NAMES.has(word);
/** The Q2 component grounds no name at all — every word appears lowercase. */
const noNames = (): boolean => false;

describe("normalizeLabel", () => {
  it("folds case, spacing and plurals", () => {
    expect(normalizeLabel("  Strait  of   Hormuz   Crisis ")).toBe("strait of hormuz crisi");
    expect(normalizeLabel("Hormuz Talks")).toBe(normalizeLabel("hormuz talk"));
  });

  it("does NOT elide stopwords", () => {
    // Both sides of this comparison come from the model, and refusing a merge
    // costs nothing while making one wrongly swallows a storyline.
    expect(normalizeLabel("Strait of Hormuz Crisis")).not.toBe(
      normalizeLabel("Strait Hormuz Crisis"),
    );
  });

  it("splits a label into folded words", () => {
    expect(labelWords("Strait of Hormuz Crisis")).toEqual([
      "strait",
      "of",
      "hormuz",
      "crisi",
    ]);
  });
});

describe("spansTouch", () => {
  const a = { spanFromMs: day("2026-08-01"), spanToMs: day("2026-08-05") };

  it("sees overlap", () => {
    expect(spansTouch(a, { spanFromMs: day("2026-08-04"), spanToMs: day("2026-08-09") }, 0)).toBe(
      true,
    );
  });

  it("sees containment", () => {
    expect(spansTouch(a, { spanFromMs: day("2026-08-02"), spanToMs: day("2026-08-03") }, 0)).toBe(
      true,
    );
  });

  it("bridges a gap within the grace window, and refuses one beyond it", () => {
    const later = { spanFromMs: day("2026-08-10"), spanToMs: day("2026-08-12") };
    expect(spansTouch(a, later, 7)).toBe(true);
    expect(spansTouch(a, later, 2)).toBe(false);
  });

  it("lets a single-day storyline touch its neighbours", () => {
    const oneDay = { spanFromMs: day("2026-08-05"), spanToMs: day("2026-08-05") };
    expect(spansTouch(a, oneDay, 0)).toBe(true);
  });

  it("is symmetric", () => {
    const b = { spanFromMs: day("2026-08-20"), spanToMs: day("2026-08-22") };
    expect(spansTouch(a, b, 3)).toBe(spansTouch(b, a, 3));
  });
});

describe("sharedLabels", () => {
  it("keeps only labels more than one storyline holds", () => {
    const components = sharedLabels([
      arc("a", "Strait of Hormuz Crisis", "2026-08-01", "2026-08-05"),
      arc("b", "Strait of Hormuz Crisis", "2026-08-04", "2026-08-09"),
      arc("c", "Fort Hood Crash", "2026-08-01", "2026-08-02"),
    ]);
    expect([...components.keys()]).toEqual(["crisi hormuz of strait"]);
    expect(components.get("crisi hormuz of strait")).toHaveLength(2);
  });

  it("groups labels that differ only by word order", () => {
    const components = sharedLabels([
      arc("a", "Canada US Trade Deal", "2026-08-07", "2026-08-20"),
      arc("b", "US Canada Trade Deal", "2026-08-12", "2026-08-20"),
    ]);
    expect([...components.keys()]).toEqual(["canada deal trade us"]);
    expect(components.get("canada deal trade us")).toHaveLength(2);
  });

  it("groups labels that differ only by case or plural", () => {
    const components = sharedLabels([
      arc("a", "Hormuz Talks", "2026-08-01", "2026-08-05"),
      arc("b", "hormuz talk", "2026-08-04", "2026-08-09"),
    ]);
    expect(components.size).toBe(1);
  });
});

describe("planLabelMerge", () => {
  it("merges the Hormuz component into one storyline", () => {
    // The six arcs as the archive held them on 2026-08-17.
    const arcs = [
      arc("a1865f16", "Strait of Hormuz Crisis", "2026-07-27", "2026-08-17", 3),
      arc("e2c8dd39", "Strait of Hormuz Crisis", "2026-08-02", "2026-08-14", 17),
      arc("da67ae6e", "Strait of Hormuz Crisis", "2026-08-03", "2026-08-17", 3),
      arc("0b100445", "Strait of Hormuz Crisis", "2026-08-13", "2026-08-14", 2),
      arc("176a9e5f", "Strait of Hormuz Crisis", "2026-08-14", "2026-08-17", 3),
      arc("85689f17", "Strait of Hormuz Crisis", "2026-08-17", "2026-08-17", 3),
    ];

    const { plans, refusals } = planLabelMerge(
      "strait of hormuz crisi",
      arcs,
      isHormuzName,
      RULES,
    );

    expect(refusals).toEqual([]);
    expect(plans).toHaveLength(1);
    // The 17-group arc wins: more coverage keeps the UUID more readers hold.
    expect(plans[0]!.winnerId).toBe("e2c8dd39");
    expect(plans[0]!.loserIds).toHaveLength(5);
    expect(new Set(plans[0]!.loserIds)).toEqual(
      new Set(["a1865f16", "da67ae6e", "0b100445", "176a9e5f", "85689f17"]),
    );
  });

  it("refuses a component whose label names nothing", () => {
    // "Q2 2026 Financial Results" over CVB Financial, Mitsui, Mayfair Gold and
    // Westaim. Overlapping spans, identical model label, three unrelated
    // companies — the boilerplate arc this guard exists to refuse.
    const arcs = [
      arc("b02f7974", "Q2 2026 Financial Results", "2026-07-22", "2026-08-13", 5),
      arc("3e3805e9", "Q2 2026 Financial Results", "2026-07-23", "2026-08-13", 3),
      arc("f8364a46", "Q2 2026 Financial Results", "2026-08-12", "2026-08-13", 3),
    ];

    const { plans, refusals } = planLabelMerge(
      "q2 2026 financial result",
      arcs,
      noNames,
      RULES,
    );

    expect(plans).toEqual([]);
    expect(refusals).toEqual([
      { label: "q2 2026 financial result", storylines: 3, reason: "no grounded name" },
    ]);
  });

  it("folds a possessive to the spelling the corpus tokenizer produces", () => {
    // The `dillard'` refusal, measured on the dev archive: two arcs of one
    // earnings story, both labelled "Dillard's Tariff Refund Earnings", refused
    // for "no grounded name" while `dillard` sat capitalized in the coverage.
    // `singular` alone dropped the final `s` and left the apostrophe stranded,
    // so the grounding gate asked for a token the corpus could never hold.
    expect(labelWords("Dillard's Tariff Refund Earnings")).toEqual([
      "dillard",
      "tariff",
      "refund",
      "earning",
    ]);

    // Both sides of the comparison must land on one spelling, so assert the
    // corpus side reaches the same word rather than trusting that it does.
    const evidence = properNounEvidence(
      [
        {
          title: "Tariff refunds boost bottom line",
          description: "Little Rock-based Dillard's beat estimates as tariff refunds landed.",
        },
      ],
      singular,
    );
    expect(evidence("dillard")).toBe(true);
    expect(labelWords("Dillard's Earnings")[0]).toBe("dillard");
  });

  it("grounds a possessive label and merges the component it was refusing", () => {
    const arcs = [
      arc("first", "Dillard's Tariff Refund Earnings", "2026-08-11", "2026-08-13"),
      arc("second", "Dillard's Tariff Refund Earnings", "2026-08-12", "2026-08-14"),
    ];

    const { plans, refusals } = planLabelMerge(
      normalizeLabel("Dillard's Tariff Refund Earnings"),
      arcs,
      (word) => word === "dillard",
      RULES,
    );

    expect(refusals).toEqual([]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.loserIds).toEqual(["second"]);
  });

  it("trims a plural possessive too, which the 's rule alone would miss", () => {
    // "Workers' Rights" leaves `workers'` if only `'s` is stripped, and
    // `singular` will not touch a word ending in an apostrophe.
    expect(labelWords("Workers' Rights March")).toEqual(["worker", "right", "march"]);
  });

  it("keeps two same-named stories apart when their spans do not touch", () => {
    // ADR-0010's own disambiguator: a label is non-unique and the date span is
    // what tells two storylines sharing one apart.
    const arcs = [
      arc("old", "Fort Hood Crash", "2026-01-04", "2026-01-06"),
      arc("new", "Fort Hood Crash", "2026-08-14", "2026-08-17"),
    ];

    const { plans } = planLabelMerge("fort hood crash", arcs, (w) => w === "hood", RULES);

    expect(plans).toEqual([]);
  });

  it("chains a component through a middle arc that covers the gap", () => {
    const arcs = [
      arc("early", "Hormuz Crisis", "2026-08-01", "2026-08-05"),
      arc("late", "Hormuz Crisis", "2026-08-18", "2026-08-22"),
      arc("middle", "Hormuz Crisis", "2026-08-03", "2026-08-20", 9),
    ];

    // Grace 0, so nothing here is bridged by tolerance: early and late are 13
    // days apart and never touch. Middle overlaps both, so all three are one.
    const { plans } = planLabelMerge("hormuz crisi", arcs, isHormuzName, {
      ...RULES,
      graceDays: 0,
    });

    expect(spansTouch(arcs[0]!, arcs[1]!, 0)).toBe(false);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.winnerId).toBe("middle");
    expect(plans[0]!.loserIds).toHaveLength(2);
  });

  it("splits one label into two components when the gap is real", () => {
    const arcs = [
      arc("s1", "Hormuz Crisis", "2026-08-01", "2026-08-03"),
      arc("s2", "Hormuz Crisis", "2026-08-02", "2026-08-04"),
      arc("s3", "Hormuz Crisis", "2026-09-01", "2026-09-03"),
      arc("s4", "Hormuz Crisis", "2026-09-02", "2026-09-04"),
    ];

    const { plans } = planLabelMerge("hormuz crisi", arcs, isHormuzName, RULES);

    expect(plans).toHaveLength(2);
    expect(plans.every((plan) => plan.loserIds.length === 1)).toBe(true);
  });

  it("refuses a component larger than the safety valve, and says so by name", () => {
    const arcs = Array.from({ length: 6 }, (_, index) =>
      arc(`s${index}`, "Hormuz Crisis", "2026-08-01", "2026-08-30"),
    );

    const { plans, refusals } = planLabelMerge("hormuz crisi", arcs, isHormuzName, {
      graceDays: 7,
      maxComponent: 5,
    });

    expect(plans).toEqual([]);
    expect(refusals).toEqual([
      { label: "hormuz crisi", storylines: 6, reason: "component too large" },
    ]);
  });

  it("shuts the valve on a maxComponent that is not a number", () => {
    // `Number("abc")` is NaN, and `length > NaN` is false — the valve would
    // pass everything on exactly the run where the operator typed the flag
    // wrong. The CLI rejects the flag outright; this is the second lock.
    const arcs = Array.from({ length: 6 }, (_, index) =>
      arc(`s${index}`, "Hormuz Crisis", "2026-08-01", "2026-08-30"),
    );

    const { plans, refusals } = planLabelMerge("hormuz crisi", arcs, isHormuzName, {
      graceDays: 7,
      maxComponent: Number.NaN,
    });

    expect(plans).toEqual([]);
    expect(refusals).toEqual([
      { label: "hormuz crisi", storylines: 6, reason: "component too large" },
    ]);
  });

  it("never plans a component of one", () => {
    const arcs = [
      arc("alone", "Hormuz Crisis", "2026-08-01", "2026-08-03"),
      arc("far", "Hormuz Crisis", "2026-12-01", "2026-12-03"),
    ];

    const { plans, refusals } = planLabelMerge("hormuz crisi", arcs, isHormuzName, RULES);

    expect(plans).toEqual([]);
    expect(refusals).toEqual([]);
  });

  it("plans the same merge whatever order the candidates arrive in", () => {
    // A replay of the same night must write the same rows (§7.4).
    const arcs = [
      arc("a", "Hormuz Crisis", "2026-08-01", "2026-08-06", 4),
      arc("b", "Hormuz Crisis", "2026-08-05", "2026-08-09", 4),
      arc("c", "Hormuz Crisis", "2026-08-08", "2026-08-12", 9),
    ];
    const forward = planLabelMerge("hormuz crisi", arcs, isHormuzName, RULES);
    const backward = planLabelMerge("hormuz crisi", [...arcs].reverse(), isHormuzName, RULES);

    expect(backward.plans).toEqual(forward.plans);
    // Ties on group count fall to the earlier span, then the id.
    expect(forward.plans[0]!.winnerId).toBe("c");
  });

  it("grounds on any one word of the label, not all of them", () => {
    const arcs = [
      arc("a", "Strait of Hormuz Crisis", "2026-08-01", "2026-08-05"),
      arc("b", "Strait of Hormuz Crisis", "2026-08-04", "2026-08-09"),
    ];

    const { plans } = planLabelMerge(
      "strait of hormuz crisi",
      arcs,
      (word) => word === "hormuz",
      RULES,
    );

    expect(plans).toHaveLength(1);
  });

  it("treats a grace window as days, not milliseconds", () => {
    const arcs = [
      arc("a", "Hormuz Crisis", "2026-08-01", "2026-08-01"),
      arc("b", "Hormuz Crisis", "2026-08-08", "2026-08-08"),
    ];
    expect(
      planLabelMerge("hormuz crisi", arcs, isHormuzName, { graceDays: 7, maxComponent: 25 })
        .plans,
    ).toHaveLength(1);
    expect(
      planLabelMerge("hormuz crisi", arcs, isHormuzName, { graceDays: 6, maxComponent: 25 })
        .plans,
    ).toHaveLength(0);
    expect(day("2026-08-08") - day("2026-08-01")).toBe(7 * DAY);
  });
});
