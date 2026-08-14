import { describe, expect, it } from "vitest";
import {
  buildLabelPrompt,
  fallbackLabel,
  needsLabel,
  selectLabelMembers,
  validateLabel,
  type LabelMember,
} from "./storyline-label.js";

/**
 * The label decisions, pure (ADR-0011, "Labels"). No network, no database — the
 * point of putting the judgement here is that "may we use what came back" is
 * answerable offline, on recorded text, for ever.
 *
 * The contract under test is ADR-0011's fixed half: 2–3 words, contains a
 * proper noun, no punctuation. The unfixed half — "names the event, not just
 * the entity" — is deliberately unenforced, and one test below says so out
 * loud rather than leaving the gap to be discovered as a bug.
 */

const CRASH: LabelMember[] = [
  {
    title: "Helicopter crashes at Fort Hood during training exercise",
    description: "Two crew members were aboard the aircraft when it went down at Fort Hood.",
    published: new Date("2026-03-01T14:00:00Z"),
  },
  {
    title: "Fort Hood crash investigation opens",
    description: "Investigators arrived at Fort Hood on Monday to examine the wreckage.",
    published: new Date("2026-03-02T09:00:00Z"),
  },
  {
    title: "Survivor found near Fort Hood crash site",
    description: "A survivor was recovered close to the Fort Hood site overnight.",
    published: new Date("2026-03-03T11:00:00Z"),
  },
];

describe("needsLabel", () => {
  const NEVER = { labelAt: null, labelGroupCount: null };
  const LABELLED = { labelAt: new Date("2026-03-01T00:00:00Z"), labelGroupCount: 4 };

  it("says yes at promotion — the storyline just became real", () => {
    expect(needsLabel(LABELLED, { groupCount: 4, trigger: "promotion", driftFactor: 2 })).toBe(true);
  });

  it("says yes at a merge, whose whole point is that the story changed shape", () => {
    expect(needsLabel(LABELLED, { groupCount: 5, trigger: "merge", driftFactor: 2 })).toBe(true);
  });

  it("says yes to anything with no baseline, however it got that way", () => {
    // Never labelled, or labelled before the drift column existed. Both are
    // "we do not know what this label was describing", and the answer to that
    // is one relabel, not a wrong drift decision for ever.
    expect(needsLabel(NEVER, { groupCount: 2, trigger: "drift", driftFactor: 2 })).toBe(true);
    expect(
      needsLabel(
        { labelAt: new Date("2026-03-01T00:00:00Z"), labelGroupCount: null },
        { groupCount: 2, trigger: "drift", driftFactor: 2 },
      ),
    ).toBe(true);
  });

  it("holds a label until membership has actually doubled", () => {
    // Ordinary growth is not drift. Relabelling at 5 groups of 4 would turn a
    // storyline-volume cost into a group-volume one, which is the thing
    // ADR-0011 bought the fallback to avoid.
    expect(needsLabel(LABELLED, { groupCount: 7, trigger: "drift", driftFactor: 2 })).toBe(false);
    expect(needsLabel(LABELLED, { groupCount: 8, trigger: "drift", driftFactor: 2 })).toBe(true);
  });
});

describe("selectLabelMembers", () => {
  const member = (day: number, title: string): LabelMember => ({
    title,
    description: null,
    published: new Date(`2026-03-${String(day).padStart(2, "0")}T12:00:00Z`),
  });

  it("keeps the origin however long the arc runs", () => {
    // Recency alone loses the event itself: ten headlines about a verdict do
    // not say what the trial was about, and the label has to name the
    // happening.
    const members = [1, 2, 3, 4, 5, 6].map((day) => member(day, `day ${day}`));
    const chosen = selectLabelMembers(members, 3);

    expect(chosen.map((m) => m.title)).toEqual(["day 1", "day 5", "day 6"]);
  });

  it("reads oldest first, as the story ran", () => {
    const members = [3, 1, 2].map((day) => member(day, `day ${day}`));
    expect(selectLabelMembers(members, 10).map((m) => m.title)).toEqual([
      "day 1",
      "day 2",
      "day 3",
    ]);
  });

  it("takes everything when the storyline is smaller than the sample", () => {
    const members = [1, 2].map((day) => member(day, `day ${day}`));
    expect(selectLabelMembers(members, 10)).toHaveLength(2);
    expect(selectLabelMembers([], 10)).toEqual([]);
  });
});

describe("buildLabelPrompt", () => {
  it("states the whole contract and nothing about our schema", () => {
    const prompt = buildLabelPrompt(CRASH);

    expect(prompt).toContain("2 or 3 words");
    expect(prompt).toContain("proper noun");
    expect(prompt).toContain("No punctuation");
    expect(prompt).toContain("Helicopter crashes at Fort Hood during training exercise");
    // The model is told what the story is, never what a storyline is: UUIDs,
    // groups and profile tokens are our vocabulary and would only invite the
    // model to reason about them.
    expect(prompt).not.toMatch(/storyline|group|uuid/i);
  });

  it("trims a long description rather than paying to send it whole", () => {
    const prompt = buildLabelPrompt([
      { title: "Fort Hood crash", description: "x".repeat(500), published: new Date() },
    ]);
    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(700);
  });
});

describe("validateLabel", () => {
  it("accepts a two- or three-word name grounded in the coverage", () => {
    expect(validateLabel("Fort Hood Crash", CRASH)).toBe("Fort Hood Crash");
    expect(validateLabel("Fort Hood", CRASH)).toBe("Fort Hood");
  });

  it("cleans the wrapping a model puts around an answer", () => {
    expect(validateLabel('  "Fort Hood Crash"  ', CRASH)).toBe("Fort Hood Crash");
    expect(validateLabel("**Fort Hood Crash**", CRASH)).toBe("Fort Hood Crash");
    expect(validateLabel("Fort Hood Crash.", CRASH)).toBe("Fort Hood Crash");
  });

  it("refuses a label of the wrong length", () => {
    expect(validateLabel("Fort", CRASH)).toBeNull();
    expect(validateLabel("The Fort Hood Helicopter Crash", CRASH)).toBeNull();
  });

  it("refuses a sentence, which is what a chatty model returns", () => {
    expect(
      validateLabel('Sure! A good tag would be: "Fort Hood Crash".', CRASH),
    ).toBeNull();
  });

  it("refuses a name that appears nowhere in the coverage", () => {
    // The failure that actually matters: a model naming a story after
    // something it invented. Grounding is checkable; "is this a proper noun"
    // in the abstract is not.
    expect(validateLabel("Belgrade Derailment", CRASH)).toBeNull();
  });

  it("refuses a label with no capitalized word at all", () => {
    expect(validateLabel("crash investigation", CRASH)).toBeNull();
  });

  it("keeps a year, which is not punctuation", () => {
    // Live evidence: the first run against the API refused "Osun Election
    // 2026" — a good label — on a rule ADR-0011 never wrote. The contract bars
    // punctuation, and a digit is not punctuation.
    const members: LabelMember[] = [
      {
        title: "Osun election results delayed",
        description: "The Osun election count continued overnight.",
        published: new Date("2026-03-01T00:00:00Z"),
      },
    ];
    expect(validateLabel("Osun Election 2026", members)).toBe("Osun Election 2026");
  });

  it("keeps punctuation that lives inside a name", () => {
    const members: LabelMember[] = [
      {
        title: "Xi'an factory fire kills four",
        description: "The fire began at a plant in Xi'an on Tuesday.",
        published: new Date("2026-03-01T00:00:00Z"),
      },
    ];
    expect(validateLabel("Xi'an Fire", members)).toBe("Xi'an Fire");
  });

  it("does NOT enforce 'the event, not just the entity' — and cannot", () => {
    // "Fort Hood Crash" and "Donald Trump" are both two capitalized grounded
    // words; no test over tokens separates them. The prompt carries this
    // clause and live output is what judges it (ADR-0011: the prompt iterates,
    // the contract does not). Written as a test so the gap is a decision on
    // the record rather than a bug someone finds later.
    const trump: LabelMember[] = [
      {
        title: "Donald Trump speaks in Ohio",
        description: "Donald Trump addressed supporters in Ohio.",
        published: new Date("2026-03-01T00:00:00Z"),
      },
    ];
    expect(validateLabel("Donald Trump", trump)).toBe("Donald Trump");
  });
});

describe("fallbackLabel", () => {
  it("names a storyline whose members share no phrase at all", () => {
    // The containment rule is gone with the guarantee it served (ADR-0011), and
    // this is what that buys: the old extractor returned null here, because
    // "fort hood" is absent from the third headline's own words.
    const label = fallbackLabel([
      ...CRASH,
      {
        title: "Training flights resume after the Texas accident",
        description: "Flights resumed on Friday.",
        published: new Date("2026-03-04T09:00:00Z"),
      },
    ]);
    expect(label).toBe("Fort Hood");
  });

  it("Title Cases what it returns — a label is read, not typed into a box", () => {
    expect(fallbackLabel(CRASH)).toBe("Fort Hood");
  });

  it("returns null rather than a bad name when there is no phrase", () => {
    expect(fallbackLabel([])).toBeNull();
    expect(
      fallbackLabel([{ title: "Rain", description: null, published: new Date() }]),
    ).toBeNull();
  });
});
